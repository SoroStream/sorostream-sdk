import { describe, it, expect } from 'vitest';
import { MockSoroStreamClient } from '../src/mock.js';
import { Keypair } from '@stellar/stellar-sdk';
import type { PaginatedStreams, Stream } from '../src/types.js';

const RECIPIENT = Keypair.random().publicKey();
const OTHER = Keypair.random().publicKey();
const TOKEN = 'GTOKEN';

async function seedStreams(mock: MockSoroStreamClient, count: number) {
  for (let i = 0; i < count; i++) {
    await mock.createStream({
      recipient: RECIPIENT,
      token: TOKEN,
      amount: 1_000_000_000n,
      durationSeconds: 3600,
      autoRenew: false,
    });
  }
}

describe('#150 getStreamsByRecipient', () => {
  it('returns all streams for recipient without pagination', async () => {
    const mock = new MockSoroStreamClient();
    await seedStreams(mock, 3);
    // Also create a stream for another recipient - should not be returned
    await mock.createStream({
      recipient: OTHER,
      token: TOKEN,
      amount: 100n,
      durationSeconds: 60,
      autoRenew: false,
    });

    const result = await mock.getStreamsByRecipient(RECIPIENT);
    expect(Array.isArray(result)).toBe(true);
    const streams = result as Stream[];
    expect(streams).toHaveLength(3);
    streams.forEach((s) => expect(s.recipient).toBe(RECIPIENT));
  });

  it('returns empty array when no streams for recipient', async () => {
    const mock = new MockSoroStreamClient();
    const result = await mock.getStreamsByRecipient(RECIPIENT);
    expect(result).toEqual([]);
  });

  it('returns paginated result with limit and cursor', async () => {
    const mock = new MockSoroStreamClient();
    await seedStreams(mock, 5);

    const page1 = (await mock.getStreamsByRecipient(RECIPIENT, { limit: 2 })) as PaginatedStreams;
    expect(page1.streams).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.cursor).not.toBeNull();

    const page2 = (await mock.getStreamsByRecipient(RECIPIENT, {
      limit: 2,
      cursor: page1.cursor!,
    })) as PaginatedStreams;
    expect(page2.streams).toHaveLength(2);

    const page3 = (await mock.getStreamsByRecipient(RECIPIENT, {
      limit: 2,
      cursor: page2.cursor!,
    })) as PaginatedStreams;
    expect(page3.streams).toHaveLength(1);
    expect(page3.hasMore).toBe(false);
  });

  it('returns type-safe Stream objects with all required fields', async () => {
    const mock = new MockSoroStreamClient();
    await seedStreams(mock, 1);

    const result = await mock.getStreamsByRecipient(RECIPIENT);
    const streams = result as Stream[];
    const s = streams[0];

    expect(typeof s.id).toBe('string');
    expect(typeof s.sender).toBe('string');
    expect(s.recipient).toBe(RECIPIENT);
    expect(typeof s.deposit).toBe('bigint');
    expect(typeof s.flowRate).toBe('bigint');
    expect(['Active', 'Cancelled', 'Completed', 'Paused']).toContain(s.status);
  });

  it('includes active, completed and cancelled streams', async () => {
    const mock = new MockSoroStreamClient();
    await seedStreams(mock, 2);

    const allStreams = (await mock.getStreamsByRecipient(RECIPIENT)) as Stream[];
    const [s1, s2] = allStreams;

    await mock.cancelStream({ streamId: s1.id });

    const after = (await mock.getStreamsByRecipient(RECIPIENT)) as Stream[];
    const statuses = after.map((s) => s.status);
    expect(statuses).toContain('Cancelled');
    expect(statuses).toContain('Active');
  });
});
