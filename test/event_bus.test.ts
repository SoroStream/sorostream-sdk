import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';

import { SoroStreamClient } from '../src/SoroStreamClient.js';
import { InMemoryEventBus } from '../src/eventBus.js';
import type { IEventBus } from '../src/eventBus.js';
import type { Stream, WalletAdapter } from '../src/types.js';

const TEST_PK = Keypair.random().publicKey();
const TEST_RECIPIENT = Keypair.random().publicKey();
const VALID_CONTRACT = 'CAVTXNC2WCHINDNP4VBLSOQA2667VE3RPQZNGD5TFI4U2QSHTVAC667T';

function makeStream(overrides: Partial<Stream> = {}): Stream {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: '1',
    sender: TEST_PK,
    recipient: TEST_RECIPIENT,
    token: VALID_CONTRACT,
    deposit: 100_000n,
    flowRate: 100n,
    startTime: now,
    endTime: now + 1000,
    lastWithdrawTime: now,
    status: 'Active',
    autoRenew: false,
    ...overrides,
  };
}

// ── Issue #212: Custom event bus integration ─────────────────────────────────

describe('InMemoryEventBus', () => {
  it('dispatches emitted data to registered handlers', () => {
    const bus = new InMemoryEventBus();
    const handler = vi.fn();
    bus.on('stream.created', handler);

    bus.emit('stream.created', { streamId: '1' });

    expect(handler).toHaveBeenCalledWith({ streamId: '1' });
  });

  it('supports multiple handlers for the same event', () => {
    const bus = new InMemoryEventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.on('stream.created', a);
    bus.on('stream.created', b);

    bus.emit('stream.created', { streamId: '1' });

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('does not call handlers registered for a different event', () => {
    const bus = new InMemoryEventBus();
    const handler = vi.fn();
    bus.on('stream.withdrawn', handler);

    bus.emit('stream.created', { streamId: '1' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('unsubscribe removes the handler', () => {
    const bus = new InMemoryEventBus();
    const handler = vi.fn();
    const unsubscribe = bus.on('stream.created', handler);

    unsubscribe();
    bus.emit('stream.created', { streamId: '1' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('emitting an event with no handlers is a no-op', () => {
    const bus = new InMemoryEventBus();
    expect(() => bus.emit('stream.created', {})).not.toThrow();
  });
});

describe('SoroStreamClient event bus integration', () => {
  let mockAdapter: WalletAdapter;

  beforeEach(() => {
    mockAdapter = {
      getPublicKey: vi.fn().mockResolvedValue(TEST_PK),
      signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
      isConnected: vi.fn().mockResolvedValue(true),
    };
  });

  it('uses a default in-memory event bus when none is configured', () => {
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: mockAdapter,
    });

    expect((client as any).eventBus).toBeInstanceOf(InMemoryEventBus);
  });

  it('emits stream.created through a custom bus on createStream', async () => {
    const eventBus: IEventBus = { emit: vi.fn(), on: vi.fn(() => () => {}) };
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: mockAdapter,
      eventBus,
    });

    (client as any).server = {
      getAccount: vi.fn().mockResolvedValue({ accountId: () => TEST_PK }),
    };
    vi.spyOn(client, 'buildAndSubmit' as any).mockResolvedValue({
      txHash: 'txhash_create',
      ledger: 0,
    });
    vi.spyOn(client, 'getStreamsBySender').mockResolvedValue([makeStream({ id: '42' })]);

    await client.createStream({
      recipient: TEST_RECIPIENT,
      token: VALID_CONTRACT,
      amount: 1000n,
      durationSeconds: 3600,
      autoRenew: false,
      skipAllowanceCheck: true,
    });

    expect(eventBus.emit).toHaveBeenCalledWith(
      'stream.created',
      expect.objectContaining({ streamId: '42', txHash: 'txhash_create' }),
    );
  });

  it('emits stream.withdrawn through a custom bus on withdraw', async () => {
    const eventBus: IEventBus = { emit: vi.fn(), on: vi.fn(() => () => {}) };
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: mockAdapter,
      eventBus,
    });

    vi.spyOn(client, 'buildAndSubmit' as any).mockResolvedValue({
      txHash: 'txhash_withdraw',
      ledger: 0,
    });
    vi.spyOn(client, 'getClaimable').mockResolvedValue(500n);

    await client.withdraw({ streamId: '42' });

    expect(eventBus.emit).toHaveBeenCalledWith(
      'stream.withdrawn',
      expect.objectContaining({ streamId: '42', amount: '500', txHash: 'txhash_withdraw' }),
    );
  });

  it('emits stream.cancelled through a custom bus on cancelStream', async () => {
    const eventBus: IEventBus = { emit: vi.fn(), on: vi.fn(() => () => {}) };
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: mockAdapter,
      eventBus,
    });

    vi.spyOn(client, 'buildAndSubmit' as any).mockResolvedValue({
      txHash: 'txhash_cancel',
      ledger: 0,
    });

    await client.cancelStream({ streamId: '42' });

    expect(eventBus.emit).toHaveBeenCalledWith(
      'stream.cancelled',
      expect.objectContaining({ streamId: '42', txHash: 'txhash_cancel' }),
    );
  });

  it('emits rpc.error through a custom bus when submission fails', async () => {
    const eventBus: IEventBus = { emit: vi.fn(), on: vi.fn(() => () => {}) };
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: mockAdapter,
      eventBus,
    });

    const mockServer = {
      getAccount: vi.fn().mockRejectedValue(new Error('network down')),
      simulateTransaction: vi.fn(),
      prepareTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      getTransaction: vi.fn(),
    };
    (client as any).server = mockServer;

    await expect(client.cancelStream({ streamId: '42' })).rejects.toThrow();

    expect(eventBus.emit).toHaveBeenCalledWith(
      'rpc.error',
      expect.objectContaining({ method: 'cancelStream' }),
    );
  });
});
