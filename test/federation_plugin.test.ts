import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFederationPlugin } from '../src/federationPlugin.js';
import type { MiddlewareContext } from '../src/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const MOCK_STELLAR_ADDRESS = 'GABC2DEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV';

function makeFetchThatResolves(stellarAddress = MOCK_STELLAR_ADDRESS) {
  return vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      text: async () => `FEDERATION_SERVER="https://federation.example.com"`,
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ account_id: stellarAddress }),
    });
}

function makeFetchThatFails() {
  return vi.fn().mockResolvedValueOnce({ ok: false, status: 404 });
}

function makeCtx(method: string, args: unknown[]): MiddlewareContext & { args: unknown[] } {
  return { method, args };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createFederationPlugin (issue #401)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ... existing tests ...

  it('caches negative results with a short TTL and retries after expiration', async () => {
    // Use a short negative TTL for the test
    const negativeTtlMs = 30; // 30 ms
    const fetchMock = makeFetchThatFails();
    const plugin = createFederationPlugin({
      fetch: fetchMock as any,
      negativeCacheTtlMs: negativeTtlMs,
      throwOnResolutionFailure: false,
    });

    const params = { recipient: 'alice*example.com', token: 'G...', amount: 1000n };
    const ctx = makeCtx('createStream', [params]);

    // First call: fails, caches negative result
    await plugin.before!(ctx);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(params.recipient).toBe('alice*example.com'); // unchanged

    // Second call immediately: should use cached negative result, no new fetch
    const params2 = { recipient: 'alice*example.com', token: 'G...', amount: 500n };
    const ctx2 = makeCtx('createStream', [params2]);
    await plugin.before!(ctx2);
    expect(fetchMock).toHaveBeenCalledTimes(1); // still 1
    expect(params2.recipient).toBe('alice*example.com'); // unchanged

    // Advance time beyond negative TTL
    await vi.advanceTimersByTimeAsync(negativeTtlMs + 1);

    // Third call: should fetch again because negative cache expired
    const params3 = { recipient: 'alice*example.com', token: 'G...', amount: 2000n };
    const ctx3 = makeCtx('createStream', [params3]);
    await plugin.before!(ctx3);
    expect(fetchMock).toHaveBeenCalledTimes(2); // now 2

    // Still fails, so recipient unchanged
    expect(params3.recipient).toBe('alice*example.com');

    // Now make the fetch succeed on the next call
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        text: async () => `FEDERATION_SERVER="https://federation.example.com"`,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ account_id: MOCK_STELLAR_ADDRESS }),
      });

    // The third call's failure cached its own negative result starting at
    // the current (fake) time — advance past its TTL too, or the fourth
    // call would just serve that still-fresh negative cache without fetching.
    await vi.advanceTimersByTimeAsync(negativeTtlMs + 1);

    // Fourth call: should succeed and update recipient
    const params4 = { recipient: 'alice*example.com', token: 'G...', amount: 3000n };
    const ctx4 = makeCtx('createStream', [params4]);
    await plugin.before!(ctx4);
    expect(fetchMock).toHaveBeenCalledTimes(4); // 2 previous + 2 for success
    expect(params4.recipient).toBe(MOCK_STELLAR_ADDRESS);
  });

  it('does not call onResolved for negative cached results', async () => {
    const fetchMock = makeFetchThatFails();
    const onResolved = vi.fn();
    const plugin = createFederationPlugin({
      fetch: fetchMock as any,
      negativeCacheTtlMs: 60_000,
      onResolved,
      throwOnResolutionFailure: false,
    });

    const params = { recipient: 'alice*example.com', token: 'G...', amount: 1000n };
    const ctx = makeCtx('createStream', [params]);

    // First call: fails
    await plugin.before!(ctx);
    expect(onResolved).not.toHaveBeenCalled();

    // Second call: uses cached negative
    const params2 = { recipient: 'alice*example.com', token: 'G...', amount: 500n };
    const ctx2 = makeCtx('createStream', [params2]);
    await plugin.before!(ctx2);
    expect(onResolved).not.toHaveBeenCalled();

    // Advance time beyond TTL
    await vi.advanceTimersByTimeAsync(60_000 + 1);

    // Third call: fails again, still no onResolved
    const params3 = { recipient: 'alice*example.com', token: 'G...', amount: 2000n };
    const ctx3 = makeCtx('createStream', [params3]);
    await plugin.before!(ctx3);
    expect(onResolved).not.toHaveBeenCalled();
  });

  // ── Issue #737: Cache invalidation when account_id changes ──────────────

  it('updates the cache when a second lookup for the same address returns a different account_id (issue #737)', async () => {
    const FIRST_ADDRESS = 'GABC2DEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV';
    const SECOND_ADDRESS = 'GBBB2DEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV';

    const fetchMock = vi.fn();
    // First lookup: toml + federation query → FIRST_ADDRESS
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        text: async () => `FEDERATION_SERVER="https://federation.example.com"`,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ account_id: FIRST_ADDRESS }),
      });

    const cacheTtlMs = 60_000; // 1 minute
    const plugin = createFederationPlugin({
      fetch: fetchMock as any,
      cacheTtlMs,
      throwOnResolutionFailure: true,
    });

    // First lookup: resolves to FIRST_ADDRESS
    const params1 = { recipient: 'alice*example.com', token: 'G...', amount: 1000n };
    const ctx1 = makeCtx('createStream', [params1]);
    await plugin.before!(ctx1);
    expect(params1.recipient).toBe(FIRST_ADDRESS);
    expect(fetchMock).toHaveBeenCalledTimes(2); // toml + federation query

    // Second lookup within TTL: should serve from cache, no new fetch
    const params2 = { recipient: 'alice*example.com', token: 'G...', amount: 500n };
    const ctx2 = makeCtx('createStream', [params2]);
    await plugin.before!(ctx2);
    expect(params2.recipient).toBe(FIRST_ADDRESS); // cached value
    expect(fetchMock).toHaveBeenCalledTimes(2); // still 2, no new fetch

    // Advance time beyond cache TTL so the cached entry expires
    await vi.advanceTimersByTimeAsync(cacheTtlMs + 1);

    // Set up mock for the second round of fetches (after cache expiry) → SECOND_ADDRESS
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        text: async () => `FEDERATION_SERVER="https://federation.example.com"`,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ account_id: SECOND_ADDRESS }),
      });

    // Third lookup: cache expired, should fetch again and get SECOND_ADDRESS
    const params3 = { recipient: 'alice*example.com', token: 'G...', amount: 2000n };
    const ctx3 = makeCtx('createStream', [params3]);
    await plugin.before!(ctx3);
    expect(params3.recipient).toBe(SECOND_ADDRESS); // new value, not stale cache
    expect(fetchMock).toHaveBeenCalledTimes(4); // 2 more calls (toml + federation query)

    // Fourth lookup within the new TTL: should serve the UPDATED cache value
    const params4 = { recipient: 'alice*example.com', token: 'G...', amount: 3000n };
    const ctx4 = makeCtx('createStream', [params4]);
    await plugin.before!(ctx4);
    expect(params4.recipient).toBe(SECOND_ADDRESS); // updated cache, not stale FIRST_ADDRESS
    expect(fetchMock).toHaveBeenCalledTimes(4); // no new fetch — cache was updated
  });

  it('cache entry is updated (not bypassed) after a changed lookup result (issue #737)', async () => {
    const FIRST_ADDRESS = 'GABC2DEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV';
    const SECOND_ADDRESS = 'GBBB2DEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV';

    const fetchMock = vi.fn();
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        text: async () => `FEDERATION_SERVER="https://federation.example.com"`,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ account_id: FIRST_ADDRESS }),
      });

    const cacheTtlMs = 60_000;
    const sharedCache = new Map<string, { stellarAddress: string | null; expiresAt: number }>();
    const plugin = createFederationPlugin({
      fetch: fetchMock as any,
      cacheTtlMs,
      cache: sharedCache as any,
      throwOnResolutionFailure: true,
    });

    // First lookup resolves to FIRST_ADDRESS
    const params1 = { recipient: 'alice*example.com', token: 'G...', amount: 1000n };
    await plugin.before!(makeCtx('createStream', [params1]));
    expect(params1.recipient).toBe(FIRST_ADDRESS);

    // Verify the cache entry stores the first address
    const cachedBefore = sharedCache.get('alice*example.com');
    expect(cachedBefore).toBeDefined();
    expect(cachedBefore!.stellarAddress).toBe(FIRST_ADDRESS);

    // Expire the cache and do a second lookup that returns SECOND_ADDRESS
    await vi.advanceTimersByTimeAsync(cacheTtlMs + 1);

    // Set up mock for the second round of fetches → SECOND_ADDRESS
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        text: async () => `FEDERATION_SERVER="https://federation.example.com"`,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ account_id: SECOND_ADDRESS }),
      });

    const params2 = { recipient: 'alice*example.com', token: 'G...', amount: 2000n };
    await plugin.before!(makeCtx('createStream', [params2]));
    expect(params2.recipient).toBe(SECOND_ADDRESS);

    // Verify the cache entry was updated to the new address (not bypassed)
    const cachedAfter = sharedCache.get('alice*example.com');
    expect(cachedAfter).toBeDefined();
    expect(cachedAfter!.stellarAddress).toBe(SECOND_ADDRESS);
    expect(cachedAfter!.stellarAddress).not.toBe(FIRST_ADDRESS);

    // A third lookup (within new TTL) must use the updated cache — no fetch
    const fetchCountBefore = fetchMock.mock.calls.length;
    const params3 = { recipient: 'alice*example.com', token: 'G...', amount: 3000n };
    await plugin.before!(makeCtx('createStream', [params3]));
    expect(params3.recipient).toBe(SECOND_ADDRESS);
    expect(fetchMock.mock.calls.length).toBe(fetchCountBefore); // no new fetch
  });
});
