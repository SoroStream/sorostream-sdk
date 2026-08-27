---
"@sorostream/sdk": patch
---

fix(#408): getStreamsByRecipient now accepts an optional `filter` parameter

Passing `{ activeOnly: true }` (or any `StreamFilterCriteria`) to
`getStreamsByRecipient` now correctly excludes completed and cancelled
streams. Previously, calling `getStreamsByRecipient` with a status/activeOnly
filter had no effect because the filter was not applied — completed streams
from the same ledger as the query were silently included.

The fix applies `filterStreams` client-side after the RPC fetch.
Filtered calls bypass the read cache so the unfiltered cache entry
is not poisoned. The signature change is fully backward-compatible:
callers that omit the third argument receive the same unfiltered
`Stream[]` as before.
