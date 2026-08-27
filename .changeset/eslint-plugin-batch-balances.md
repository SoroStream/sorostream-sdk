---
"@sorostream/eslint-plugin": patch
---

Add `getMultipleStreamBalances` to the `await-async-sdk-methods` default method list so calls to the new batched balance reader are flagged when used without `await` (issue #445).
