import { nativeToScVal, xdr } from '@stellar/stellar-sdk';

/**
 * LRU cache for nativeToScVal results to avoid repeated buffer allocations
 * on hot paths (issue #616).
 *
 * ScVal objects produced by nativeToScVal are immutable XDR structures.
 * Caching them eliminates redundant serialization and reduces GC pressure.
 *
 * ## Eviction Policy
 *
 * `ScValCache` uses a **Least Recently Used (LRU)** eviction strategy backed
 * by insertion-order iteration of a native `Map`.
 *
 * - Every cache **hit** moves the accessed entry to the tail of the map
 *   (delete-then-re-insert), making it the most recently used.
 * - Every cache **miss** appends the new entry to the tail.
 * - When the map reaches `maxSize`, the entry at the **head** (least recently
 *   used) is evicted before the new entry is inserted.
 *
 * This gives O(1) average-case complexity for both reads and writes because
 * `Map` iteration, deletion, and insertion are all O(1) amortised in V8 / JSC.
 *
 * ## Choosing `maxSize`
 *
 * The default of `256` is a reasonable middle ground for most applications:
 *
 * | Workload | Recommended `maxSize` |
 * |---|---|
 * | Single-stream scripts / CLI tools | 32–64 — tiny footprint, full hit-rate for the small key space |
 * | Typical dApps (tens of streams, ≤ 10 addresses) | 128–256 (default) |
 * | Multi-tenant services (thousands of distinct addresses/stream IDs) | 512–2048 — larger working set keeps eviction pressure low |
 * | Memory-constrained environments (React Native, edge workers) | 32–128 — trade hit-rate for RSS |
 *
 * Each cached entry stores a `string` key (`"<type>:<value>"`) and an
 * `xdr.ScVal` object.  A typical `address` entry occupies roughly 200–400 B
 * of heap; 256 entries therefore adds ≈ 50–100 KB of live memory — negligible
 * for Node or browser but worth tuning on constrained targets.
 *
 * ## Caveats for Applications with Many Distinct Addresses or Values
 *
 * - If your application streams payments to a large number of unique recipient
 *   addresses (e.g. payroll to thousands of employees), the working set may
 *   exceed `DEFAULT_MAX_SIZE`.  Evicted entries will be re-computed on the next
 *   access, adding minor serialization overhead but no correctness issues.
 *   Increase `maxSize` proportionally to the expected number of *hot* keys in
 *   a single request burst.
 *
 * - The `xdrBase64Cache` used by {@link cachedScValBase64} is an **unbounded**
 *   `Map` intentionally — it caches static string values (event topic filters)
 *   that are set up once at startup and never change.  If you dynamically
 *   generate a large number of unique symbol/string values at runtime, prefer
 *   calling `nativeToScVal` directly rather than routing through
 *   `cachedScValBase64`.
 *
 * - The singleton {@link _scValCache | `_scValCache`} is shared across the
 *   entire SDK process.  When running multiple `SoroStreamClient` instances
 *   with different contract IDs, they share the same cache — this is usually
 *   beneficial (reduced allocation), but it means the effective per-instance
 *   budget is `maxSize / N` under adversarial key diversity.  Supply a
 *   per-instance `ScValCache` via internal configuration if isolation is
 *   required.
 *
 * @example Creating a larger cache for a high-throughput service:
 * ```ts
 * import { ScValCache } from 'sorostream-sdk/scValCache';
 * const cache = new ScValCache(1024); // 1 024-entry LRU
 * ```
 */

const DEFAULT_MAX_SIZE = 256;

type ScValType = 'address' | 'u64' | 'i128' | 'u32' | 'symbol' | 'string' | 'bool';

export class ScValCache {
  private readonly cache = new Map<string, xdr.ScVal>();
  private readonly maxSize: number;

  constructor(maxSize = DEFAULT_MAX_SIZE) {
    this.maxSize = maxSize;
  }

  get(value: unknown, type: ScValType): xdr.ScVal {
    const key = `${type}:${String(value)}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      // Move to end for LRU
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }

    const scVal = nativeToScVal(value, { type });
    if (this.cache.size >= this.maxSize) {
      // Evict oldest entry
      const first = this.cache.keys().next().value;
      if (first !== undefined) this.cache.delete(first);
    }
    this.cache.set(key, scVal);
    return scVal;
  }

  clear(): void {
    this.cache.clear();
  }

  /**
   * Invalidate cache entries scoped to a single value (issue #679).
   *
   * When `type` is supplied only the `"<type>:<value>"` entry is removed
   * (e.g. `invalidate(addr, 'address')` after an account state change such
   * as a sequence-number bump or trustline change). When `type` is omitted,
   * every entry for the value across all types is removed.
   *
   * Unrelated entries are left intact. Returns the number of entries removed.
   */
  invalidate(value: unknown, type?: ScValType): number {
    if (type !== undefined) {
      return this.cache.delete(`${type}:${String(value)}`) ? 1 : 0;
    }
    const suffix = `:${String(value)}`;
    let removed = 0;
    for (const key of [...this.cache.keys()]) {
      if (key.endsWith(suffix)) {
        this.cache.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Invalidate the cached `address` ScVal for a single address.
   * Convenience wrapper around {@link invalidate} for account state changes.
   * Returns the number of entries removed (0 or 1).
   */
  invalidateAddress(address: string): number {
    return this.invalidate(address, 'address');
  }

  get size(): number {
    return this.cache.size;
  }
}

// Singleton shared across the SDK for hot-path caching.
const globalCache = new ScValCache();

/**
 * Cached version of nativeToScVal. Returns the same xdr.ScVal instance
 * for repeated calls with identical value+type, avoiding a fresh buffer
 * allocation each time.
 */
export function cachedScVal(value: unknown, type: ScValType): xdr.ScVal {
  return globalCache.get(value, type);
}

// Pre-warm boolean singletons — these never change.
const TRUE_VAL = nativeToScVal(true, { type: 'bool' });
const FALSE_VAL = nativeToScVal(false, { type: 'bool' });

export function cachedBool(value: boolean): xdr.ScVal {
  return value ? TRUE_VAL : FALSE_VAL;
}

/**
 * Cache for base64-encoded XDR strings (used by indexer event topic filters).
 * Avoids re-serializing + re-encoding the same symbol on every poll cycle.
 */
const xdrBase64Cache = new Map<string, string>();

export function cachedScValBase64(value: unknown, type: ScValType): string {
  const key = `${type}:${String(value)}`;
  const cached = xdrBase64Cache.get(key);
  if (cached !== undefined) return cached;

  const encoded = nativeToScVal(value, { type }).toXDR('base64');
  xdrBase64Cache.set(key, encoded);
  return encoded;
}

export { globalCache as _scValCache };
