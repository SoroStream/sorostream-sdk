import { describe, it, expect } from 'vitest';
import { MockSoroStreamClient } from '../src/mock.js';

describe('lockUntil (issue #557)', () => {
  const baseParams = {
    recipient: 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJ',
    token: 'GUSDC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHI',
    amount: 1_000_000n,
    durationSeconds: 3600,
    autoRenew: false,
  };

  it('locks an existing stream via client.lockUntil', async () => {
    const client = new MockSoroStreamClient();
    const { streamId } = await client.createStream(baseParams);
    const lockTime = new Date(Date.now() + 1800 * 1000);

    const result = await client.lockUntil(streamId, lockTime);
    expect(result.txHash).toBeTruthy();

    const stream = await client.getStream(streamId);
    expect(stream.lockUntil).toBeDefined();
  });

  it('throws StreamAlreadyLockedError when locking with an earlier or equal timestamp', async () => {
    const client = new MockSoroStreamClient();
    const { streamId } = await client.createStream(baseParams);
    const now = Date.now();
    const lockTime1 = new Date(now + 3600 * 1000);
    const lockTime2 = new Date(now + 1800 * 1000);

    await client.lockUntil(streamId, lockTime1);
    await expect(client.lockUntil(streamId, lockTime2)).rejects.toThrow('already locked');
  });

  it('attempt cancel before lock expiry → expect rejection', async () => {
    const client = new MockSoroStreamClient();
    const { streamId } = await client.createStream(baseParams);
    const lockTime = new Date(Date.now() + 9999 * 1000);

    await client.lockUntil(streamId, lockTime);
    await expect(client.cancelStream({ streamId })).rejects.toThrow('locked');
  });
});
