import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { nativeToScVal, xdr } from '@stellar/stellar-sdk';

import { SoroStreamClient } from '../src/SoroStreamClient.js';
import { RequestDeduplicator, dedupKey } from '../src/requestDeduplicator.js';
import { StreamNotFoundError } from '../src/errors.js';
import type { WalletAdapter } from '../src/types.js';

const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const SENDER = 'GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF';
const RECIPIENT = 'GAXXZ5XSL2VTQPGWB3LPU5273HSJXMK7VHLZTF2XKW65QFZVA3XKULQZ';
const TOKEN = 'CAVTXNC2WCHINDNP4VBLSOQA2667VE3RPQZNGD5TFI4U2QSHTVAC667T';

/** Builds the ScVal a contract would return for `get_stream`. */
function streamScVal(id: string, overrides: Record<string, unknown> = {}): xdr.ScVal {
  return nativeToScVal(
    {
      id,
      sender: SENDER,
      recipient: RECIPIENT,
      token: TOKEN,
      deposit: 1_000_000n,
      flow_rate: 100n,
      start_time: 1_700_000_000,
      end_time: 1_700_010_000,
      last_withdraw_time: 1_700_000_000,
      status: 'Active',
      auto_renew: false,
      ...overrides,
    },
    {
      type: {
        id: ['symbol', 'string'],
        sender: ['symbol', 'string'],
        recipient: ['symbol', 'string'],
        token: ['symbol', 'string'],
        deposit: ['symbol', 'i128'],
        flow_rate: ['symbol', 'i128'],
        start_time: ['symbol', 'u64'],
        end_time: ['symbol', 'u64'],
        last_withdraw_time: ['symbol', 'u64'],
        status: ['symbol', 'string'],
        auto_renew: ['symbol', 'bool'],
      },
    },
  );
}

function makeClient(options: Record<string, unknown> = {}): SoroStreamClient {
  const adapter: WalletAdapter = {
    getPublicKey: vi.fn().mockResolvedValue(SENDER),
    signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
    isConnected: vi.fn().mockResolvedValue(true),
  };
  return new SoroStreamClient({
    network: 'testnet',
    contractId: CONTRACT_ID,
    walletAdapter: adapter,
    skipVersionCheck: true,
    skipPeerCheck: true,
    ryowTimeoutMs: 0,
    ...options,
  });
}

// ── RequestDeduplicator unit tests ───────────────────────────────────────────

describe('RequestDeduplicator (#426)', () => {
  it('collapses concurrent calls for the same key into one request', async () => {
    const dedup = new RequestDeduplicator();
    let calls = 0;

    const factory = async (): Promise<number> => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return 42;
    };

    const results = await Promise.all(Array.from({ length: 5 }, () => dedup.dedupe('k', factory)));

    expect(calls).toBe(1);
    expect(results).toEqual([42, 42, 42, 42, 42]);
    expect(dedup.stats()).toMatchObject({
      requests: 5,
      started: 1,
      deduplicated: 4,
      inFlight: 0,
    });
  });

  it('does not share requests across different keys', async () => {
    const dedup = new RequestDeduplicator();
    let calls = 0;
    const factory = async (): Promise<number> => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return calls;
    };

    await Promise.all([dedup.dedupe('a', factory), dedup.dedupe('b', factory)]);
    expect(calls).toBe(2);
    expect(dedup.stats().deduplicated).toBe(0);
  });

  it('starts a fresh request once the previous one settled', async () => {
    const dedup = new RequestDeduplicator();
    let calls = 0;
    const factory = async (): Promise<number> => ++calls;

    await dedup.dedupe('k', factory);
    await dedup.dedupe('k', factory);

    expect(calls).toBe(2);
    expect(dedup.size).toBe(0);
  });

  it('propagates a rejection to every joined caller and does not cache it', async () => {
    const dedup = new RequestDeduplicator();
    let calls = 0;
    const factory = async (): Promise<number> => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      throw new Error('boom');
    };

    const settled = await Promise.allSettled([
      dedup.dedupe('k', factory),
      dedup.dedupe('k', factory),
    ]);

    expect(calls).toBe(1);
    expect(settled.every((s) => s.status === 'rejected')).toBe(true);
    expect(dedup.has('k')).toBe(false);

    // A later caller retries instead of receiving the cached failure.
    await expect(dedup.dedupe('k', factory)).rejects.toThrow('boom');
    expect(calls).toBe(2);
  });

  it('normalises a synchronously throwing factory into a rejection', async () => {
    const dedup = new RequestDeduplicator();
    await expect(
      dedup.dedupe('k', () => {
        throw new Error('sync boom');
      }),
    ).rejects.toThrow('sync boom');
    expect(dedup.size).toBe(0);
  });

  it('runs every call independently when disabled', async () => {
    const dedup = new RequestDeduplicator({ enabled: false });
    let calls = 0;
    const factory = async (): Promise<number> => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return calls;
    };

    await Promise.all([dedup.dedupe('k', factory), dedup.dedupe('k', factory)]);
    expect(calls).toBe(2);
    expect(dedup.stats().deduplicated).toBe(0);
  });

  it('reports the deduplicated key through the callback', async () => {
    const seen: string[] = [];
    const dedup = new RequestDeduplicator({ onDeduplicated: (key) => seen.push(key) });
    const factory = async (): Promise<void> => {
      await new Promise((r) => setTimeout(r, 5));
    };
    await Promise.all([dedup.dedupe('shared', factory), dedup.dedupe('shared', factory)]);
    expect(seen).toEqual(['shared']);
  });

  it('clear() detaches tracking without breaking existing callers', async () => {
    const dedup = new RequestDeduplicator();
    let calls = 0;
    const factory = async (): Promise<number> => {
      const attempt = ++calls;
      await new Promise((r) => setTimeout(r, 10));
      return attempt;
    };

    const first = dedup.dedupe('k', factory);
    dedup.clear();
    const second = dedup.dedupe('k', factory);

    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(calls).toBe(2);
  });

  it('dedupKey builds order-independent, stable keys', () => {
    expect(dedupKey('getStream', 'testnet', '42')).toBe('getStream|testnet|42');
    expect(dedupKey('q', undefined)).toBe(dedupKey('q', null));
    expect(dedupKey('q', { limit: 20, cursor: '5' })).toBe(
      dedupKey('q', { cursor: '5', limit: 20 }),
    );
    expect(dedupKey('q', { limit: 20 })).not.toBe(dedupKey('q', { limit: 21 }));
  });
});

