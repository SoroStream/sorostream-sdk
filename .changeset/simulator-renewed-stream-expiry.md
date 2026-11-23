---
"@sorostream/sdk": patch
---

Fix `StreamSimulator.advance` tracking fired expiries by stream ID alone (issue #948), which permanently suppressed the `onExpire` callback of a renewed stream (same ID, extended `endTime`). Expiry is now tracked per stream ID and `endTime`, so the callback fires once for each distinct `endTime` that is crossed.
