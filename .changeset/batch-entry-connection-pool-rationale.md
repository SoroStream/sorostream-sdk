---
"@sorostream/sdk": patch
---

Document why `@sorostream/sdk/batch` re-exports `ConnectionPool` (issue #984): no bulk operation uses it, it is kept for backward compatibility with existing imports, and new code should import it from `@sorostream/sdk/core` or the package root. No runtime change.
