# Custom Transport Adapters

The `RpcTransportAdapter` interface lets you control exactly how `SoroStreamClient` talks to Soroban RPC — route requests through a private node, add auth headers, log or cache calls, or swap in an in-memory fake for tests. Implement the interface and pass it as the `transport` client option.

---

## Interface Definition

```typescript
interface RpcTransportAdapter {
  init?(context: RpcTransportInitContext): Promise<void> | void;
  getAccount(address: string): Promise<Account>;
  getHealth(): Promise<rpc.Api.GetHealthResponse>;
  getLatestLedger(): Promise<rpc.Api.GetLatestLedgerResponse>;
  getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse>;
  simulateTransaction(tx: Transaction | FeeBumpTransaction): Promise<rpc.Api.SimulateTransactionResponse>;
  prepareTransaction(tx: Transaction | FeeBumpTransaction): Promise<Transaction | FeeBumpTransaction>;
  sendTransaction(tx: Transaction | FeeBumpTransaction): Promise<rpc.Api.SendTransactionResponse>;
  getEvents(request: RpcTransportGetEventsRequest): Promise<rpc.Api.GetEventsResponse>;
  teardown?(): Promise<void> | void;
}

interface RpcTransportInitContext {
  network: Network;
  rpcUrl: string;
}

interface RpcTransportGetEventsRequest {
  filters: rpc.Api.EventFilter[];
  startLedger?: number;
  endLedger?: number;
  cursor?: string;
  limit?: number;
}
```

`Account`, `Transaction`, `FeeBumpTransaction`, and `rpc.Api.*` are re-exported (or re-exportable) from `@stellar/stellar-sdk` — a real `rpc.Server` instance already structurally satisfies `RpcTransportAdapter`, which is exactly how the SDK's own default transport implements it (see [Reference Implementation](#reference-implementation-the-default-transport) below).

