import { describe, it, expect, vi, beforeEach } from 'vitest';
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

function makeCtx(method: string, args: unknown[]): MiddlewareContext & { args: unknown[] } {
  return { method, args };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createFederationPlugin (issue #401)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a SoroStreamPlugin with a before hook', () => {
    const plugin = createFederationPlugin();
    expect(typeof plugin.before).toBe('function');
  });

  it('resolves a federation address in recipient before createStream', async () => {
    const fetchMock = makeFetchThatResolves();
    const plugin = createFederationPlugin({ fetch: fetchMock as any });

    const params = { recipient: 'alice*example.com', token: 'G...', amount: 1000n };
    const ctx = makeCtx('createStream', [params]);

    await plugin.before!(ctx);

    expect(params.recipient).toBe(MOCK_STELLAR_ADDRESS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not modify recipient when it is already a G-address', async () => {
    const fetchMock = vi.fn();
    const plugin = createFederationPlugin({ fetch: fetchMock as any });

    const params = { recipient: MOCK_STELLAR_ADDRESS, token: 'G...', amount: 1000n };
    const ctx = makeCtx('createStream', [params]);

    await plugin.before!(ctx);

    expect(params.recipient).toBe(MOCK_STELLAR_ADDRESS);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not modify methods other than createStream', async () => {
    const fetchMock = makeFetchThatResolves();
    const plugin = createFederationPlugin({ fetch: fetchMock as any });

    const params = { recipient: 'alice*example.com' };
    const ctx = makeCtx('withdraw', [params]);

    await plugin.before!(ctx);

    expect(params.recipient).toBe('alice*example.com');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caches resolved addresses and avoids re-fetching within TTL', async () => {
    const fetchMock = makeFetchThatResolves();
    const plugin = createFederationPlugin({
      fetch: fetchMock as any,
      cacheTtlMs: 60_000,
    });

    const params1 = { recipient: 'alice*example.com', token: 'G...', amount: 1000n };
    const params2 = { recipient: 'alice*example.com', token: 'G...', amount: 2000n };

    await plugin.before!(makeCtx('createStream', [params1]));
    await plugin.before!(makeCtx('createStream', [params2]));

    // Only 2 fetches (stellar.toml + federation lookup) for the first call
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(params1.recipient).toBe(MOCK_STELLAR_ADDRESS);
    expect(params2.recipient).toBe(MOCK_STELLAR_ADDRESS);
  });

  it('calls onResolved callback with correct args on first resolution', async () => {
    const fetchMock = makeFetchThatResolves();
    const onResolved = vi.fn();
    const plugin = createFederationPlugin({
      fetch: fetchMock as any,
      onResolved,
    });

    const params = { recipient: 'alice*example.com', token: 'G...', amount: 1000n };
    await plugin.before!(makeCtx('createStream', [params]));

    expect(onResolved).toHaveBeenCalledOnce();
    expect(onResolved).toHaveBeenCalledWith('alice*example.com', MOCK_STELLAR_ADDRESS, false);
  });

  it('calls onResolved with fromCache=true on second call', async () => {
    const fetchMock = makeFetchThatResolves();
    const onResolved = vi.fn();
    const plugin = createFederationPlugin({
      fetch: fetchMock as any,
      onResolved,
    });

    const params = { recipient: 'alice*example.com', token: 'G...', amount: 1000n };
    await plugin.before!(makeCtx('createStream', [params]));

    const params2 = { recipient: 'alice*example.com', token: 'G...', amount: 500n };
    await plugin.before!(makeCtx('createStream', [params2]));

    expect(onResolved).toHaveBeenCalledTimes(2);
    expect(onResolved).toHaveBeenNthCalledWith(2, 'alice*example.com', MOCK_STELLAR_ADDRESS, true);
  });

  it('silently leaves recipient unchanged when resolution fails (throwOnResolutionFailure=false)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 404 });
    const plugin = createFederationPlugin({
      fetch: fetchMock as any,
      throwOnResolutionFailure: false,
    });

    const params = { recipient: 'alice*example.com', token: 'G...', amount: 1000n };
    const ctx = makeCtx('createStream', [params]);

    // Should not throw
    await expect(plugin.before!(ctx)).resolves.toBeUndefined();
    // Recipient left unchanged
    expect(params.recipient).toBe('alice*example.com');
  });

  it('throws when resolution fails and throwOnResolutionFailure=true', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false, status: 404 });
    const plugin = createFederationPlugin({
      fetch: fetchMock as any,
      throwOnResolutionFailure: true,
    });

    const params = { recipient: 'alice*example.com', token: 'G...', amount: 1000n };
    const ctx = makeCtx('createStream', [params]);

    await expect(plugin.before!(ctx)).rejects.toThrow();
  });

  it('handles missing args gracefully', async () => {
    const plugin = createFederationPlugin();
    const ctx = makeCtx('createStream', []);

    // Should not throw
    await expect(plugin.before!(ctx)).resolves.toBeUndefined();
  });

  it('handles null/non-object first arg gracefully', async () => {
    const plugin = createFederationPlugin();
    const ctx = makeCtx('createStream', [null]);

    await expect(plugin.before!(ctx)).resolves.toBeUndefined();
  });
});
