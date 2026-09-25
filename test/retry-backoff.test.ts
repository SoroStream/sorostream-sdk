import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RetryBackoff, jitterDelay } from '../src/retry.js';

describe('RetryBackoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns a delay within [0, baseDelayMs) on first failure (base attempt)', () => {
    const backoff = new RetryBackoff({ baseDelayMs: 200, maxDelayMs: 5000 });
    const delay = backoff.onFailure('request-1');
    // First failure: cap = min(5000, 200 * 2^0) = 200, jitter ∈ [150, 250]
    expect(delay).toBeGreaterThanOrEqual(150);
    expect(delay).toBeLessThanOrEqual(250);
  });

  it('increases delay on subsequent failures', () => {
    const backoff = new RetryBackoff({ baseDelayMs: 200, maxDelayMs: 5000 });

    // Simulate 3 failures
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      delays.push(backoff.onFailure('request-1'));
    }

    // Each delay should be within its respective cap ±25% jitter
    // Attempt 0: cap = 200, jitter ∈ [150, 250]
    // Attempt 1: cap = 400, jitter ∈ [300, 500]
    // Attempt 2: cap = 800, jitter ∈ [600, 1000]
    expect(delays[0]).toBeGreaterThanOrEqual(150);
    expect(delays[0]).toBeLessThanOrEqual(250);
    expect(delays[1]).toBeGreaterThanOrEqual(300);
    expect(delays[1]).toBeLessThanOrEqual(500);
    expect(delays[2]).toBeGreaterThanOrEqual(600);
    expect(delays[2]).toBeLessThanOrEqual(1000);
  });

  it('resets backoff after success', () => {
    const backoff = new RetryBackoff({ baseDelayMs: 200, maxDelayMs: 5000 });

    // Simulate 3 failures
    for (let i = 0; i < 3; i++) {
      backoff.onFailure('request-1');
    }

    // Record success
    backoff.onSuccess('request-1');

    // Next failure should start at base delay again
    const delay = backoff.onFailure('request-1');
    expect(delay).toBeGreaterThanOrEqual(150);
    expect(delay).toBeLessThanOrEqual(250);
    expect(backoff.getAttemptCount('request-1')).toBe(1);
  });

  it('maintains separate backoff state per request key', () => {
    const backoff = new RetryBackoff({ baseDelayMs: 200, maxDelayMs: 5000 });

    // Fail request-1 three times
    for (let i = 0; i < 3; i++) {
      backoff.onFailure('request-1');
    }

    // request-2 is fresh
    const delay = backoff.onFailure('request-2');
    expect(delay).toBeGreaterThanOrEqual(150);
    expect(delay).toBeLessThanOrEqual(250);
    expect(backoff.getAttemptCount('request-2')).toBe(1);
    expect(backoff.getAttemptCount('request-1')).toBe(3);
  });

  it('resets only the specified request key', () => {
    const backoff = new RetryBackoff({ baseDelayMs: 200, maxDelayMs: 5000 });

    // Fail both requests
    for (let i = 0; i < 3; i++) {
      backoff.onFailure('request-1');
      backoff.onFailure('request-2');
    }

    // Reset only request-1
    backoff.reset('request-1');

    expect(backoff.getAttemptCount('request-1')).toBe(0);
    expect(backoff.getAttemptCount('request-2')).toBe(3);
  });

  it('resetAll clears all backoff state', () => {
    const backoff = new RetryBackoff({ baseDelayMs: 200, maxDelayMs: 5000 });

    // Fail multiple requests
    for (let i = 0; i < 3; i++) {
      backoff.onFailure('request-1');
      backoff.onFailure('request-2');
    }

    backoff.resetAll();

    expect(backoff.getAttemptCount('request-1')).toBe(0);
    expect(backoff.getAttemptCount('request-2')).toBe(0);
  });

  it('simulates: 3 failures, 1 success, 1 failure — final failure starts at base delay', () => {
    const backoff = new RetryBackoff({ baseDelayMs: 200, maxDelayMs: 5000 });

    // 3 failures — backoff increases
    for (let i = 0; i < 3; i++) {
      backoff.onFailure('my-request');
    }
    expect(backoff.getAttemptCount('my-request')).toBe(3);

    // 1 success — resets backoff
    backoff.onSuccess('my-request');
    expect(backoff.getAttemptCount('my-request')).toBe(0);

    // 1 failure — should start at base delay level (attempt 0)
    const delay = backoff.onFailure('my-request');
    expect(delay).toBeGreaterThanOrEqual(150);
    expect(delay).toBeLessThanOrEqual(250);
    expect(backoff.getAttemptCount('my-request')).toBe(1);
  });

  it('caps delay at maxDelayMs (jitter still bounded by cap)', () => {
    const backoff = new RetryBackoff({ baseDelayMs: 1000, maxDelayMs: 500 });

    // Even with many failures, delay should never exceed maxDelayMs * 1.25
    for (let i = 0; i < 10; i++) {
      const delay = backoff.onFailure('request-1');
      expect(delay).toBeLessThanOrEqual(625);
      expect(delay).toBeGreaterThanOrEqual(375);
    }
  });

  it('verifies the delay sequence across 5 retries with fake timers', async () => {
    const { withRetry } = await import('../src/retry.js');

    let attempt = 0;
    const fn = vi.fn(async () => {
      attempt++;
      throw new Error(`transient-${attempt}`);
    });

    // Deterministic jitter: pick the midpoint of the ±25% window so the
    // scheduled delays are predictable. With rawDelay=cap and random=0.5,
    // jitterDelay returns floor(cap - 0.25*cap + 0.5*(0.5*cap)) = cap.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const promise = withRetry(fn, {
      maxAttempts: 5,
      baseDelayMs: 100,
      maxDelayMs: 100_000,
    });

    // Attach a handler up front so the eventual rejection is not reported as
    // an unhandled promise rejection while fake timers drive the sequence.
    let caught: unknown;
    promise.catch((err) => {
      caught = err;
    });

    // With fake timers, no real time elapses between retries; advance by the
    // expected exponential delays (100, 200, 400, 800) so the sequence is
    // deterministic and each retry's setTimeout fires in turn.
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(800);

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('RPC request failed after 5 attempt');
    expect(fn).toHaveBeenCalledTimes(5);
  });
});

describe('jitterDelay', () => {
  it('returns 0 for a zero raw delay', () => {
    expect(jitterDelay(0)).toBe(0);
  });

  it('applies ±25% jitter to a raw delay', () => {
    vi.useFakeTimers();
    try {
      // With a fixed raw delay of 1000, jitter ∈ [750, 1250]
      const seen = new Set<number>();
      for (let i = 0; i < 200; i++) {
        seen.add(jitterDelay(1000));
      }
      for (const d of seen) {
        expect(d).toBeGreaterThanOrEqual(750);
        expect(d).toBeLessThanOrEqual(1250);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('produces a spread across the ±25% window', () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      // random=0 → floor(750 + 0) = 750
      expect(jitterDelay(1000)).toBe(750);
    } finally {
      randomSpy.mockRestore();
    }

    const randomSpy2 = vi.spyOn(Math, 'random').mockReturnValue(1);
    try {
      // random=1 → floor(750 + 500) = 1250
      expect(jitterDelay(1000)).toBe(1250);
    } finally {
      randomSpy2.mockRestore();
    }
  });
});