import { describe, it, expect } from 'vitest';
import { MockSoroStreamClient } from '../src/mock.js';

describe('lockUntil parameter', () => {
  const baseParams = {
    recipient: 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJ',
    token: 'GUSDC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHI',
    amount: 1_000_000n,
    durationSeconds: 3600,
    autoRenew: false,
  };

  it('accepts a lockUntil within stream bounds', async () => {
    const client = new MockSoroStreamClient();
    const now = Math.floor(Date.now() / 1000);
    const { streamId } = await client.createStream({
      ...baseParams,
      lockUntil: now + 1800, // halfway through the stream
    });
    expect(streamId).toBeTruthy();
  });

  it('getClaimable returns 0 before lockUntil expires', async () => {
    const client = new MockSoroStreamClient();
    const now = Math.floor(Date.now() / 1000);
    const { streamId } = await client.createStream({
      ...baseParams,
      lockUntil: now + 9999, // far future
    });
    const claimable = await client.getClaimable(streamId);
    expect(claimable).toBe(0n);
  });

  it('lockUntil is stored on the stream object', async () => {
    const client = new MockSoroStreamClient();
    const now = Math.floor(Date.now() / 1000);
    const lockUntil = now + 1800;
    const { streamId } = await client.createStream({
      ...baseParams,
      lockUntil,
    });
    const stream = await client.getStream(streamId);
    expect(stream.lockUntil).toBe(lockUntil);
  });
});
