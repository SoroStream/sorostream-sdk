---
"@sorostream/sdk": minor
---

Add tree-shakeable `/core` and `/batch` sub-path entry points plus `"sideEffects": false` (#206), publish external source maps for production builds (#207), add `encodeStreamId`/`decodeStreamId` base58 utilities for u64 stream IDs (#211), and add a framework-agnostic `IEventBus` interface with a default in-memory implementation for SDK lifecycle events (#212).