// ── Client integration ───────────────────────────────────────────────────────

describe('SoroStreamClient read deduplication (#426)', () => {
  let client: SoroStreamClient;

  beforeEach(() => {
    client = makeClient();
  });

  afterEach(() => {
    client.destroy();
    vi.restoreAllMocks();
  });

  it('five concurrent getStream calls for the same ID issue one RPC call', async () => {
    let rpcCalls = 0;
    vi.spyOn(client as never as { simulateOp: unknown }, 'simulateOp').mockImplementation(
      async () => {
        rpcCalls++;
        await new Promise((r) => setTimeout(r, 10));
        return { result: { retval: streamScVal('7') }, latestLedger: 1 } as never;
      },
    );

    const results = await Promise.all(Array.from({ length: 5 }, () => client.getStream('7')));

    expect(rpcCalls).toBe(1);
    expect(results).toHaveLength(5);
    for (const stream of results) {
      expect(stream.id).toBe('7');
      // Every caller observes the exact same resolved object.
      expect(stream).toBe(results[0]);
    }
    expect(client.getRequestStats()).toMatchObject({ started: 1, deduplicated: 4 });
  });

  it('does not deduplicate different stream IDs', async () => {
    const ids: string[] = [];
    vi.spyOn(client as never as { simulateOp: unknown }, 'simulateOp').mockImplementation(
      async (op: unknown) => {
        void op;
        const id = String(ids.length + 1);
        ids.push(id);
        await new Promise((r) => setTimeout(r, 5));
        return { result: { retval: streamScVal(id) }, latestLedger: 1 } as never;
      },
    );

    await Promise.all([client.getStream('1'), client.getStream('2')]);
    expect(ids).toHaveLength(2);
    expect(client.getRequestStats().deduplicated).toBe(0);
  });

  it('rejects every joined caller when the shared request fails, then retries', async () => {
    let rpcCalls = 0;
    vi.spyOn(client as never as { simulateOp: unknown }, 'simulateOp').mockImplementation(
      async () => {
        rpcCalls++;
        await new Promise((r) => setTimeout(r, 5));
        return { error: 'contract error: stream missing' } as never;
      },
    );

    const settled = await Promise.allSettled([client.getStream('9'), client.getStream('9')]);
    expect(rpcCalls).toBe(1);
    expect(settled.every((s) => s.status === 'rejected')).toBe(true);
    expect((settled[0] as PromiseRejectedResult).reason).toBeInstanceOf(StreamNotFoundError);

    // The failure is not cached: a later caller triggers a new request.
    await expect(client.getStream('9')).rejects.toBeInstanceOf(StreamNotFoundError);
    expect(rpcCalls).toBe(2);
  });

  it('emits a requestDeduplicated event when a call joins an in-flight request', async () => {
    const events: Array<Record<string, unknown>> = [];
    const bus = {
      emit: (event: string, data: unknown) => {
        if (event === 'requestDeduplicated') events.push(data as Record<string, unknown>);
      },
      on: () => () => {},
    };
    const busClient = makeClient({ eventBus: bus });
    vi.spyOn(busClient as never as { simulateOp: unknown }, 'simulateOp').mockImplementation(
      async () => {
        await new Promise((r) => setTimeout(r, 10));
        return { result: { retval: streamScVal('3') }, latestLedger: 1 } as never;
      },
    );

    await Promise.all([busClient.getStream('3'), busClient.getStream('3')]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ network: 'testnet' });
    busClient.destroy();
  });

  it('honours { dedupeRequests: false }', async () => {
    const plain = makeClient({ dedupeRequests: false });
    let rpcCalls = 0;
    vi.spyOn(plain as never as { simulateOp: unknown }, 'simulateOp').mockImplementation(
      async () => {
        rpcCalls++;
        await new Promise((r) => setTimeout(r, 10));
        return { result: { retval: streamScVal('4') }, latestLedger: 1 } as never;
      },
    );

    await Promise.all([plain.getStream('4'), plain.getStream('4')]);
    expect(rpcCalls).toBe(2);
    plain.destroy();
  });

  it('deduplicates concurrent getClaimable calls', async () => {
    let rpcCalls = 0;
    vi.spyOn(client as never as { simulateOp: unknown }, 'simulateOp').mockImplementation(
      async () => {
        rpcCalls++;
        await new Promise((r) => setTimeout(r, 10));
        return {
          result: { retval: nativeToScVal(500, { type: 'i128' }) },
          latestLedger: 1,
        } as never;
      },
    );

    const results = await Promise.all(Array.from({ length: 4 }, () => client.getClaimable('11')));
    expect(rpcCalls).toBe(1);
    expect(results).toEqual([500n, 500n, 500n, 500n]);
  });

  it('deduplicates concurrent getStreamsBySender calls', async () => {
    let rpcCalls = 0;
    vi.spyOn(client as never as { simulateOp: unknown }, 'simulateOp').mockImplementation(
      async () => {
        rpcCalls++;
        await new Promise((r) => setTimeout(r, 10));
        return {
          result: { retval: xdr.ScVal.scvVec([streamScVal('1')]) },
          latestLedger: 1,
        } as never;
      },
    );

    const [a, b] = await Promise.all([
      client.getStreamsBySender(SENDER),
      client.getStreamsBySender(SENDER),
    ]);
    expect(rpcCalls).toBe(1);
    expect(a).toEqual(b);
  });

  it('bypasses the TTL cache with { refresh: true } but still deduplicates', async () => {
    let rpcCalls = 0;
    vi.spyOn(client as never as { simulateOp: unknown }, 'simulateOp').mockImplementation(
      async () => {
        rpcCalls++;
        await new Promise((r) => setTimeout(r, 5));
        return { result: { retval: streamScVal('12') }, latestLedger: 1 } as never;
      },
    );

    await client.getStream('12');
    expect(rpcCalls).toBe(1);

    // Cached read — no RPC call.
    await client.getStream('12');
    expect(rpcCalls).toBe(1);

    // Forced refresh — one RPC call shared by both concurrent callers.
    await Promise.all([
      client.getStream('12', { refresh: true }),
      client.getStream('12', { refresh: true }),
    ]);
    expect(rpcCalls).toBe(2);
  });

  it('clearInFlightRequests() lets the next caller start a new request', async () => {
    let rpcCalls = 0;
    vi.spyOn(client as never as { simulateOp: unknown }, 'simulateOp').mockImplementation(
      async () => {
        rpcCalls++;
        await new Promise((r) => setTimeout(r, 10));
        return { result: { retval: streamScVal('13') }, latestLedger: 1 } as never;
      },
    );

    const first = client.getStream('13');
    // Let the read register itself as in-flight before detaching it.
    await Promise.resolve();
    await Promise.resolve();
    client.clearInFlightRequests();
    const second = client.getStream('13');

    await Promise.all([first, second]);
    expect(rpcCalls).toBe(2);
  });

  it('drops in-flight tracking on a network switch', async () => {
    vi.spyOn(client as never as { simulateOp: unknown }, 'simulateOp').mockImplementation(
      async () => ({ result: { retval: streamScVal('14') }, latestLedger: 1 }) as never,
    );

    await client.getStream('14');
    client.setNetwork('futurenet');
    expect((client as never as { requestDedup: { size: number } }).requestDedup.size).toBe(0);
  });
});
