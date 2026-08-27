import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SoroStreamClient } from '../src/SoroStreamClient.js';
import type { WalletAdapter, Stream } from '../src/types.js';

const VALID_CONTRACT = 'CAVTXNC2WCHINDNP4VBLSOQA2667VE3RPQZNGD5TFI4U2QSHTVAC667T';
const VALID_ACCOUNT = 'GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF';
const VALID_RECIPIENT = 'GAXXZ5XSL2VTQPGWB3LPU5273HSJXMK7VHLZTF2XKW65QFZVA3XKULQZ';

function makeMockAdapter(): WalletAdapter {
  return {
    getPublicKey: vi.fn().mockResolvedValue(VALID_ACCOUNT),
    signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
    isConnected: vi.fn().mockResolvedValue(true),
  };
}

function makeStream(overrides: Partial<Stream> = {}): Stream {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: '1',
    sender: VALID_ACCOUNT,
    recipient: VALID_ACCOUNT,
    token: VALID_CONTRACT,
    deposit: 1000n,
    flowRate: 1n,
    startTime: now,
    endTime: now + 3600,
    lastWithdrawTime: now,
    status: 'Active',
    autoRenew: false,
    ...overrides,
  };
}

describe('Multi-tenant namespace support', () => {
  let adapter: WalletAdapter;

  beforeEach(() => {
    adapter = makeMockAdapter();
  });

  it('stores namespace when creating a stream with namespace parameter', async () => {
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: adapter,
      skipPeerCheck: true,
    });

    // Mock the internal methods
    (client as any).validateStreamParams = vi.fn().mockResolvedValue(undefined);
    (client as any).checkAllowance = vi.fn().mockResolvedValue(undefined);
    (client as any).getLedgerTimestamp = vi.fn().mockResolvedValue(Math.floor(Date.now() / 1000));
    (client as any).validateCliff = vi.fn().mockResolvedValue(undefined);

    (client as any).buildAndSubmit = vi.fn().mockResolvedValue({ txHash: 'tx-hash-1', ledger: 0 });

    let streamCounter = 0;
    vi.spyOn(client, 'getStreamsBySender').mockImplementation(async () => {
      streamCounter++;
      return [makeStream({ id: String(streamCounter) })];
    });

    // Create a stream with namespace
    const result = await client.createStream({
      recipient: VALID_RECIPIENT,
      token: VALID_CONTRACT,
      amount: 100000000n,
      durationSeconds: 3600,
      autoRenew: false,
      namespace: 'tenant-abc',
    });

    // Verify the namespace was stored
    const namespaceRegistry = (client as any).namespaceRegistry as Map<string, string>;
    expect(namespaceRegistry.get(result.streamId)).toBe('tenant-abc');
  });

  it('does not store namespace when creating a stream without namespace', async () => {
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: adapter,
      skipPeerCheck: true,
    });

    (client as any).validateStreamParams = vi.fn().mockResolvedValue(undefined);
    (client as any).checkAllowance = vi.fn().mockResolvedValue(undefined);
    (client as any).getLedgerTimestamp = vi.fn().mockResolvedValue(Math.floor(Date.now() / 1000));
    (client as any).validateCliff = vi.fn().mockResolvedValue(undefined);

    (client as any).buildAndSubmit = vi.fn().mockResolvedValue({ txHash: 'tx-hash-1', ledger: 0 });

    let streamCounter = 0;
    vi.spyOn(client, 'getStreamsBySender').mockImplementation(async () => {
      streamCounter++;
      return [makeStream({ id: String(streamCounter) })];
    });

    // Create a stream without namespace
    const result = await client.createStream({
      recipient: VALID_RECIPIENT,
      token: VALID_CONTRACT,
      amount: 100000000n,
      durationSeconds: 3600,
      autoRenew: false,
    });

    // Verify no namespace was stored
    const namespaceRegistry = (client as any).namespaceRegistry as Map<string, string>;
    expect(namespaceRegistry.has(result.streamId)).toBe(false);
  });

  it('getStreamsByNamespace returns only streams with matching namespace', async () => {
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: adapter,
      skipPeerCheck: true,
    });

    // Manually populate the namespace registry
    const namespaceRegistry = (client as any).namespaceRegistry as Map<string, string>;
    namespaceRegistry.set('1', 'tenant-abc');
    namespaceRegistry.set('2', 'tenant-abc');
    namespaceRegistry.set('3', 'tenant-xyz');

    // Mock getStream to return different streams
    vi.spyOn(client, 'getStream').mockImplementation(async (id: string) => {
      return makeStream({ id });
    });

    // Query for tenant-abc
    const abcStreams = await client.getStreamsByNamespace('tenant-abc');
    expect(abcStreams).toHaveLength(2);
    expect(abcStreams.map((s) => s.id)).toEqual(['1', '2']);

    // Query for tenant-xyz
    const xyzStreams = await client.getStreamsByNamespace('tenant-xyz');
    expect(xyzStreams).toHaveLength(1);
    expect(xyzStreams[0]!.id).toBe('3');

    // Query for non-existent namespace
    const noStreams = await client.getStreamsByNamespace('tenant-none');
    expect(noStreams).toHaveLength(0);
  });

  it('getStreamsByNamespace cleans up registry for inaccessible streams', async () => {
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: adapter,
      skipPeerCheck: true,
    });

    const namespaceRegistry = (client as any).namespaceRegistry as Map<string, string>;
    namespaceRegistry.set('1', 'tenant-abc');
    namespaceRegistry.set('2', 'tenant-abc');

    // Mock getStream: stream "1" works, stream "2" throws
    vi.spyOn(client, 'getStream').mockImplementation(async (id: string) => {
      if (id === '2') throw new Error('Stream not found');
      return makeStream({ id });
    });

    const streams = await client.getStreamsByNamespace('tenant-abc');
    expect(streams).toHaveLength(1);
    expect(streams[0]!.id).toBe('1');

    // Verify stream "2" was cleaned up from registry
    expect(namespaceRegistry.has('2')).toBe(false);
  });
});
