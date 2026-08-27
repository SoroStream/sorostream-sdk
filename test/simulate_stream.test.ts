import { describe, it, expect } from 'vitest';
import { simulateStream } from '../src/utils.js';
import { toStroops } from '../src/utils.js';

// ---------------------------------------------------------------------------
// simulateStream (issue #399)
// ---------------------------------------------------------------------------

describe('simulateStream (issue #399)', () => {
  const amount = toStroops('100');
  const durationSeconds = 3600; // 1 hour

  it('returns the correct flow rate and timeline', () => {
    const result = simulateStream({ amount, durationSeconds });

    expect(result.totalAmount).toBe(amount / BigInt(durationSeconds) * BigInt(durationSeconds));
    expect(result.flowRate).toBe(amount / BigInt(durationSeconds));
    expect(result.durationSeconds).toBe(durationSeconds);
    expect(result.endTime - result.startTime).toBe(durationSeconds);
  });

  it('returns snapshots from 0 % to 100 %', () => {
    const result = simulateStream({ amount, durationSeconds });

    expect(result.snapshots.length).toBeGreaterThan(0);

    const first = result.snapshots[0]!;
    expect(first.timestamp).toBe(result.startTime);
    expect(first.streamed).toBe(0n);
    expect(first.remaining).toBe(result.totalAmount);
    expect(first.percentComplete).toBe(0);

    const last = result.snapshots[result.snapshots.length - 1]!;
    expect(last.timestamp).toBe(result.endTime);
    expect(last.streamed).toBe(result.totalAmount);
    expect(last.remaining).toBe(0n);
    expect(last.percentComplete).toBe(100);
  });

  it('streamed + remaining equals totalAmount at every snapshot', () => {
    const result = simulateStream({ amount, durationSeconds });
    for (const snap of result.snapshots) {
      expect(snap.streamed + snap.remaining).toBe(result.totalAmount);
    }
  });

  it('honours a custom startTime', () => {
    const customStart = 2_000_000_000;
    const result = simulateStream({ amount, durationSeconds, startTime: customStart });

    expect(result.startTime).toBe(customStart);
    expect(result.endTime).toBe(customStart + durationSeconds);
    expect(result.snapshots[0]!.timestamp).toBe(customStart);
  });

  it('honours a custom snapshotCount', () => {
    const result = simulateStream({ amount, durationSeconds }, 5);
    // At minimum: start + up to 5 intermediate + end = 7
    expect(result.snapshots.length).toBeGreaterThanOrEqual(2);
    expect(result.snapshots.length).toBeLessThanOrEqual(7);
  });

  it('throws on zero amount', () => {
    expect(() => simulateStream({ amount: 0n, durationSeconds })).toThrow(
      /amount must be > 0/,
    );
  });

  it('throws on zero durationSeconds', () => {
    expect(() => simulateStream({ amount, durationSeconds: 0 })).toThrow(
      /durationSeconds must be > 0/,
    );
  });

  it('snapshots are sorted in ascending timestamp order', () => {
    const result = simulateStream({ amount, durationSeconds });
    for (let i = 1; i < result.snapshots.length; i++) {
      expect(result.snapshots[i]!.timestamp).toBeGreaterThanOrEqual(
        result.snapshots[i - 1]!.timestamp,
      );
    }
  });

  it('percentComplete is monotonically non-decreasing', () => {
    const result = simulateStream({ amount, durationSeconds });
    for (let i = 1; i < result.snapshots.length; i++) {
      expect(result.snapshots[i]!.percentComplete).toBeGreaterThanOrEqual(
        result.snapshots[i - 1]!.percentComplete,
      );
    }
  });

  it('works with a short 10-second stream', () => {
    const result = simulateStream({ amount: toStroops('1'), durationSeconds: 10 });
    expect(result.durationSeconds).toBe(10);
    expect(result.snapshots[0]!.streamed).toBe(0n);
    expect(result.snapshots[result.snapshots.length - 1]!.streamed).toBe(result.totalAmount);
  });
});
