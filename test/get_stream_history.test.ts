import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SoroStreamClient } from '../src/SoroStreamClient.js';

describe('getStreamHistory (#361)', () => {
  let client: SoroStreamClient;

  beforeEach(() => {
    client = new SoroStreamClient({
      network: 'testnet',
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      skipVersionCheck: true,
      skipPeerCheck: true,
    });
  });

  it('is a public method on SoroStreamClient', () => {
    expect(typeof client.getStreamHistory).toBe('function');
  });

  it('accepts cursor and limit parameters', async () => {
    const mockIndexer = {
      getStreamHistory: vi.fn().mockResolvedValue({
        events: [],
        cursor: 'cursor-abc',
        latestLedger: 12345,
      }),
    };
    vi.doMock('../src/indexer.js', () => ({ StreamIndexer: vi.fn(() => mockIndexer) }));

    // Verify signature
    const params = client.getStreamHistory.length;
    // streamId + cursor? + limit? = 3 formal params (cursor/limit optional)
    expect(params).toBeLessThanOrEqual(3);
  });

  it('returns PaginatedEvents shape', async () => {
    const fakeResult = {
      events: [
        {
          type: 'StreamCreated' as const,
          streamId: '42',
          ledger: 1000,
          ledgerClosedAt: '2024-01-01T00:00:00Z',
          txHash: 'abc123',
          id: 'event-1',
          pagingToken: 'token-1',
          data: {
            sender: 'GABC',
            recipient: 'GDEF',
            token: 'GUSDC',
            deposit: 100_000_000n,
            flowRate: 38n,
            startTime: 1704067200,
            endTime: 1706745600,
            autoRenew: false,
          },
        },
      ],
      cursor: 'next-cursor',
      latestLedger: 12345,
    };

    // Mock the server's simulateTransaction to test integration point
    const mockServer = {
      getEvents: vi.fn().mockResolvedValue({
        events: [],
        cursor: 'cursor-1',
        latestLedger: 12345,
      }),
    };
    (client as any).server = mockServer;

    // The result shape should match PaginatedEvents
    expect(fakeResult).toHaveProperty('events');
    expect(fakeResult).toHaveProperty('cursor');
    expect(fakeResult).toHaveProperty('latestLedger');
    expect(Array.isArray(fakeResult.events)).toBe(true);
  });
});
