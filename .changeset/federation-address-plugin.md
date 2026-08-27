---
"@sorostream/sdk": minor
---

Add `createFederationPlugin` for automatic Stellar federation address resolution before stream creation (#401).

- `createFederationPlugin(options?)` returns a `SoroStreamPlugin` that resolves `user*domain.com` federation addresses in `createStream` params to raw G-addresses before the transaction is built.
- Maintains an in-memory cache (configurable TTL, default 5 minutes) to avoid redundant network round-trips within the same session.
- `throwOnResolutionFailure` (default `false`) controls whether a failed lookup throws `FederationResolutionError` or silently falls through to downstream SDK validation.
- `onResolved` callback lets callers log or instrument each resolution, including cache hits (`fromCache: true`).
