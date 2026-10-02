import { describe, it, expect, vi } from 'vitest';
import { computeBackoffDelay, RetryBackoff, withRetry } from '../src/retry.js';
import { ReplayTransport, ReplayFixtureError } from '../src/replayTransport.js';
import type { FixtureFile } from '../src/replayTransport.js';
import { createFederationPlugin } from '../src/federationPlugin.js';
import type { FederationCacheEntry } from '../src/federationPlugin.js';
import type { MiddlewareContext } from '../src/types.js';

// ── #632: custom backoff strategies ─────────────────────────────────────────

describe('computeBackoffDelay (#632)', () => {
  it('defaults to exponential', () => {
    expect([0, 1, 2, 3].map((a) => computeBackoffDelay(a, 100, 10_000))).toEqual([
      100, 200, 400, 800,
    ]);
  });

  it('supports linear and constant', () => {
    expect([0, 1, 2].map((a) => computeBackoffDelay(a, 100, 10_000, 'linear'))).toEqual([
      100, 200, 300,
    ]);
    expect([0, 1, 2].map((a) => computeBackoffDelay(a, 100, 10_000, 'constant'))).toEqual([
      100, 100, 100,
    ]);
  });

  it('supports a custom function, capped at maxDelayMs', () => {
    const fn = (attempt: number, base: number) => base + attempt * 1_000;
    expect(computeBackoffDelay(0, 50, 1_500, fn)).toBe(50);
    expect(computeBackoffDelay(5, 50, 1_500, fn)).toBe(1_500);
  });

  it('treats negative / NaN custom delays as 0', () => {
    expect(computeBackoffDelay(0, 100, 1_000, () => -5)).toBe(0);
    expect(computeBackoffDelay(0, 100, 1_000, () => NaN)).toBe(0);
  });
});

describe('RetryBackoff / withRetry with custom backoff (#632)', () => {
  it('RetryBackoff uses the strategy without jitter when jitter: false', () => {
    const b = new RetryBackoff({ baseDelayMs: 100, backoff: 'linear', jitter: false });
    expect([b.onFailure('k'), b.onFailure('k'), b.onFailure('k')]).toEqual([100, 200, 300]);
  });

  it('withRetry calls a custom backoff function with the attempt index', async () => {
    const backoff = vi.fn(() => 0);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('a'))
      .mockRejectedValueOnce(new Error('b'))
      .mockResolvedValue('ok');
    await expect(withRetry(fn, { maxAttempts: 3, backoff, jitter: false })).resolves.toBe('ok');
    expect(backoff.mock.calls.map((c) => c[0])).toEqual([0, 1]);
  });
});

// ── #631: replay filtering ──────────────────────────────────────────────────

const fixture: FixtureFile = {
  recordedAt: '2026-01-01T00:00:00.000Z',
  entries: [
    { method: 'getHealth', request: {}, response: { status: 'healthy' } },
    { method: 'getLatestLedger', request: {}, response: { sequence: 1 } },
    { method: 'getLatestLedger', request: {}, response: { sequence: 2 } },
  ],
};

describe('ReplayTransport filtering (#631)', () => {
  it('only replays methods listed in `methods`', async () => {
    const t = ReplayTransport.replay(fixture, { methods: ['getLatestLedger'] });
    await expect(t.getLatestLedger()).resolves.toEqual({ sequence: 1 });
    await expect(t.getHealth()).rejects.toBeInstanceOf(ReplayFixtureError);
  });

  it('applies a custom filter predicate', async () => {
    const t = ReplayTransport.replay(fixture, {
      filter: (e) => (e.response as { sequence?: number }).sequence !== 1,
    });
    await expect(t.getLatestLedger()).resolves.toEqual({ sequence: 2 });
    await expect(t.getHealth()).resolves.toEqual({ status: 'healthy' });
  });

  it('replays everything when no filter is given', async () => {
    const t = ReplayTransport.replay(fixture);
    await expect(t.getLatestLedger()).resolves.toEqual({ sequence: 1 });
    await expect(t.getLatestLedger()).resolves.toEqual({ sequence: 2 });
  });
});

// ── #629: federation lookup caching ─────────────────────────────────────────

const G = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

function mockFetch() {
  return vi.fn(async (url: string) => {
    if (url.includes('stellar.toml')) {
      return new Response('FEDERATION_SERVER="https://fed.example.com/federation"');
    }
    return new Response(JSON.stringify({ account_id: G }));
  });
}

function ctx(recipient: string): MiddlewareContext {
  return { method: 'createStream', args: [{ recipient }] };
}

describe('federation plugin caching (#629)', () => {
  it('reuses a cached lookup across calls', async () => {
    const fetch = mockFetch();
    const plugin = createFederationPlugin({ fetch });
    const a = ctx('alice*example.com');
    const b = ctx('alice*example.com');
    await plugin.before!(a);
    await plugin.before!(b);
    expect((b.args[0] as { recipient: string }).recipient).toBe(G);
    expect(fetch).toHaveBeenCalledTimes(2); // toml + federation, once
  });

  it('deduplicates concurrent lookups for the same address', async () => {
    const fetch = mockFetch();
    const plugin = createFederationPlugin({ fetch });
    await Promise.all([1, 2, 3].map(() => plugin.before!(ctx('alice*example.com'))));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('shares a cache between plugin instances and supports clearCache()', async () => {
    const fetch = mockFetch();
    const shared = new Map<string, FederationCacheEntry>();
    const p1 = createFederationPlugin({ fetch, cache: shared });
    const p2 = createFederationPlugin({ fetch, cache: shared });
    await p1.before!(ctx('alice*example.com'));
    await p2.before!(ctx('alice*example.com'));
    expect(fetch).toHaveBeenCalledTimes(2);

    p2.clearCache();
    await p1.before!(ctx('alice*example.com'));
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
