# Migration Guide: v0.0.x / v0.1.0 → v1.0.0

This guide helps you upgrade from any `0.x` release of `@sorostream/sdk` to the `1.0.0` stable release.
v1.0.0 stabilises the public API, hardens security defaults, and introduces several new entry points. Follow
the checklist below and work through each breaking-change section that applies to your code.

> **Related:** If you are upgrading from v0.0.x to v0.1.0 first, see the [v0.0.x → v0.1.0 guide](../MIGRATION.md).

---

## Quick Upgrade Checklist

- [ ] Install v1.0.0: `npm install @sorostream/sdk@1.0.0`
- [ ] Update `batchWithdraw` call sites to read `result.failures` instead of catching errors (see [#229](#229-batchwithdraw-return-type-change))
- [ ] Add a `catch` (or optional-chain) for `InsecureRpcUrlError` if your RPC URL is `http://` (see [#463](#463-insecurerpccurlerror-thrown-for-non-tls-rpc-urls))
- [ ] Update sub-path imports to use the new entry points (see [#206](#206-new-sub-path-entry-points))
- [ ] Update `createStream` calls that pass historical `startTime` values (see [#411](#411-starttimeinpasterror))
- [ ] Review Nonce / idempotency key handling if you pass `nonce` in `CreateStreamParams` (see [#231](#231-nonce-field-and-noncenotsupportederror))
- [ ] Update any code that inspects raw `BatchWithdrawResult[]` — it is replaced by `BatchWithdrawPartialResult` (see [#229](#229-batchwithdraw-return-type-change))
- [ ] Re-run `npm test` and `npm run lint` to surface any remaining issues

---

## Breaking Changes

### #229: `batchWithdraw` Return Type Change

**Summary:** `batchWithdraw` no longer throws when individual withdrawals fail. It always resolves with a
`BatchWithdrawPartialResult` object containing two arrays — `successes` and `failures`.

**Before (v0.0.x / v0.1.0):**
```ts
try {
  const results = await client.batchWithdraw([
    { streamId: "1", amount: toStroops("10") },
    { streamId: "2", amount: toStroops("20") },
  ]);
  // results: BatchWithdrawResult[]
} catch (error) {
  // Thrown on the first failure — you cannot tell which streams succeeded
  console.error("Batch failed:", error);
}
```

**After (v1.0.0):**
```ts
import type { BatchWithdrawPartialResult } from "@sorostream/sdk";

const result: BatchWithdrawPartialResult = await client.batchWithdraw([
  { streamId: "1", amount: toStroops("10") },
  { streamId: "2", amount: toStroops("20") },
]);

if (result.successes.length > 0) {
  console.log("Succeeded:", result.successes.join(", "));
}

if (result.failures.length > 0) {
  for (const { id, error } of result.failures) {
    console.error(`Stream ${id} failed:`, error.message);
    // Retry only the failed IDs — safe to do without double-withdrawing successes
  }
}
```

**What changed:**
- Return type: `Promise<BatchWithdrawResult[]>` → `Promise<BatchWithdrawPartialResult>`
- No longer throws on partial failures
- `BatchWithdrawPartialResult` is now exported from `@sorostream/sdk`

---

### #463: `InsecureRpcUrlError` Thrown for Non-TLS RPC URLs

**Summary:** The SDK now rejects `http://` (non-TLS) RPC endpoint URLs at construction time and on `setNetwork`
/ `updateConfig` calls, throwing the new `InsecureRpcUrlError`.

> **Loopback exception:** `http://localhost`, `http://127.0.0.1`, and `http://[::1]` are still allowed for
> local Soroban Quickstart development.

**Before (v0.0.x / v0.1.0):**
```ts
// Silently accepted — data sent over unencrypted HTTP
const client = new SoroStreamClient({
  rpcUrl: "http://rpc.example.com",
  // ...
});
```

**After (v1.0.0):**
```ts
import { InsecureRpcUrlError } from "@sorostream/sdk";

try {
  const client = new SoroStreamClient({
    rpcUrl: "https://rpc.example.com", // ✅ Use HTTPS
    // ...
  });
} catch (err) {
  if (err instanceof InsecureRpcUrlError) {
    console.error("Switch your RPC URL to HTTPS:", err.message);
  }
}
```

**Migration:** Replace every `http://` RPC URL with `https://`. If you run a local node for testing, you may
continue using `http://localhost:8000`.

---

### #206: New Sub-Path Entry Points

**Summary:** Three new sub-path exports allow bundlers to tree-shake wallet adapter code out of
core-only builds.

| Import path | Contents |
|---|---|
| `@sorostream/sdk` | Full SDK (unchanged) |
| `@sorostream/sdk/core` | Client + utilities — **no** wallet adapters |
| `@sorostream/sdk/wallets` | All wallet adapters (Freighter, Ledger, etc.) |
| `@sorostream/sdk/wallet` | Alias for `/wallets` |
| `@sorostream/sdk/batch` | Bulk / batch types and helpers |

**Before (v0.0.x / v0.1.0):**
```ts
// Everything imported from the root — no tree-shaking of wallets possible
import { SoroStreamClient, createFreighterAdapter } from "@sorostream/sdk";
```

**After (v1.0.0):**
```ts
// Server-side code — import only the core, keeps bundle wallet-free
import { SoroStreamClient } from "@sorostream/sdk/core";

// Browser code — import wallets separately
import { createFreighterAdapter } from "@sorostream/sdk/wallets";

// Batch helpers
import type { BatchWithdrawPartialResult } from "@sorostream/sdk/batch";
```

**Why it matters:** The `@sorostream/sdk/core` entry point is verified (via CI) to exclude
`wallet.ts` and all Freighter / Ledger dependencies, so server-side Node.js bundles are
significantly smaller.

---

### #411: `StartTimeInPastError` on Historical `startTime`

**Summary:** `createStream` now throws `StartTimeInPastError` when `startTime` is earlier than the current
ledger timestamp, instead of silently submitting a transaction the contract will reject.

**Before (v0.0.x / v0.1.0):**
```ts
// Would submit to the network and the contract would reject it
await client.createStream({
  recipient: "G...",
  startTime: Date.now() - 60_000, // 1 minute in the past
  // ...
});
```

**After (v1.0.0):**
```ts
import { StartTimeInPastError } from "@sorostream/sdk";

try {
  await client.createStream({
    recipient: "G...",
    startTime: Date.now(),          // ✅ Use current or future timestamp
    // ...
  });
} catch (err) {
  if (err instanceof StartTimeInPastError) {
    // SDK caught this before hitting the network — check your timestamps
    console.error(err.message);
  }
}
```

---

### #231: `nonce` Field and `NonceNotSupportedError`

**Summary:** `CreateStreamParams` now accepts an optional `nonce` field for caller-supplied idempotency keys.
If the on-chain contract does not support nonces, the SDK emits `console.warn` by default. Pass
`strict: true` in `WriteOptions` to throw `NonceNotSupportedError` instead.

**Before:**
```ts
// No idempotency key support
await client.createStream({ recipient: "G...", /* ... */ });
```

**After (v1.0.0):**
```ts
import { NonceNotSupportedError } from "@sorostream/sdk";

// Check capability before sending
const supported = await client.supportsNonce();

await client.createStream(
  {
    recipient: "G...",
    nonce: crypto.randomUUID(), // Idempotency key
    // ...
  },
  { strict: supported } // Only throw if contract actually supports nonces
);
```

---

## New Features in v1.0.0

These additions are non-breaking but improve your integration:

### `getMultipleStreamBalances` (#445)
Fetch claimable balances for many streams in a single batched RPC call.

```ts
const balances = await client.getMultipleStreamBalances(["1", "2", "3"]);
// Returns Map<string, bigint>
```

### `writeRateLimit` — Client-Side Rate Limiting (#464)
Throttle write operations to prevent accidental RPC flooding:

```ts
const client = new SoroStreamClient({
  rpcUrl: "https://rpc.mainnet.stellar.org",
  writeRateLimit: { maxPerSecond: 5, burst: 10 },
  // ...
});
```

### `IEventBus` — Lifecycle Events (#212)
Subscribe to stream lifecycle events without polling:

```ts
const bus = new InMemoryEventBus();
bus.on("stream.created", (event) => console.log("Created:", event.streamId));
bus.on("stream.withdrawn", (event) => console.log("Withdrawn:", event.streamId));

const client = new SoroStreamClient({ eventBus: bus, /* ... */ });
```

### `encodeStreamId` / `decodeStreamId` (#211)
Round-trip-safe, URL-safe base58 encoding for `u64` stream IDs:

```ts
import { encodeStreamId, decodeStreamId } from "@sorostream/sdk";

const encoded = encodeStreamId(12345678901234567890n); // "3GfWqABCD..."
const decoded = decodeStreamId(encoded);               // 12345678901234567890n
```

### `MultiNetworkClient` (#515)
Fan read operations across multiple networks simultaneously:

```ts
import { MultiNetworkClient } from "@sorostream/sdk";

const multi = new MultiNetworkClient([mainnetClient, testnetClient]);
const stream = await multi.getStream("42"); // Queries all networks
```

### CDN / Browser Script Tag Usage (#651)
For projects that cannot use a bundler, load the SDK directly from a CDN:

```html
<!-- unpkg -->
<script src="https://unpkg.com/@sorostream/sdk/dist/sorostream.global.js"></script>

<!-- jsDelivr -->
<script src="https://cdn.jsdelivr.net/npm/@sorostream/sdk/dist/sorostream.global.js"></script>

<script>
  const { SoroStreamClient } = SoroStream;
  const client = new SoroStreamClient({ rpcUrl: "https://...", network: "mainnet" });
</script>
```

---

## Security Changes

See [SECURITY.md](../SECURITY.md) for a full guide. Key v1.0.0 hardening:

- All non-loopback `http://` RPC URLs now throw `InsecureRpcUrlError` (#463)
- A `Security` CI workflow runs `npm audit --audit-level=high` on every PR (#461)
- Use `writeRateLimit` to guard against replay / flooding (#464)
- Use `nonce` + `strict: true` for idempotent stream creation (#231)

---

## Getting Help

1. Read the full [CHANGELOG.md](../CHANGELOG.md) for detailed entry history
2. Consult the API reference via `npx typedoc` or the hosted docs site
3. Browse the `examples/` directory for working reference implementations
4. Open an issue at [github.com/SoroStream/sorostream-sdk/issues](https://github.com/SoroStream/sorostream-sdk/issues)

---

## Version Compatibility

| SDK version | Contract versions |
|---|---|
| v1.0.0 | 1.0.0 – 1.99.99 |
| v0.1.0 | 0.x |
| v0.0.x | 0.x |

v1.0.0 is **not** backward compatible with v0.0.x or v0.1.0 due to the breaking changes listed above.
