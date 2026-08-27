---
"@sorostream/sdk": minor
---

Add four SDK features:

- `client.resolveFederationAddress(name)` resolves Stellar federation addresses (e.g. `alice*example.com`) to G-addresses, with a 5-minute in-memory cache and `null` (never throw) on failure (#216).
- Automatic wallet network-switch handling: the client now detects wallet-initiated network changes (e.g. switching networks in Freighter), re-points itself at the new network, and emits a `networkChanged` event via the new `onNetworkChanged` subscription and `onNetworkChange` config callback (#215).
- Optional `@sorostream/sdk/graphql` sub-path export with `StreamTypeDefs`, a `BigInt` scalar config, and resolver helpers for building GraphQL APIs over stream data — `graphql` remains a devDependency only, never a hard dependency (#214).
- `checkPeerDependencies()` now runs once per client construction to validate the installed `@stellar/stellar-sdk` version against this SDK's required range, throwing `SoroStreamDependencyError` on an incompatible major version and warning on a newer compatible minor version. Opt out with `{ skipPeerCheck: true }` (#213).
