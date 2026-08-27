---
"@sorostream/sdk": minor
---

feat: stream query methods now accept combined filters (status, asset code, date range)

`getStreamsBySender`, `getStreamsByRecipient`, and `getStreamsByNamespace` accept
an optional `StreamFilterCriteria` that ANDs together status, token (asset),
`startTime`/`endTime` date-range bounds, and the existing `activeOnly` flag —
so dashboards can narrow results without fetching every stream and filtering
client-side.

`getStreamsBySender` and `getStreamsByNamespace` gain the same `filter` parameter
that `getStreamsByRecipient` already had. `StreamFilterCriteria` adds four
optional inclusive bounds (Unix seconds): `startTimeFrom`, `startTimeTo`,
`endTimeFrom`, `endTimeTo`. Filtered calls bypass the read cache so narrowed
results never poison the unfiltered cache entry. All signature changes are
backward-compatible: callers that omit the filter receive the same result as
before.
