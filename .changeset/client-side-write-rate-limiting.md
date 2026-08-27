---
"@sorostream/sdk": minor
---

Add opt-in client-side rate limiting for write operations (issue #464). Configure `writeRateLimit: { maxPerSecond, burst?, shared? }` on `SoroStreamClientOptions` to throttle how many write calls (`createStream`, `withdraw`, `cancelStream`, `createStreams`, etc.) can be submitted per second from a single `SoroStreamClient` instance, guarding against accidental RPC flooding from runaway loops or retry storms. Excess calls are queued and delayed rather than rejected. Disabled by default — existing clients are unaffected until they opt in.
