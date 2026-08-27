---
"@sorostream/sdk": minor
"@sorostream/sdk-react-native": minor
---

Add injectable `StorageAdapter`, `WebSocketFactory`, and `FetchAdapter` overrides (`SoroStreamClientOptions.adapters`) and a `createClient({ adapters })` factory so the SDK can run in environments without `localStorage`, `WebSocket`, or `fetch` as globals (issue #199). The audit log, `watchClaimable`'s WebSocket subscription, federation resolution, price feeds, and webhook forwarding all accept overrides; existing browser usage is unaffected since every override defaults to the corresponding global. Adds the `@sorostream/sdk-react-native` companion package with an AsyncStorage-backed `StorageAdapter` implementation.
