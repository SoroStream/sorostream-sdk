/**
 * Regression tests for issues #713, #714, #715 and #720.
 *
 * - #713 stale-while-revalidate stream cache reads
 * - #714 late deduplication joiners must never receive a settled entry
 * - #715 deterministic connection-pool waiter priority after same-tick releases
 * - #720 replay transport matching fixtures by method + recorded parameters
 */
import { describe, it, expect } from 'vitest';

import { LocalStorageStreamCache, DEFAULT_MAX_AGE_MS } from '../src/streamStateCache.js';
import { RequestDeduplicator } from '../src/requestDeduplicator.js';
import { ConnectionPool } from '../src/connectionPool.js';
import { ReplayTransport, ReplayFixtureError } from '../src/replayTransport.js';
import type { FixtureFile } from '../src/replayTransport.js';
import type { StorageAdapter } from '../src/adapters.js';
import type { SerializedStream } from '../src/serialization.js';
import { deserializeStream } from '../src/serialization.js';
import type { Stream } from '../src/types.js';

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

// ── #713: stale-while-revalidate cache reads ────────────────────────────────

describe('#713 stale-while-revalidate reads', () => {
  it('returns the stale value immediately and updates the cache once refresh resolves', async () => {
    const adapter = memoryAdapter();
    const cache = new LocalStorageStreamCache(adapter, 1);
    cache.set('testnet', stream('s1'));
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Stale for the plain fresh-only lookup…
    expect(cache.get('testnet', 's1')).toBeUndefined();

    let resolveRefresh!: (value: Stream) => void;
    const controlled = new Promise<Stream>((resolve) => {
      resolveRefresh = resolve;
    });

    const { value, refresh } = cache.getWithRevalidate('testnet', 's1', () => controlled);

    // …but still served immediately as the revalidating value.
    expect(value?.id).toBe('s1');
    expect(value?.deposit).toBe(1_000_000n);

    resolveRefresh(deserializeStream({ ...serialized('s1'), deposit: '2000000' }));
    const updated = await refresh;
    expect(updated.deposit).toBe(2_000_000n);

    // The refreshed value replaces the cached entry (checked without the
    // freshness window, which the test cache deliberately keeps tiny).
    const verifier = new LocalStorageStreamCache(adapter);
    expect(verifier.get('testnet', 's1')?.deposit).toBe(2_000_000n);
  });

  it('leaves the cache untouched and rejects when the refresh fails', async () => {
    const cache = new LocalStorageStreamCache(memoryAdapter());
    cache.set('testnet', stream('s1'));

    const { value, refresh } = cache.getWithRevalidate('testnet', 's1', () =>
      Promise.reject(new Error('offline')),
    );

    expect(value?.id).toBe('s1');
    await expect(refresh).rejects.toThrow('offline');
    expect(cache.get('testnet', 's1')?.id).toBe('s1');
  });

  it('normalises a synchronously-throwing refresh into a rejection', async () => {
    const cache = new LocalStorageStreamCache(memoryAdapter());
    const { value, refresh } = cache.getWithRevalidate('testnet', 'missing', () => {
      throw new Error('boom');
    });
    expect(value).toBeUndefined();
    await expect(refresh).rejects.toThrow('boom');
  });
});

// ── #714: late joiners never join a settled entry ───────────────────────────

describe('#714 late deduplication joiners', () => {
  it('starts a fresh request when the in-flight entry has already settled', async () => {
    const dedup = new RequestDeduplicator();
    let resolveFirst!: (value: string) => void;
    const first = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });

    const p1 = dedup.dedupe('k', () => first);

    let late!: Promise<string>;
    queueMicrotask(() => {
      late = dedup.dedupe('k', () => Promise.resolve('fresh'));
    });

    resolveFirst('old');

    expect(await p1).toBe('old');
    expect(await late).toBe('fresh');
    expect(dedup.stats().started).toBe(2);
    expect(dedup.stats().deduplicated).toBe(0);
  });

  it('still shares one request across callers created in the same tick', async () => {
    const dedup = new RequestDeduplicator();
    let calls = 0;
    const factory = () => {
      calls++;
      return new Promise<number>((resolve) => setTimeout(() => resolve(calls), 5));
    };

    const [a, b] = await Promise.all([dedup.dedupe('k', factory), dedup.dedupe('k', factory)]);

    expect(calls).toBe(1);
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(dedup.stats()).toMatchObject({ started: 1, deduplicated: 1 });
  });
});

// ── #715: deterministic waiter priority ─────────────────────────────────────

const RPC_URL = 'https://soroban-testnet.stellar.org';
const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

