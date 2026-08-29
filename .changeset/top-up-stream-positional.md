---
"@sorostream/sdk": minor
---

Expose `client.topUpStream(streamId, amount)` as a positional convenience wrapper
around the existing `topUp(params)` call. It invokes the contract's `top_up`
entry point so a sender can top up an active stream and extend its `endTime`
proportionally without cancelling and recreating it, and returns
`{ txHash, newEndTime }`. The `MockSoroStreamClient` exposes the same method for
parity in tests.