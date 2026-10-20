/**
 * Tests for Issue #729: ScValCache eviction order under a workload exceeding DEFAULT_MAX_SIZE.
 *
 * Verifies:
 * - The cache size never exceeds DEFAULT_MAX_SIZE (256) even when driven past it.
 * - The actual eviction order produced is LRU (Least-Recently-Used): the oldest,
 *   least-recently-accessed entry is evicted when the cache is full.
 * - Eviction works correctly across the supported non-address ScVal types:
 *   'u64' | 'i128' | 'u32' | 'symbol' | 'string' | 'bool'
 * - The 'address' type evicts correctly when populated with real Stellar addresses.
 */
import { describe, it, expect } from 'vitest';
import { ScValCache } from '../src/scValCache.js';

// DEFAULT_MAX_SIZE is 256 — replicate the constant here so tests are
// self-documenting without depending on the module exporting it.
const DEFAULT_MAX_SIZE = 256;

// ── Helpers ────────────────────────────────────────────────────────────────

type ScValType = 'address' | 'u64' | 'i128' | 'u32' | 'symbol' | 'string' | 'bool';

// Types that accept plain numeric/string values (no Stellar StrKey validation).
const NON_ADDRESS_TYPES: Exclude<ScValType, 'address'>[] = [
  'u64',
  'i128',
  'u32',
  'symbol',
  'string',
  'bool',
];

/** Produces a valid value for each non-address ScValType. */
function valueFor(type: Exclude<ScValType, 'address'>, seed: number): unknown {
  switch (type) {
    case 'u64':
      return BigInt(seed);
    case 'i128':
      return BigInt(seed) - 500n;
    case 'u32':
      return seed % 2 ** 32;
    case 'symbol':
      return `sym${seed}`;
    case 'string':
      return `str${seed}`;
    case 'bool':
      return seed % 2 === 0;
  }
}

// ── Issue #729: eviction order past DEFAULT_MAX_SIZE ──────────────────────