describe('#715 pool waiter priority after same-tick releases', () => {
  it('grants queued waiters by priority rank, FIFO within a rank, regardless of enqueue order', async () => {
    const pool = new ConnectionPool({
      poolSize: 2,
      maxConnections: 2,
      rpcUrl: RPC_URL,
      contractId: CONTRACT_ID,
    });
    try {
      const heldA = await pool.acquire();
      const heldB = await pool.acquire();

      const granted: string[] = [];
      const record = (label: string) => (handle: { release: () => void }) => {
        granted.push(label);
        return handle;
      };

      // Enqueued deliberately out of priority order: normal, low, normal, high.
      const wNormal1 = pool.acquire({ priority: 'normal' }).then(record('normal1'));
      const wLow = pool.acquire({ priority: 'low' }).then(record('low'));
      const wNormal2 = pool.acquire({ priority: 'normal' }).then(record('normal2'));
      const wHigh = pool.acquire({ priority: 'high' }).then(record('high'));

      // Both held connections are released in the same tick.
      heldA.release();
      heldB.release();

      const [hHigh, hNormal1] = await Promise.all([wHigh, wNormal1]);
      expect(granted).toEqual(['high', 'normal1']);

      // Freeing the high-priority handle grants the next normal waiter…
      hHigh.release();
      const hNormal2 = await wNormal2;
      expect(granted).toEqual(['high', 'normal1', 'normal2']);

      // …and only then the low-priority one.
      hNormal1.release();
      const hLow = await wLow;
      expect(granted).toEqual(['high', 'normal1', 'normal2', 'low']);

      hNormal2.release();
      hLow.release();
      expect(pool.getStats()).toMatchObject({ total: 2 });
    } finally {
      pool.destroy();
    }
  });
});

// ── #720: parameter-aware replay matching ───────────────────────────────────

describe('#720 replay fixture parameter matching', () => {
  function fixture(): FixtureFile {
    return {
      recordedAt: '2026-01-01T00:00:00.000Z',
      entries: [
        { method: 'getAccount', request: { address: 'GAAA' }, response: { id: 'GAAA' } },
        { method: 'getAccount', request: { address: 'GBBB' }, response: { id: 'GBBB' } },
      ],
    };
  }

  it('serves the entry recorded for the requested parameters, not the next in order', async () => {
    const transport = ReplayTransport.replay(fixture());
    const b = await transport.getAccount('GBBB');
    const a = await transport.getAccount('GAAA');
    expect((b as { id: string }).id).toBe('GBBB');
    expect((a as { id: string }).id).toBe('GAAA');
  });

  it('falls back to insertion order for entries recorded without parameters', async () => {
    const transport = ReplayTransport.replay({
      recordedAt: '2026-01-01T00:00:00.000Z',
      entries: [
        { method: 'getLatestLedger', request: {}, response: { sequence: 1 } },
        { method: 'getLatestLedger', request: {}, response: { sequence: 2 } },
      ],
    });
    await expect(transport.getLatestLedger()).resolves.toEqual({ sequence: 1 });
    await expect(transport.getLatestLedger()).resolves.toEqual({ sequence: 2 });
  });

  it('throws when no recorded or unparameterised entry matches', async () => {
    const transport = ReplayTransport.replay(fixture());
    await expect(transport.getAccount('GZZZ')).rejects.toBeInstanceOf(ReplayFixtureError);
  });
});

// ── contractId key scoping ───────────────────────────────────────────────────

describe('LocalStorageStreamCache contractId key scoping', () => {
  it('two caches with the same network but different contractIds do not share entries', () => {
    const adapter = memoryAdapter();
    const cacheA = new LocalStorageStreamCache(adapter, DEFAULT_MAX_AGE_MS, 'CONTRACT-A');
    const cacheB = new LocalStorageStreamCache(adapter, DEFAULT_MAX_AGE_MS, 'CONTRACT-B');

    cacheA.set('testnet', stream('s1'));

    // contractB must not find the entry written by contractA.
    expect(cacheB.get('testnet', 's1')).toBeUndefined();
    // contractA still finds its own entry.
    expect(cacheA.get('testnet', 's1')?.id).toBe('s1');
  });

  it('two caches on different networks with the same contractId do not share entries', () => {
    const adapter = memoryAdapter();
    const cacheTestnet = new LocalStorageStreamCache(adapter, DEFAULT_MAX_AGE_MS, 'CONTRACT-X');
    const cacheMainnet = new LocalStorageStreamCache(adapter, DEFAULT_MAX_AGE_MS, 'CONTRACT-X');

    cacheTestnet.set('testnet', stream('s2'));

    expect(cacheMainnet.get('mainnet', 's2')).toBeUndefined();
    expect(cacheTestnet.get('testnet', 's2')?.id).toBe('s2');
  });

  it('delete() only removes the entry for its own contractId', () => {
    const adapter = memoryAdapter();
    const cacheA = new LocalStorageStreamCache(adapter, DEFAULT_MAX_AGE_MS, 'CONTRACT-A');
    const cacheB = new LocalStorageStreamCache(adapter, DEFAULT_MAX_AGE_MS, 'CONTRACT-B');

    cacheA.set('testnet', stream('s3'));
    cacheB.set('testnet', stream('s3'));

    cacheA.delete('testnet', 's3');

    expect(cacheA.get('testnet', 's3')).toBeUndefined();
    expect(cacheB.get('testnet', 's3')?.id).toBe('s3');
  });

  it('a cache without contractId remains backward-compatible with the old key format', () => {
    const adapter = memoryAdapter();
    const legacy = new LocalStorageStreamCache(adapter);
    legacy.set('testnet', stream('s4'));
    expect(legacy.get('testnet', 's4')?.id).toBe('s4');

    // A scoped cache must not find the legacy entry.
    const scoped = new LocalStorageStreamCache(adapter, DEFAULT_MAX_AGE_MS, 'C');
    expect(scoped.get('testnet', 's4')).toBeUndefined();
  });
});
