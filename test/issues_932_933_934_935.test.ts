/**
 * Issues #932, #933, #934 and #935.
 *
 * - #932: StreamIndexer.queryEvents computed `hasMore` from the post-filter
 *   events array length instead of the raw RPC response size, undercounting
 *   when some returned events are filtered out.
 * - #933: StreamIndexer derives a stream's ID differently for StreamCreated
 *   (decoded value's `id` field) versus StreamWithdrawn/StreamCancelled
 *   (topic[1]) — confirm both paths produce the same ID format.
 * - #934: MultiNetworkClient.findStreamAcrossNetworks silently drops
 *   networks where getStream fails; findStreamAcrossNetworksDetailed reports
 *   the per-network error instead.
 * - #935: MultiNetworkClient's constructor rejects duplicate network configs
 *   with a MultiNetworkConfigError naming the offending network.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { nativeToScVal, rpc } from '@stellar/stellar-sdk';
import { StreamIndexer } from '../src/indexer.js';
import type { RpcTransportAdapter } from '../src/transport.js';
import { MultiNetworkClient, MultiNetworkConfigError } from '../src/multiNetwork.js';
import type { NetworkConfig } from '../src/multiNetwork.js';
import type { WalletAdapter, Stream } from '../src/types.js';

afterEach(() => vi.restoreAllMocks());

const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

function makeTransport(getEventsImpl: RpcTransportAdapter['getEvents']): RpcTransportAdapter {
  return {
    getAccount: vi.fn(),
    getHealth: vi.fn(),
    getLatestLedger: vi.fn(),
    getTransaction: vi.fn(),
    simulateTransaction: vi.fn(),
    prepareTransaction: vi.fn(),
    sendTransaction: vi.fn(),
    getEvents: getEventsImpl,
  };
}

function streamCreatedRawEvent(id: string) {
  return {
    id: '000000100-000000001',
    pagingToken: 'token-created',
    ledger: 100,
    ledgerClosedAt: new Date().toISOString(),
    txHash: 'hash-created',
    inSuccessfulContractCall: true,
    topic: [nativeToScVal('StreamCreated', { type: 'symbol' })],
    value: nativeToScVal({
      id,
      sender: 'GSENDER',
      recipient: 'GRECIPIENT',
      token: 'GTOKEN',
      deposit: 1000n,
      flow_rate: 10n,
      start_time: 1000,
      end_time: 2000,
      auto_renew: false,
    }),
  };
}

function streamWithdrawnRawEvent(id: bigint) {
  return {
    id: '000000105-000000002',
    pagingToken: 'token-withdrawn',
    ledger: 105,
    ledgerClosedAt: new Date().toISOString(),
    txHash: 'hash-withdrawn',
    inSuccessfulContractCall: true,
    topic: [
      nativeToScVal('StreamWithdrawn', { type: 'symbol' }),
      nativeToScVal(id, { type: 'u64' }),
    ],
    value: nativeToScVal({ recipient: 'GRECIPIENT', amount: 100n }),
  };
}

// ── #932 ──────────────────────────────────────────────────────────────────

describe('#932 StreamIndexer.hasMore', () => {
  it('reports hasMore=true when raw events hit the limit but some get filtered out', async () => {
    // Raw response returns exactly `limit` (2) events, but one of them is not
    // from a successful contract call and is dropped by the filter, leaving
    // only 1 parsed event — fewer than `limit`. hasMore must still be true
    // because the server returned a full page of raw events.
    const transport = makeTransport(
      vi.fn().mockResolvedValue({
        events: [
          streamCreatedRawEvent('42'),
          { ...streamCreatedRawEvent('43'), inSuccessfulContractCall: false },
        ],
        cursor: 'page-1-cursor',
        latestLedger: 110,
      }),
    );

    const indexer = new StreamIndexer(transport, CONTRACT_ID);
    const page = await indexer.getStreamHistory('42', { limit: 2 });

    expect(page.events).toHaveLength(1);
    expect(page.hasMore).toBe(true);
  });

  it('still reports hasMore=false when nothing was filtered and fewer than limit came back', async () => {
    const transport = makeTransport(
      vi.fn().mockResolvedValue({
        events: [streamCreatedRawEvent('42')],
        cursor: 'c1',
        latestLedger: 105,
      }),
    );

    const indexer = new StreamIndexer(transport, CONTRACT_ID);
    const page = await indexer.getStreamHistory('42', { limit: 10 });

    expect(page.events).toHaveLength(1);
    expect(page.hasMore).toBe(false);
  });
});

// ── #933 ──────────────────────────────────────────────────────────────────

describe('#933 StreamIndexer stream ID format parity', () => {
  it('produces the same streamId string for StreamCreated (value.id) and StreamWithdrawn (topic[1])', async () => {
    const streamId = '42';
    const transport = makeTransport(
      vi.fn().mockResolvedValue({
        events: [streamCreatedRawEvent(streamId), streamWithdrawnRawEvent(42n)],
        cursor: 'c1',
        latestLedger: 110,
      }),
    );

    const indexer = new StreamIndexer(transport, CONTRACT_ID);
    const page = await indexer.getEventsBySender('GSENDER', { limit: 10 });

    // Both events are for the same underlying stream; filter by streamId
    // isn't applied here (getEventsBySender filters by sender only), so we
    // see both and can compare their derived IDs directly.
    const created = page.events.find((e) => e.type === 'StreamCreated');
    const withdrawn = page.events.find((e) => e.type === 'StreamWithdrawn');

    expect(created?.streamId).toBe(streamId);
    expect(withdrawn?.streamId).toBe(streamId);
    expect(created?.streamId).toBe(withdrawn?.streamId);
  });

  it('keeps the same format for a stream ID beyond Number.MAX_SAFE_INTEGER', async () => {
    const bigId = 9_007_199_254_740_993n; // 2^53 + 1
    const transport = makeTransport(
      vi.fn().mockResolvedValue({
        events: [streamCreatedRawEvent(bigId.toString()), streamWithdrawnRawEvent(bigId)],
        cursor: 'c1',
        latestLedger: 110,
      }),
    );

    const indexer = new StreamIndexer(transport, CONTRACT_ID);
    const page = await indexer.getEventsBySender('GSENDER', { limit: 10 });

    const created = page.events.find((e) => e.type === 'StreamCreated');
    const withdrawn = page.events.find((e) => e.type === 'StreamWithdrawn');

    expect(created?.streamId).toBe(bigId.toString());
    expect(withdrawn?.streamId).toBe(bigId.toString());
  });
});

// ── #934 / #935 shared fixtures ─────────────────────────────────────────────

const VALID_CONTRACT_TESTNET = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const VALID_CONTRACT_MAINNET = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const VALID_ACCOUNT = 'GAXXZ5XSL2VTQPGWB3LPU5273HSJXMK7VHLZTF2XKW65QFZVA3XKULQZ';
const RECIPIENT = 'GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF';

function makeAdapter(): WalletAdapter {
  return {
    getPublicKey: vi.fn().mockResolvedValue(VALID_ACCOUNT),
    signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
    isConnected: vi.fn().mockResolvedValue(true),
  };
}

function makeConfigs(): NetworkConfig[] {
  return [
    {
      network: 'testnet',
      contractId: VALID_CONTRACT_TESTNET,
      walletAdapter: makeAdapter(),
      skipVersionCheck: true,
    },
    {
      network: 'mainnet',
      contractId: VALID_CONTRACT_MAINNET,
      walletAdapter: makeAdapter(),
      skipVersionCheck: true,
    },
  ];
}

function makeStream(id: string, sender: string): Stream {
  return {
    id,
    sender,
    recipient: RECIPIENT,
    token: 'GTOKEN',
    deposit: 1_000_000n,
    flowRate: 1_000n,
    startTime: 1_700_000_000,
    endTime: 1_700_003_600,
    lastWithdrawTime: 1_700_000_000,
    status: 'Active',
    autoRenew: false,
  };
}

function makeStreamScVal(stream: Stream): rpc.Api.SimulateTransactionSuccessResponse {
  return {
    result: {
      retval: nativeToScVal(
        {
          id: stream.id,
          sender: stream.sender,
          recipient: stream.recipient,
          token: stream.token,
          deposit: Number(stream.deposit),
          flow_rate: Number(stream.flowRate),
          start_time: stream.startTime,
          end_time: stream.endTime,
          last_withdraw_time: stream.lastWithdrawTime,
          status: stream.status,
          auto_renew: stream.autoRenew,
        },
        { type: 'map' },
      ),
    },
    latestLedger: 100,
  } as unknown as rpc.Api.SimulateTransactionSuccessResponse;
}

// ── #934 ──────────────────────────────────────────────────────────────────

describe('#934 MultiNetworkClient.findStreamAcrossNetworksDetailed', () => {
  it('reports a per-network error instead of silently dropping the failed network', async () => {
    const multi = new MultiNetworkClient(makeConfigs());

    const testnetClient = multi.getClient('testnet');
    vi.spyOn((testnetClient as any).contract, 'call').mockImplementation(() => ({
      build: () => ({}),
    }));
    vi.spyOn(testnetClient as any, 'simulateOp').mockResolvedValue(
      makeStreamScVal(makeStream('99', VALID_ACCOUNT)),
    );

    const mainnetClient = multi.getClient('mainnet');
    vi.spyOn((mainnetClient as any).contract, 'call').mockImplementation(() => ({
      build: () => ({}),
    }));
    const rpcError = new Error('RPC timeout');
    vi.spyOn(mainnetClient as any, 'simulateOp').mockRejectedValue(rpcError);

    // The existing array-returning method still just drops the failed network.
    const simple = await multi.findStreamAcrossNetworks('99');
    expect(simple).toHaveLength(1);
    expect(simple[0]!.network).toBe('testnet');

    // The detailed method reports both outcomes, including the real error.
    const detailed = await multi.findStreamAcrossNetworksDetailed('99');
    expect(detailed.found).toHaveLength(1);
    expect(detailed.found[0]!.network).toBe('testnet');

    const testnetResult = detailed.results.find((r) => r.network === 'testnet');
    const mainnetResult = detailed.results.find((r) => r.network === 'mainnet');

    expect(testnetResult?.error).toBeNull();
    expect(testnetResult?.stream).not.toBeNull();

    expect(mainnetResult?.stream).toBeNull();
    expect(mainnetResult?.error).toBeInstanceOf(Error);
    // simulateOp's rejection is retried and wrapped (see RpcRetryExhaustedError
    // in src/errors.ts) rather than surfaced as the bare original error.
    expect((mainnetResult?.error as Error).message).toContain('RPC timeout');

    multi.destroy();
  });
});

// ── #935 ──────────────────────────────────────────────────────────────────

describe('#935 MultiNetworkClient rejects duplicate network configs', () => {
  it('throws MultiNetworkConfigError naming the duplicate network', () => {
    const configs = makeConfigs();
    const duplicateTestnet: NetworkConfig = {
      network: 'testnet',
      contractId: VALID_CONTRACT_TESTNET,
      walletAdapter: makeAdapter(),
      skipVersionCheck: true,
    };

    expect(() => new MultiNetworkClient([...configs, duplicateTestnet])).toThrow(
      MultiNetworkConfigError,
    );
    expect(() => new MultiNetworkClient([...configs, duplicateTestnet])).toThrow(/testnet/);
  });

  it('names the specific duplicate network, not a generic message', () => {
    const configs = makeConfigs();
    const duplicateMainnet: NetworkConfig = {
      network: 'mainnet',
      contractId: VALID_CONTRACT_MAINNET,
      walletAdapter: makeAdapter(),
      skipVersionCheck: true,
    };

    try {
      new MultiNetworkClient([...configs, duplicateMainnet]);
      expect.unreachable('expected MultiNetworkConfigError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MultiNetworkConfigError);
      expect((err as Error).message).toContain('mainnet');
      expect((err as Error).message).not.toContain('testnet');
    }
  });
});
