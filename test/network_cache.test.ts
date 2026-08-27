/**
 * Tests for issue #230: getStreamsBySender / getStreamsByRecipient must include
 * the network identifier in the cache key, and the caches must be invalidated
 * when the client switches networks via setNetwork().
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SoroStreamClient } from '../src/SoroStreamClient.js';
import type { Network, Stream, WalletAdapter } from '../src/types.js';
import { nativeToScVal, rpc } from '@stellar/stellar-sdk';

const VALID_CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const SENDER = 'GAXXZ5XSL2VTQPGWB3LPU5273HSJXMK7VHLZTF2XKW65QFZVA3XKULQZ';
const RECIPIENT = 'GAXXZ5XSL2VTQPGWB3LPU5273HSJXMK7VHLZTF2XKW65QFZVA3XKULQZ';

function makeAdapter(): WalletAdapter {
  return {
    getPublicKey: vi.fn().mockResolvedValue(SENDER),
    signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
    isConnected: vi.fn().mockResolvedValue(true),
  };
}

function makeStream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: '1',
    sender: SENDER,
    recipient: RECIPIENT,
    token: 'GTOKEN',
    deposit: 1_000_000n,
    flowRate: 1_000n,
    startTime: 1_700_000_000,
    endTime: 1_700_003_600,
    lastWithdrawTime: 1_700_000_000,
    status: 'Active',
    autoRenew: false,
    ...overrides,
  };
}

function makeStreamsResult(streams: Stream[]): rpc.Api.SimulateTransactionSuccessResponse {
  const scVal = nativeToScVal(
    streams.map((s) => ({
      id: s.id,
      sender: s.sender,
      recipient: s.recipient,
      token: s.token,
      deposit: Number(s.deposit),
      flow_rate: Number(s.flowRate),
      start_time: s.startTime,
      end_time: s.endTime,
      last_withdraw_time: s.lastWithdrawTime,
      status: s.status,
      auto_renew: s.autoRenew,
    })),
  );
  return {
    result: { retval: scVal },
    latestLedger: 100,
  } as unknown as rpc.Api.SimulateTransactionSuccessResponse;
}

function setupClient(network: Network = 'testnet') {
  const adapter = makeAdapter();
  const client = new SoroStreamClient({
    network,
    contractId: VALID_CONTRACT,
    walletAdapter: adapter,
  });
  // Prevent nativeToScVal from failing on contract.call() internals
  vi.spyOn((client as any).contract, 'call').mockImplementation(() => ({
    build: () => ({}),
  }));
  return client;
}

// ── getStreamsBySender ────────────────────────────────────────────────────────

describe('#230 getStreamsBySender — network-keyed cache', () => {
  it('caches results using the current network as part of the key', async () => {
    const client = setupClient('testnet');
    const simulateSpy = vi
      .spyOn(client as any, 'simulateOp')
      .mockResolvedValue(makeStreamsResult([makeStream({ sender: 'TESTNET_SENDER' })]));

    const first = await client.getStreamsBySender(SENDER);
    expect(Array.isArray(first)).toBe(true);
    expect(simulateSpy).toHaveBeenCalledTimes(1);

    // Second call should hit the cache — no extra RPC call
    const second = await client.getStreamsBySender(SENDER);
    expect(second).toStrictEqual(first);
    expect(simulateSpy).toHaveBeenCalledTimes(1);
  });

  it('invalidates sender cache on setNetwork and refetches from new network', async () => {
    const client = setupClient('testnet');
    const simulateSpy = vi
      .spyOn(client as any, 'simulateOp')
      .mockResolvedValueOnce(makeStreamsResult([makeStream({ id: 'testnet-1' })]))
      .mockResolvedValueOnce(makeStreamsResult([makeStream({ id: 'mainnet-1' })]));

    const testnetResult = (await client.getStreamsBySender(SENDER)) as Stream[];
    expect(testnetResult[0]!.id).toBe('testnet-1');
    expect(simulateSpy).toHaveBeenCalledTimes(1);

    // Switch networks — cache must be flushed
    client.setNetwork('mainnet');

    const mainnetResult = (await client.getStreamsBySender(SENDER)) as Stream[];
    expect(mainnetResult[0]!.id).toBe('mainnet-1');
    // Must have made a second RPC call (cache was cleared)
    expect(simulateSpy).toHaveBeenCalledTimes(2);
  });

  it('does not return testnet cached data after switching to mainnet', async () => {
    const client = setupClient('testnet');
    vi.spyOn(client as any, 'simulateOp')
      .mockResolvedValueOnce(makeStreamsResult([makeStream({ id: 'testnet-stream' })]))
      .mockResolvedValueOnce(makeStreamsResult([makeStream({ id: 'mainnet-stream' })]));

    await client.getStreamsBySender(SENDER);
    client.setNetwork('mainnet');
    const after = (await client.getStreamsBySender(SENDER)) as Stream[];

    expect(after[0]!.id).toBe('mainnet-stream');
    expect(after[0]!.id).not.toBe('testnet-stream');
  });

  it('does not write to senderCache when the network switches mid-flight', async () => {
    const client = setupClient('testnet');

    let resolve!: (v: unknown) => void;
    vi.spyOn(client as any, 'simulateOp').mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );

    const pending = client.getStreamsBySender(SENDER);
    // Switch networks before the RPC resolves
    client.setNetwork('mainnet');
    resolve(makeStreamsResult([makeStream({ id: 'testnet-stream' })]));
    await pending;

    // The stale testnet result must not have populated the mainnet cache
    expect((client as any).senderCache.size).toBe(0);
  });

  it('paginated calls bypass the cache', async () => {
    const client = setupClient('testnet');
    const simulateSpy = vi
      .spyOn(client as any, 'simulateOp')
      .mockResolvedValue(makeStreamsResult([makeStream()]));

    // First non-paginated call — populates cache
    await client.getStreamsBySender(SENDER);
    expect(simulateSpy).toHaveBeenCalledTimes(1);

    // Paginated call — must NOT hit the cache, must call RPC
    await client.getStreamsBySender(SENDER, { limit: 5 });
    expect(simulateSpy).toHaveBeenCalledTimes(2);
  });
});

// ── getStreamsByRecipient ─────────────────────────────────────────────────────

describe('#230 getStreamsByRecipient — network-keyed cache', () => {
  it('caches results using the current network as part of the key', async () => {
    const client = setupClient('testnet');
    const simulateSpy = vi
      .spyOn(client as any, 'simulateOp')
      .mockResolvedValue(makeStreamsResult([makeStream()]));

    await client.getStreamsByRecipient(RECIPIENT);
    expect(simulateSpy).toHaveBeenCalledTimes(1);

    // Second call must hit the cache
    await client.getStreamsByRecipient(RECIPIENT);
    expect(simulateSpy).toHaveBeenCalledTimes(1);
  });

  it('invalidates recipient cache on setNetwork and refetches from new network', async () => {
    const client = setupClient('testnet');
    vi.spyOn(client as any, 'simulateOp')
      .mockResolvedValueOnce(makeStreamsResult([makeStream({ id: 'testnet-r' })]))
      .mockResolvedValueOnce(makeStreamsResult([makeStream({ id: 'mainnet-r' })]));

    const first = (await client.getStreamsByRecipient(RECIPIENT)) as Stream[];
    expect(first[0]!.id).toBe('testnet-r');

    client.setNetwork('mainnet');

    const second = (await client.getStreamsByRecipient(RECIPIENT)) as Stream[];
    expect(second[0]!.id).toBe('mainnet-r');
  });

  it('does not write to recipientCache when network switches mid-flight', async () => {
    const client = setupClient('testnet');

    let resolve!: (v: unknown) => void;
    vi.spyOn(client as any, 'simulateOp').mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );

    const pending = client.getStreamsByRecipient(RECIPIENT);
    client.setNetwork('mainnet');
    resolve(makeStreamsResult([makeStream()]));
    await pending;

    expect((client as any).recipientCache.size).toBe(0);
  });

  it('setNetwork also clears stream cache (regression guard)', async () => {
    const client = setupClient('testnet');
    vi.spyOn(client as any, 'simulateOp').mockResolvedValue(makeStreamsResult([makeStream()]));

    await client.getStreamsBySender(SENDER);
    await client.getStreamsByRecipient(RECIPIENT);

    expect((client as any).senderCache.size).toBeGreaterThan(0);
    expect((client as any).recipientCache.size).toBeGreaterThan(0);

    client.setNetwork('mainnet');

    expect((client as any).senderCache.size).toBe(0);
    expect((client as any).recipientCache.size).toBe(0);
    expect((client as any).streamCache.size).toBe(0);
  });
});
