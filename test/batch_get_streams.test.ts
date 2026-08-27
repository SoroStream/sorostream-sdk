import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { nativeToScVal, xdr } from '@stellar/stellar-sdk';

import { SoroStreamClient } from '../src/SoroStreamClient.js';
import { MockSoroStreamClient } from '../src/mock.js';
import { StreamNotFoundError, SoroStreamError } from '../src/errors.js';
import type { WalletAdapter } from '../src/types.js';

const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const SENDER = 'GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF';
const RECIPIENT = 'GAXXZ5XSL2VTQPGWB3LPU5273HSJXMK7VHLZTF2XKW65QFZVA3XKULQZ';
const TOKEN = 'CAVTXNC2WCHINDNP4VBLSOQA2667VE3RPQZNGD5TFI4U2QSHTVAC667T';

const STREAM_TYPE_MAP = {
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
} as const;

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
    { type: STREAM_TYPE_MAP as unknown as Record<string, [string, string]> },
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

/**
 * Installs a `simulateOp` spy that answers `get_streams` with the requested
 * subset of `available` and records how many RPC calls were made.
 */
function mockBatchRpc(
  client: SoroStreamClient,
  available: string[],
  hooks: { onCall?: (fnName: string, ids: string[]) => void } = {},
): { calls: () => number; batchCalls: () => string[][] } {
  let calls = 0;
  const batches: string[][] = [];

  vi.spyOn(client as never as { simulateOp: unknown }, 'simulateOp').mockImplementation(
    async (operation: unknown) => {
      calls++;
      const op = operation as {
        body(): {
          invokeHostFunctionOp(): {
            hostFunction(): { invokeContract(): { functionName(): string; args(): xdr.ScVal[] } };
          };
        };
      };
      const invoke = op.body().invokeHostFunctionOp().hostFunction().invokeContract();
      const fnName = invoke.functionName().toString();
      const args = invoke.args();

      if (fnName === 'get_streams') {
        const ids = (args[0]!.vec() ?? []).map((v) => String(v.u64().toString()));
        batches.push(ids);
        hooks.onCall?.(fnName, ids);
        const found = ids.filter((id) => available.includes(id));
        return {
          result: { retval: xdr.ScVal.scvVec(found.map((id) => streamScVal(id))) },
          latestLedger: 1,
        } as never;
      }

      if (fnName === 'get_stream') {
        const id = String(args[0]!.u64().toString());
        hooks.onCall?.(fnName, [id]);
        if (!available.includes(id)) return { error: 'stream not found' } as never;
        return { result: { retval: streamScVal(id) }, latestLedger: 1 } as never;
      }

      return { error: `unexpected call ${fnName}` } as never;
    },
  );

  return { calls: () => calls, batchCalls: () => batches };
}

