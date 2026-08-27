---
"@sorostream/sdk": minor
---

Add an optional `onProgress` callback to the batch operations so callers can render incremental progress:

- `batchWithdraw(streamIds, batchSize?, onProgress?)` — fires after each chunk (transaction) completes, whether it succeeded or failed.
- `bulkCreateStreams(rows, { ..., onProgress })` — fires after each chunk, or after each individual row for mixed-token chunks.

Both callbacks receive `{ completed, total, processedIds }`, where `completed`/`total` count individual streams/rows and `processedIds` lists the stream IDs (withdraw) or recipient addresses (create) handled by the step that just finished. The new `BatchProgress` type is exported from `@sorostream/sdk`, `@sorostream/sdk/core`, and `@sorostream/sdk/batch`.
