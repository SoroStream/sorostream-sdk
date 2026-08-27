---
"@sorostream/sdk": minor
---

Add opt-in rate-limit-aware request queue with priority lanes (issue #265). Bursty batch operations that submit many writes and reads concurrently can trigger 429s from Soroban RPC with no backpressure today. Configure `requestQueue: { maxConcurrent, priorityLanes }` on `SoroStreamClientOptions` to cap in-flight requests and drain write operations ahead of reads when the queue is saturated. `client.getQueueStats()` returns live per-lane queue depth and in-flight counts, and a `rateLimitDelayed` event (via the client's `eventBus`) fires with an estimated wait time whenever a request is held in queue. Disabled by default — existing clients are unaffected until they opt in.
