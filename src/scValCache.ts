import { nativeToScVal, xdr } from '@stellar/stellar-sdk';

/**
 * LRU cache for nativeToScVal results to avoid repeated buffer allocations
 * on hot paths (issue #616).
 *
 * `xdr.ScVal` instances from `@stellar/stellar-sdk` are ordinary **mutable**
 * JS objects (a union exposes `set(...)`, and values such as an address's
 * 32-byte key are live `Buffer`s), so handing the same instance to every caller
 * would let one caller's in-place change silently corrupt the value seen by
 * every unrelated call site sharing the cache.
 *
 * The cache therefore stores each entry's **serialized XDR** (an immutable
 * base64 string) and returns a **fresh, independent `xdr.ScVal`** on every call.
 * What it saves is the expensive part of `nativeToScVal` (for an `address`:
 * StrKey decoding and checksum validation), not the allocation of the result
 * object. Callers may freely mutate what they get back.
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
  /** Key → base64 XDR. Strings are immutable, so no caller can alter an entry. */
  private readonly cache = new Map<string, string>();
  private readonly maxSize: number;

  constructor(maxSize = DEFAULT_MAX_SIZE) {
    this.maxSize = maxSize;
  }

  /**
   * Returns the `xdr.ScVal` for `value` as `type`. Repeated calls return equal
   * but **independent** instances: mutating one never affects the cache or any
   * other caller (issue #985).
   */
  get(value: unknown, type: ScValType): xdr.ScVal {
    const key = `${type}:${String(value)}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      // Move to end for LRU
      this.cache.delete(key);
      this.cache.set(key, cached);
      return xdr.ScVal.fromXDR(cached, 'base64');
    }

    const scVal = nativeToScVal(value, { type });
    if (this.cache.size >= this.maxSize) {
      // Evict least recently used entry (head of the map)
      const first = this.cache.keys().next().value;
      if (first !== undefined) this.cache.delete(first);
    }
    // Cache the serialized form, never the instance handed to the caller.
    this.cache.set(key, scVal.toXDR('base64'));
    return scVal;
  }

  /**
   * Returns whether an entry is currently cached. Read-only: it does not
   * refresh the entry's LRU position or create it.
   */
  has(value: unknown, type: ScValType): boolean {
    return this.cache.has(`${type}:${String(value)}`);
  }

  /**
   * Removes a single entry from the cache.  Returns `true` if the entry
   * existed and was deleted, `false` if it was not cached.
   *
   * Use this after an account's state changes (e.g. a sequence-number bump or
   * trustline change) to invalidate only the affected address without
   * discarding the rest of the hot LRU contents.
   *
   * @example
   * ```ts
   * // Invalidate just the encoded ScVal for a single address.
   * cache.delete(changedAddress, 'address');
   * ```
   */
  delete(value: unknown, type: ScValType): boolean {
    const key = `${type}:${String(value)}`;
    return this.cache.delete(key);
  }

  /**
   * Convenience helper that removes **all** cache entries whose key starts
   * with `address:<addr>`.  Because the key format is `"address:<value>"` and
   * address values are unique StrKeys, this is equivalent to calling
   * `delete(addr, 'address')` but is more discoverable when the caller only
   * knows the account address rather than the full `(value, type)` pair.
   *
   * Returns `true` if at least one entry was deleted.
   *
   * @example
   * ```ts
   * // After account state change:
   * cache.deleteByAddress('GDDZFLD7...');
   * ```
   */
  deleteByAddress(address: string): boolean {
    return this.delete(address, 'address');
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

// Singleton shared across the SDK for hot-path caching.
const globalCache = new ScValCache();

/**
 * Cached version of nativeToScVal. Repeated calls with identical value+type
 * reuse the cached serialized form instead of redoing the conversion, and each
 * call returns its own independent `xdr.ScVal` that the caller may mutate.
 */
export function cachedScVal(value: unknown, type: ScValType): xdr.ScVal {
  return globalCache.get(value, type);
}

/**
 * Returns an `xdr.ScVal` boolean. A new instance is built on every call: there
 * is nothing to convert, and sharing one mutable singleton across the whole SDK
 * would let a single in-place change corrupt every other caller (issue #985).
 */
export function cachedBool(value: boolean): xdr.ScVal {
  return xdr.ScVal.scvBool(value);
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
