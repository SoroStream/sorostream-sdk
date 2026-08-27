---
"@sorostream/sdk": minor
---

Add `getMultipleStreamBalances(streamIds)` (issue #445) for fetching current accrued claimable balances for many streams in a single batched RPC call — one `get_claimable` operation per stream ID packed into a single `simulateTransaction`, so dashboards can render live balances without issuing per-stream requests. Results share the existing claimable TTL cache and in-flight request pool with `getClaimable`, duplicate IDs are de-duplicated while preserving first-seen order, and missing streams resolve to `0n`. If the RPC server rejects the batched simulation (e.g. it only accepts a single `invokeHostFunction` operation per transaction) or returns an unexpected response shape, the method gracefully falls back to per-stream `getClaimable` calls. Also implemented on `MockSoroStreamClient` and both `SoroStreamSandbox` variants, with the new `StreamBalance` type exported from `@sorostream/sdk` and `@sorostream/sdk/core`.
