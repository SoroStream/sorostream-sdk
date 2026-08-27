import { describe, it, expect, vi } from 'vitest';
import { StreamIndexer } from '../src/indexer.js';
import { SoroStreamClient } from '../src/SoroStreamClient.ts';
import type { RpcTransportAdapter } from '../src/transport.js';
import { nativeToScVal } from '@stellar/stellar-sdk';

describe('Issue #428: Cursor-based pagination for getStreamHistory', () => {
  const mockEvents = [
    {
      id: '000000100-000000001',
      pagingToken: 'token-1',
      ledger: 100,
      ledgerClosedAt: new Date().toISOString(),
      txHash: 'hash-1',
      inSuccessfulContractCall: true,
      topic: [nativeToScVal('StreamCreated', { type: 'symbol' })],
      value: nativeToScVal({
        id: '42',
        sender: 'GSENDER',
        recipient: 'GRECIPIENT',
        token: 'GTOKEN',
        deposit: 1000n,
        flow_rate: 10n,
        start_time: 1000,
        end_time: 2000,
        auto_renew: false,
      }),
    },
    {
      id: '000000105-000000002',
      pagingToken: 'token-2',
      ledger: 105,
      ledgerClosedAt: new Date().toISOString(),
      txHash: 'hash-2',
      inSuccessfulContractCall: true,
      topic: [
        nativeToScVal('StreamWithdrawn', { type: 'symbol' }),
        nativeToScVal(42n, { type: 'u64' }),
      ],
      value: nativeToScVal({
        recipient: 'GRECIPIENT',
        amount: 100n,
      }),
    },
  ];

  it('queries events with cursor and limit and returns nextCursor & hasMore', async () => {
    const mockTransport: RpcTransportAdapter = {
      getAccount: vi.fn(),
      getHealth: vi.fn(),
      getLatestLedger: vi.fn(),
      getTransaction: vi.fn(),
      simulateTransaction: vi.fn(),
      prepareTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      getEvents: vi.fn().mockResolvedValue({
        events: mockEvents,
        cursor: 'page-1-cursor',
        latestLedger: 110,
      }),
    };

    const indexer = new StreamIndexer(
      mockTransport,
      'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
    );

    const page = await indexer.getStreamHistory('42', {
      limit: 2,
      cursor: 'prev-cursor',
    });

    expect(mockTransport.getEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: 'prev-cursor',
        limit: 2,
      }),
    );

    expect(page.events).toHaveLength(2);
    expect(page.cursor).toBe('page-1-cursor');
    expect(page.nextCursor).toBe('token-2');
    expect(page.hasMore).toBe(true);
  });

  it('exposes getStreamHistory on SoroStreamClient', async () => {
    const mockTransport: RpcTransportAdapter = {
      getAccount: vi.fn(),
      getHealth: vi.fn(),
      getLatestLedger: vi.fn(),
      getTransaction: vi.fn(),
      simulateTransaction: vi.fn(),
      prepareTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      getEvents: vi.fn().mockResolvedValue({
        events: [mockEvents[0]],
        cursor: 'c1',
        latestLedger: 105,
      }),
    };

    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
      transport: mockTransport,
    });

    const page = await client.getStreamHistory('42', { limit: 10 });
    expect(page.events).toHaveLength(1);
    expect(page.hasMore).toBe(false);
  });
});
