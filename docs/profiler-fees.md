# GasProfiler — Resource Fee vs Inclusion Fee

> Addresses issue [#742](https://github.com/SoroStream/sorostream-sdk/issues/742).

## Background: Soroban's Two-Component Fee Model

Every Soroban transaction on Stellar pays **two distinct, additive fee
components**:

```
totalFee = inclusionFee + resourceFee
```

Both are denominated in **stroops** (1 XLM = 10 000 000 stroops).

---

## 1. Inclusion Fee (classic fee)

The inclusion fee is the standard Stellar network fee paid to validators for
_including_ the transaction in a ledger.  It is not specific to Soroban — every
Stellar transaction pays it.

- **Formula:** `feePerOperation × numberOfOperations`
- **Default minimum:** 100 stroops (= `BASE_FEE`) for a single-operation
  transaction
- **Surge pricing:** During periods of high network congestion the effective
  inclusion fee may rise above `BASE_FEE` through fee-bump or fee-market
  mechanisms

The SDK uses `BASE_FEE = 100` stroops when building simulation transactions
inside `GasProfiler`.  The profiler does **not** report the inclusion fee
separately — it is a fixed constant that callers must add on top.

---

## 2. Resource Fee (`minResourceFee` / Soroban fee)

The resource fee covers the on-chain **compute resources consumed by the
smart-contract execution**.  The RPC node calculates it during simulation by
metering several sub-components:

| Sub-component | What it covers |
|---|---|
| CPU instructions (`cpuInsns`) | Wasm execution time |
| Memory bytes | Peak working-set allocated by the contract |
| Ledger reads | `readOnly` ledger entries accessed |
| Ledger writes | `readWrite` ledger entries mutated or created |
| Historical storage | Long-term archival / TTL extension of contract state |
| Events / return value | XDR bytes emitted as events or return data |
| Transaction size | Byte-length of the signed envelope |

The simulation response exposes the pre-computed total as
`SimulateTransactionSuccessResponse.minResourceFee` (a string of stroops).

**`SimulationProfile.minFee` equals `minResourceFee`** — the resource fee
only.  It does _not_ include the inclusion fee.

---

## `SimulationProfile` Fields Explained

```ts
interface SimulationProfile {
  operationType: string;           // e.g. "create_stream"
  params: Record<string, unknown>; // call parameters for traceability
  cpuInstructions: string;         // Wasm CPU insns (see note below)
  minFee: string;                  // minResourceFee in stroops (resource fee only)
  ledgerReads: number;             // readOnly + readWrite ledger key count
  ledgerWrites: number;            // readWrite ledger key count
  contractEntryBytesRead: number;  // (reserved, always 0 currently)
  contractEntryBytesWritten: number; // (reserved, always 0 currently)
  success: boolean;
  error?: string;
}
```

> **Note on `cpuInstructions`:** The SDK v13 typed simulation response does not
> expose `cost.cpuInsns` through its public interface.  The field is set to
> `"0"` as a safe sentinel.  Raw CPU instruction counts can still be read from
> the untyped `cost` field of a `SimulateTransactionSuccessResponse` if your
> code has direct access to the RPC server response.

---

## Worked Example

```ts
import { GasProfiler } from 'sorostream-sdk';

const profiler = new GasProfiler({
  network:    'testnet',
  contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXXX',
  publicKey:  'GAHLQXMVPK3EQIRJC5IXHW3X5PVBZFUKQWY7M7ASJB3WMATNLWQXXXXX',
});

const profile = await profiler.profileCreateStream({
  sender:          'GAHLQXMVPK3EQIRJC5IXHW3X5PVBZFUKQWY7M7ASJB3WMATNLWQXXXXX',
  recipient:       'GBDZX35QEFQ2AXXXXX5XXXXX6XXXXXX7XXXXXX8XXXXXX9XXXXXXAXXXXX',
  token:           'GDQOE23CFSUMSVQK4Y5JHPPYK73VYCNHZHA7ENKCV37P6SUEO6XQBKPP',
  amount:          BigInt('1000000000'), // 100 XLM (7 decimal places on Stellar)
  durationSeconds: 86400,               // 1 day
  autoRenew:       false,
});

// ── Representative output (values vary by network state) ─────────────────
// profile.operationType → "create_stream"
// profile.success       → true
// profile.minFee        → "2847"   stroops  (resource fee only)
// profile.ledgerReads   → 4        (2 readOnly + 2 readWrite keys)
// profile.ledgerWrites  → 2        (readWrite keys: stream entry + balance)
// profile.cpuInstructions → "0"    (sentinel; see note above)

// ── Computing the total fee for a real submission ────────────────────────
const BASE_FEE_STROOPS = 100; // inclusion fee
const totalFeeStroops  = BASE_FEE_STROOPS + Number(profile.minFee);
// → 2 947 stroops ≈ 0.000 294 7 XLM

console.log(`Resource fee : ${profile.minFee} stroops`);
console.log(`Inclusion fee: ${BASE_FEE_STROOPS} stroops`);
console.log(`Total fee    : ${totalFeeStroops} stroops`);
```

---

## Batch Profiling and the `ProfileReport` Summary

`GasProfiler.batchProfile` runs multiple simulations concurrently and returns a
[`ProfileReport`](../src/profiler.ts) whose `summary` aggregates across
successful profiles:

| `summary` field | Description |
|---|---|
| `totalMinFee` | Sum of resource fees across all operations (stroops) |
| `averageMinFee` | `totalMinFee / successCount` (stroops) |
| `totalLedgerReads` | Sum of ledger keys read |
| `totalLedgerWrites` | Sum of ledger keys written |
| `totalCpuInstructions` | Sum of CPU instructions (`0n` currently — see note) |
| `averageCpuInstructions` | Average CPU instructions (`0n` currently) |

Failed profiles (`success: false`) are excluded from all aggregations.

### Example — batch of three operations

```ts
const report = await profiler.batchProfile([
  () => profiler.profileCreateStream({ /* … */ }),
  () => profiler.profileWithdraw({ streamId: 'stream:1', recipient: 'GB…' }),
  () => profiler.profileCancelStream({ streamId: 'stream:1', sender: 'GA…' }),
]);

// report.summary.totalMinFee     → 7843n  stroops
// report.summary.averageMinFee   → 2614n  stroops
// report.summary.totalLedgerReads  → 11
// report.summary.totalLedgerWrites → 5
```

The inclusion fee is **not** included in the summary — multiply the number of
operations by `BASE_FEE` and add it to `totalMinFee` when estimating real
submission costs.

---

## Cross-references

- [Stellar Developer Docs — Fees and Resource Limits](https://developers.stellar.org/docs/learn/fundamentals/fees-resource-limits-metering)
- [`src/profiler.ts`](../src/profiler.ts) — source for `GasProfiler`, `SimulationProfile`, `ProfileReport`
- [Issue #742](https://github.com/SoroStream/sorostream-sdk/issues/742) — tracking issue for this documentation
