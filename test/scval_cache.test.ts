import { describe, it, expect } from 'vitest';
import { Address } from '@stellar/stellar-sdk';
import { ScValCache, cachedScVal, cachedBool, cachedScValBase64 } from '../src/scValCache.js';

describe('ScValCache (issue #616)', () => {
  it('returns equal but independent instances for repeated calls with identical value+type', () => {
    const cache = new ScValCache();
    const a = cache.get('test_val', 'symbol');
    const b = cache.get('test_val', 'symbol');
    expect(a.toXDR('base64')).toBe(b.toXDR('base64'));
    // Issue #985: each caller gets its own instance, never a shared mutable one.
    expect(a).not.toBe(b);
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
    cache.get(1n, 'u64');
    cache.get(2n, 'u64');
    cache.get(3n, 'u64'); // evicts 1n

    expect(cache.size).toBe(2);
    expect(cache.has(1n, 'u64')).toBe(false); // evicted
    expect(cache.has(2n, 'u64')).toBe(true);
    expect(cache.has(3n, 'u64')).toBe(true);
  });

  it('LRU access refreshes entry', () => {
    const cache = new ScValCache(2);
    cache.get(1n, 'u64');
    cache.get(2n, 'u64');
    // Access 1n again to refresh it
    cache.get(1n, 'u64');
    // Adding 3n should evict 2n (oldest), not 1n
    cache.get(3n, 'u64');

    expect(cache.has(1n, 'u64')).toBe(true);
    expect(cache.has(2n, 'u64')).toBe(false);
  });

  it('clear() empties the cache', () => {
    const cache = new ScValCache();
    cache.get(1n, 'u64');
    cache.get(2n, 'u64');
    expect(cache.size).toBe(2);

    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('cachedScVal returns equal but independent instances via the global cache', () => {
    const a = cachedScVal(100n, 'u64');
    const b = cachedScVal(100n, 'u64');
    expect(a.toXDR('base64')).toBe(b.toXDR('base64'));
    expect(a).not.toBe(b);
  });

  it('cachedBool returns the right boolean, as a new instance every call (issue #985)', () => {
    const t1 = cachedBool(true);
    const t2 = cachedBool(true);
    const f1 = cachedBool(false);
    expect(t1.b()).toBe(true);
    expect(t2.b()).toBe(true);
    expect(f1.b()).toBe(false);
    expect(t1).not.toBe(t2);
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

// ── Issue #679: per-entry and per-address invalidation ────────────────────────

describe('ScValCache per-entry invalidation (#679)', () => {
  const ADDR_1 = 'GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF';
  const ADDR_2 = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

  it('delete(value, type) removes the specific entry and returns true', () => {
    const cache = new ScValCache();
    cache.get('sym1', 'symbol');
    cache.get('sym2', 'symbol');
    expect(cache.size).toBe(2);

    const deleted = cache.delete('sym1', 'symbol');
    expect(deleted).toBe(true);
    expect(cache.size).toBe(1);
  });

  it('delete returns false when the entry is not cached', () => {
    const cache = new ScValCache();
    expect(cache.delete('nonexistent', 'symbol')).toBe(false);
  });

  it('delete invalidates only the targeted entry, not unrelated entries', () => {
    const cache = new ScValCache();
    cache.get(1n, 'u64');
    cache.get(2n, 'u64');
    cache.get('sym', 'symbol');
    expect(cache.size).toBe(3);

    cache.delete(1n, 'u64');
    expect(cache.size).toBe(2);

    // Other entries are unaffected.
    const two = cache.get(2n, 'u64');
    const sym = cache.get('sym', 'symbol');
    expect(two).toBeDefined();
    expect(sym).toBeDefined();
  });

  it('after delete, the entry is gone and is recomputed on the next get', () => {
    const cache = new ScValCache();
    const original = cache.get('StreamCreated', 'symbol');
    expect(cache.delete('StreamCreated', 'symbol')).toBe(true);
    expect(cache.has('StreamCreated', 'symbol')).toBe(false);

    const refetched = cache.get('StreamCreated', 'symbol');
    expect(cache.has('StreamCreated', 'symbol')).toBe(true);
    expect(refetched.toXDR('base64')).toBe(original.toXDR('base64'));
  });

  it('deleteByAddress removes an address entry without touching other types', () => {
    const cache = new ScValCache();
    cache.get(ADDR_1, 'address');
    cache.get(ADDR_2, 'address');
    cache.get(42n, 'u64');
    expect(cache.size).toBe(3);

    const removed = cache.deleteByAddress(ADDR_1);
    expect(removed).toBe(true);
    expect(cache.size).toBe(2);

    // ADDR_2 and u64 entry survive.
    expect(cache.get(ADDR_2, 'address')).toBeDefined();
    expect(cache.get(42n, 'u64')).toBeDefined();
  });

  it('deleteByAddress returns false for an address not in the cache', () => {
    const cache = new ScValCache();
    expect(cache.deleteByAddress(ADDR_1)).toBe(false);
  });

  it('delete does not interfere with LRU eviction order after the entry is removed', () => {
    const cache = new ScValCache(3);
    cache.get('a', 'symbol');
    cache.get('b', 'symbol');
    cache.get('c', 'symbol');

    // Delete 'a' manually.
    cache.delete('a', 'symbol');
    expect(cache.size).toBe(2);

    // Insert 'd' — no eviction needed (size is 2, limit is 3).
    cache.get('d', 'symbol');
    expect(cache.size).toBe(3);

    // Insert 'e' — now full; LRU is 'b' (oldest remaining).
    cache.get('e', 'symbol');
    expect(cache.size).toBe(3);

    // 'c' and 'd' and 'e' should be present; 'b' was evicted.
    const c = cache.get('c', 'symbol');
    expect(c).toBeDefined();
  });
});

// ── Issue #985: cached values must not be shared mutable instances ───────────

describe('ScValCache hands out independent instances (#985)', () => {
  const ADDR = 'GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF';

  it('mutating a returned ScVal in place does not corrupt later gets', () => {
    const cache = new ScValCache();
    const first = cache.get(ADDR, 'address');
    const before = first.toXDR('base64');

    // Overwrite the returned address's 32 key bytes in place.
    first.address().accountId().ed25519().fill(0);

    const second = cache.get(ADDR, 'address');
    expect(second.toXDR('base64')).toBe(before);
    expect(Address.fromScVal(second).toString()).toBe(ADDR);
  });

  it('mutating the value returned on a hit does not corrupt the cache either', () => {
    const cache = new ScValCache();
    cache.get(ADDR, 'address'); // miss: populates the cache
    const hit = cache.get(ADDR, 'address'); // hit
    hit.address().accountId().ed25519().fill(0xff);

    const next = cache.get(ADDR, 'address');
    expect(Address.fromScVal(next).toString()).toBe(ADDR);
  });

  it('mutating a cachedScVal result does not corrupt the shared global cache', () => {
    const first = cachedScVal(ADDR, 'address');
    first.address().accountId().ed25519().fill(0);

    const second = cachedScVal(ADDR, 'address');
    expect(Address.fromScVal(second).toString()).toBe(ADDR);
  });

  it('separate callers each get their own instance', () => {
    const cache = new ScValCache();
    const a = cache.get(ADDR, 'address');
    const b = cache.get(ADDR, 'address');
    const c = cache.get(ADDR, 'address');
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('has() is read-only: it neither creates entries nor refreshes LRU order', () => {
    const cache = new ScValCache(2);
    cache.get(1n, 'u64');
    cache.get(2n, 'u64');

    expect(cache.has(3n, 'u64')).toBe(false);
    expect(cache.size).toBe(2);

    // Probing 1n must not promote it: adding 3n still evicts 1n (the oldest).
    expect(cache.has(1n, 'u64')).toBe(true);
    cache.get(3n, 'u64');
    expect(cache.has(1n, 'u64')).toBe(false);
    expect(cache.has(2n, 'u64')).toBe(true);
  });
});
