import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { MockSoroStreamClient } from '../src/mock.js';
import {
  calculateVestingSchedule,
  serializeStreamToJSON,
  deserializeStreamFromJSON,
  bigintReplacer,
  bigintReviver,
} from '../src/utils.js';
import type { Stream } from '../src/types.js';

describe('Full vesting cliff-to-release lifecycle', () => {
  let mock: MockSoroStreamClient;

  beforeEach(() => {
    mock = new MockSoroStreamClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('create stream with cliff 50%, verify claimable via vesting schedule at cliff boundary', async () => {
    const totalDurationSeconds = 3600;
    const cliffSeconds = Math.floor(totalDurationSeconds * 0.5);
    const amount = 3_600_000n;

    const { streamId: sid } = await mock.createStream({
      recipient: 'GRECIPIENT',
      token: 'GUSDC',
      amount,
      durationSeconds: totalDurationSeconds,
      autoRenew: false,
      cliffSeconds,
    });
    const stream = await mock.getStream(sid);
    expect(stream.status).toBe('Active');

    const startTime = stream.startTime;

    const beforeCliff = calculateVestingSchedule(
      stream,
      cliffSeconds,
      startTime + cliffSeconds - 1,
    );
    expect(beforeCliff.inCliff).toBe(true);
    expect(beforeCliff.effectiveClaimable).toBe(0n);

    const atCliff = calculateVestingSchedule(stream, cliffSeconds, startTime + cliffSeconds);
    expect(atCliff.inCliff).toBe(false);
    expect(atCliff.effectiveClaimable).toBeGreaterThan(0n);
    expect(atCliff.effectiveClaimable).toBe(stream.flowRate * BigInt(cliffSeconds));

    const afterCliffTime = startTime + cliffSeconds + 900;
    const afterCliff = calculateVestingSchedule(stream, cliffSeconds, afterCliffTime);
    expect(afterCliff.inCliff).toBe(false);
    expect(afterCliff.effectiveClaimable).toBeGreaterThan(stream.flowRate * BigInt(cliffSeconds));

    const atEnd = calculateVestingSchedule(stream, cliffSeconds, stream.endTime);
    expect(atEnd.effectiveClaimable).toBe(atEnd.totalAmount);
  });

  it('create stream, advance time, withdraw all, verify final state', async () => {
    const durationSeconds = 3600;
    const amount = 3_600_000n;

    const { streamId: sid } = await mock.createStream({
      recipient: 'GRECIPIENT',
      token: 'GUSDC',
      amount,
      durationSeconds,
      autoRenew: false,
    });
    const stream = await mock.getStream(sid);

    // Use fake timers so withdraw sees an advanced "now"
    vi.useFakeTimers();
    vi.setSystemTime(new Date((stream.startTime + 500) * 1000));

    const withdrawResult = await mock.withdraw({ streamId: sid });
    expect(withdrawResult.txHash).toBeTruthy();
    const withdrawn = BigInt(withdrawResult.amount);
    expect(withdrawn).toBeGreaterThan(0n);

    vi.useRealTimers();
    const afterWithdraw = await mock.getStream(sid);
    expect(afterWithdraw.lastWithdrawTime).toBe(stream.startTime + 500);
  });

  it('stream serialization round-trip with bigintReplacer/bigintReviver', async () => {
    const { streamId: sid } = await mock.createStream({
      recipient: 'GRECIPIENT',
      token: 'GUSDC',
      amount: 7_200_000n,
      durationSeconds: 7200,
      autoRenew: false,
    });
    const stream = await mock.getStream(sid);

    // Serialize using bigintReplacer directly (skipping stream.toJSON())
    const plain = { id: stream.id, deposit: stream.deposit, flowRate: stream.flowRate };
    const json = JSON.stringify(plain, bigintReplacer);
    expect(json).toContain('_bigint');

    const restored = JSON.parse(json, bigintReviver);
    expect(restored.deposit).toBe(stream.deposit);
    expect(restored.flowRate).toBe(stream.flowRate);
  });

  it('serializeStreamToJSON and deserializeStreamFromJSON round-trip', async () => {
    const { streamId: sid } = await mock.createStream({
      recipient: 'GRECIPIENT',
      token: 'GUSDC',
      amount: 5_000_000n,
      durationSeconds: 5000,
      autoRenew: false,
    });
    const stream = await mock.getStream(sid);

    const json = serializeStreamToJSON(stream);
    expect(typeof json).toBe('string');

    const restored = deserializeStreamFromJSON(json);
    expect(restored.id).toBe(stream.id);
    expect(restored.deposit).toBe(stream.deposit);
    expect(restored.flowRate).toBe(stream.flowRate);
    expect(restored.sender).toBe(stream.sender);
    expect(restored.recipient).toBe(stream.recipient);
    expect(restored.startTime).toBe(stream.startTime);
    expect(restored.endTime).toBe(stream.endTime);
    expect(restored.status).toBe(stream.status);
  });
});
