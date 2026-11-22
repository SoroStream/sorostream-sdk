import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRpcCompatTransport } from '../src/rpc-compat.js';
import { StreamMonitor } from '../src/stream-monitor.js';

describe('Issue #915: RpcV2TransportAdapter.postV2 non-OK error message', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('includes the status code and response body text in the thrown error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('upstream overloaded', { status: 503 })),
    );
    const transport = createRpcCompatTransport('https://rpc.example', { rpcVersion: 'v2' });

    const err = await transport.getHealth().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('503');
    expect((err as Error).message).toContain('upstream overloaded');
  });

  it('falls back to an empty body when response.text() rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        text: () => Promise.reject(new Error('body stream failed')),
      })),
    );
    const transport = createRpcCompatTransport('https://rpc.example', { rpcVersion: 'v2' });

    await expect(transport.getHealth()).rejects.toThrow('RPC v2 health failed (500): ');
    await expect(transport.getHealth()).rejects.not.toThrow('body stream failed');
  });
});

describe("Issue #916: config.onError and 'monitorError' listeners both fire", () => {
  it('invokes both config.onError and monitor.on("monitorError") once for one failure', async () => {
    const failure = new Error('rpc down');
    const onError = vi.fn();
    const listener = vi.fn();

    const monitor = new StreamMonitor(
      ['stream-1'],
      {
        getStream: vi.fn().mockRejectedValue(failure),
        getClaimable: vi.fn(),
      },
      { pollIntervalMs: 60_000, onError },
    );
    monitor.on('monitorError', listener);

    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    monitor.stop();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith({ streamId: 'stream-1', error: failure });
    expect(listener).toHaveBeenCalledWith({ streamId: 'stream-1', error: failure });
  });
});
