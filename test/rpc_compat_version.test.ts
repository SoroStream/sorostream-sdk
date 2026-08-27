/**
 * Tests for graceful handling of unrecognised Soroban RPC node API versions
 * (issue #413).
 *
 * The SDK must never throw an unhandled error when a node reports an API
 * version it does not recognise — it must fall back gracefully and surface a
 * clear compatibility warning instead.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRpcCompatTransport,
  detectRpcVersion,
  parseApiMajorVersion,
} from '../src/rpc-compat.js';
import type { RpcVersion } from '../src/rpc-compat.js';

/**
 * Lets individual tests sabotage default-transport construction to simulate
 * unexpected failures inside the detection chain (issue #413).
 */
const transportMockState = vi.hoisted(() => ({ failConstruction: false }));

vi.mock('../src/transport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/transport.js')>();
  return {
    ...actual,
    createDefaultRpcTransport: (...args: Parameters<typeof actual.createDefaultRpcTransport>) => {
      if (transportMockState.failConstruction) {
        throw new Error('transport construction exploded');
      }
      return actual.createDefaultRpcTransport(...args);
    },
  };
});

/** Minimal fetch Response stand-in good enough for the probe code paths. */
function fetchOk(body: unknown): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
}

function fetchFails(error: Error): ReturnType<typeof vi.fn> {
  return vi.fn().mockRejectedValue(error);
}

/** Flushes pending microtasks/timers so eager probe promises settle. */
function settle(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('parseApiMajorVersion (issue #413)', () => {
  it('parses numeric versions', () => {
    expect(parseApiMajorVersion(3)).toBe(3);
    expect(parseApiMajorVersion(2.9)).toBe(2);
  });

  it('parses string versions like "3", "v3", and "3.0.1"', () => {
    expect(parseApiMajorVersion('3')).toBe(3);
    expect(parseApiMajorVersion('v3')).toBe(3);
    expect(parseApiMajorVersion('V3')).toBe(3);
    expect(parseApiMajorVersion('3.0.1')).toBe(3);
  });

  it('returns null for values with no recognisable major version', () => {
    expect(parseApiMajorVersion(undefined)).toBeNull();
    expect(parseApiMajorVersion(null)).toBeNull();
    expect(parseApiMajorVersion('healthy')).toBeNull();
    expect(parseApiMajorVersion({})).toBeNull();
    expect(parseApiMajorVersion(NaN)).toBeNull();
  });
});

describe('detectRpcVersion never throws on unrecognised node versions (issue #413)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('classifies a standard v2 health payload as v2 without warnings', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', fetchOk({ status: 'healthy' }));

    await expect(detectRpcVersion('https://rpc.example.com')).resolves.toBe('v2');
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back gracefully (no throw) when the node reports an unrecognised version', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', fetchOk({ status: 'healthy', version: 'v9', latestLedger: 123 }));

    // Must resolve — not reject — even though "v9" is unknown to this SDK build.
    await expect(detectRpcVersion('https://rpc.example.com')).resolves.toBe('v2');

    // A clear compatibility warning is surfaced instead of an error.
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]?.join(' ') ?? '';
    expect(message).toContain('[SoroStream]');
    expect(message).toContain('does not recognise');
    expect(message).toContain('v9');
  });

  it('recognises numeric and nested-style version fields as unsupported majors too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', fetchOk({ status: 'healthy', api_version: 7 }));

    await expect(detectRpcVersion('https://rpc.example.com')).resolves.toBe('v2');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('7'));
  });

  it('does not warn for supported self-reported versions', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', fetchOk({ status: 'healthy', version: '2' }));

    await expect(detectRpcVersion('https://rpc.example.com')).resolves.toBe('v2');
    expect(warn).not.toHaveBeenCalled();
  });

  it('treats a non-JSON health body as v1 instead of throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
      }),
    );

    await expect(detectRpcVersion('https://rpc.example.com')).resolves.toBe('v1');
    expect(warn).not.toHaveBeenCalled();
  });

  it('treats a failed probe as v1 instead of throwing', async () => {
    vi.stubGlobal('fetch', fetchFails(new Error('network down')));

    await expect(detectRpcVersion('https://rpc.example.com')).resolves.toBe('v1');
  });
});

describe('createRpcCompatTransport tolerates unrecognised node versions (issue #413)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reports the mismatch through onVersionDetected while staying functional', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', fetchOk({ status: 'healthy', version: 'v9' }));

    const payloads: unknown[] = [];
    const transport = createRpcCompatTransport('https://rpc.example.com', {
      rpcVersion: 'auto',
      onVersionDetected: (payload) => payloads.push(payload),
    });

    expect(transport.getHealth).toBeTypeOf('function');
    await settle();

    expect(payloads).toEqual([
      {
        version: 'v2',
        rpcUrl: 'https://rpc.example.com',
        autoDetected: true,
        unrecognizedVersion: 'v9',
      },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('does not recognise'));
  });

  it('never leaks an unhandled rejection when the detection chain fails unexpectedly', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const handler = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', handler);

    try {
      vi.stubGlobal('fetch', fetchOk({ status: 'healthy' }));
      transportMockState.failConstruction = true;

      const transport = createRpcCompatTransport('https://rpc.example.com', {
        rpcVersion: 'auto',
      });
      expect(transport.getHealth).toBeTypeOf('function');

      await settle(50);

      // The SDK surfaced a clear warning instead of an unhandled error…
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('falling back'), expect.any(Error));
      // …and nothing escaped as an unhandled rejection.
      expect(unhandled).toEqual([]);
    } finally {
      transportMockState.failConstruction = false;
      process.off('unhandledRejection', handler);
    }
  });

  it('stays silent and rejection-free when only the probe network request fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onVersionDetected = vi.fn();
    const unhandled: unknown[] = [];
    const handler = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', handler);

    try {
      vi.stubGlobal('fetch', fetchFails(new Error('connection refused')));

      createRpcCompatTransport('https://rpc.example.com', {
        rpcVersion: 'auto',
        onVersionDetected,
      });

      await settle(50);

      // Probe failures degrade to v1 quietly; no errors escape anywhere.
      expect(warn).not.toHaveBeenCalled();
      expect(onVersionDetected).toHaveBeenCalledWith({
        version: 'v1',
        rpcUrl: 'https://rpc.example.com',
        autoDetected: true,
      });
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', handler);
    }
  });

  it('survives a throwing onVersionDetected consumer callback', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const transport = createRpcCompatTransport('https://rpc.example.com', {
      rpcVersion: 'v1',
      onVersionDetected: () => {
        throw new Error('consumer bug');
      },
    });

    expect(transport.getAccount).toBeTypeOf('function');
    expect(warn).toHaveBeenCalledWith(
      '[SoroStream] onVersionDetected callback threw:',
      expect.any(Error),
    );
  });

  it('warns and falls back to v1 for an explicit-but-unrecognised version override', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const payloads: unknown[] = [];

    const transport = createRpcCompatTransport('https://rpc.example.com', {
      // Plain-JS callers can pass anything; the runtime guard must cope.
      rpcVersion: 'v4' as RpcVersion,
      onVersionDetected: (payload) => payloads.push(payload),
    });

    expect(transport.getHealth).toBeTypeOf('function');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Unknown rpcVersion "v4"'));
    expect(payloads).toEqual([
      { version: 'v1', rpcUrl: 'https://rpc.example.com', autoDetected: false },
    ]);
  });
});