| Method | Required | Description |
|--------|----------|-------------|
| `init(context)` | No | Setup hook — see [Adapter Lifecycle](#adapter-lifecycle). |
| `getAccount(address)` | Yes | Fetches an account's current sequence number and balances. |
| `getHealth()` | Yes | Node health check. |
| `getLatestLedger()` | Yes | Fetches the latest ledger sequence/hash. |
| `getTransaction(hash)` | Yes | Polls for the status/result of a submitted transaction. |
| `simulateTransaction(tx)` | Yes | Simulates a contract invocation to get footprint, cost, and result. |
| `prepareTransaction(tx)` | Yes | Simulates and returns a transaction with footprint/auth/fees assembled. |
| `sendTransaction(tx)` | Yes | Submits a signed transaction. |
| `getEvents(request)` | Yes | Fetches contract events — backs `subscribeEvents`, `watchClaimable`, and `getActivityLog`. |
| `teardown()` | No | Cleanup hook — see [Adapter Lifecycle](#adapter-lifecycle). |

### `Network` type

```typescript
type Network = "mainnet" | "testnet" | "futurenet";
```

---

## Adapter Lifecycle

A transport goes through three phases while a `SoroStreamClient` is alive:

1. **Initialization** — `init(context)` is called once, synchronously after the `transport` you passed is assigned as the client's active transport, and again every time [`client.setNetwork()`](./README.md#soroStreamclient) switches networks. `context.network`/`context.rpcUrl` tell you which endpoint to point at. The SDK does not `await` this call before making requests (matching how the built-in contract-version check already fires-and-forgets on construction) — if your transport needs to finish connecting before it can serve requests, queue calls internally until `init` resolves.
2. **Request** — one of the eight request methods above is called for every RPC round-trip `SoroStreamClient` needs to make. Requests are **not** guaranteed to be sequential; reads (`getAccount`, `simulateTransaction`, `getEvents`, …) can run concurrently with each other and with in-flight writes.
3. **Teardown** — `teardown()` is called only when the consumer explicitly calls [`client.disconnect()`](./README.md#soroStreamclient). It is never called automatically (e.g. on process exit or GC) — if your transport holds a socket, timer, or connection pool, document that consumers must call `disconnect()` when they're done with the client.

```typescript
const client = new SoroStreamClient({
  network: "testnet",
  contractId: "C...",
  walletAdapter,
  transport: myTransport, // init() fires now
});

client.setNetwork("mainnet"); // init() fires again with the new context

await client.disconnect(); // teardown() fires
```

---

## Error Handling

- Request methods should **reject** (throw) on any failure to deliver the request or parse a response — connection refused, timeout, non-2xx status, malformed payload. Never resolve with a synthetic success value to paper over a failed call.
- Request methods should **not** reject when the RPC server itself reports an application-level error inside an otherwise-successful response — e.g. `simulateTransaction` returning a result where `rpc.Api.isSimulationError(result)` is `true` is a normal, successful resolution. The SDK's own error classes (see [`ERRORS.md`](./src/ERRORS.md)) are derived from inspecting these response payloads, not from your transport throwing.
- Thrown errors are passed through the SDK's `CircuitBreaker` (if configured) and `withRetry` wrapper unmodified. `withRetry` looks for an optional string `.body` or `.response.body` field on the thrown value to include in `SoroStreamRetryExhaustedError`'s log — prefer throwing a real `Error` (or the SDK's `SoroStreamTransportError`, which extends it) with a `cause` over throwing a plain string or object.
- `init` and `teardown` failures are **not** caught by the SDK — an unhandled rejection from `init` (called fire-and-forget) becomes an unhandled promise rejection in the host process; a rejection from `teardown` propagates out of `client.disconnect()`.

```typescript
import { SoroStreamTransportError } from "@sorostream/sdk";

async function getAccount(address: string) {
  try {
    return await myRpcClient.getAccount(address);
  } catch (cause) {
    throw new SoroStreamTransportError(`getAccount failed for ${address}`, cause);
  }
}
```

---

## Walkthrough: Implementing a Minimal Adapter

The simplest useful custom transport wraps the built-in default transport and adds behavior — here, structured logging with timing for every RPC call:

```typescript
import { createDefaultRpcTransport } from "@sorostream/sdk";
import type { RpcTransportAdapter, RpcTransportInitContext } from "@sorostream/sdk";

export function createLoggingRpcTransport(rpcUrl: string): RpcTransportAdapter {
  let base: RpcTransportAdapter | null = null;

  async function timed<T>(method: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      console.log(`[rpc] ${method} ok in ${Date.now() - start}ms`);
      return result;
    } catch (error) {
      console.error(`[rpc] ${method} failed in ${Date.now() - start}ms:`, error);
      throw error;
    }
  }

  return {
    init(context: RpcTransportInitContext) {
      base = createDefaultRpcTransport(context.rpcUrl);
      return base.init?.(context);
    },
    getAccount: (address) => timed("getAccount", () => base!.getAccount(address)),
    getHealth: () => timed("getHealth", () => base!.getHealth()),
    getLatestLedger: () => timed("getLatestLedger", () => base!.getLatestLedger()),
    getTransaction: (hash) => timed("getTransaction", () => base!.getTransaction(hash)),
    simulateTransaction: (tx) => timed("simulateTransaction", () => base!.simulateTransaction(tx)),
    prepareTransaction: (tx) => timed("prepareTransaction", () => base!.prepareTransaction(tx)),
    sendTransaction: (tx) => timed("sendTransaction", () => base!.sendTransaction(tx)),
    getEvents: (request) => timed("getEvents", () => base!.getEvents(request)),
    teardown: () => base?.teardown?.(),
  };
}
```

Usage:

```typescript
import { SoroStreamClient } from "@sorostream/sdk";

const client = new SoroStreamClient({
  network: "testnet",
  contractId: "C...",
  walletAdapter,
  transport: createLoggingRpcTransport("https://soroban-testnet.stellar.org"),
});
```

This same pattern — delegate to `createDefaultRpcTransport` and override only the methods you care about — is exactly how you'd add request retries at the transport layer, route reads and writes to different endpoints, or inject custom headers for a private RPC node with bearer-token auth.

---

## Reference Implementation: The Default Transport

`createDefaultRpcTransport` (at `src/transport.ts:111`) is the transport `SoroStreamClient` uses whenever no `transport` option is provided, and the canonical example of an adapter built directly on `@stellar/stellar-sdk`'s `rpc.Server`:

```typescript
export function createDefaultRpcTransport(
  rpcUrl: string,
  opts?: rpc.Server.Options
): RpcTransportAdapter {
  const server = new rpc.Server(rpcUrl, { allowHttp: false, ...opts });
  return {
    getAccount: (address) => server.getAccount(address),
    getHealth: () => server.getHealth(),
    getLatestLedger: () => server.getLatestLedger(),
    getTransaction: (hash) => server.getTransaction(hash),
    simulateTransaction: (tx) => server.simulateTransaction(tx),
    prepareTransaction: (tx) => server.prepareTransaction(tx),
    sendTransaction: (tx) => server.sendTransaction(tx),
    getEvents: (request) => server.getEvents(request),
  };
}
```

Key patterns to follow:
- **No `init`/`teardown` needed** if your transport is stateless per-call (like `rpc.Server`, which is just an HTTP client wrapper with nothing to open or close).
- **Delegate, don't reimplement** — every method is a one-line pass-through to the underlying `rpc.Server` call of the same name.
- **`opts` merge with a safe default** (`allowHttp: false`) so callers can add headers/timeout without accidentally weakening the default security posture.

---

## What a Custom Transport Does — and Doesn't — Cover

Setting `transport` on `SoroStreamClient` replaces the RPC calls the client itself makes directly (`createStream`, `withdraw`, `getStream`, `getClaimable`, `subscribeEvents`, `watchClaimable`, `getActivityLog`, `exportStreamHistory`, …) and the polling done by `subscribeEvents`'s underlying `EventPoller`.

It does **not** cover the opt-in high-throughput connection pool (`poolSize` client option, see [`ConnectionPool`](./README.md#client-options)) — the pool manages its own pooled `rpc.Server` connections independently for now. If you need a custom transport *and* `poolSize`, the pool's connections will bypass your transport; avoid combining them until pool-level transport injection lands.

---

## Wiring a Custom Transport into `SoroStreamClient`

```typescript
import { SoroStreamClient } from "@sorostream/sdk";

const client = new SoroStreamClient({
  network: "testnet",
  contractId: "C...",
  walletAdapter,
  transport: myCustomTransport,
});

// ... use the client normally — createStream, getStream, subscribeEvents, etc.
// all now route through myCustomTransport.

await client.disconnect(); // calls myCustomTransport.teardown(), if defined
```

`setNetwork()` keeps using the same transport instance across a network switch (re-invoking `init` with the new `network`/`rpcUrl`) rather than discarding and recreating it, so a custom transport can hold long-lived state (a persistent connection, an auth token) across network changes if it chooses to.

---

## Exporting Your Adapter

If you publish a custom transport as an npm package, export the factory function and the `RpcTransportAdapter` type:

```typescript
// my-rpc-transport/index.ts
import type { RpcTransportAdapter } from "@sorostream/sdk";
export function createMyRpcTransport(options: { /* ... */ }): RpcTransportAdapter {
  // ...
}
export type { RpcTransportAdapter };
```

Consumers import both and pass the adapter directly:

```typescript
import { SoroStreamClient } from "@sorostream/sdk";
import { createMyRpcTransport } from "my-rpc-transport";

const client = new SoroStreamClient({
  network: "testnet",
  contractId: "C...",
  walletAdapter,
  transport: createMyRpcTransport({ /* ... */ }),
});
```

---

## Related Documentation

- [`WalletAdapter` / Custom Wallet Adapters](./CUSTOM_WALLET_ADAPTERS.md) — the equivalent extension point for signing, as opposed to transport.
- [`ERRORS.md`](./src/ERRORS.md) — the SDK's own error classes, their cause, and recovery guidance.
- [Rate Limiting](./docs/rate-limiting.md) — default polling intervals and RPC call patterns a custom transport will observe.
