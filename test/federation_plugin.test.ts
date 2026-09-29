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
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => `FEDERATION_SERVER="https://federation.example.com"`,
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ account_id: MOCK_STELLAR_ADDRESS }),
    });

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
});