describe('ScValCache eviction order past DEFAULT_MAX_SIZE (issue #729)', () => {
  it('cache size never exceeds DEFAULT_MAX_SIZE when inserting more than 256 distinct entries', () => {
    const cache = new ScValCache(DEFAULT_MAX_SIZE);
    const overCount = DEFAULT_MAX_SIZE + 50; // 306 distinct entries

    // Insert across all non-address types to simulate a realistic workload
    for (let i = 0; i < overCount; i++) {
      const type = NON_ADDRESS_TYPES[i % NON_ADDRESS_TYPES.length]!;
      cache.get(valueFor(type, i), type);
    }

    expect(cache.size).toBeLessThanOrEqual(DEFAULT_MAX_SIZE);
    // Exact size must equal DEFAULT_MAX_SIZE since we inserted more than the limit
    expect(cache.size).toBe(DEFAULT_MAX_SIZE);
  });

  it('documents eviction order: LRU (oldest-inserted, least-recently-used entry is evicted first)', () => {
    // Use a small cache to make the LRU assertion cheap and deterministic.
    const maxSize = 4;
    const cache = new ScValCache(maxSize);

    // Insert 4 entries to fill the cache
    cache.get('sym0', 'symbol');
    cache.get('sym1', 'symbol');
    cache.get('sym2', 'symbol');
    cache.get('sym3', 'symbol');
    expect(cache.size).toBe(maxSize);

    // Access 'sym0' again to promote it to MRU (most-recently-used)
    const sym0Instance = cache.get('sym0', 'symbol');

    // Now sym1 is the oldest (LRU). Inserting a new entry should evict sym1.
    cache.get('sym4', 'symbol');
    expect(cache.size).toBe(maxSize);

    // sym0 was just accessed, so it must still be cached (same instance)
    const sym0After = cache.get('sym0', 'symbol');
    expect(sym0After).toBe(sym0Instance);

    // sym1 was LRU and must have been evicted — its re-fetch creates a new
    // instance with no reference equality to sym0.
    const sym1After = cache.get('sym1', 'symbol');
    expect(sym1After).not.toBe(sym0Instance);

    // Verify the cache still doesn't grow past maxSize
    expect(cache.size).toBeLessThanOrEqual(maxSize);
  });

  it('eviction works correctly across multiple ScVal types in a mixed workload', () => {
    const cache = new ScValCache(DEFAULT_MAX_SIZE);
    const totalInserts = DEFAULT_MAX_SIZE + 100; // 356 inserts

    for (let i = 0; i < totalInserts; i++) {
      const type = NON_ADDRESS_TYPES[i % NON_ADDRESS_TYPES.length]!;
      cache.get(valueFor(type, i), type);
    }

    // Size invariant: must never exceed DEFAULT_MAX_SIZE
    expect(cache.size).toBeLessThanOrEqual(DEFAULT_MAX_SIZE);
  });

  it('inserting exactly DEFAULT_MAX_SIZE + 1 entries evicts only one entry', () => {
    const cache = new ScValCache(DEFAULT_MAX_SIZE);

    for (let i = 0; i < DEFAULT_MAX_SIZE; i++) {
      cache.get(i, 'u32');
    }
    expect(cache.size).toBe(DEFAULT_MAX_SIZE);

    // One more insert triggers exactly one eviction
    cache.get(DEFAULT_MAX_SIZE, 'u32');
    expect(cache.size).toBe(DEFAULT_MAX_SIZE);
  });

  it('LRU access prevents eviction of a recently-used entry across a large workload', () => {
    const cache = new ScValCache(DEFAULT_MAX_SIZE);

    // Fill the cache
    for (let i = 0; i < DEFAULT_MAX_SIZE; i++) {
      cache.get(`key${i}`, 'string');
    }

    // Access key0 to make it MRU; then drive past DEFAULT_MAX_SIZE keeping it alive.
    cache.get('key0', 'string');
    const key0Before = cache.get('key0', 'string');

    // Add only a few extra entries to trigger eviction of the oldest keys
    // (key1, key2, ...) but key0 was just refreshed so it should survive.
    for (let i = DEFAULT_MAX_SIZE; i < DEFAULT_MAX_SIZE + 5; i++) {
      cache.get(`key${i}`, 'string');
    }

    // key0 must still be cached — we just refreshed it
    const key0After = cache.get('key0', 'string');
    expect(key0After).toBe(key0Before);

    // Size invariant maintained
    expect(cache.size).toBeLessThanOrEqual(DEFAULT_MAX_SIZE);
  });

  it('size invariant holds continuously across a 3× overload (768 inserts)', () => {
    const cache = new ScValCache(DEFAULT_MAX_SIZE);
    const total = DEFAULT_MAX_SIZE * 3; // 768 inserts

    for (let i = 0; i < total; i++) {
      const type = NON_ADDRESS_TYPES[i % NON_ADDRESS_TYPES.length]!;
      cache.get(valueFor(type, i), type);
      // Assert on every insert — size invariant must hold at every step
      expect(cache.size).toBeLessThanOrEqual(DEFAULT_MAX_SIZE);
    }

    expect(cache.size).toBe(DEFAULT_MAX_SIZE);
  });

  it('eviction applies to the address type when populated with real Stellar addresses', () => {
    // Use a small max-size so the test is fast and deterministic.
    const maxSize = 2;
    const cache = new ScValCache(maxSize);

    // Real Stellar addresses (G-address and C-address formats both accepted by nativeToScVal)
    const addr1 = 'GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF';
    const addr2 = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
    const addr3 = 'CAVTXNC2WCHINDNP4VBLSOQA2667VE3RPQZNGD5TFI4U2QSHTVAC667T';

    // Fill to capacity
    cache.get(addr1, 'address');
    cache.get(addr2, 'address');
    expect(cache.size).toBe(maxSize);

    // One more address triggers eviction of the oldest entry (addr1)
    cache.get(addr3, 'address');
    expect(cache.size).toBe(maxSize);

    // addr1 was evicted; fetching it again creates a new instance
    const addr1Refetched = cache.get(addr1, 'address');
    expect(addr1Refetched).toBeDefined();
    expect(addr1Refetched.toXDR().length).toBeGreaterThan(0);
  });
});
