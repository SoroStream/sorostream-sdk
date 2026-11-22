---
"@sorostream/sdk": patch
---

Fix `serializeStream`/`deserializeStream` (issue #987), and `deserializeStreamFromJSON`, silently dropping a stream's optional `tag` and `namespace` fields, which also lost them in `LocalStorageStreamCache` round-trips. `SerializedStream` gains optional `tag` and `namespace` fields; both are omitted from the serialized form when a stream has none.
