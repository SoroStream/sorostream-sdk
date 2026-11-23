---
"@sorostream/sdk": patch
---

Fix `createFederationPlugin`'s `resolveFresh` joining a concurrent plain `resolve()` lookup that was already in flight for the same address (issue #956), which returned a possibly cached result and defeated its "bypass the cache" contract. Fresh lookups are now tracked separately: concurrent `resolveFresh` calls still share one request, and a plain `resolve()` may still join an in-flight fresh one.
