import { describe, it, expect } from 'vitest';
import { safeClaimable, claimableNow } from '../src/utils.js';
import type { Stream } from '../src/types.js';

const I128_MAX = (1n << 127n) - 1n;

function makeStream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: '1',
    sender: 'GSENDER',
    recipient: 'GRECIPIENT',
    token: 'GTOKEN',
    deposit: 1_000_000_000n,
    flowRate: 1000n,
    startTime: 1_000_000,
    endTime: 2_000_000,
    lastWithdrawTime: 1_000_000,
    status: 'Active',
    autoRenew: false,
    ...overrides,
  };
}

describe('safeClaimable (issue #609)', () => {
  it('computes flowRate * elapsed for normal values', () => {
    expect(safeClaimable(100n, 500n)).toBe(50_000n);
  });

  it('returns 0n when flowRate is 0', () => {
    expect(safeClaimable(0n, 1000n)).toBe(0n);
  });

  it('returns 0n when elapsed is 0', () => {
    expect(safeClaimable(100n, 0n)).toBe(0n);
  });

  it('returns 0n when flowRate is negative', () => {
    expect(safeClaimable(-1n, 100n)).toBe(0n);
  });

  it('returns 0n when elapsed is negative', () => {
    expect(safeClaimable(100n, -1n)).toBe(0n);
  });

  it('caps at deposit when result exceeds it', () => {
    const deposit = 500n;
    expect(safeClaimable(100n, 10n, deposit)).toBe(deposit);
  });

  it('does not cap when result is within deposit', () => {
    const deposit = 5000n;
    expect(safeClaimable(100n, 10n, deposit)).toBe(1000n);
  });

  it('handles large flowRate near i128 max without throwing when within range', () => {
    const largeRate = I128_MAX / 1000n;
    expect(safeClaimable(largeRate, 999n)).toBe(largeRate * 999n);
  });

  it('throws when result exceeds i128 max without a cap', () => {
    const largeRate = I128_MAX;
    expect(() => safeClaimable(largeRate, 2n)).toThrow('overflow');
  });

  it('caps before overflow check when deposit is provided', () => {
    const deposit = 1000n;
    expect(safeClaimable(I128_MAX, 2n, deposit)).toBe(deposit);
  });
});

describe('claimableNow overflow protection (issue #609)', () => {
  it('caps claimable at deposit for normal streams', () => {
    const stream = makeStream({
      deposit: 500n,
      flowRate: 1000n,
      startTime: 1_000_000,
      endTime: 2_000_000,
      lastWithdrawTime: 1_000_000,
    });
    const result = claimableNow(stream);
    expect(result).toBeLessThanOrEqual(stream.deposit);
  });

  it('returns 0n for non-active streams', () => {
    expect(claimableNow(makeStream({ status: 'Cancelled' }))).toBe(0n);
    expect(claimableNow(makeStream({ status: 'Completed' }))).toBe(0n);
    expect(claimableNow(makeStream({ status: 'Paused' }))).toBe(0n);
  });
});
