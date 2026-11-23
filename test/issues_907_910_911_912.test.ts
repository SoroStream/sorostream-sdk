/**
 * Tests for issues #907, #910, #911, #912
 *
 * #907 — resolveConditionalParam misidentifies a ConditionalBranchMap keyed
 *         'byteLength' (with a numeric value) as a Buffer-like object because
 *         the guard used `typeof value.byteLength !== 'number'`. Fixed by
 *         checking for real ArrayBuffer / TypedArray / DataView instances
 *         instead of duck-typing on the property name.
 *
 * #910 — getWithRevalidate (streamStateCache) catches JSON/deserialization
 *         errors internally but no test confirmed that the corrupt-storage
 *         path still triggers and resolves the refresh() promise, and that the
 *         refreshed value is written back into the cache.
 *
 * #911 — loadSorostreamConfig treats ALL import() failures (including a
 *         SyntaxError in a config file that *does* exist) the same as
 *         "file not found", silently moving on with no indication a broken
 *         file was skipped. Now distinguishes the two cases: missing file →
 *         silent; existing-but-broken file → warns and rethrows.
 *
 * #912 — isStorageExpired accepts an optional `at` timestamp for the
 *         timestamp-based TTL check but always used `this.currentLedgerSeq`
 *         for the ledger-based check, unlike simulateWithdraw which accepts
 *         an `opts.ledger` override. Added a matching `ledger` parameter.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveConditionalParam,
  conditionalByTokenType,
  type TemplateTokenContext,
} from '../src/templates.js';
import { LocalStorageStreamCache } from '../src/streamStateCache.js';
import { loadSorostreamConfig } from '../src/sorostream-config.js';
import { StreamSimulator } from '../src/simulator.js';
import type { StorageAdapter } from '../src/adapters.js';
import type { Stream } from '../src/types.js';
import { deserializeStream } from '../src/serialization.js';
import type { SerializedStream } from '../src/serialization.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

function memoryAdapter(): StorageAdapter {
  const store = new Map<string, string>();
  return {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, v),
    removeItem: (k) => void store.delete(k),
  };
}

/** Returns the raw Map backing a memoryAdapter (for white-box corruption tests). */
function memoryAdapterWithStore(): { adapter: StorageAdapter; store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    adapter: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
      removeItem: (k) => void store.delete(k),
    },
    store,
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

