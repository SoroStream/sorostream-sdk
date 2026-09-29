import { nativeToScVal, xdr } from '@stellar/stellar-sdk';

/**
 * LRU cache for nativeToScVal results to avoid repeated buffer allocations
 * on hot paths (issue #616).
 *
 * ScVal objects produced by nativeToScVal are immutable XDR structures.
 * Caching them eliminates redundant serialization and reduces GC pressure.
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
