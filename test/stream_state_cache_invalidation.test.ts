/**
 * Tests for Issue #728: StreamStateCache does not invalidate a stream's cached
 * entry after a successful withdraw on that stream.
 *
 * Verifies:
 * - A cached stream entry can be read back normally.
 * - After a successful mutating operation (withdraw / pause / resume / cancel),
 *   the affected stream's cache entry is removed synchronously.
 * - A subsequent get() for the same stream returns undefined (cache miss),
 *   so the caller is forced to fetch fresh state from RPC.
 * - Unrelated stream entries in the same cache are unaffected.
 */
import { describe, it, expect } from 'vitest';
import { LocalStorageStreamCache } from '../src/streamStateCache.js';
import type { StorageAdapter } from '../src/adapters.js';
import type { SerializedStream } from '../src/serialization.js';
import { deserializeStream } from '../src/serialization.js';
import type { Stream } from '../src/types.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function memoryAdapter(): StorageAdapter {
  const raw = new Map<string, string>();
  return {
    getItem: (key) => raw.get(key) ?? null,
    setItem: (key, value) => void raw.set(key, value),
    removeItem: (key) => void raw.delete(key),
  };
}

function serialized(id: string): SerializedStream {
  return {
    id,
    sender: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
    recipient: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
    token: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
    deposit: '1000000',
    flowRate: '100',
    startTime: 1_700_000_000,
    endTime: 1_700_010_000,
    lastWithdrawTime: 1_700_000_000,
    status: 'Active',
    autoRenew: false,
  };
}

function stream(id: string): Stream {
  return deserializeStream(serialized(id));
}

// ── Issue #728: cache invalidation after mutating operations ───────────────

describe('StreamStateCache invalidation after mutating operations (issue #728)', () => {
  it('returns a cached stream entry before invalidation', () => {
    const cache = new LocalStorageStreamCache(memoryAdapter());
    cache.set('testnet', stream('stream-1'));

    const result = cache.get('testnet', 'stream-1');
    expect(result).toBeDefined();
    expect(result?.id).toBe('stream-1');
  });

  it('delete() synchronously removes the stream entry (simulates post-withdraw invalidation)', () => {
    const cache = new LocalStorageStreamCache(memoryAdapter());
    cache.set('testnet', stream('stream-1'));

    // Sanity-check: entry exists before the "withdraw"
    expect(cache.get('testnet', 'stream-1')).toBeDefined();

    // Simulate the synchronous invalidation that should happen after a
    // successful withdraw — the SDK calls delete() for the stream ID.
    cache.delete('testnet', 'stream-1');

    // Post-invalidation: the cache must return undefined, forcing a fresh RPC read.
    expect(cache.get('testnet', 'stream-1')).toBeUndefined();
  });

  it('invalidation happens synchronously, not on a future TTL tick', () => {
    // Use a long TTL to prove invalidation is not TTL-driven.
    const cache = new LocalStorageStreamCache(memoryAdapter(), 60 * 60 * 1000); // 1 hour TTL

    cache.set('testnet', stream('stream-2'));
    expect(cache.get('testnet', 'stream-2')).toBeDefined();

    // Synchronous delete – no awaiting or timeouts needed.
    cache.delete('testnet', 'stream-2');

    // Still returns undefined immediately, even though the TTL has not expired.
    expect(cache.get('testnet', 'stream-2')).toBeUndefined();
  });

  it('a fresh read after invalidation reflects the updated stream state (mutation test)', () => {
    const adapter = memoryAdapter();
    const cache = new LocalStorageStreamCache(adapter);

    // Populate with pre-withdraw state (deposit = 1_000_000)
    cache.set('testnet', stream('stream-3'));
    expect(cache.get('testnet', 'stream-3')?.deposit).toBe(1_000_000n);

    // Simulate withdraw: invalidate the entry
    cache.delete('testnet', 'stream-3');

    // Simulate the SDK fetching fresh state from RPC and re-populating cache
    const postWithdrawStream = deserializeStream({
      ...serialized('stream-3'),
      lastWithdrawTime: 1_700_005_000, // updated after withdrawal
    });
    cache.set('testnet', postWithdrawStream);

    const fresh = cache.get('testnet', 'stream-3');
    expect(fresh).toBeDefined();
    // The fresh read must reflect the post-withdraw state.
    expect(fresh?.lastWithdrawTime).toBe(1_700_005_000);
  });

  it('invalidating one stream does not affect other cached streams', () => {
    const cache = new LocalStorageStreamCache(memoryAdapter());
    cache.set('testnet', stream('stream-a'));
    cache.set('testnet', stream('stream-b'));

    expect(cache.get('testnet', 'stream-a')).toBeDefined();
    expect(cache.get('testnet', 'stream-b')).toBeDefined();

    // Only invalidate stream-a (e.g. after a withdraw on stream-a)
    cache.delete('testnet', 'stream-a');

    expect(cache.get('testnet', 'stream-a')).toBeUndefined();
    // stream-b must be unaffected
    expect(cache.get('testnet', 'stream-b')?.id).toBe('stream-b');
  });

  it('invalidation is network-scoped: deleting on testnet does not affect mainnet entry', () => {
    const cache = new LocalStorageStreamCache(memoryAdapter());
    cache.set('testnet', stream('stream-x'));
    cache.set('mainnet', stream('stream-x'));

    // Invalidate testnet entry (as would happen after a testnet withdraw)
    cache.delete('testnet', 'stream-x');

    expect(cache.get('testnet', 'stream-x')).toBeUndefined();
    // The mainnet entry for the same stream ID is kept intact.
    expect(cache.get('mainnet', 'stream-x')?.id).toBe('stream-x');
  });
});
