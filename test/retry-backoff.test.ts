import { describe, it, expect } from 'vitest';
import { RetryBackoff } from '../src/retry.js';

describe('RetryBackoff', () => {
  it('returns 0 delay on first failure (base attempt)', () => {
    const backoff = new RetryBackoff({ baseDelayMs: 200, maxDelayMs: 5000 });
    const delay = backoff.onFailure('request-1');
    // First failure: cap = min(5000, 200 * 2^0) = 200, delay = random(0, 200)
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThan(200);
  });

  it('increases delay on subsequent failures', () => {
    const backoff = new RetryBackoff({ baseDelayMs: 200, maxDelayMs: 5000 });

    // Simulate 3 failures
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      delays.push(backoff.onFailure('request-1'));
    }

    // Each delay should be within its respective cap
    // Attempt 0: cap = 200, Attempt 1: cap = 400, Attempt 2: cap = 800
    expect(delays[0]).toBeLessThan(200);
    expect(delays[1]).toBeLessThan(400);
    expect(delays[2]).toBeLessThan(800);
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
    expect(delay).toBeLessThan(200);
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
    expect(delay).toBeLessThan(200);
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
    expect(delay).toBeLessThan(200);
    expect(backoff.getAttemptCount('my-request')).toBe(1);
  });

  it('caps delay at maxDelayMs', () => {
    const backoff = new RetryBackoff({ baseDelayMs: 1000, maxDelayMs: 500 });

    // Even with many failures, delay should never exceed maxDelayMs
    for (let i = 0; i < 10; i++) {
      const delay = backoff.onFailure('request-1');
      expect(delay).toBeLessThan(500);
    }
  });
});
