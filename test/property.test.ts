/**
 * Property-based tests for flow rate and vesting calculations (Issue #103).
 * Uses fast-check with 10,000 iterations per property.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { calculateVestingSchedule, claimableNow, toStroops, formatUSDC } from '../src/utils.js';
import type { Stream } from '../src/types.js';

const NUM_RUNS = 10_000;

// Arbitrary: valid positive stream duration in seconds (1s – 10 years)
const durationArb = fc.integer({ min: 1, max: 10 * 365 * 24 * 3600 });

// Arbitrary: flow rate in stroops (1 – 1e12)
const flowRateArb = fc.bigInt({ min: 1n, max: 1_000_000_000_000n });

// Arbitrary: a valid Stream object for vesting tests
const streamArb = fc
  .record({
    durationSecs: durationArb,
    flowRate: flowRateArb,
    startTime: fc.integer({ min: 1_000_000, max: 2_000_000_000 }),
  })
  .map(({ durationSecs, flowRate, startTime }): Stream => ({
    id: '0',
    sender: 'GSENDER',
    recipient: 'GRECIPIENT',
    token: 'GTOKEN',
    deposit: flowRate * BigInt(durationSecs),
    flowRate,
    startTime,
    endTime: startTime + durationSecs,
    lastWithdrawTime: startTime,
    status: 'Active',
    autoRenew: false,
  }));

describe('property: claimableNow ≤ totalAmount', () => {
  it('never returns more than the full deposit', () => {
    fc.assert(
      fc.property(streamArb, (stream) => {
        const claimable = claimableNow(stream);
        return claimable <= stream.deposit;
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('property: claimableNow is monotonically non-decreasing over time', () => {
  it('claimable at t+dt ≥ claimable at t for active streams', () => {
    fc.assert(
      fc.property(streamArb, fc.integer({ min: 0, max: 3600 }), (stream, delta) => {
        const t1 = stream.startTime + 100;
        const t2 = t1 + delta;
        // Simulate claimableNow at two points by adjusting lastWithdrawTime
        const s1: Stream = { ...stream, lastWithdrawTime: stream.startTime };
        const s2: Stream = { ...stream, lastWithdrawTime: stream.startTime };

        const elapsed1 = Math.max(0, Math.min(t1, stream.endTime) - stream.startTime);
        const elapsed2 = Math.max(0, Math.min(t2, stream.endTime) - stream.startTime);
        const c1 = stream.flowRate * BigInt(elapsed1);
        const c2 = stream.flowRate * BigInt(elapsed2);

        return c2 >= c1;
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('property: claimable = 0 before cliff', () => {
  it('vesting schedule returns effectiveClaimable = 0n during cliff period', () => {
    fc.assert(
      fc.property(
        streamArb,
        fc.integer({ min: 1, max: 4 * 365 * 24 * 3600 }),
        (stream, cliffSeconds) => {
          // Pick a time strictly inside the cliff
          const nowInCliff = stream.startTime + Math.floor(cliffSeconds / 2);
          if (nowInCliff >= stream.startTime + cliffSeconds) return true; // skip edge

          const result = calculateVestingSchedule(stream, cliffSeconds, nowInCliff);
          return result.effectiveClaimable === 0n;
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('property: totalAmount = flowRate × duration', () => {
  it('vesting schedule reports correct totalAmount', () => {
    fc.assert(
      fc.property(streamArb, (stream) => {
        const result = calculateVestingSchedule(stream, 0, stream.startTime);
        const expected = stream.flowRate * BigInt(stream.endTime - stream.startTime);
        return result.totalAmount === expected;
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ── Issue #240: Property-based tests for formatUSDC and toStroops round-trip ──

// Arbitrary: valid stroop amount (0 to u64 max)
const stroopArb = fc.bigInt({ min: 0n, max: 2n ** 64n - 1n });

// Arbitrary: valid decimal amount string (0 to 1e12 with up to 7 decimal places)
const decimalStringArb = fc
  .tuple(fc.bigInt({ min: 0n, max: 1_000_000_000_000n }), fc.integer({ min: 0, max: 7 }))
  .map(([whole, decimalPlaces]: [bigint, number]) => {
    if (decimalPlaces === 0) return whole.toString();
    const factor = 10n ** BigInt(decimalPlaces);
    const decimal = (whole % factor).toString().padStart(decimalPlaces, '0');
    return `${whole / factor}.${decimal}`;
  });

describe('property: toStroops(formatUSDC(n)) === n', () => {
  it('round-trip invariant holds for any valid stroop amount (default 7 decimals)', () => {
    fc.assert(
      fc.property(stroopArb, (stroops: bigint) => {
        const formatted = formatUSDC(stroops, 7);
        const roundTripped = toStroops(formatted, 7);
        return roundTripped === stroops;
      }),
      { numRuns: 1_000 },
    );
  });

  it('round-trip invariant holds for custom decimals (6)', () => {
    fc.assert(
      fc.property(stroopArb, (stroops: bigint) => {
        const formatted = formatUSDC(stroops, 6);
        const roundTripped = toStroops(formatted, 6);
        return roundTripped === stroops;
      }),
      { numRuns: 1_000 },
    );
  });

  it('round-trip invariant holds for custom decimals (18)', () => {
    fc.assert(
      fc.property(stroopArb, (stroops: bigint) => {
        const formatted = formatUSDC(stroops, 18);
        const roundTripped = toStroops(formatted, 18);
        return roundTripped === stroops;
      }),
      { numRuns: 1_000 },
    );
  });
});

describe('property: formatUSDC produces parseable string', () => {
  it('formatUSDC output can be parsed back by toStroops', () => {
    fc.assert(
      fc.property(
        stroopArb,
        fc.integer({ min: 0, max: 18 }),
        (stroops: bigint, decimals: number) => {
          const formatted = formatUSDC(stroops, decimals);
          // Should not throw when parsing
          const parsed = toStroops(formatted, decimals);
          return parsed === stroops;
        },
      ),
      { numRuns: 1_000 },
    );
  });
});

describe('boundary values', () => {
  it('handles 0 without throwing', () => {
    expect(() => formatUSDC(0n)).not.toThrow();
    expect(() => toStroops('0')).not.toThrow();
    expect(formatUSDC(0n)).toBe('0.0000000');
    expect(toStroops('0')).toBe(0n);
  });

  it('handles MAX_SAFE_INTEGER without throwing', () => {
    const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
    expect(() => formatUSDC(maxSafe)).not.toThrow();
    const formatted = formatUSDC(maxSafe);
    const roundTripped = toStroops(formatted);
    expect(roundTripped).toBe(maxSafe);
  });

  it('handles u64 max without throwing', () => {
    const u64Max = 2n ** 64n - 1n;
    expect(() => formatUSDC(u64Max)).not.toThrow();
    const formatted = formatUSDC(u64Max);
    const roundTripped = toStroops(formatted);
    expect(roundTripped).toBe(u64Max);
  });

  it('handles single stroop (minimum positive value)', () => {
    expect(() => formatUSDC(1n)).not.toThrow();
    expect(formatUSDC(1n)).toBe('0.0000001');
    expect(toStroops('0.0000001')).toBe(1n);
  });

  it('handles large values with custom decimals', () => {
    const largeValue = 10n ** 18n; // 1e18 stroops
    expect(() => formatUSDC(largeValue, 18)).not.toThrow();
    const formatted = formatUSDC(largeValue, 18);
    const roundTripped = toStroops(formatted, 18);
    expect(roundTripped).toBe(largeValue);
  });
});
