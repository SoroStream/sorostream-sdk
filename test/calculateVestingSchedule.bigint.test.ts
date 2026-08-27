/**
 * Regression tests for calculateVestingSchedule when totalAmount exceeds
 * Number.MAX_SAFE_INTEGER (â‰ˆ9.007e15).
 *
 * Originally: `Math.floor(totalSeconds * pct)` and `BigInt(elapsed)` would
 * round intermediate Number values to the nearest representable double,
 * drifting the returned vested amounts by a few stroops for very large
 * streams. The fix keeps every intermediate in BigInt.
 *
 * See: fix/bigint-vesting-arithmetic branch.
 */
import { describe, it, expect } from 'vitest';
import { calculateVestingSchedule } from '../src/utils.js';
import type { Stream } from '../src/types.js';

const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

function makeStream(
  overrides: Partial<Stream> & {
    flowRate: bigint;
    startTime: number;
    endTime: number;
    deposit: bigint;
  },
): Stream {
  return {
    id: '0',
    sender: 'GSENDER',
    recipient: 'GRECIPIENT',
    token: 'GTOKEN',
    lastWithdrawTime: overrides.startTime,
    status: 'Active',
    autoRenew: false,
    ...overrides,
  };
}

describe('calculateVestingSchedule â€” BigInt safety (totalAmount > MAX_SAFE_INTEGER)', () => {
  it('produces exact totalAmount when flowRate Ã— duration exceeds Number.MAX_SAFE_INTEGER', () => {
    const startTime = 1_700_000_000;
    // 10 USDC/s Ã— ~3.17 years â‰ˆ 1B USDC total = 10_000_000_000_000_000 stroops
    const flowRate = 100_000_000n;
    const duration = 100_000_000; // ~3.17 years, well within MAX_SAFE_INTEGER
    const totalAmount = 10_000_000_000_000_000n;
    const cliff = 25_000_000;

    const stream = makeStream({
      flowRate,
      startTime,
      endTime: startTime + duration,
      deposit: totalAmount,
    });

    // Mid-cliff: effectiveClaimable should be 0n, totalAmount should be exact.
    const result = calculateVestingSchedule(stream, cliff, startTime + cliff / 2);

    expect(result.totalAmount).toBe(totalAmount);
    expect(result.totalAmount).toBeGreaterThan(MAX_SAFE_INTEGER);
    expect(result.effectiveClaimable).toBe(0n);
    expect(result.inCliff).toBe(true);
  });

  it('returns exact effectiveClaimable just past cliff when totalAmount > MAX_SAFE_INTEGER', () => {
    const startTime = 1_700_000_000;
    const flowRate = 100_000_000n; // 10 USDC/s
    const duration = 100_000_000; // ~3.17 years
    const totalAmount = 10_000_000_000_000_000n;
    const cliff = 25_000_000;
    const elapsedAfterCliff = 1_000_000; // seconds since cliff end

    const stream = makeStream({
      flowRate,
      startTime,
      endTime: startTime + duration,
      deposit: totalAmount,
    });

    const result = calculateVestingSchedule(stream, cliff, startTime + cliff + elapsedAfterCliff);

    // Expected: flowRate × (cliff + elapsedAfterCliff) — cliff time is included in the vested amount
    // because the vesting model counts from startTime, not from cliffEnd.
    const expected = 100_000_000n * BigInt(cliff + elapsedAfterCliff);
    expect(result.effectiveClaimable).toBe(expected);
    expect(result.inCliff).toBe(false);
  });

  it('preserves BigInt precision for milestone vested amounts when totalSeconds > MAX_SAFE_INTEGER', () => {
    // Constructed: totalSeconds above 2^53 so that intermediate
    // `Math.floor(totalSeconds * 0.25)` in the old code rounded to the
    // next representable Number and drifted the vested amount by ~1 stroop.
    //
    // We use an *even* value so its Number representation is exact (IEEE
    // 754 spacing in the [2^53, 2^54] range is 2, so even values round
    // cleanly). This lets us assert exact BigInt equality.
    const flowRate = 1n;
    const totalSecondsBig = 10_000_000_000_000_000n; // > MAX_SAFE_INTEGER, exact as Number
    const startTime = 0;
    const cliffSeconds = 0;

    const stream = makeStream({
      flowRate,
      startTime,
      endTime: startTime + Number(totalSecondsBig), // even â†’ exact
      deposit: totalSecondsBig,
    });

    const result = calculateVestingSchedule(stream, cliffSeconds, startTime);

    const vestedActual = result.milestones.map((m) => m.vested);

    // Cliff milestone: cliffSeconds = 0 â†’ vested = 0n.
    expect(vestedActual).toContain(0n);

    // Percent milestones at 25% / 50% / 75% / 100% of totalSeconds,
    // all exact BigInt divisions:
    expect(vestedActual).toContain(2_500_000_000_000_000n); // 25% of 10^16
    expect(vestedActual).toContain(5_000_000_000_000_000n); // 50%
    expect(vestedActual).toContain(7_500_000_000_000_000n); // 75%
    expect(vestedActual).toContain(10_000_000_000_000_000n); // 100%

    // Must not contain 0n without a real cliff edge case.
    // (cliffSeconds=0 just so the cliff milestone exists as 0n.)
  });

  it('preserves exact totalAmount and cliff milestone when endTime-startTime > MAX_SAFE_INTEGER', () => {
    // Validates the cliff milestone and totalAmount survive the
    // Number subtraction `endTime - startTime` boundary.
    const flowRate = 7n;
    const totalSecondsBig = 10_000_000_000_000_000n;
    const cliffSeconds = 2_500_000_000_000_000; // > MAX_SAFE_INTEGER, even â†’ exact
    const startTime = 0;

    const stream = makeStream({
      flowRate,
      startTime,
      endTime: startTime + Number(totalSecondsBig),
      deposit: flowRate * totalSecondsBig,
    });

    const result = calculateVestingSchedule(stream, cliffSeconds, startTime + 1_000);

    expect(result.totalAmount).toBe(flowRate * totalSecondsBig);
    expect(result.totalAmount).toBeGreaterThan(MAX_SAFE_INTEGER);

    const cliffMs = result.milestones.find((m) => m.time === startTime + cliffSeconds);
    expect(cliffMs).toBeDefined();
    expect(cliffMs!.vested).toBe(flowRate * BigInt(cliffSeconds));
  });

  it("handles the user's example: totalAmount = 10_000_000_000_000_000n at mid-cliff", () => {
    // Exact repro of the bug report.
    const totalAmount = 10_000_000_000_000_000n;
    const startTime = 0;
    const endTime = 100_000_000;
    const flowRate = 100_000_000n; // totalAmount / (endTime - startTime) exactly
    const cliff = 25_000_000;
    const now = startTime + cliff / 2; // mid-cliff

    const stream = makeStream({
      flowRate,
      startTime,
      endTime,
      deposit: totalAmount,
    });

    const result = calculateVestingSchedule(stream, cliff, now);

    // Expected behaviour per the bug report:
    //   - totalAmount is exact (no rounding)
    //   - effectiveClaimable is 0 at mid-cliff
    expect(result.totalAmount).toBe(totalAmount);
    expect(result.effectiveClaimable).toBe(0n);
    expect(result.inCliff).toBe(true);

    // The cliff milestone's vested must equal flowRate Ã— cliffSeconds exactly.
    const cliffMs = result.milestones[0];
    expect(cliffMs).toBeDefined();
    expect(cliffMs!.vested).toBe(flowRate * BigInt(cliff));
  });

  it('handles zero cliff duration and immediate vesting', () => {
    const startTime = 1_700_000_000;
    const flowRate = 10_000_000n;
    const duration = 100_000;

    const stream = makeStream({
      flowRate,
      startTime,
      endTime: startTime + duration,
      deposit: flowRate * BigInt(duration),
    });

    const atStart = calculateVestingSchedule(stream, 0, startTime);
    expect(atStart.cliffEndTime).toBe(startTime);
    expect(atStart.inCliff).toBe(false);
    expect(atStart.effectiveClaimable).toBe(0n);
    expect(atStart.milestones[0]?.time).toBe(startTime);
    expect(atStart.milestones[0]?.vested).toBe(0n);

    const afterOneSecond = calculateVestingSchedule(stream, 0, startTime + 1);
    expect(afterOneSecond.inCliff).toBe(false);
    expect(afterOneSecond.effectiveClaimable).toBe(flowRate);
    expect(afterOneSecond.totalAmount).toBe(stream.deposit);
  });
});

