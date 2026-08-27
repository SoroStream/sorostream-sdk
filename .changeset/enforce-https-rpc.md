---
"@sorostream/sdk": patch
---

Reject non-TLS (`http://`) RPC endpoint URLs at `SoroStreamClient` construction, `setNetwork`, and `updateConfig` time, throwing a clear `InsecureRpcUrlError` instead of silently routing transaction data over an unencrypted connection (issue #463). Loopback hosts (`localhost`, `127.0.0.1`, `::1`) remain allowed for local Soroban quickstart development.
