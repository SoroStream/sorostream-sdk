import { describe, it, expect } from 'vitest';
import { MockSoroStreamClient } from '../src/mock.js';

describe('cloneStream', () => {
  const baseParams = {
    recipient: 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJ',
    token: 'GUSDC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHI',
    amount: 5_000_000n,
    durationSeconds: 7200,
    autoRenew: false,
  };

  it('clones a stream with identical parameters', async () => {
    const client = new MockSoroStreamClient();
    const { streamId: sourceId } = await client.createStream(baseParams);
    const source = await client.getStream(sourceId);

    const { streamId: cloneId } = await client.cloneStream(sourceId);
    const cloned = await client.getStream(cloneId);

    expect(cloned.token).toBe(source.token);
    expect(cloned.recipient).toBe(source.recipient);
    expect(cloned.deposit).toBe(source.deposit);
    expect(cloned.autoRenew).toBe(source.autoRenew);
    expect(cloned.id).not.toBe(source.id);
  });

  it('applies overrides before creating the clone', async () => {
    const newRecipient = 'GNEWRECIPIENT123456789012345678901234567890123456789012345';
    const client = new MockSoroStreamClient();
    const { streamId: sourceId } = await client.createStream(baseParams);

    const { streamId: cloneId } = await client.cloneStream(sourceId, {
      recipient: newRecipient,
      amount: 10_000_000n,
    });
    const cloned = await client.getStream(cloneId);

    expect(cloned.recipient).toBe(newRecipient);
    expect(cloned.deposit).toBe(10_000_000n);
  });

  it('new stream gets startTime = now', async () => {
    const client = new MockSoroStreamClient();
    const before = Math.floor(Date.now() / 1000);
    const { streamId: sourceId } = await client.createStream(baseParams);
    const { streamId: cloneId } = await client.cloneStream(sourceId);
    const after = Math.floor(Date.now() / 1000);

    const cloned = await client.getStream(cloneId);
    expect(cloned.startTime).toBeGreaterThanOrEqual(before);
    expect(cloned.startTime).toBeLessThanOrEqual(after);
  });
});
