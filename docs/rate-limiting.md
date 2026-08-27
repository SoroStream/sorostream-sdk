# RPC Rate Limiting

This document describes how the SoroStream SDK interacts with Horizon and Soroban RPC endpoints, the default polling intervals, and how to tune the SDK to stay within public rate limits.

## Default Polling Intervals

| Behaviour | Default | Source |
|---|---|---|
| `EventPoller` poll interval | **5 000 ms** | `src/events.ts` — `setInterval(..., 5000)` |
| Stream read cache TTL | **5 000 ms** | `src/SoroStreamClient.ts` — `STREAM_CACHE_TTL_MS` |
| `watchClaimable` on-chain reconcile | **5 000 ms** | `WatchClaimableOptions.reconcileMs` default |
| `watchClaimable` UI tick | **200 ms** | `WatchClaimableOptions.tickMs` default (interpolated, no RPC call) |
| Transaction confirmation poll | **120 000 ms** timeout | `SoroStreamClientOptions.txTimeoutMs` default |

## Methods That Make Network Calls

### One call per invocation

| Method | RPC operation |
|---|---|
| `createStream` | `simulateTransaction` → `sendTransaction` → `getTransaction` (poll) |
| `withdraw` | `simulateTransaction` → `sendTransaction` → `getTransaction` (poll) |
| `cancelStream` | `simulateTransaction` → `sendTransaction` → `getTransaction` (poll) |
| `topUp` | `simulateTransaction` → `sendTransaction` → `getTransaction` (poll) |
| `getStream` | `simulateTransaction` (read-only, cached for 5 s) |
| `getClaimable` | `simulateTransaction` (read-only, cached for 5 s) |
| `getStreamsBySender` | `simulateTransaction` (read-only, not cached) |
| `getStreamsByRecipient` | `simulateTransaction` (read-only, not cached) |
| `estimateCreateStreamFee` | `simulateTransaction` |
| `estimateWithdrawFee` | `simulateTransaction` |
| `estimateCancelStreamFee` | `simulateTransaction` |
| `estimateTopUpFee` | `simulateTransaction` |

### Continuous / background calls

| Feature | Call pattern |
|---|---|
| `subscribeEvents` | `getEvents` once every **5 s** per active `EventPoller` instance |
| `watchClaimable` | `simulateTransaction` once every `reconcileMs` (default 5 s); pure interpolation every `tickMs` (default 200 ms, no RPC) |
| `watchStreamDrift` | `simulateTransaction` once every `intervalMs` (default 30 000 ms) |

### Batch methods

| Method | Call pattern |
|---|---|
| `batchWithdraw(streamIds, batchSize?)` | One transaction per batch (default batch size: 8) |
| `bulkCreateStreams(rows, options)` | One transaction per batch (default batch size: 8) |

## Known Rate Limits for Public Stellar RPC Endpoints

| Endpoint | Limit (approximate) |
|---|---|
| `https://soroban-testnet.stellar.org` | ~100 requests / 10 s per IP |
| `https://soroban.stellar.org` (mainnet) | ~100 requests / 10 s per IP |
| `https://rpc-futurenet.stellar.org` | ~100 requests / 10 s per IP |
| Horizon (`https://horizon.stellar.org`) | 3 600 requests / hour per IP |

> These limits are imposed by the Stellar Development Foundation infrastructure and are not guaranteed. For production use, run a dedicated RPC node or use a commercial provider.

## Concurrent Call Limit

The SDK uses an internal `RateLimiter` that caps concurrent in-flight RPC calls to **10** (configurable via the `maxConcurrent` constructor parameter on `RateLimiter`). Calls that exceed the limit are queued and dispatched as slots free.

## Tuning Recommendations

### Reduce polling frequency

```typescript
const client = new SoroStreamClient({ ... });

// Slow down watchClaimable reconciliation to once per 30 s
const stop = watchClaimable(stream, reconcile, onTick, {
  reconcileMs: 30_000,
  tickMs: 1_000,
});
```

### Use a custom RPC URL

Point the client at a private RPC node or a commercial provider (e.g. Ankr, QuickNode) to avoid shared public limits:

```typescript
const client = new SoroStreamClient({
  network: "mainnet",
  contractId: "C...",
  walletAdapter: adapter,
  rpcUrl: "https://your-private-rpc.example.com",
});
```

### Leverage the read cache

`getStream` and `getClaimable` are cached for 5 s. Calling them in a tight loop within that window is free. If you need fresh data more often, reduce the `STREAM_CACHE_TTL_MS` constant or call `setNetwork` to flush the cache immediately.

### Deduplicate event subscriptions

Each call to `subscribeEvents` adds a subscriber to a shared `EventPoller`. A single `EventPoller` instance polls the RPC once every 5 s regardless of how many subscribers are attached — you do **not** pay N × 5 s calls for N subscribers on the same client instance.

### Connection pooling

The underlying `@stellar/stellar-sdk` `rpc.Server` instance is reused across all calls within a single `SoroStreamClient`. Avoid constructing multiple clients for the same network in the same process; instead share one client instance.

### Caching strategies for high-traffic applications

- **Redis/Memcached**: Cache `getStream` responses in a shared store and invalidate on known write transactions.
- **Edge caching**: For read-only UI dashboards, proxy `getStream` through a CDN or serverless edge function with a 5–10 s TTL.
- **Batch reads**: Prefer `getStreamsBySender` or `getStreamsByRecipient` over per-stream `getStream` calls when loading a list.
