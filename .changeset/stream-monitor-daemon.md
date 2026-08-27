---
"@sorostream/sdk": minor
---

Add stream monitoring daemon with configurable alert thresholds and callbacks (issue #266). `client.createStreamMonitor(streamIds, config)` centralizes polling for many streams into a single background process instead of every consumer hand-rolling its own polling loop. Configure `pollIntervalMs`, `expiryWarningMs`, and `lowBalanceThreshold`, then subscribe to `streamExpiringSoon`, `streamExpired`, `streamLowBalance`, and `streamStatusChanged` events on the returned monitor. RPC errors for one stream are caught and reported via a `monitorError` event (or the `onError` config callback) without interrupting polling for the rest. Call `monitor.stop()` to clear all timers.
