import { afterEach, describe, expect, it, vi } from 'vitest';
import { StreamMonitor } from '../src/stream-monitor.js';
import { createRpcCompatTransport, parseApiMajorVersion } from '../src/rpc-compat.js';
import type { RpcVersion } from '../src/rpc-compat.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('StreamMonitor.stop() idempotency (#879)', () => {
  it('can be called multiple times without error or repeated cleanup', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const abortSpy = vi.spyOn(AbortController.prototype, 'abort');
    const monitor = new StreamMonitor(
      ['stream-1'],
      {
        getStream: vi.fn(() => new Promise<never>(() => {})),
        getClaimable: vi.fn(() => new Promise<never>(() => {})),
      },
      { pollIntervalMs: 60_000 },
    );

    expect(() => monitor.stop()).not.toThrow();
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(abortSpy).toHaveBeenCalledTimes(1);

    expect(() => monitor.stop()).not.toThrow();
    expect(() => monitor.stop()).not.toThrow();
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(abortSpy).toHaveBeenCalledTimes(1);
  });
});

describe('parseApiMajorVersion (#880)', () => {
  it.each<[unknown, number | null]>([
    [3, 3],
    [1, 1],
    [2.9, 2],
    [-1, -1],
    ['3', 3],
    ['v3', 3],
    ['V2', 2],
    ['3.0.1', 3],
    ['v2.1', 2],
    ['  v4  ', 4],
    ['abc', null],
    ['', null],
    ['vX', null],
    ['-1', null],
    [Number.NaN, null],
    [Number.POSITIVE_INFINITY, null],
    [null, null],
    [undefined, null],
    [{}, null],
  ])('parseApiMajorVersion(%j) -> %j', (input, expected) => {
    expect(parseApiMajorVersion(input)).toBe(expected);
  });
});

describe('createRpcCompatTransport auto-detect memoization (#881)', () => {
  it('probes once and notifies once for concurrent calls before detection resolves', async () => {
    let resolveProbe!: (res: Response) => void;
    const probeResponse = new Promise<Response>((resolve) => {
      resolveProbe = resolve;
    });
    let probeCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith('/v2/health')) {
        probeCalls++;
        return probeResponse;
      }
      return Promise.reject(new Error('unexpected request'));
    });
    vi.stubGlobal('fetch', fetchMock);

    const onVersionDetected = vi.fn();
    const transport = createRpcCompatTransport('https://rpc.example.com', { onVersionDetected });

    const calls = [
      transport.getAccount('GABC').catch(() => undefined),
      transport.getHealth().catch(() => undefined),
      transport.getLatestLedger().catch(() => undefined),
    ];

    resolveProbe(new Response('not found', { status: 404 }));
    await Promise.all(calls);

    expect(probeCalls).toBe(1);
    expect(onVersionDetected).toHaveBeenCalledTimes(1);
    expect(onVersionDetected).toHaveBeenCalledWith(
      expect.objectContaining({ version: 'v1', autoDetected: true }),
    );
  });
});

describe('createRpcCompatTransport unrecognised explicit rpcVersion (#882)', () => {
  it('warns and falls back to v1 with autoDetected false', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onVersionDetected = vi.fn();

    createRpcCompatTransport('https://rpc.example.com', {
      rpcVersion: 'v3' as RpcVersion,
      onVersionDetected,
    });

    expect(warnSpy).toHaveBeenCalled();
    expect(onVersionDetected).toHaveBeenCalledTimes(1);
    expect(onVersionDetected).toHaveBeenCalledWith(
      expect.objectContaining({ version: 'v1', autoDetected: false }),
    );
  });
});
