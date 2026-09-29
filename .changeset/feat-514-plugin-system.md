---
"@sorostream/sdk": minor
---

feat(#514): plugin system with before/after middleware hooks

Extends the PluginRegistry with `runBefore` and `runAfter` execution hooks so
third-party middleware can intercept and transform stream operations.
