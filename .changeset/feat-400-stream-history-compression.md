---
"@sorostream/sdk": minor
---

feat(#400): add gzip and deflate compression support to exportStreamHistory

Large NDJSON stream history payloads can now be compressed on the fly by
passing `compression: 'gzip'` or `compression: 'deflate'` in
`ExportStreamHistoryOptions`. The compressor is wired into the writable
pipeline using Node.js `zlib` and falls back gracefully to no compression
in browser environments where `zlib` is unavailable.