// Regression tests for the off-by-one bug:
// "When a stream is created with startTime set to an arbitrary Unix
//  timestamp (not epoch-aligned), cliffEndTime is calculated incorrectly
//  by an off-by-one in ledger sequence math."
//
// Stellar ledgers close roughly every 5 seconds, so any code path that
// rounds cliffEndTime to a ledger boundary would shift it by up to one
// ledger (~5s) whenever startTime is not a multiple of 5. Pinning it
// down here: cliffEndTime must be `startTime + cliffSeconds` bit-exact,
// regardless of startTime alignment, with no ledger-boundary rounding.
const STELLAR_LEDGER_SECONDS = 5; // ~5 s ledger-close cadence on mainnet/testnet
const ONE_YEAR_SECONDS = 365 * 24 * 3600;
const ALL_LEDGER_OFFSETS = Array.from({ length: STELLAR_LEDGER_SECONDS }, (_, i) => i);

describe('calculateVestingSchedule â€” cliffEndTime exactness (non-epoch-aligned startTime)', () => {
  it('startTime not aligned to a Stellar ledger boundary preserves bit-exact cliffEndTime', () => {
    // 1_700_000_003 mod 5 === 3 â†’ not aligned with any ~5 s ledger close.
    // If the implementation ever rounds to a ledger boundary
    // (e.g. Math.ceil(x / 5) * 5), cliffEndTime will drift by â‰¥ 2 s and
    // this test fails.
    const startTime = 1_700_000_003;
    const cliffSeconds = ONE_YEAR_SECONDS;
    const totalSeconds = 4 * ONE_YEAR_SECONDS;
    const flowRate = 100n;

    const stream = makeStream({
      flowRate,
      startTime,
      endTime: startTime + totalSeconds,
      deposit: flowRate * BigInt(totalSeconds),
    });

    const result = calculateVestingSchedule(stream, cliffSeconds, startTime + cliffSeconds / 2);
    expect(result.cliffEndTime).toBe(startTime + cliffSeconds);
    // Cliff milestone must sit at the same bit-exact instant.
    expect(result.milestones[0]!.time).toBe(startTime + cliffSeconds);
  });

  it('cliffEndTime is exact for every Stellar-ledger offset', () => {
    // Sweep all ledger-offsets (0..4 relative to a 5 s ledger close).
    // A rounding bug would manifest in at least one of these classes.
    const cliffSeconds = ONE_YEAR_SECONDS;
    const totalSeconds = 4 * ONE_YEAR_SECONDS;
    const flowRate = 100n;

    for (const mod of ALL_LEDGER_OFFSETS) {
      const startTime = 1_700_000_000 + mod;
      const stream = makeStream({
        flowRate,
        startTime,
        endTime: startTime + totalSeconds,
        deposit: flowRate * BigInt(totalSeconds),
      });
      const result = calculateVestingSchedule(stream, cliffSeconds, startTime);
      expect(result.cliffEndTime, `mod=${mod}`).toBe(startTime + cliffSeconds);
      expect(result.milestones[0]!.time, `mod=${mod}`).toBe(startTime + cliffSeconds);
    }
  });

  it('cliffEndTime is exact across minute-and-second grid alignments', () => {
    // Sanity sweep across the time grid most consumers slice on (UTC
    // minutes). Any rounding scheme would manifest here.
    const cliffSeconds = 7 * 24 * 3600;
    const totalSeconds = 30 * 24 * 3600;
    const flowRate = 12_345n;

    // Step by the ledger cadence to keep the sweep tight while still
    // covering non-aligned values across the full minute.
    for (let mod = 0; mod < 60; mod += STELLAR_LEDGER_SECONDS) {
      const startTime = 1_700_000_000 + mod;
      const stream = makeStream({
        flowRate,
        startTime,
        endTime: startTime + totalSeconds,
        deposit: flowRate * BigInt(totalSeconds),
      });
      const result = calculateVestingSchedule(stream, cliffSeconds, startTime + cliffSeconds);
      expect(result.cliffEndTime, `mod=${mod}`).toBe(startTime + cliffSeconds);
    }
  });

  it('inCliff flips on the exact cliffEndTime instant â€” no 1-ledger drift', () => {
    // startTime is intentionally not aligned to any ledger or minute
    // boundary. A ledger-rounded cliffEndTime would either swallow the
    // last second of cliff (inCliff still true past the true boundary)
    // or cut it short (inCliff false before the true boundary).
    const startTime = 1_700_000_003;
    const cliffSeconds = ONE_YEAR_SECONDS;
    const stream = makeStream({
      flowRate: 7n,
      startTime,
      endTime: startTime + 4 * ONE_YEAR_SECONDS,
      deposit: 7n * BigInt(4 * ONE_YEAR_SECONDS),
    });

    // exactly at cliffEndTime â†’ inCliff must be false
    const atCliff = calculateVestingSchedule(stream, cliffSeconds, startTime + cliffSeconds);
    expect(atCliff.cliffEndTime).toBe(startTime + cliffSeconds);
    expect(atCliff.inCliff).toBe(false);

    // 1 second before cliffEndTime â†’ inCliff must be true
    const justInside = calculateVestingSchedule(stream, cliffSeconds, startTime + cliffSeconds - 1);
    expect(justInside.cliffEndTime).toBe(startTime + cliffSeconds);
    expect(justInside.inCliff).toBe(true);
  });

  it('small cliffs preserve exactness across every ledger offset', () => {
    // Catches any floor/ceil introduced for "short" cliff paths. Uses
    // small cliff values that are deliberately non-aligned with the 5 s
    // ledger cadence to maximise sensitivity to rounding.
    const totalSeconds = 3600;
    const cliffSeconds = 13; // not aligned with STELLAR_LEDGER_SECONDS

    for (const mod of ALL_LEDGER_OFFSETS) {
      const startTime = 1_700_000_000 + mod;
      const stream = makeStream({
        flowRate: 1n,
        startTime,
        endTime: startTime + totalSeconds,
        deposit: BigInt(totalSeconds),
      });
      const result = calculateVestingSchedule(stream, cliffSeconds, startTime + cliffSeconds);
      expect(result.cliffEndTime, `mod=${mod}`).toBe(startTime + cliffSeconds);
    }
  });
});
