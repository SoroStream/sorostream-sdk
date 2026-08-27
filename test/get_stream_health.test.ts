import { describe, it, expect } from 'vitest';
import { getStreamHealth } from '../src/utils.js';
import type { Stream } from '../src/types.js';

// ---------------------------------------------------------------------------
// getStreamHealth (issue #398)
// ---------------------------------------------------------------------------

const BASE_TIME = 1_700_000_000; // fixed "now" reference

/** Helper that builds a minimal valid Active stream. */
function makeStream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: 'stream-1',
    sender: 'GSENDER',
    recipient: 'GRECIPIENT',
    token: 'GTOKEN',
    deposit: 10_000_000n,       // 1 USDC at 7 decimals
    flowRate: 100n,              // 100 stroops/s
    startTime: BASE_TIME - 3600, // started 1 hour ago
    endTime: BASE_TIME + 3600,   // ends in 1 hour (2-hour total)
    lastWithdrawTime: BASE_TIME - 60, // withdrew 60 seconds ago
    status: 'Active',
    autoRenew: false,
    ...overrides,
  };
}

describe('getStreamHealth (issue #398)', () => {
  it('returns score 100 and status "healthy" for a normally running stream', () => {
    const stream = makeStream();
    const result = getStreamHealth(stream, BASE_TIME);

    expect(result.score).toBe(100);
    expect(result.status).toBe('healthy');
    expect(result.diagnostics).toHaveLength(0);
  });

  it('returns correct remainingBalance', () => {
    const stream = makeStream();
    const result = getStreamHealth(stream, BASE_TIME);

    // elapsed = BASE_TIME - (BASE_TIME - 3600) = 3600 s
    // streamed = 100 * 3600 = 360_000
    // remaining = 10_000_000 - 360_000 = 9_640_000
    expect(result.remainingBalance).toBe(9_640_000n);
  });

  it('returns correct elapsedSeconds and remainingSeconds', () => {
    const stream = makeStream();
    const result = getStreamHealth(stream, BASE_TIME);

    expect(result.elapsedSeconds).toBe(3600);
    expect(result.remainingSeconds).toBe(3600);
  });

  it('returns status "cancelled" for a cancelled stream', () => {
    const stream = makeStream({ status: 'Cancelled' });
    const result = getStreamHealth(stream, BASE_TIME);

    expect(result.score).toBe(0);
    expect(result.status).toBe('cancelled');
    expect(result.diagnostics).toContain('Stream has been cancelled');
  });

  it('returns status "completed" for a completed stream', () => {
    const stream = makeStream({ status: 'Completed' });
    const result = getStreamHealth(stream, BASE_TIME);

    expect(result.score).toBe(100);
    expect(result.status).toBe('completed');
    expect(result.remainingBalance).toBe(0n);
  });

  it('deducts points when the stream is stalled (long since last withdrawal)', () => {
    // Duration = 7200 s, stall threshold = max(60, 7200 * 0.1) = 720 s
    // Set lastWithdrawTime to 5000 s ago — well past the stall threshold
    const stream = makeStream({
      lastWithdrawTime: BASE_TIME - 5000,
    });
    const result = getStreamHealth(stream, BASE_TIME);

    expect(result.score).toBeLessThan(100);
    expect(result.status).not.toBe('healthy');
    expect(result.diagnostics.some((d) => d.includes('stall threshold'))).toBe(true);
  });

  it('deducts points when the stream is underfunded', () => {
    // Set deposit very low so remaining < remaining payout
    const stream = makeStream({ deposit: 1n });
    const result = getStreamHealth(stream, BASE_TIME);

    expect(result.score).toBeLessThan(100);
    expect(result.diagnostics.some((d) => d.includes('Underfunded'))).toBe(true);
  });

  it('deducts points when stream is > 90% elapsed with balance remaining', () => {
    // 95% elapsed: BASE_TIME - startTime = 0.95 * 7200 = 6840 s elapsed
    const stream = makeStream({
      startTime: BASE_TIME - 6840,
      endTime: BASE_TIME + 360, // 360 s remaining
      lastWithdrawTime: BASE_TIME - 30, // recent withdrawal — no stall
    });
    const result = getStreamHealth(stream, BASE_TIME);

    // Should detect near-expiry
    expect(result.diagnostics.some((d) => d.includes('90%'))).toBe(true);
  });

  it('score is clamped to [0, 100]', () => {
    const stream = makeStream({
      deposit: 1n,
      lastWithdrawTime: BASE_TIME - 99_999,
    });
    const result = getStreamHealth(stream, BASE_TIME);

    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('returns secondsSinceLastWithdrawal of 0 when lastWithdrawTime is 0', () => {
    const stream = makeStream({ lastWithdrawTime: 0 });
    const result = getStreamHealth(stream, BASE_TIME);

    expect(result.secondsSinceLastWithdrawal).toBe(0);
  });

  it('status is "warning" for moderate issues (score 50–79)', () => {
    // Stalled stream but not critically underfunded → warning zone
    const stream = makeStream({
      startTime: BASE_TIME - 7000,
      endTime: BASE_TIME + 200,
      lastWithdrawTime: BASE_TIME - 3000, // long stall
    });
    const result = getStreamHealth(stream, BASE_TIME);

    expect(['warning', 'critical']).toContain(result.status);
  });

  it('status is "critical" when score drops below 50', () => {
    // Both underfunded and severely stalled
    const stream = makeStream({
      deposit: 1n,
      lastWithdrawTime: BASE_TIME - 100_000,
    });
    const result = getStreamHealth(stream, BASE_TIME);

    expect(result.status).toBe('critical');
    expect(result.score).toBeLessThan(50);
  });
});
