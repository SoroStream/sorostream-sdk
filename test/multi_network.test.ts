/**
 * Tests for Issue #393: Multi-network client configuration.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MultiNetworkClient, MultiNetworkConfigError, MultiNetworkNotFoundError } from '../src/multiNetwork.js';
import type { NetworkConfig } from '../src/multiNetwork.js';
import type { WalletAdapter, Stream } from '../src/types.js';
import { nativeToScVal, rpc } from '@stellar/stellar-sdk';

afterEach(() => vi.restoreAllMocks());

const VALID_CONTRACT_TESTNET  = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const VALID_CONTRACT_MAINNET  = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const VALID_ACCOUNT = 'GAXXZ5XSL2VTQPGWB3LPU5273HSJXMK7VHLZTF2XKW65QFZVA3XKULQZ';
const RECIPIENT     = 'GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF';

function makeAdapter(): WalletAdapter {
  return {
    getPublicKey: vi.fn().mockResolvedValue(VALID_ACCOUNT),
    signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
    isConnected: vi.fn().mockResolvedValue(true),
  };
}

function makeConfigs(extra?: Partial<NetworkConfig>): NetworkConfig[] {
  return [
    { network: 'testnet', contractId: VALID_CONTRACT_TESTNET, walletAdapter: makeAdapter(), skipVersionCheck: true, ...extra },
    { network: 'mainnet', contractId: VALID_CONTRACT_MAINNET, walletAdapter: makeAdapter(), skipVersionCheck: true },
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
      retval: nativeToScVal({
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
      }, { type: 'map' }),
    },
    latestLedger: 100,
  } as unknown as rpc.Api.SimulateTransactionSuccessResponse;
}

function makeStreamsScVal(streams: Stream[]): rpc.Api.SimulateTransactionSuccessResponse {
  return {
    result: {
      retval: nativeToScVal(
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
      ),
    },
    latestLedger: 100,
  } as unknown as rpc.Api.SimulateTransactionSuccessResponse;
}

// ── Construction ──────────────────────────────────────────────────────────

describe('MultiNetworkClient – construction', () => {
  it('constructs with a single network', () => {
    const multi = new MultiNetworkClient([
      { network: 'testnet', contractId: VALID_CONTRACT_TESTNET, walletAdapter: makeAdapter(), skipVersionCheck: true },
    ]);
    expect(multi.networks).toEqual(['testnet']);
    multi.destroy();
  });

  it('constructs with two networks', () => {
    const multi = new MultiNetworkClient(makeConfigs());
    expect(multi.networks).toHaveLength(2);
    expect(multi.networks).toContain('testnet');
    expect(multi.networks).toContain('mainnet');
    multi.destroy();
  });

  it('throws MultiNetworkConfigError when configs is empty', () => {
    expect(() => new MultiNetworkClient([])).toThrow(MultiNetworkConfigError);
  });

  it('throws MultiNetworkConfigError on duplicate networks', () => {
    expect(
      () =>
        new MultiNetworkClient([
          { network: 'testnet', contractId: VALID_CONTRACT_TESTNET, walletAdapter: makeAdapter(), skipVersionCheck: true },
          { network: 'testnet', contractId: VALID_CONTRACT_TESTNET, walletAdapter: makeAdapter(), skipVersionCheck: true },
        ]),
    ).toThrow(MultiNetworkConfigError);
  });
});

// ── getClient / hasNetwork ────────────────────────────────────────────────

describe('MultiNetworkClient.getClient', () => {
  let multi: MultiNetworkClient;

  beforeEach(() => { multi = new MultiNetworkClient(makeConfigs()); });
  afterEach(() => multi.destroy());

  it('returns the correct SoroStreamClient for a configured network', () => {
    const client = multi.getClient('testnet');
    expect(client).toBeDefined();
    expect((client as any).network).toBe('testnet');
  });

  it('throws MultiNetworkNotFoundError for an unconfigured network', () => {
    expect(() => multi.getClient('futurenet')).toThrow(MultiNetworkNotFoundError);
  });
});

describe('MultiNetworkClient.hasNetwork', () => {
  let multi: MultiNetworkClient;

  beforeEach(() => { multi = new MultiNetworkClient(makeConfigs()); });
  afterEach(() => multi.destroy());

  it('returns true for configured networks', () => {
    expect(multi.hasNetwork('testnet')).toBe(true);
    expect(multi.hasNetwork('mainnet')).toBe(true);
  });

  it('returns false for unconfigured networks', () => {
    expect(multi.hasNetwork('futurenet')).toBe(false);
  });
});

// ── getStream ─────────────────────────────────────────────────────────────

describe('MultiNetworkClient.getStream', () => {
  it('delegates to the correct network client', async () => {
    const multi = new MultiNetworkClient(makeConfigs());
    const testnetClient = multi.getClient('testnet');
    const stream = makeStream('42', VALID_ACCOUNT);

    vi.spyOn((testnetClient as any).contract, 'call').mockImplementation(() => ({
      build: () => ({}),
    }));
    vi.spyOn(testnetClient as any, 'simulateOp').mockResolvedValue(makeStreamScVal(stream));

    const result = await multi.getStream('testnet', '42');
    expect(result.id).toBe('42');
    multi.destroy();
  });

  it('throws MultiNetworkNotFoundError for unconfigured network', async () => {
    const multi = new MultiNetworkClient(makeConfigs());
    await expect(multi.getStream('futurenet', '1')).rejects.toThrow(MultiNetworkNotFoundError);
    multi.destroy();
  });
});

// ── getStreamsByRecipientAllNetworks ──────────────────────────────────────

describe('MultiNetworkClient.getStreamsByRecipientAllNetworks', () => {
  it('fans out to all networks and aggregates results', async () => {
    const multi = new MultiNetworkClient(makeConfigs());

    const testnetStream = makeStream('1', 'TESTNET_SENDER_' + VALID_ACCOUNT.slice(0, 20));
    const mainnetStream = makeStream('2', 'MAINNET_SENDER_' + VALID_ACCOUNT.slice(0, 20));

    const testnetClient = multi.getClient('testnet');
    vi.spyOn((testnetClient as any).contract, 'call').mockImplementation(() => ({ build: () => ({}) }));
    vi.spyOn(testnetClient as any, 'simulateOp').mockResolvedValue(makeStreamsScVal([testnetStream]));

    const mainnetClient = multi.getClient('mainnet');
    vi.spyOn((mainnetClient as any).contract, 'call').mockImplementation(() => ({ build: () => ({}) }));
    vi.spyOn(mainnetClient as any, 'simulateOp').mockResolvedValue(makeStreamsScVal([mainnetStream]));

    const { results, allStreams } = await multi.getStreamsByRecipientAllNetworks(RECIPIENT);

    expect(results).toHaveLength(2);
    expect(allStreams).toHaveLength(2);
    expect(results.every((r) => r.error === null)).toBe(true);
    multi.destroy();
  });

  it('captures per-network errors without rejecting the whole call', async () => {
    const multi = new MultiNetworkClient(makeConfigs());

    const testnetClient = multi.getClient('testnet');
    vi.spyOn((testnetClient as any).contract, 'call').mockImplementation(() => ({ build: () => ({}) }));
    vi.spyOn(testnetClient as any, 'simulateOp').mockRejectedValue(new Error('RPC down'));

    const mainnetClient = multi.getClient('mainnet');
    vi.spyOn((mainnetClient as any).contract, 'call').mockImplementation(() => ({ build: () => ({}) }));
    vi.spyOn(mainnetClient as any, 'simulateOp').mockResolvedValue(makeStreamsScVal([]));

    const { results, allStreams } = await multi.getStreamsByRecipientAllNetworks(RECIPIENT);

    const failed = results.find((r) => r.error !== null);
    expect(failed).toBeDefined();
    expect(allStreams).toHaveLength(0);
    multi.destroy();
  });
});

// ── getStreamsBySenderAllNetworks ────────────────────────────────────────

describe('MultiNetworkClient.getStreamsBySenderAllNetworks', () => {
  it('aggregates results from all networks', async () => {
    const multi = new MultiNetworkClient(makeConfigs());

    for (const network of ['testnet', 'mainnet'] as const) {
      const client = multi.getClient(network);
      vi.spyOn((client as any).contract, 'call').mockImplementation(() => ({ build: () => ({}) }));
      vi.spyOn(client as any, 'simulateOp').mockResolvedValue(makeStreamsScVal([makeStream('1', VALID_ACCOUNT)]));
    }

    const { allStreams } = await multi.getStreamsBySenderAllNetworks(VALID_ACCOUNT);
    expect(allStreams).toHaveLength(2); // one per network
    multi.destroy();
  });
});

// ── findStreamAcrossNetworks ──────────────────────────────────────────────

describe('MultiNetworkClient.findStreamAcrossNetworks', () => {
  it('returns matches from all networks that have the stream', async () => {
    const multi = new MultiNetworkClient(makeConfigs());

    for (const network of ['testnet', 'mainnet'] as const) {
      const client = multi.getClient(network);
      vi.spyOn((client as any).contract, 'call').mockImplementation(() => ({ build: () => ({}) }));
      vi.spyOn(client as any, 'simulateOp').mockResolvedValue(makeStreamScVal(makeStream('99', VALID_ACCOUNT)));
    }

    const found = await multi.findStreamAcrossNetworks('99');
    expect(found).toHaveLength(2);
    expect(found.map((f) => f.network).sort()).toEqual(['mainnet', 'testnet']);
    multi.destroy();
  });

  it('returns empty array when stream exists on no network', async () => {
    const multi = new MultiNetworkClient(makeConfigs());

    for (const network of ['testnet', 'mainnet'] as const) {
      const client = multi.getClient(network);
      vi.spyOn((client as any).contract, 'call').mockImplementation(() => ({ build: () => ({}) }));
      vi.spyOn(client as any, 'simulateOp').mockRejectedValue(new Error('not found'));
    }

    const found = await multi.findStreamAcrossNetworks('999');
    expect(found).toHaveLength(0);
    multi.destroy();
  });
});

// ── destroy ───────────────────────────────────────────────────────────────

describe('MultiNetworkClient.destroy', () => {
  it('calls destroy on every underlying client', () => {
    const multi = new MultiNetworkClient(makeConfigs());
    const destroySpies = multi.networks.map((n) =>
      vi.spyOn(multi.getClient(n), 'destroy'),
    );
    multi.destroy();
    for (const spy of destroySpies) {
      expect(spy).toHaveBeenCalledOnce();
    }
  });
});

// ── Error types ───────────────────────────────────────────────────────────

describe('MultiNetworkConfigError', () => {
  it('has the correct name', () => {
    const err = new MultiNetworkConfigError('test');
    expect(err.name).toBe('MultiNetworkConfigError');
    expect(err.message).toBe('test');
  });
});

describe('MultiNetworkNotFoundError', () => {
  it('includes the missing network and available ones in the message', () => {
    const err = new MultiNetworkNotFoundError('futurenet', ['testnet', 'mainnet']);
    expect(err.name).toBe('MultiNetworkNotFoundError');
    expect(err.message).toContain('futurenet');
    expect(err.message).toContain('testnet');
    expect(err.message).toContain('mainnet');
  });
});
