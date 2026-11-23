---
"@sorostream/sdk": patch
---

Make `bigIntScalarConfig.serialize` and `parseValue` reject a non-integer `number` (for example `1.5`, `NaN` or `Infinity`) with the module's own descriptive `TypeError` instead of an opaque `RangeError` from the native `BigInt()` constructor (issue #957), and add tests.
