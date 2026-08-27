/**
 * Tests for issue #436: calculateStreamDelta utility
 */
import { describe, it, expect } from 'vitest';
import { calculateStreamDelta, claimableNow } from '../src/utils.js';
import type { Stream } from '../src/types.js';

function makeStream(overrides: Partial<Stream> = {}): Stream {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: 'stream-1',
    sender: 'GSENDER',
    recipient: 'GRECIPIENT',
    token: 'GUSDC',
    deposit: 1_000_000_000n,
    flowRate: 1_000n, // 1000 stroops/second
    startTime: now - 100,
    endTime: now + 1000,
    lastWithdrawTime: now - 100,
    status: 'Active',
    autoRenew: false,
    ...overrides,
  };
}

describe('Issue #436 — calculateStreamDelta', () => {
  it('returns positive delta when stream has progressed past previousClaimable', () => {
    const now = Math.floor(Date.now() / 1000);
    const stream = makeStream({
      flowRate: 1_000n,
      lastWithdrawTime: now - 100,
    });
    // After 100 seconds: 100 * 1000 = 100_000 stroops claimable
    const previousClaimable = 50_000n; // we had 50_000 before
    const delta = calculateStreamDelta(stream, previousClaimable, now);
    // current = 100 * 1000 = 100_000; delta = 100_000 - 50_000 = 50_000
    expect(delta).toBe(50_000n);
  });

  it('returns 0 when previousClaimable equals current', () => {
    const now = Math.floor(Date.now() / 1000);
    const stream = makeStream({ flowRate: 1_000n, lastWithdrawTime: now - 100 });
    const current = 100_000n; // exactly what would be claimable
    const delta = calculateStreamDelta(stream, current, now);
    expect(delta).toBe(0n);
  });

  it('returns 0 when previousClaimable is greater (e.g. after a withdrawal)', () => {
    const now = Math.floor(Date.now() / 1000);
    const stream = makeStream({ flowRate: 1_000n, lastWithdrawTime: now - 10 });
    const previousClaimable = 50_000n; // more than current 10_000
    const delta = calculateStreamDelta(stream, previousClaimable, now);
    expect(delta).toBe(0n);
  });

  it('returns 0 for a Cancelled stream', () => {
    const now = Math.floor(Date.now() / 1000);
    const stream = makeStream({ status: 'Cancelled' });
    expect(calculateStreamDelta(stream, 0n, now)).toBe(0n);
  });

  it('returns 0 for a Completed stream', () => {
    const now = Math.floor(Date.now() / 1000);
    const stream = makeStream({ status: 'Completed' });
    expect(calculateStreamDelta(stream, 0n, now)).toBe(0n);
  });

  it('returns 0 for a Paused stream', () => {
    const now = Math.floor(Date.now() / 1000);
    const stream = makeStream({ status: 'Paused', pausedAt: now - 50 });
    expect(calculateStreamDelta(stream, 0n, now)).toBe(0n);
  });

  it('caps at endTime — does not count beyond stream end', () => {
    const now = Math.floor(Date.now() / 1000);
    const stream = makeStream({
      flowRate: 1_000n,
      lastWithdrawTime: now - 200,
      endTime: now - 50, // stream ended 50s ago
    });
    // current claimable capped at endTime: (now - 50 - (now - 200)) = 150s → 150_000 stroops
    const delta = calculateStreamDelta(stream, 100_000n, now);
    expect(delta).toBe(50_000n);
  });

  it('uses now default when no time override is provided', () => {
    const stream = makeStream({ flowRate: 1_000n });
    // Just verify it returns a non-negative bigint without throwing
    const delta = calculateStreamDelta(stream, 0n);
    expect(delta).toBeGreaterThanOrEqual(0n);
    expect(typeof delta).toBe('bigint');
  });

  it('delta from zero matches claimableNow for a fresh stream', () => {
    const now = Math.floor(Date.now() / 1000);
    const stream = makeStream({ flowRate: 1_000n, lastWithdrawTime: now - 50 });
    const delta = calculateStreamDelta(stream, 0n, now);
    const expected = claimableNow({ ...stream });
    // Both compute flowRate * elapsed from lastWithdrawTime
    expect(delta).toBe(expected);
  });
});
