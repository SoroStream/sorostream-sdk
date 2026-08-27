---
"@sorostream/sdk": minor
---

Add a pluggable `RpcTransportAdapter` extension point for routing every Soroban RPC call `SoroStreamClient` makes (`getAccount`, `getHealth`, `getLatestLedger`, `getTransaction`, `simulateTransaction`, `prepareTransaction`, `sendTransaction`, `getEvents`) through a custom transport — a private RPC node, a request-signing proxy, or an in-memory fake for tests — instead of the built-in `rpc.Server`-backed default.

- New `transport?: RpcTransportAdapter` client option, alongside `createDefaultRpcTransport(rpcUrl, opts?)` (the built-in implementation, exported so custom transports can compose with it) and the `RpcTransportAdapter` / `RpcTransportInitContext` / `RpcTransportGetEventsRequest` types.
- New `client.disconnect()` method, calling the active transport's optional `teardown()` hook.
- New optional `SoroStreamTransportError` for adapter authors to wrap lower-level transport failures consistently.
- `EventPoller` and `StreamIndexer` (backing `subscribeEvents`, `watchClaimable`, and `getActivityLog`/`exportStreamHistory`) now route through the same custom transport when one is configured.
- Added `CUSTOM_TRANSPORT.md`, documenting the interface, adapter lifecycle (initialization/request/teardown), the error handling contract, and a minimal working adapter example.

Does not yet cover the opt-in high-throughput connection pool (`poolSize`), which still manages its own pooled RPC connections independently — documented as a known scope boundary in CUSTOM_TRANSPORT.md.
