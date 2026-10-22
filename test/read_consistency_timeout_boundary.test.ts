/**
 * Issue #730 – waitForLedger boundary tests at the timeoutMs deadline.
 *
 * Tests pin down behaviour at two critical points relative to the deadline:
 *
 * 1. Ledger becomes available exactly at timeoutMs (final poll resolves).
 * 2. Ledger becomes available one poll interval *after* timeoutMs (timeout
 *    fires before the ledger is seen → should reject with a timeout error).
 *
 * Fake timers are used so the tests run in microseconds.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitForLedger } from '../src/readConsistency.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Creates a mock LedgerProvider whose sequence advances on a schedule.
 *
 * `schedule` is a list of { atMs, sequence } entries.  The mock returns
 * the highest sequence whose `atMs` is ≤ Date.now() at the time the call
 * is made.  This lets us simulate a ledger that "arrives" at a precise
 * virtual timestamp without any real I/O.
 */
function makeMockServer(
  schedule: Array<{ atMs: number; sequence: number }>,
  baseMs = 0,
) {
  return {
    getLatestLedger: vi.fn().mockImplementation(async () => {
      const now = Date.now() - baseMs;
      let seq = 0;
      for (const entry of schedule) {
        if (entry.atMs <= now) seq = Math.max(seq, entry.sequence);
      }
      return { sequence: seq };
    }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('waitForLedger – timeoutMs boundary (#730)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Scenario 1 ──────────────────────────────────────────────────────────────

  it('resolves when the awaited ledger closes exactly at timeoutMs', async () => {
    /*
     * Setup:
     *   timeoutMs     = 1 000 ms
     *   pollIntervalMs =  500 ms
     *
     * Timeline (virtual):
     *   t=0    : poll #1 → sequence 0 (below target 10)
     *   t=500  : poll #2 → sequence 0  (still below, remaining = 500 ms)
     *   t=1000 : The remaining time before the deadline equals exactly one
     *            more poll interval; the implementation schedules
     *            Math.min(pollInterval, remaining) = Math.min(500, 0) = 0 ms,
     *            so it wakes up immediately.
     *
     * To guarantee the ledger is visible exactly at t=1000 we set the mock
     * sequence to advance to 10 when Date.now() >= 1000.
     */
    const timeoutMs = 1_000;
    const pollIntervalMs = 500;
    const targetSequence = 10;
    const startMs = Date.now(); // captured before advancing fake clock

    const server = makeMockServer(
      [{ atMs: timeoutMs, sequence: targetSequence }],
      startMs,
    );

    const promise = waitForLedger(server, targetSequence, {
      timeoutMs,
      pollIntervalMs,
    });

    // Advance virtual time in steps that match the poll interval.
    // Each runAllTimersAsync flushes all pending timers & microtasks.
    await vi.advanceTimersByTimeAsync(timeoutMs);

    // The promise must resolve (not reject) because the ledger was found.
    await expect(promise).resolves.toBeUndefined();
    expect(server.getLatestLedger).toHaveBeenCalled();
  });

  // ── Scenario 2 ──────────────────────────────────────────────────────────────

  it('rejects with a timeout error when ledger closes one poll interval after timeoutMs', async () => {
    /*
     * Setup:
     *   timeoutMs     = 1 000 ms
     *   pollIntervalMs =  500 ms
     *
     * The ledger only reaches targetSequence at t = 1 500 ms, which is
     * 500 ms past the deadline.  The deadline check runs at t ≈ 1 000 ms
     * (remaining ≤ 0) and must throw before the ledger is ever seen.
     */
    const timeoutMs = 1_000;
    const pollIntervalMs = 500;
    const targetSequence = 10;
    const startMs = Date.now();

    const server = makeMockServer(
      [{ atMs: timeoutMs + pollIntervalMs, sequence: targetSequence }],
      startMs,
    );

    const promise = waitForLedger(server, targetSequence, {
      timeoutMs,
      pollIntervalMs,
    });
    // Suppress unhandled rejection warning while we drive the test.
    promise.catch(() => {});

    // Advance past the deadline but not all the way to t=1500.
    await vi.advanceTimersByTimeAsync(timeoutMs + 10);

    await expect(promise).rejects.toThrow(
      /waitForLedger: timed out after 1000ms waiting for ledger 10/,
    );
    // The error message should include the current (stale) sequence.
    await expect(promise).rejects.toThrow(/current: 0/);
  });

  // ── Scenario 3 – AbortSignal cancels before timeout ─────────────────────────

  it('rejects with AbortError when signal is aborted before the ledger arrives', async () => {
    const timeoutMs = 5_000;
    const pollIntervalMs = 500;
    const targetSequence = 99;
    const startMs = Date.now();

    // Ledger never arrives within the window.
    const server = makeMockServer([], startMs);

    const controller = new AbortController();
    const promise = waitForLedger(server, targetSequence, {
      timeoutMs,
      pollIntervalMs,
      signal: controller.signal,
    });
    // Suppress unhandled rejection warning while we drive the test.
    promise.catch(() => {});

    // Abort at t=300 — well before the first poll interval fires.
    await vi.advanceTimersByTimeAsync(300);
    controller.abort();
    await vi.advanceTimersByTimeAsync(10);

    await expect(promise).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('rejects immediately when aborted during a pending ledger request', async () => {
    const controller = new AbortController();
    let resolveRequest!: (value: { sequence: number }) => void;
    const server = {
      getLatestLedger: vi.fn(
        () => new Promise<{ sequence: number }>((resolve) => (resolveRequest = resolve)),
      ),
    };
    const promise = waitForLedger(server, 99, { signal: controller.signal });
    const rejection = expect(promise).rejects.toMatchObject({ name: 'AbortError' });

    controller.abort();
    await rejection;
    expect(server.getLatestLedger).toHaveBeenCalledTimes(1);

    resolveRequest({ sequence: 0 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(server.getLatestLedger).toHaveBeenCalledTimes(1);
  });

  // ── Scenario 4 – Ledger seen before first poll ────────────────────────────

  it('resolves immediately when the ledger is already at or above the target', async () => {
    const server = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 50 }),
    };

    const promise = waitForLedger(server, 42, {
      timeoutMs: 10_000,
      pollIntervalMs: 500,
    });

    // No timer advancement needed — the first poll should satisfy the condition.
    await vi.advanceTimersByTimeAsync(0);

    await expect(promise).resolves.toBeUndefined();
    // Should have checked exactly once.
    expect(server.getLatestLedger).toHaveBeenCalledTimes(1);
  });

  // ── Scenario 5 – exact timeout tick: remaining becomes exactly 0 ───────────

  it('times out when remaining hits exactly 0 before the ledger is found', async () => {
    /*
     * Uses a very short timeout with a poll interval equal to the timeout,
     * so the check for remaining <= 0 is exercised in the simplest path.
     */
    const timeoutMs = 100;
    const pollIntervalMs = 100;
    const targetSequence = 7;
    const startMs = Date.now();

    // Ledger never arrives.
    const server = makeMockServer([], startMs);

    const promise = waitForLedger(server, targetSequence, {
      timeoutMs,
      pollIntervalMs,
    });
    // Suppress unhandled rejection warning while we drive the test.
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(timeoutMs + 1);

    await expect(promise).rejects.toThrow(
      /waitForLedger: timed out after 100ms/,
    );
  });
});
