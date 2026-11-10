/**
 * Tests for Issue #679: ScValCache scoped invalidation for a single address or value.
 *
 * Verifies:
 * - `invalidate(value, type)` removes only the targeted entry while leaving unrelated entries intact.
 * - `invalidate(value)` (without type) removes matching entries across all ScValTypes.
 * - `invalidateAddress(address)` removes cached entries for a single Stellar address without
 *   clearing unrelated addresses or values.
 * - Existing LRU eviction and `clear()` behavior remain unchanged for callers that don't use
 *   scoped invalidation.
 * - Global helpers `invalidateCachedAddress` and `invalidateCachedScVal` invalidate the shared singleton.
 */
import { describe, it, expect } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import {
  ScValCache,
  cachedScVal,
  cachedScValBase64,
  invalidateCachedAddress,
  invalidateCachedScVal,
  _scValCache,
} from '../src/scValCache.js';

const ADDR_1 = Keypair.random().publicKey();
const ADDR_2 = Keypair.random().publicKey();
const ADDR_3 = Keypair.random().publicKey();

describe('ScValCache scoped invalidation (issue #679)', () => {
  it('invalidates a single address while leaving unrelated entries intact', () => {
    const cache = new ScValCache();

    const val1 = cache.get(ADDR_1, 'address');
    const val2 = cache.get(ADDR_2, 'address');
    const amountVal = cache.get(500n, 'i128');
    const symbolVal = cache.get('transfer', 'symbol');

    expect(cache.size).toBe(4);
    expect(cache.has(ADDR_1, 'address')).toBe(true);
    expect(cache.has(ADDR_2, 'address')).toBe(true);

    const removed = cache.invalidateAddress(ADDR_1);
    expect(removed).toBe(1);
    expect(cache.size).toBe(3);
    expect(cache.has(ADDR_1, 'address')).toBe(false);
    expect(cache.has(ADDR_2, 'address')).toBe(true);

    // Unrelated entries return the exact same cached ScVal references
    expect(cache.get(ADDR_2, 'address')).toBe(val2);
    expect(cache.get(500n, 'i128')).toBe(amountVal);
    expect(cache.get('transfer', 'symbol')).toBe(symbolVal);

    // Re-fetching the invalidated address produces a fresh ScVal instance
    const recomputedVal1 = cache.get(ADDR_1, 'address');
    expect(recomputedVal1).not.toBe(val1);
    expect(recomputedVal1.toXDR('base64')).toBe(val1.toXDR('base64'));
  });

  it('invalidate(value, type) removes only the specified type for that value', () => {
    const cache = new ScValCache();

    const asSymbol = cache.get('active', 'symbol');
    const asString = cache.get('active', 'string');
    expect(cache.size).toBe(2);

    const removed = cache.invalidate('active', 'symbol');
    expect(removed).toBe(1);
    expect(cache.size).toBe(1);
    expect(cache.has('active', 'symbol')).toBe(false);
    expect(cache.has('active', 'string')).toBe(true);
    expect(cache.get('active', 'string')).toBe(asString);
    expect(cache.get('active', 'symbol')).not.toBe(asSymbol);
  });

  it('invalidate(value) without type removes all cached representations of that value', () => {
    const cache = new ScValCache();

    cache.get(ADDR_1, 'address');
    cache.get(ADDR_1, 'string');
    cache.get(ADDR_2, 'address');
    expect(cache.size).toBe(3);

    const removed = cache.invalidate(ADDR_1);
    expect(removed).toBe(2);
    expect(cache.size).toBe(1);
    expect(cache.has(ADDR_1, 'address')).toBe(false);
    expect(cache.has(ADDR_1, 'string')).toBe(false);
    expect(cache.has(ADDR_2, 'address')).toBe(true);
  });

  it('returns 0 when invalidating an address or value that is not in the cache', () => {
    const cache = new ScValCache();
    cache.get(ADDR_1, 'address');

    expect(cache.invalidateAddress(ADDR_2)).toBe(0);
    expect(cache.invalidateAddress('')).toBe(0);
    expect(cache.invalidate(999n, 'u64')).toBe(0);
    expect(cache.size).toBe(1);
  });

  it('preserves existing LRU eviction and clear() behavior', () => {
    const cache = new ScValCache(3);

    const v1 = cache.get(ADDR_1, 'address');
    const v2 = cache.get(ADDR_2, 'address');
    const v3 = cache.get(ADDR_3, 'address');

    // Touch ADDR_1 so ADDR_2 becomes least recently used
    expect(cache.get(ADDR_1, 'address')).toBe(v1);

    // Inserting a 4th item evicts ADDR_2 (LRU)
    cache.get(42, 'u32');
    expect(cache.has(ADDR_2, 'address')).toBe(false);
    expect(cache.get(ADDR_1, 'address')).toBe(v1);
    expect(cache.get(ADDR_3, 'address')).toBe(v3);

    // Global clear removes everything
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get(ADDR_2, 'address')).not.toBe(v2);
  });

  it('invalidates entries in the shared global singleton via helper functions', () => {
    _scValCache.clear();

    const g1 = cachedScVal(ADDR_1, 'address');
    const g2 = cachedScVal(ADDR_2, 'address');
    cachedScValBase64(ADDR_1, 'address');

    expect(invalidateCachedAddress(ADDR_1)).toBe(1);
    expect(cachedScVal(ADDR_2, 'address')).toBe(g2);
    expect(cachedScVal(ADDR_1, 'address')).not.toBe(g1);

    const numVal = cachedScVal(123n, 'u64');
    expect(invalidateCachedScVal(123n, 'u64')).toBe(1);
    expect(cachedScVal(123n, 'u64')).not.toBe(numVal);
  });
});
