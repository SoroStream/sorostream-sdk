# Migrating to v1.0

v1.0 introduced breaking changes to method signatures, error types, and the stream data model. This guide covers every change with before/after examples.

---

## 1. `amount` is now `bigint`, not `number`

All token amounts in the SDK are now `bigint` (stroops). The `toStroops()` helper converts human-readable USDC strings to the correct type.

```ts
// v0.x — number
await client.createStream({ ..., amount: 100_000_000 });

// v1.0 — bigint
import { toStroops } from "@sorostream/sdk";
await client.createStream({ ..., amount: toStroops("100") }); // 100 USDC → 1_000_000_000n
```

Any place you read `stream.deposit`, `stream.flowRate`, or the return value of `getClaimable()` you must treat the value as `bigint`:

```ts
// v0.x
const claimable: number = await client.getClaimable(streamId);
console.log(claimable / 10_000_000);

// v1.0
import { formatUSDC } from "@sorostream/sdk";
const claimable: bigint = await client.getClaimable(streamId);
console.log(formatUSDC(claimable)); // "100.0000000"
```

---

## 2. `createStream` return type changed

```ts
// v0.x — returned a plain string
const streamId: string = await client.createStream(params);

// v1.0 — returns an object
const { streamId, txHash } = await client.createStream(params);
```

---

## 3. `withdraw` return type changed

```ts
// v0.x — returned a plain tx hash string
const txHash: string = await client.withdraw({ streamId });

// v1.0 — returns an object
const { txHash, amount } = await client.withdraw({ streamId });
// `amount` is a string representation of the withdrawn stroops
```

---

## 4. `topUp` return type changed

```ts
// v0.x — returned a plain tx hash string
const txHash: string = await client.topUp({ streamId, amount: 50_000_000 });

// v1.0 — returns an object; amount must be bigint
const { txHash, newEndTime } = await client.topUp({
  streamId,
  amount: toStroops("50"),
});
// newEndTime is a Date object
```

---

## 5. Renamed `Stream` fields

| v0.x field        | v1.0 field           | Notes                           |
|-------------------|----------------------|---------------------------------|
| `flow_rate`       | `flowRate`           | camelCase                       |
| `start_time`      | `startTime`          | camelCase                       |
| `end_time`        | `endTime`            | camelCase; unit is **seconds**  |
| `last_withdraw`   | `lastWithdrawTime`   | camelCase                       |
| `auto_renew`      | `autoRenew`          | camelCase                       |

All timestamp fields (`startTime`, `endTime`, `lastWithdrawTime`, `pausedAt`) are Unix timestamps in **seconds**.

---

## 6. Renamed error classes

Update your `catch` blocks to use the new class names exported from `@sorostream/sdk`:

| v0.x class              | v1.0 class                  |
|-------------------------|-----------------------------|
| `StreamError`           | `SoroStreamError`           |
| `NotFoundError`         | `StreamNotFoundError`       |
| `InactiveStreamError`   | `StreamNotActiveError`      |
| `TxFailedError`         | `TransactionFailedError`    |
| `BadAddressError`       | `InvalidAddressError`       |
| `BalanceError`          | `InsufficientBalanceError`  |
| `AmountError`           | `InsufficientAmountError`   |

```ts
// v0.x
import { NotFoundError, TxFailedError } from "@sorostream/sdk";
try {
  await client.withdraw({ streamId });
} catch (e) {
  if (e instanceof NotFoundError) { ... }
  if (e instanceof TxFailedError) { ... }
}

// v1.0
import { StreamNotFoundError, TransactionFailedError } from "@sorostream/sdk";
try {
  await client.withdraw({ streamId });
} catch (e) {
  if (e instanceof StreamNotFoundError) { ... }
  if (e instanceof TransactionFailedError) { ... }
}
```

All error classes extend `SoroStreamError`, so catching the base class still works:

```ts
import { SoroStreamError } from "@sorostream/sdk";
try { ... } catch (e) {
  if (e instanceof SoroStreamError) { /* any SDK error */ }
}
```

---

## 7. `getStreamsBySender` / `getStreamsByRecipient` return type

Without a `pagination` argument the methods still return `Stream[]` (backward-compatible). Passing a `PaginationParams` object returns `PaginatedStreams`:

```ts
// v0.x / v1.0 without pagination — unchanged
const streams: Stream[] = await client.getStreamsBySender(sender);

// v1.0 with pagination — new overload
const page = await client.getStreamsBySender(sender, { limit: 20 });
// page is PaginatedStreams: { streams, cursor, hasMore }
```

---

## 8. Wallet adapter interface

The `WalletAdapter` interface now requires three methods. Any custom adapter must add `isConnected`:

```ts
// v0.x
const adapter = {
  getPublicKey: async () => "G...",
  signTransaction: async (xdr, network) => signedXdr,
};

// v1.0
const adapter: WalletAdapter = {
  getPublicKey: async () => "G...",
  signTransaction: async (xdr, network) => signedXdr,
  isConnected: async () => true,  // ← new required method
};
```

---

## Summary checklist

- [ ] Replace `number` amounts with `bigint` / `toStroops()`
- [ ] Destructure `{ streamId, txHash }` from `createStream`
- [ ] Destructure `{ txHash, amount }` from `withdraw`
- [ ] Destructure `{ txHash, newEndTime }` from `topUp`
- [ ] Update `stream.flow_rate` → `stream.flowRate` etc. (snake_case → camelCase)
- [ ] Update error class names in `catch` blocks
- [ ] Add `isConnected` to any custom `WalletAdapter` implementations
- [ ] Treat all timestamp fields as Unix seconds (not milliseconds)
