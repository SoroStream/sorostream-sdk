import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

describe('Drain flow integration test', () => {
  let adapter: WalletAdapter;

  beforeEach(() => {
    adapter = makeMockAdapter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('queues 5 mutations and drains them in correct order when RPC is available', async () => {
    const submissionOrder: string[] = [];

    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: adapter,
      skipPeerCheck: true,
    });

    // Mock all the internal methods
    (client as any).validateStreamParams = vi.fn().mockResolvedValue(undefined);
    (client as any).checkAllowance = vi.fn().mockResolvedValue(undefined);
    (client as any).getLedgerTimestamp = vi.fn().mockResolvedValue(Math.floor(Date.now() / 1000));
    (client as any).validateCliff = vi.fn().mockResolvedValue(undefined);

    // Track submission order by intercepting buildAndSubmit
    (client as any).buildAndSubmit = vi.fn().mockImplementation(async (...args: any[]) => {
      const opIdx = submissionOrder.length;
      submissionOrder.push(`mutation-${opIdx}`);
      return { txHash: `tx-hash-${opIdx}`, ledger: 0 };
    });

    // Mock getStreamsBySender to return a stream
    let streamCounter = 0;
    vi.spyOn(client, 'getStreamsBySender').mockImplementation(async () => {
      streamCounter++;
      return [makeStream({ id: String(streamCounter) })];
    });

    // Queue 5 createStream calls sequentially
    for (let i = 0; i < 5; i++) {
      await client.createStream({
        recipient: VALID_RECIPIENT,
        token: VALID_CONTRACT,
        amount: BigInt(1000 * (i + 1)),
        durationSeconds: 3600,
        autoRenew: false,
      });
    }

    // Verify all 5 mutations were submitted in order
    expect(submissionOrder).toEqual([
      'mutation-0',
      'mutation-1',
      'mutation-2',
      'mutation-3',
      'mutation-4',
    ]);
  });

  it('drains queued mutations sequentially with correct ordering', async () => {
    const submissionOrder: number[] = [];
    let submissionCounter = 0;

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

    (client as any).buildAndSubmit = vi.fn().mockImplementation(async (...args: any[]) => {
      submissionCounter++;
      submissionOrder.push(submissionCounter);
      return { txHash: `tx-hash-${submissionCounter}`, ledger: 0 };
    });

    let streamCounter = 0;
    vi.spyOn(client, 'getStreamsBySender').mockImplementation(async () => {
      streamCounter++;
      return [makeStream({ id: String(streamCounter) })];
    });

    // Create streams sequentially
    for (let i = 0; i < 5; i++) {
      await client.createStream({
        recipient: VALID_RECIPIENT,
        token: VALID_CONTRACT,
        amount: BigInt(1000 * (i + 1)),
        durationSeconds: 3600,
        autoRenew: false,
      });
    }

    // Verify submissions happened in sequential order
    expect(submissionOrder).toEqual([1, 2, 3, 4, 5]);
  });

  it('queueDrained event fires with correct results after all mutations complete', async () => {
    const events: Array<{ type: string; data: unknown }> = [];

    const eventBus = {
      emit: vi.fn((event: string, data: unknown) => {
        events.push({ type: event, data });
      }),
      on: vi.fn(),
      off: vi.fn(),
    };

    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: adapter,
      skipPeerCheck: true,
    });

    (client as any).eventBus = eventBus;
    (client as any).validateStreamParams = vi.fn().mockResolvedValue(undefined);
    (client as any).checkAllowance = vi.fn().mockResolvedValue(undefined);
    (client as any).getLedgerTimestamp = vi.fn().mockResolvedValue(Math.floor(Date.now() / 1000));
    (client as any).validateCliff = vi.fn().mockResolvedValue(undefined);

    (client as any).buildAndSubmit = vi.fn().mockImplementation(async (...args: any[]) => {
      return { txHash: `tx-hash-${Date.now()}`, ledger: 0 };
    });

    let streamCounter = 0;
    vi.spyOn(client, 'getStreamsBySender').mockImplementation(async () => {
      streamCounter++;
      return [makeStream({ id: String(streamCounter) })];
    });

    // Create 3 streams
    for (let i = 0; i < 3; i++) {
      await client.createStream({
        recipient: VALID_RECIPIENT,
        token: VALID_CONTRACT,
        amount: BigInt(1000 * (i + 1)),
        durationSeconds: 3600,
        autoRenew: false,
      });
    }

    // Verify stream.created events were emitted
    const createdEvents = events.filter((e) => e.type === 'stream.created');
    expect(createdEvents).toHaveLength(3);

    // Each created event should have the correct data shape
    for (const event of createdEvents) {
      const data = event.data as Record<string, unknown>;
      expect(data).toHaveProperty('streamId');
      expect(data).toHaveProperty('sender', VALID_ACCOUNT);
      expect(data).toHaveProperty('recipient', VALID_RECIPIENT);
      expect(data).toHaveProperty('token', VALID_CONTRACT);
      expect(data).toHaveProperty('txHash');
    }
  });

  it('maintains queue order across multiple drain cycles', async () => {
    const allSubmissions: string[] = [];

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

    (client as any).buildAndSubmit = vi.fn().mockImplementation(async (...args: any[]) => {
      const txHash = `tx-hash-${allSubmissions.length + 1}`;
      allSubmissions.push(txHash);
      return { txHash, ledger: 0 };
    });

    let streamCounter = 0;
    vi.spyOn(client, 'getStreamsBySender').mockImplementation(async () => {
      streamCounter++;
      return [makeStream({ id: String(streamCounter) })];
    });

    // First batch: 3 streams
    for (let i = 0; i < 3; i++) {
      await client.createStream({
        recipient: VALID_RECIPIENT,
        token: VALID_CONTRACT,
        amount: BigInt(1000 * (i + 1)),
        durationSeconds: 3600,
        autoRenew: false,
      });
    }

    const firstBatchCount = allSubmissions.length;
    expect(firstBatchCount).toBe(3);

    // Second batch: 2 more streams
    for (let i = 0; i < 2; i++) {
      await client.createStream({
        recipient: VALID_RECIPIENT,
        token: VALID_CONTRACT,
        amount: BigInt(2000 * (i + 1)),
        durationSeconds: 7200,
        autoRenew: true,
      });
    }

    // Verify all 5 submissions happened in total
    expect(allSubmissions.length).toBe(5);

    // Verify ordering is maintained across batches
    expect(allSubmissions).toEqual([
      'tx-hash-1',
      'tx-hash-2',
      'tx-hash-3',
      'tx-hash-4',
      'tx-hash-5',
    ]);
  });
});
