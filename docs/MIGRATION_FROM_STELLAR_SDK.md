# Migration Guide: @stellar/stellar-sdk → @sorostream/sdk

This guide helps developers familiar with `@stellar/stellar-sdk` map their existing patterns to the SoroStream SDK.

---

## Key Conceptual Differences

| @stellar/stellar-sdk | @sorostream/sdk |
|----------------------|-----------------|
| Low-level — build every transaction manually | High-level — one method call per operation |
| You manage XDR, fees, signatures, and polling | The client manages transaction lifecycle |
| Generic — any Stellar/Soroban operation | Specialised — payment streaming only |
| No built-in caching | Read cache with optimistic updates |
| No middleware system | Plugin hooks for `before`/`after`/`onError` |

---

## Operation Mapping Table

| What you did before | What you do now |
|---------------------|-----------------|
| Build a `Transaction` with `TransactionBuilder` | `client.createStream(params)` |
| Simulate with `server.simulateTransaction` | Handled internally by the client |
| Sign with `Keypair` or wallet SDK | `WalletAdapter.signTransaction()` |
| Submit with `server.sendTransaction` | Handled internally by the client |
| Poll with `server.getTransaction` | Handled internally (with timeout & backoff) |
| Fetch account data with `server.getAccount` | `client.getStream(id)` / `client.getClaimable(id)` |
| Parse contract events manually | `client.subscribeEvents(filter, cb)` |
| Estimate fees with `server.prepareTransaction` | `client.estimateCreateStreamFee(params)` |

---

## Before/After Code Examples

### 1. Creating a Payment Stream

**Before (@stellar/stellar-sdk):**

```typescript
import { Contract, TransactionBuilder, Networks, BASE_FEE, rpc, Keypair, nativeToScVal } from "@stellar/stellar-sdk";

const kp = Keypair.fromSecret("SA...");
const contract = new Contract("C...");
const server = new rpc.Server("https://soroban-testnet.stellar.org");

const account = await server.getAccount(kp.publicKey());
const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
  .addOperation(contract.call("create_stream", /* ... args ... */))
  .setTimeout(30)
  .build();

const prepared = await server.prepareTransaction(tx);
prepared.sign(kp);
const result = await server.sendTransaction(prepared);
// ... poll for confirmation manually ...
```

**After (@sorostream/sdk):**

```typescript
import { SoroStreamClient, createKeypairAdapter, toStroops } from "@sorostream/sdk";

const client = new SoroStreamClient({
  network: "testnet",
  contractId: "C...",
  walletAdapter: createKeypairAdapter("SA..."),
});

const { streamId, txHash } = await client.createStream({
  recipient: "G...",
  token: "G...",
  amount: toStroops("100"),
  durationSeconds: 30 * 24 * 60 * 60,
  autoRenew: false,
});
```

### 2. Checking a Balance

**Before:** Simulate a contract call manually, parse the ScVal return value.

**After:**

```typescript
const claimable = await client.getClaimable(streamId);
```

### 3. Performing a Withdrawal

**Before:** Build, simulate, sign, submit, and poll a `withdraw` contract call.

**After:**

```typescript
const { txHash, amount } = await client.withdraw({ streamId });
```

### 4. Subscribing to Events

**Before:** Poll ledger entries or parse transaction meta manually.

**After:**

```typescript
const sub = client.subscribeEvents({ streamId: "42" }, (event) => {
  console.log(event.type, event.streamId);
});
```

### 5. Handling Errors

**Before:** Parse `rpc.Api.SimulateTransactionResponse` for error codes.

**After:** Catch typed errors:

```typescript
try {
  await client.createStream({ ... });
} catch (err) {
  if (err instanceof InvalidAddressError) {
    // Handle invalid address
  } else if (err instanceof InsufficientAllowanceError) {
    // Handle insufficient token allowance
  } else if (err instanceof TransactionFailedError) {
    // Handle network rejection
  }
}
```

All error classes are exported from `@sorostream/sdk`. See `src/ERRORS.md` for the full list.

---

## Wallet Connection Differences

| Pattern | @stellar/stellar-sdk | @sorostream/sdk |
|---------|---------------------|-----------------|
| Server-side signing | `Keypair.fromSecret(secret)` + manual signing | `createKeypairAdapter(secret)` |
| Browser wallet | `@stellar/freighter-api` directly | `createFreighterAdapter()` |
| Custom signer | Implement yourself | Implement `WalletAdapter` interface |
| Multisig | Manual signature collection | `createMultisigAdapter({ signers })` |

---

## Error Handling Changes

| Scenario | @stellar/stellar-sdk | @sorostream/sdk |
|----------|---------------------|-----------------|
| Invalid address | Transaction simulation fails | `InvalidAddressError` (pre-validation) |
| Insufficient balance | Simulation error | `InsufficientBalanceError` |
| Stream not found | Simulation returns error | `StreamNotFoundError` |
| Transaction rejected | `sendTransaction` returns ERROR | `TransactionFailedError` |
| Duplicate stream | No built-in check | `DuplicateStreamError` (opt-in via `checkDuplicate`) |

---

## What Has No Direct Equivalent

- **`server.getAccount()`** — The SDK calls this internally. Use `client.getStream()` / `client.getClaimable()` for on-chain data.
- **`server.prepareTransaction()`** — Internal. Use `client.estimateCreateStreamFee()` for fee estimates.
- **`TransactionBuilder`** — Internal. Configure streams via `CreateStreamParams`.
- **`nativeToScVal` / `scValToNative`** — Internal. The SDK handles all serialisation.
- **`Keypair`** — Use `createKeypairAdapter` or another `WalletAdapter`.
- **Custom contract calls** — The SDK only exposes SoroStream contract methods. For other Soroban operations, continue using `@stellar/stellar-sdk` alongside.
