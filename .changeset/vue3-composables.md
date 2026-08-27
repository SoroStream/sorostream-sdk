---
'@sorostream/vue': minor
---

**#422** Add the `@sorostream/vue` package with `useStream`, `useStreamList`, and `useWithdraw` Vue 3 composables. All three accept plain values, `ref`s, or getters for the client and their inputs, expose fully typed reactive `{ loading, error }` state, re-run when their inputs change, and clean up on scope disposal. `useStream` binds to a single stream and keeps it live through the SDK's `observeStream()` observable (#423); `useStreamList` accepts `{ ids }`, `{ sender }`, or `{ recipient }` and uses the batch reader (#427) so a table of streams costs one RPC call, with optional polling; `useWithdraw` tracks submission state and returns the transaction hash and amount.
