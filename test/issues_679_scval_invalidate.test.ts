import { describe, it, expect } from 'vitest';
import { ScValCache } from '../src/scValCache.js';

const ADDR = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

describe('ScValCache scoped invalidation (issue #679)', () => {
  it('invalidateAddress removes only that address entry, leaving others intact', () => {
    const cache = new ScValCache();
    const target = cache.get(ADDR, 'address');
    const other = cache.get('GOTHERADDRESS', 'address');
    const sym = cache.get('memo', 'symbol');

    expect(cache.invalidateAddress(ADDR)).toBe(1);

    // Target re-computed (new instance), unrelated entries untouched (same instance).
    expect(cache.get(ADDR, 'address')).not.toBe(target);
    expect(cache.get('GOTHERADDRESS', 'address')).toBe(other);
    expect(cache.get('memo', 'symbol')).toBe(sym);
  });

  it('invalidate with type removes only the matching type entry', () => {
    const cache = new ScValCache();
    const u64 = cache.get(42, 'u64');
    const u32 = cache.get(42, 'u32');

    expect(cache.invalidate(42, 'u64')).toBe(1);
    expect(cache.get(42, 'u64')).not.toBe(u64);
    expect(cache.get(42, 'u32')).toBe(u32);
  });

  it('invalidate without type removes all types for the value', () => {
    const cache = new ScValCache();
    cache.get(7, 'u64');
    cache.get(7, 'u32');
    cache.get(8, 'u64');

    expect(cache.invalidate(7)).toBe(2);
    expect(cache.size).toBe(1);
  });

  it('invalidating a missing entry returns 0 and changes nothing', () => {
    const cache = new ScValCache();
    const kept = cache.get('x', 'symbol');
    expect(cache.invalidateAddress('GUNKNOWN')).toBe(0);
    expect(cache.get('x', 'symbol')).toBe(kept);
  });
});