describe('getStreams – batch read (#427)', () => {
  let client: SoroStreamClient;

  beforeEach(() => {
    client = makeClient();
  });

  afterEach(() => {
    client.destroy();
    vi.restoreAllMocks();
  });

  it('fetches many streams in a single RPC call', async () => {
    const rpc = mockBatchRpc(client, ['1', '2', '3']);

    const streams = await client.getStreams(['1', '2', '3']);

    expect(rpc.calls()).toBe(1);
    expect(streams.map((s) => s.id)).toEqual(['1', '2', '3']);
    expect(streams[0]!.deposit).toBe(1_000_000n);
    expect(streams[0]!.sender).toBe(SENDER);
  });

  it('returns results in the requested order, independent of contract ordering', async () => {
    mockBatchRpc(client, ['1', '2', '3']);
    const streams = await client.getStreams(['3', '1', '2']);
    expect(streams.map((s) => s.id)).toEqual(['3', '1', '2']);
  });

  it('collapses duplicate IDs into one lookup', async () => {
    const rpc = mockBatchRpc(client, ['5']);
    const streams = await client.getStreams(['5', '5', '5']);
    expect(rpc.batchCalls()).toEqual([['5']]);
    expect(streams.map((s) => s.id)).toEqual(['5']);
  });

  it('omits unknown IDs and reports them through getStreamsBatch', async () => {
    mockBatchRpc(client, ['1', '3']);
    const result = await client.getStreamsBatch(['1', '2', '3']);
    expect(result.streams.map((s) => s.id)).toEqual(['1', '3']);
    expect(result.missing).toEqual(['2']);
    expect(result.rpcCalls).toBe(1);
  });

  it('throws StreamNotFoundError for a missing ID when strict', async () => {
    mockBatchRpc(client, ['1']);
    await expect(client.getStreams(['1', '404'], { strict: true })).rejects.toBeInstanceOf(
      StreamNotFoundError,
    );
  });

  it('splits large requests into chunked parallel calls', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => String(i + 1));
    const rpc = mockBatchRpc(client, ids);

    const streams = await client.getStreams(ids);

    // 120 ids / default chunk size of 50 → 3 calls instead of 120.
    expect(rpc.calls()).toBe(3);
    expect(rpc.batchCalls().map((c) => c.length)).toEqual([50, 50, 20]);
    expect(streams).toHaveLength(120);
  });

  it('honours a custom chunkSize', async () => {
    const ids = ['1', '2', '3', '4', '5'];
    const rpc = mockBatchRpc(client, ids);
    await client.getStreams(ids, { chunkSize: 2 });
    expect(rpc.batchCalls()).toEqual([['1', '2'], ['3', '4'], ['5']]);
  });

  it('serves IDs already in the read cache without an RPC call', async () => {
    const rpc = mockBatchRpc(client, ['1', '2']);

    // Warm the per-stream cache through the single-stream path.
    await client.getStream('1');
    expect(rpc.calls()).toBe(1);

    const result = await client.getStreamsBatch(['1', '2']);
    expect(result.cached).toEqual(['1']);
    expect(result.streams.map((s) => s.id)).toEqual(['1', '2']);
    // Only the uncached ID triggered a second call.
    expect(rpc.batchCalls()).toEqual([['2']]);
  });

  it('bypasses the cache with { useCache: false }', async () => {
    const rpc = mockBatchRpc(client, ['1']);
    await client.getStream('1');
    await client.getStreams(['1'], { useCache: false });
    expect(rpc.batchCalls()).toEqual([['1']]);
    expect(rpc.calls()).toBe(2);
  });

  it('warms the single-stream cache so a later getStream is free', async () => {
    const rpc = mockBatchRpc(client, ['1', '2']);
    await client.getStreams(['1', '2']);
    expect(rpc.calls()).toBe(1);

    const stream = await client.getStream('2');
    expect(stream.id).toBe('2');
    expect(rpc.calls()).toBe(1);
  });

  it('shares one in-flight request between concurrent identical batches (#426)', async () => {
    let calls = 0;
    vi.spyOn(client as never as { simulateOp: unknown }, 'simulateOp').mockImplementation(
      async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        return {
          result: { retval: xdr.ScVal.scvVec([streamScVal('1'), streamScVal('2')]) },
          latestLedger: 1,
        } as never;
      },
    );

    const [a, b] = await Promise.all([
      client.getStreams(['1', '2']),
      client.getStreams(['1', '2']),
    ]);
    expect(calls).toBe(1);
    expect(a.map((s) => s.id)).toEqual(b.map((s) => s.id));
  });

  it('falls back to individual reads on a contract without get_streams', async () => {
    const seen: string[] = [];
    let calls = 0;
    vi.spyOn(client as never as { simulateOp: unknown }, 'simulateOp').mockImplementation(
      async (operation: unknown) => {
        calls++;
        const invoke = (
          operation as {
            body(): {
              invokeHostFunctionOp(): {
                hostFunction(): {
                  invokeContract(): { functionName(): string; args(): xdr.ScVal[] };
                };
              };
            };
          }
        )
          .body()
          .invokeHostFunctionOp()
          .hostFunction()
          .invokeContract();
        const fnName = invoke.functionName().toString();
        seen.push(fnName);
        if (fnName === 'get_streams') {
          // Simulates an older deployment: the entry point does not exist.
          return { error: 'HostError: unknown function get_streams' } as never;
        }
        const id = String(invoke.args()[0]!.u64().toString());
        if (id === '404') return { error: 'stream not found' } as never;
        return { result: { retval: streamScVal(id) }, latestLedger: 1 } as never;
      },
    );

    const streams = await client.getStreams(['1', '404', '2']);
    expect(streams.map((s) => s.id)).toEqual(['1', '2']);
    expect(seen[0]).toBe('get_streams');
    expect(seen.filter((f) => f === 'get_stream')).toHaveLength(3);
    expect(calls).toBe(4);
  });

  it('reports everything missing when the fallback is disabled', async () => {
    vi.spyOn(client as never as { simulateOp: unknown }, 'simulateOp').mockImplementation(
      async () => ({ error: 'HostError: unknown function get_streams' }) as never,
    );
    const result = await client.getStreamsBatch(['1', '2'], { fallbackToIndividual: false });
    expect(result.streams).toEqual([]);
    expect(result.missing).toEqual(['1', '2']);
  });

  it('returns an empty result for an empty ID list without any RPC call', async () => {
    const rpc = mockBatchRpc(client, ['1']);
    const result = await client.getStreamsBatch([]);
    expect(result).toEqual({ streams: [], missing: [], cached: [], rpcCalls: 0 });
    expect(rpc.calls()).toBe(0);
  });

  it('rejects malformed input', async () => {
    await expect(client.getStreams(['not-a-number'] as unknown as string[])).rejects.toBeInstanceOf(
      SoroStreamError,
    );
    await expect(client.getStreams([''] as unknown as string[])).rejects.toBeInstanceOf(
      SoroStreamError,
    );
    await expect(client.getStreams('1' as unknown as string[])).rejects.toBeInstanceOf(TypeError);
  });

  it('honours the batchReadSize client option', async () => {
    const sized = makeClient({ batchReadSize: 2 });
    const rpc = mockBatchRpc(sized, ['1', '2', '3']);
    await sized.getStreams(['1', '2', '3']);
    expect(rpc.batchCalls()).toEqual([['1', '2'], ['3']]);
    sized.destroy();
  });
});

describe('MockSoroStreamClient.getStreams (#427)', () => {
  it('returns streams in the requested order and reports missing IDs', async () => {
    const mock = new MockSoroStreamClient();
    const created = await Promise.all([
      mock.createStream({
        recipient: RECIPIENT,
        token: TOKEN,
        amount: 1_000_000n,
        durationSeconds: 3600,
        autoRenew: false,
      }),
      mock.createStream({
        recipient: RECIPIENT,
        token: TOKEN,
        amount: 2_000_000n,
        durationSeconds: 3600,
        autoRenew: false,
      }),
    ]);
    const ids = created.map((c) => c.streamId);

    const streams = await mock.getStreams([ids[1]!, ids[0]!]);
    expect(streams.map((s) => s.id)).toEqual([ids[1], ids[0]]);

    const batch = await mock.getStreamsBatch([...ids, 'missing-id']);
    expect(batch.missing).toEqual(['missing-id']);
    expect(batch.streams).toHaveLength(2);
  });
});
