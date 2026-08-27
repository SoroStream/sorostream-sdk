---
"@sorostream/sdk": minor
---

Add Soroban RPC v2 protocol compatibility layer (issue #272). The client now auto-detects whether the configured RPC endpoint speaks v1 or v2 on initialization and transparently routes requests through the matching adapter, so a network-wide upgrade to RPC v2 no longer breaks existing integrations. Configure `rpcVersion: "v1" | "v2" | "auto"` on `SoroStreamClientOptions` to override detection (defaults to `"auto"`). Subscribe to the `rpcVersionDetected` event via a custom `eventBus` to observe the detected version.
