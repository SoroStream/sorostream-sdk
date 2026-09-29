import { describe, it, expect } from 'vitest';
import { ScValCache, cachedScVal, cachedBool, cachedScValBase64 } from '../src/scValCache.js';

describe('ScValCache (issue #616)', () => {
  it('returns the same instance for repeated calls with identical value+type', () => {
    const cache = new ScValCache();
    const a = cache.get('test_val', 'symbol');
    const b = cache.get('test_val', 'symbol');
    expect(a).toBe(b);
  });

  it('returns different instances for different values', () => {
    const cache = new ScValCache();
    const a = cache.get('val_a', 'symbol');
    const b = cache.get('val_b', 'symbol');
    expect(a).not.toBe(b);
  });

  it('returns different instances for same value but different types', () => {
    const cache = new ScValCache();
    const a = cache.get(42, 'u64');
    const b = cache.get(42, 'u32');
    expect(a).not.toBe(b);
  });

  it('evicts oldest entry when maxSize is reached', () => {
    const cache = new ScValCache(2);
    const first = cache.get(1n, 'u64');
    cache.get(2n, 'u64');
    cache.get(3n, 'u64'); // evicts 1n

    expect(cache.size).toBe(2);

    const refetched = cache.get(1n, 'u64');
    // New instance — was evicted
    expect(refetched).not.toBe(first);
  });

  it('LRU access refreshes entry', () => {
    const cache = new ScValCache(2);
    const first = cache.get(1n, 'u64');
    cache.get(2n, 'u64');
    // Access 1n again to refresh it
    cache.get(1n, 'u64');
    // Adding 3n should evict 2n (oldest), not 1n
    cache.get(3n, 'u64');

    const stillCached = cache.get(1n, 'u64');
    expect(stillCached).toBe(first);
  });

  it('clear() empties the cache', () => {
    const cache = new ScValCache();
    cache.get(1n, 'u64');
    cache.get(2n, 'u64');
    expect(cache.size).toBe(2);

    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('cachedScVal returns consistent instances via the global cache', () => {
    const a = cachedScVal(100n, 'u64');
    const b = cachedScVal(100n, 'u64');
    expect(a).toBe(b);
  });

  it('cachedBool returns pre-warmed singletons', () => {
    const t1 = cachedBool(true);
    const t2 = cachedBool(true);
    const f1 = cachedBool(false);
    const f2 = cachedBool(false);
    expect(t1).toBe(t2);
    expect(f1).toBe(f2);
    expect(t1).not.toBe(f1);
  });

  it('cachedScValBase64 caches the base64-encoded XDR string', () => {
    const a = cachedScValBase64('StreamCreated', 'symbol');
    const b = cachedScValBase64('StreamCreated', 'symbol');
    expect(a).toBe(b);
    expect(typeof a).toBe('string');
    expect(a.length).toBeGreaterThan(0);
  });

  it('cached symbol ScVal serializes correctly', () => {
    const val = cachedScVal('StreamCreated', 'symbol');
    expect(val).toBeDefined();
    expect(val.switch()).toBeDefined();
  });

  it('cached u64 ScVal produces valid XDR', () => {
    const val = cachedScVal(12345n, 'u64');
    const xdrBytes = val.toXDR();
    expect(xdrBytes.length).toBeGreaterThan(0);
  });
});
