---
"@sorostream/sdk": minor
---

Add NDJSON streaming export format to `client.exportStreamHistory` (#402).

- Pass `{ format: 'ndjson', writable }` to stream history records line-by-line to any Node.js-style writable (`{ write(chunk) }`) or Web Streams `WritableStream` without buffering the full dataset in memory.
- Supports incremental processing of large stream histories for ETL pipelines and data exports.
- `BigInt` amounts are serialized as strings in each NDJSON line.
- Default format remains `'json'` (returns an array), preserving backwards compatibility.
