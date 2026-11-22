---
"@sorostream/sdk": patch
---

Fix `ScValCache`, `cachedScVal` and `cachedBool` (issue #985) handing the same mutable `xdr.ScVal` instance to every caller despite documenting the values as immutable, so one caller mutating a returned value in place could silently corrupt it for every other call site sharing the global cache. The cache now stores each entry's serialized XDR and returns a fresh, independent `xdr.ScVal` on every call; `cachedBool` builds a new boolean each time instead of returning pre-warmed singletons. Adds a read-only `ScValCache.has(value, type)` for checking whether an entry is cached without touching its LRU position.
