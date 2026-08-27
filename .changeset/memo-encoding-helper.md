---
"@sorostream/sdk": minor
---

Add `encodeMemo`, `encodeMemoHash`, and `decodeMemo` helpers for correctly encoding and decoding Soroban transaction memos (issue #217). `encodeMemo` validates text memos against the 28-byte limit and throws `SoroStreamMemoError` when exceeded; `encodeMemoHash` pads short inputs and truncates long inputs (with a warning) to the required 32 bytes; `decodeMemo` reads any memo type off a transaction record and returns `null` for no-memo transactions.