function makeActiveStream(id = 'stream-sim'): Stream {
  const t = Math.floor(Date.now() / 1000);
  return {
    id,
    sender: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
    recipient: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
    token: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
    deposit: 10_000_000n,
    flowRate: 100n,
    startTime: t - 1000,
    endTime: t + 7200,
    lastWithdrawTime: t - 1000,
    status: 'Active',
    autoRenew: false,
  } as Stream;
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue #907 — resolveConditionalParam: branch map with 'byteLength' key
// ─────────────────────────────────────────────────────────────────────────────

describe('Issue #907: resolveConditionalParam correctly handles a branch map keyed "byteLength"', () => {
  const ctx: TemplateTokenContext = { tokenType: 'byteLength', decimals: 7 };
  const ctxOther: TemplateTokenContext = { tokenType: 'native', decimals: 7 };

  it('resolves a ConditionalBranchMap whose only key is "byteLength" (numeric value)', () => {
    // The old guard: `typeof value.byteLength !== 'number'` would see
    // byteLength === 100n (a bigint, not a number) — but let's also test the
    // exact numeric case that triggered the bug.
    const branchMap = conditionalByTokenType<bigint>(
      { byteLength: 100n },
      42n, // default
    );

    // tokenType === 'byteLength' — should resolve to the branch value, not fall
    // through to the else branch (which would have returned the map itself).
    const result = resolveConditionalParam(branchMap, ctx);
    expect(result).toBe(100n);
  });

  it('resolves a branch map keyed "byteLength" with a numeric bigint value via the default', () => {
    // No branch for 'native', should fall back to default.
    const branchMap = conditionalByTokenType<bigint>({ byteLength: 999n }, 77n);
    const result = resolveConditionalParam(branchMap, ctxOther);
    expect(result).toBe(77n);
  });

  it('a plain number-valued "byteLength" branch is still correctly identified as a branch map', () => {
    // This is the exact case the old heuristic broke: a plain object with a
    // numeric `byteLength` property was misidentified as buffer-like.
    const branchMap: Record<string, number> & { default?: number } = {
      byteLength: 12,       // numeric — was the culprit
      native: 7,
      default: 1,
    };

    // Should be treated as a ConditionalBranchMap<number>, not returned as-is.
    const resultByteLength = resolveConditionalParam(
      branchMap as unknown as Parameters<typeof resolveConditionalParam>[0],
      { tokenType: 'byteLength', decimals: 7 },
    );
    expect(resultByteLength).toBe(12);

    const resultNative = resolveConditionalParam(
      branchMap as unknown as Parameters<typeof resolveConditionalParam>[0],
      { tokenType: 'native', decimals: 7 },
    );
    expect(resultNative).toBe(7);

    const resultUnknown = resolveConditionalParam(
      branchMap as unknown as Parameters<typeof resolveConditionalParam>[0],
      { tokenType: 'volatile', decimals: 7 },
    );
    expect(resultUnknown).toBe(1); // default
  });

  it('real ArrayBuffer / TypedArray values still pass through unresolved (buffer-like guard preserved)', () => {
    const ab = new ArrayBuffer(8);
    const u8 = new Uint8Array(8);
    const dv = new DataView(new ArrayBuffer(4));

    // These are real binary objects, not branch maps — must pass through as-is.
    const resultAb = resolveConditionalParam(ab as unknown as bigint, ctx);
    expect(resultAb).toBe(ab);

    const resultU8 = resolveConditionalParam(u8 as unknown as bigint, ctx);
    expect(resultU8).toBe(u8);

    const resultDv = resolveConditionalParam(dv as unknown as bigint, ctx);
    expect(resultDv).toBe(dv);
  });

  it('static bigint values pass through unchanged (regression guard)', () => {
    const result = resolveConditionalParam(999n, ctx);
    expect(result).toBe(999n);
  });

  it('function resolvers still work alongside branch maps (regression guard)', () => {
    const resolver = (c: TemplateTokenContext) => BigInt(c.decimals) * 2n;
    expect(resolveConditionalParam(resolver, { tokenType: 'native', decimals: 7 })).toBe(14n);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #910 — getWithRevalidate corrupt-storage path
// ─────────────────────────────────────────────────────────────────────────────

describe('Issue #910: getWithRevalidate corrupt-storage path triggers refresh and repopulates cache', () => {
  it('returns value=undefined for a corrupt entry and still resolves refresh()', async () => {
    const { adapter, store } = memoryAdapterWithStore();
    const cache = new LocalStorageStreamCache(adapter);

    // Write a deliberately corrupt JSON value directly into the backing store
    // to simulate a storage entry that was corrupted outside the SDK.
    const corruptKey = 'sorostream_stream_cache:testnet:stream-corrupt';
    store.set(corruptKey, 'NOT VALID JSON {{{');

    const freshStream = stream('stream-corrupt');
    const refresh = vi.fn().mockResolvedValue(freshStream);

    const { value, refresh: refreshPromise } = cache.getWithRevalidate(
      'testnet',
      'stream-corrupt',
      refresh,
    );

    // Corrupt storage must yield undefined synchronously.
    expect(value).toBeUndefined();

    // refresh() must still be called and the promise must resolve.
    const resolved = await refreshPromise;
    expect(resolved.id).toBe('stream-corrupt');
    expect(refresh).toHaveBeenCalledOnce();

    // After resolution the refreshed stream must be in the cache.
    const cached = cache.get('testnet', 'stream-corrupt');
    expect(cached).toBeDefined();
    expect(cached?.id).toBe('stream-corrupt');
  });

  it('returns value=undefined for a structurally valid JSON entry that fails deserialization', async () => {
    const { adapter, store } = memoryAdapterWithStore();
    const cache = new LocalStorageStreamCache(adapter);

    // Write a structurally valid JSON object that passes JSON.parse but will
    // fail the internal deserializeStream call (missing required fields).
    const badEntry = JSON.stringify({ stream: { not: 'a real stream' }, cachedAt: Date.now() });
    store.set('sorostream_stream_cache:testnet:stream-bad', badEntry);

    const freshStream = stream('stream-bad');
    const refresh = vi.fn().mockResolvedValue(freshStream);

    const { value, refresh: refreshPromise } = cache.getWithRevalidate(
      'testnet',
      'stream-bad',
      refresh,
    );

    expect(value).toBeUndefined();

    await refreshPromise;
    expect(refresh).toHaveBeenCalledOnce();

    // Cache must be repopulated from refresh.
    expect(cache.get('testnet', 'stream-bad')?.id).toBe('stream-bad');
  });

  it('a rejected refresh() leaves the cache empty and the returned promise rejects', async () => {
    const cache = new LocalStorageStreamCache(memoryAdapter());
    const refreshError = new Error('RPC timeout');
    const refresh = vi.fn().mockRejectedValue(refreshError);

    const { value, refresh: refreshPromise } = cache.getWithRevalidate(
      'testnet',
      'stream-missing',
      refresh,
    );

    expect(value).toBeUndefined();

    await expect(refreshPromise).rejects.toThrow('RPC timeout');

    // Nothing written — the cache for this stream must still be empty.
    expect(cache.get('testnet', 'stream-missing')).toBeUndefined();
  });

  it('a synchronously throwing refresh() wraps the error in a rejected promise', async () => {
    const cache = new LocalStorageStreamCache(memoryAdapter());
    const refresh = vi.fn().mockImplementation(() => {
      throw new Error('synchronous boom');
    });

    const { refresh: refreshPromise } = cache.getWithRevalidate(
      'testnet',
      'stream-sync-throw',
      refresh,
    );

    // Must be a Promise (not a thrown exception), and it must reject.
    await expect(refreshPromise).rejects.toThrow('synchronous boom');
  });

  it('a valid cached entry still returns the stale value while refresh runs', async () => {
    const cache = new LocalStorageStreamCache(memoryAdapter(), 1); // 1 ms TTL (immediately stale)
    const s = stream('stream-stale');
    cache.set('testnet', s);

    // Let the entry go stale.
    await new Promise((r) => setTimeout(r, 5));

    const freshStream = { ...s, lastWithdrawTime: 1_700_009_999 } as Stream;
    const refresh = vi.fn().mockResolvedValue(freshStream);

    const { value, refresh: refreshPromise } = cache.getWithRevalidate(
      'testnet',
      'stream-stale',
      refresh,
    );

    // getWithRevalidate bypasses the freshness window and returns stale value.
    expect(value?.id).toBe('stream-stale');

    await refreshPromise;

    // After refresh, cache holds the updated value.
    expect(cache.get('testnet', 'stream-stale')?.lastWithdrawTime).toBe(1_700_009_999);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #911 — loadSorostreamConfig: missing vs broken config file
// ─────────────────────────────────────────────────────────────────────────────

describe('Issue #911: loadSorostreamConfig distinguishes missing file from existing-but-broken', () => {
  it('returns null silently for a directory with no config file (missing = expected)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sorostream-empty-'));
    try {
      const result = await loadSorostreamConfig(dir);
      expect(result).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws for a config file that exists but contains a SyntaxError', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sorostream-broken-'));
    writeFileSync(join(dir, 'sorostream.config.js'), 'module.exports = { THIS IS NOT VALID JS }', 'utf-8');
    try {
      await expect(loadSorostreamConfig(dir)).rejects.toThrow(/sorostream\.config\.js/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the thrown error message names the file path that failed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sorostream-broken2-'));
    const cfgPath = join(dir, 'sorostream.config.js');
    writeFileSync(cfgPath, '!!!', 'utf-8');
    try {
      let caughtMessage = '';
      try {
        await loadSorostreamConfig(dir);
      } catch (e) {
        caughtMessage = (e as Error).message;
      }
      expect(caughtMessage).toContain('sorostream.config.js');
      expect(caughtMessage).toContain('Failed to load');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a broken .js file stops the search — the next .mjs candidate is NOT tried', async () => {
    // If .js is broken the error surfaces immediately; a valid .mjs sibling
    // must NOT be silently loaded in its place, because the developer
    // intended .js to be their config.
    const dir = mkdtempSync(join(tmpdir(), 'sorostream-broken-with-fallback-'));
    writeFileSync(join(dir, 'sorostream.config.js'), 'module.exports = { BROKEN }', 'utf-8');
    writeFileSync(
      join(dir, 'sorostream.config.mjs'),
      'export default { network: "testnet" };',
      'utf-8',
    );
    try {
      await expect(loadSorostreamConfig(dir)).rejects.toThrow(/sorostream\.config\.js/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a valid config file still loads correctly after the broken-file fix (regression guard)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sorostream-valid-'));
    writeFileSync(
      join(dir, 'sorostream.config.js'),
      'module.exports = { network: "testnet", timeoutMs: 30000 };',
      'utf-8',
    );
    try {
      const cfg = await loadSorostreamConfig(dir);
      expect(cfg).not.toBeNull();
      expect(cfg!.network).toBe('testnet');
      expect(cfg!.timeoutMs).toBe(30_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a directory with no config file still returns null after the fix (regression guard)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sorostream-no-cfg-'));
    // Write an unrelated file to ensure the directory is non-empty.
    writeFileSync(join(dir, 'README.md'), '# project', 'utf-8');
    try {
      const cfg = await loadSorostreamConfig(dir);
      expect(cfg).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #912 — isStorageExpired: ledger parameter override
// ─────────────────────────────────────────────────────────────────────────────

describe('Issue #912: isStorageExpired accepts a ledger override parameter matching simulateWithdraw', () => {
  it('uses the simulator current ledger by default (backward-compatible)', () => {
    const sim = new StreamSimulator();
    const id = 'stream-ledger-default';
    sim.setStorageTtlLedger(id, 1000);

    sim.setLedger(999);
    expect(sim.isStorageExpired(id)).toBe(false);

    sim.setLedger(1000);
    expect(sim.isStorageExpired(id)).toBe(true);
  });

  it('explicit ledger override is used instead of the simulator current ledger', () => {
    const sim = new StreamSimulator();
    const id = 'stream-ledger-override';
    sim.setStorageTtlLedger(id, 2000);

    // Simulator is at ledger 500 (not expired by default), but passing
    // ledger=2000 as override should report expired.
    sim.setLedger(500);
    expect(sim.isStorageExpired(id)).toBe(false);           // default: not expired
    expect(sim.isStorageExpired(id, sim.now(), 2000)).toBe(true);  // override: expired
    expect(sim.isStorageExpired(id, sim.now(), 1999)).toBe(false); // override: not yet
  });

  it('explicit ledger override matches the behaviour of simulateWithdraw opts.ledger', () => {
    const sim = new StreamSimulator();
    const s = makeActiveStream('stream-parity');
    sim.setStorageTtlLedger(s.id, 5000);
    sim.setLedger(100);

    // Both helpers agree at opts.ledger = 5000 (expired).
    const withdrawResult = sim.simulateWithdraw(s, undefined, { ledger: 5000 });
    expect(withdrawResult.success).toBe(false);
    expect(withdrawResult.reason).toBe('storageExpired');

    expect(sim.isStorageExpired(s.id, sim.now(), 5000)).toBe(true);

    // Both agree at opts.ledger = 4999 (not yet expired).
    const withdrawResultOk = sim.simulateWithdraw(s, undefined, { ledger: 4999 });
    expect(withdrawResultOk.success).toBe(true);

    expect(sim.isStorageExpired(s.id, sim.now(), 4999)).toBe(false);
  });

  it('the ledger override does not mutate simulator state', () => {
    const sim = new StreamSimulator();
    const id = 'stream-no-mutate';
    sim.setStorageTtlLedger(id, 1000);
    sim.setLedger(50);

    // Call with an override that fires expiry.
    sim.isStorageExpired(id, sim.now(), 1000);

    // Simulator ledger sequence is unchanged.
    expect(sim.getLedger()).toBe(50);
    // A subsequent default call uses ledger 50, which is not expired.
    expect(sim.isStorageExpired(id)).toBe(false);
  });

  it('timestamp-based TTL still works independently of the ledger override', () => {
    const sim = new StreamSimulator();
    const id = 'stream-ts-ttl';
    // Set a timestamp TTL 1 second in the past.
    sim.setStorageTtl(id, sim.now() - 1);
    sim.setStorageTtlLedger(id, 99_999); // far future ledger

    // Timestamp expired — should be true regardless of ledger override.
    expect(sim.isStorageExpired(id, sim.now(), 0)).toBe(true);
    expect(sim.isStorageExpired(id, sim.now(), 50)).toBe(true);
  });

  it('no TTL set means never expired regardless of ledger override', () => {
    const sim = new StreamSimulator();
    const id = 'stream-no-ttl';
    sim.setLedger(999_999);

    expect(sim.isStorageExpired(id)).toBe(false);
    expect(sim.isStorageExpired(id, sim.now(), 999_999)).toBe(false);
  });
});
