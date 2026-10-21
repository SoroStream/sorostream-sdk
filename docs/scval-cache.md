# ScValCache — Eviction Policy & Sizing Guide

> Addresses issue [#740](https://github.com/SoroStream/sorostream-sdk/issues/740).

## Overview

`ScValCache` (in `src/scValCache.ts`) reduces allocation pressure on hot paths
by caching the `xdr.ScVal` objects produced by `nativeToScVal`.  Because these
objects are immutable XDR structures, the same instance can be safely reused
across multiple calls.

---

## Eviction Policy — LRU via insertion-ordered `Map`

The cache implements a **Least Recently Used (LRU)** eviction policy using the
deterministic insertion order of JavaScript's native `Map`:

| Operation | Behaviour |
|---|---|
| **Hit** | Entry is moved to the tail (delete → re-insert) → most recently used |
| **Miss** | New entry appended to the tail |
| **Eviction** | When `size >= maxSize`, the head entry (least recently used) is removed before inserting the new entry |

This gives **O(1)** amortised complexity for reads, writes, and eviction —
`Map` iteration, deletion, and insertion are all O(1) in V8 and JavaScriptCore.

The default capacity is `DEFAULT_MAX_SIZE = 256`.

---

## Choosing `maxSize`

Each cached entry consists of a string key (`"<type>:<value>"`, e.g.
`"address:GABC..."`) and an `xdr.ScVal` object.  A typical `address` entry
occupies roughly **200–400 B** of heap.  At the default size of 256 entries
that is about **50–100 KB** of live memory — negligible for Node.js or browser
environments but worth tuning for constrained targets.

| Workload | Recommended `maxSize` |
|---|---|
| Single-stream CLI scripts | 32–64 — tiny footprint, full hit-rate for the small key space |
| Typical dApps (tens of streams, ≤ 10 addresses) | **128–256** (default) |
| Multi-tenant services (thousands of distinct addresses) | 512–2 048 — reduce eviction pressure |
| Memory-constrained (React Native, Cloudflare Workers) | 32–128 — trade hit-rate for lower RSS |

To supply a custom size, create a `ScValCache` instance directly and wire it
into your internal configuration (the default exported singleton
`_scValCache` can be replaced in test setups):

```ts
import { ScValCache } from 'sorostream-sdk/scValCache';

// Larger cache for a high-throughput backend
const cache = new ScValCache(1024);
```

---

## Caveats for Applications with Many Distinct Addresses or Values

### Large recipient sets (e.g. payroll to thousands of employees)

If the number of unique recipient addresses flowing through the SDK in a short
window exceeds `maxSize`, evicted entries will be re-computed on the next
access.  This incurs minor serialization overhead but no correctness issues.
**Increase `maxSize` proportionally to the number of hot keys per request
burst** rather than to the total address count.

### `xdrBase64Cache` is unbounded

`cachedScValBase64` (used internally for event-topic filters) stores results in
a plain, unbounded `Map`.  It is designed for a small set of static symbols set
up at SDK initialisation time.  If you call `cachedScValBase64` with a large
number of dynamically generated string values at runtime, switch to calling
`nativeToScVal(...).toXDR('base64')` directly to avoid unbounded memory growth.

### Shared singleton across multiple client instances

The module-level `_scValCache` singleton is shared across all `SoroStreamClient`
instances in the same process.  When running multiple clients with different
contract IDs and large distinct address spaces, the effective per-client budget
is `maxSize / N`.  If isolation is required, the internal cache reference can be
replaced with a dedicated `ScValCache` instance in test or multi-tenant setups.

---

## Quick-reference: Memory Estimates

| `maxSize` | Approx. RSS overhead |
|---|---|
| 64 | ~13–25 KB |
| 256 (default) | ~50–100 KB |
| 512 | ~100–200 KB |
| 2 048 | ~400–800 KB |

*Estimates assume ~250 B average entry size; actual values depend on value
length and V8 object overhead.*
