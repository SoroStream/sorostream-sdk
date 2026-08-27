# Stream Parameter Ranges

> **Issue:** [#543](https://github.com/SoroStream/sorostream-sdk/issues/543), [#154](https://github.com/SoroStream/sorostream-sdk/issues/154)

This document lists the valid minimum and maximum values for every field in
[`CreateStreamParams`](../src/types.ts) and related parameter interfaces.
Values are given in **raw units** (stroops / seconds) and their
**human-readable equivalents**. Each constraint is labelled as either
**SDK-enforced** (rejected before the transaction is built) or
**contract-enforced** (rejected by the Soroban runtime on-chain).

---

## Unit Primer

| Concept | Raw Unit | Conversion |
|---------|----------|------------|
| Token amounts | **stroops** (smallest unit) | 1 token = 10 000 000 stroops (7 decimals for SAC tokens like USDC) |
| Durations | **seconds** | 1 day = 86 400 s · 1 year ≈ 31 536 000 s |
| Flow rates | **stroops / second** | Computed as `amount / durationSeconds` (integer division) |
| Timestamps | **Unix seconds** | Seconds since 1970-01-01 00:00:00 UTC |

---

## `CreateStreamParams`

| Field | Type | Min | Max | Human-readable | Enforced by |
|-------|------|-----|-----|----------------|-------------|
| `amount` | `bigint` | `1n` (1 stroop) | `2^127 − 1` (Soroban `i128` max) | **Min:** 0.0000001 tokens · **Max:** ≈ 1.7 × 10³¹ tokens | **SDK** — `InsufficientAmountError` if `amount <= 0n` |
| `durationSeconds` | `number` | `1` | `2^64 − 1` (18 446 744 073 709 551 615) | **Min:** 1 second · **Max:** ≈ 584 billion years | **SDK** — `ZeroDurationError` if `< 1` (constant `MIN_STREAM_DURATION_SECONDS`). On-chain encoded as Soroban `u64`. |
| `recipient` | `string` | — | — | Valid Stellar address (`G…` or `C…`, 56 chars) | **SDK** — `InvalidAddressError` if the address fails `isValidStellarAddress()` regex. **SDK** — `AccountNotFoundError` if the account doesn't exist on-chain. |
| `token` | `string` | — | — | Valid SAC token contract address (`C…`, 56 chars) | **SDK** — `InvalidAddressError` if the address fails `isValidStellarAddress()`. |
| `autoRenew` | `boolean` | `false` | `true` | — | No validation; passed through to the contract. |
| `cliffSeconds` | `number` (optional) | `0` | Same as `durationSeconds` | **Min:** 0 (no cliff, default) | **SDK** — default `validateCliff` throws if `< 0`. Custom validator can be provided via `SoroStreamClientOptions.validateCliff`. |
| `checkDuplicate` | `boolean` (optional) | — | — | — | SDK-only opt-in flag. No range constraint. |
| `skipAllowanceCheck` | `boolean` (optional) | — | — | — | SDK-only opt-in flag. No range constraint. |

### Derived: Flow Rate

The SDK does **not** accept an explicit `flowRate` in `CreateStreamParams`.
Instead, the per-second flow rate is computed automatically:

```
flowRate = amount / durationSeconds   (integer division, bigint)
```

Because the contract stores `flowRate` as an `i128`, the derived value is
subject to the same `i128` range. In practice this is never hit since
`amount` is itself `i128`-bounded and `durationSeconds >= 1`.

> **⚠️ Important:** If `amount < durationSeconds`, integer division truncates
> the flow rate to `0n`. The contract will reject a zero flow rate. Always
> ensure `amount >= durationSeconds` (i.e. at least 1 stroop per second).

---

## `TopUpParams`

| Field | Type | Min | Max | Human-readable | Enforced by |
|-------|------|-----|-----|----------------|-------------|
| `streamId` | `string` | — | — | Numeric stream ID | **Contract** — `StreamNotFoundError` if not found. |
| `amount` | `bigint` | `1n` (1 stroop) | `2^127 − 1` (`i128` max) | **Min:** 0.0000001 tokens | **SDK** — `InsufficientAmountError` if `<= 0n`. |

---

## `UpdateFlowRateParams`

| Field | Type | Min | Max | Human-readable | Enforced by |
|-------|------|-----|-----|----------------|-------------|
| `streamId` | `string` | — | — | Numeric stream ID | **Contract** — `StreamNotFoundError` if not found. |
| `newFlowRate` | `bigint` | `1n` (1 stroop/s) | `2^127 − 1` (`i128` max) | **Min:** 0.0000001 tokens/s | **SDK** — `InsufficientAmountError` if `<= 0n`. |

---

## `WithdrawParams` / `CancelStreamParams`

| Field | Type | Constraint | Enforced by |
|-------|------|-----------|-------------|
| `streamId` | `string` | Must reference an existing stream | **Contract** — `StreamNotFoundError` |

No amount or duration constraints; the contract determines the withdrawable
balance and stream cancellability.

---

## `SplitStreamParams`

| Field | Type | Min | Max | Enforced by |
|-------|------|-----|-----|-------------|
| `streamId` | `string` | — | — | **Contract** |
| `ratioNumerator` | `number` | `1` | Must be `<= ratioDenominator` | **Contract** — encoded as `u64`. |
| `ratioDenominator` | `number` | `1` | `2^64 − 1` | **Contract** — encoded as `u64`. Must be `> 0`. |
| `recipientA` | `string` | — | — | Valid Stellar address | **Contract** |
| `recipientB` | `string` | — | — | Valid Stellar address | **Contract** |

---

## On-chain (Soroban) Type Limits

These are the hard limits imposed by the Soroban runtime. The SDK may impose
tighter bounds (documented above), but values that exceed these will always
fail at the contract level.

| Soroban Type | Used for | Min | Max |
|--------------|----------|-----|-----|
| `i128` | `amount`, `flowRate`, `deposit` | `−2^127` (−170 141 183 460 469 231 731 687 303 715 884 105 728) | `2^127 − 1` (170 141 183 460 469 231 731 687 303 715 884 105 727) |
| `u64` | `durationSeconds`, `streamId`, `ratioNumerator`, `ratioDenominator` | `0` | `2^64 − 1` (18 446 744 073 709 551 615) |
| `bool` | `autoRenew` | `false` | `true` |
| `address` | `sender`, `recipient`, `token`, `operator` | — | 56-character Stellar address |

> **Note:** While `i128` allows negative values, the SDK rejects negative
> amounts before they reach the contract. The contract itself also validates
> `amount > 0`.

---

## SDK vs Contract Enforcement Summary

| Check | Layer | Error thrown |
|-------|-------|-------------|
| `amount > 0` | **SDK** | `InsufficientAmountError` |
| `durationSeconds >= 1` | **SDK** | `ZeroDurationError` |
| `endTime > startTime` | **SDK** | `ZeroDurationError` |
| `cliffSeconds >= 0` | **SDK** (default validator) | `Error` |
| `recipient` is valid address | **SDK** | `InvalidAddressError` |
| `token` is valid address | **SDK** | `InvalidAddressError` |
| `recipient` account exists | **SDK** | `AccountNotFoundError` |
| `sender` account exists | **SDK** | `AccountNotFoundError` |
| Token allowance sufficient | **SDK** | `InsufficientAllowanceError` |
| `newFlowRate > 0` | **SDK** | `InsufficientAmountError` |
| `topUp.amount > 0` | **SDK** | `InsufficientAmountError` |
| Stream exists | **Contract** | `StreamNotFoundError` |
| Sender owns the stream | **Contract** | `TransactionFailedError` |
| Sufficient token balance | **Contract** | `TransactionFailedError` |
| Integer overflow (`i128`/`u64`) | **Contract** | `TransactionFailedError` |

---

## Practical Guidelines

### Minimum viable stream

```ts
import { toStroops } from "@sorostream/sdk";

// Smallest possible stream: 1 stroop for 1 second
const params = {
  recipient: "GRECIPIENT...",
  token:     "GUSDC...",
  amount:    1n,                // 1 stroop = 0.0000001 USDC
  durationSeconds: 1,          // 1 second
  autoRenew: false,
};
```

### Typical payroll stream

```ts
import { toStroops } from "@sorostream/sdk";

const params = {
  recipient: "GRECIPIENT...",
  token:     "GUSDC...",
  amount:    toStroops("5000"),         // 5,000 USDC
  durationSeconds: 30 * 24 * 3600,     // 30 days (2,592,000 seconds)
  autoRenew: true,
};
// Derived flowRate ≈ 19.290123n stroops/s ≈ 0.00000193 USDC/s
```

### Common pitfalls

1. **Zero flow rate** — If `amount` is smaller than `durationSeconds`, integer
   division produces `flowRate = 0n`, which the contract rejects. Ensure
   `amount >= durationSeconds`.

2. **JavaScript `Number` limits** — `durationSeconds` is a `number`
   (`Number.MAX_SAFE_INTEGER = 2^53 − 1 ≈ 9.007 × 10^15`). For durations
   beyond ~285 million years this loses precision, but this is well beyond
   any practical stream.

3. **Stroop precision** — USDC uses 7 decimals. Use `toStroops("100.50")` to
   convert human amounts; never use floating-point arithmetic with `bigint`.

---

## See Also

- [`CreateStreamParams`](../src/types.ts) — TypeScript interface definition
- [`SoroStreamClient.createStream()`](../src/SoroStreamClient.ts) — JSDoc with inline parameter docs
- [`ERRORS.md`](../src/ERRORS.md) — Full error reference
- [`state-machine.md`](./state-machine.md) — Stream lifecycle states
