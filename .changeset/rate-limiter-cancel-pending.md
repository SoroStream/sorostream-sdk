---
"@sorostream/sdk": minor
---

Add `RateLimiter.cancelPending(reason?)` (issue #947), which rejects every task still waiting in the queue instead of leaving its `run()` promise unsettled forever, and returns how many were rejected. Tasks already running are not interrupted and the limiter stays usable. Queued tasks reject with the new `RateLimiterCancelledError` (exported from `@sorostream/sdk`) unless a custom reason is given.
