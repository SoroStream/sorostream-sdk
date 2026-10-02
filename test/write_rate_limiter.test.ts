import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WriteRateLimiter, WriteRateLimitOptions } from '../src/writeRateLimiter.js';
import { RateLimitExceededError } from '../src/errors.js';

describe('WriteRateLimiter (#542) - Queue Capacity Behavior', () => {
  let limiter: WriteRateLimiter;

  // burst: 1 means only the very first call on a bucket is free; every
  // subsequent call on the same bucket must wait out the 100ms interval
  // (maxPerSecond: 10), which is what lets them occupy a queue slot.
  const options: WriteRateLimitOptions = {
    maxPerSecond: 10,
    burst: 1,
    queueSize: 2, // Small queue size for testing
    shared: false,
  };

  beforeEach(() => {
    limiter = new WriteRateLimiter(options);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should reject when queue capacity is exceeded', async () => {
    // Same operation name so all calls compete for the same bucket.
    const promise1 = limiter.acquire('write'); // free (burst allowance)
    const promise2 = limiter.acquire('write'); // queued (slot 1/2)
    const promise3 = limiter.acquire('write'); // queued (slot 2/2)

    await expect(promise1).resolves.toBeUndefined();

    // The queue is now at capacity (2/2) — the next call must reject.
    await expect(limiter.acquire('write')).rejects.toThrow(RateLimitExceededError);

    // Drain the queued operations so no promises are left pending.
    await vi.advanceTimersByTimeAsync(300);
    await expect(promise2).resolves.toBeUndefined();
    await expect(promise3).resolves.toBeUndefined();
  });

  it('should include queue depth and limit in error message', async () => {
    limiter.acquire('write'); // free
    limiter.acquire('write'); // queued (slot 1/2)
    const pending = limiter.acquire('write'); // queued (slot 2/2)

    try {
      await limiter.acquire('write');
      expect.unreachable('expected acquire() to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitExceededError);
      expect((error as RateLimitExceededError).message).toBe('Rate limit exceeded: 2/2');
      expect((error as RateLimitExceededError).queueDepth).toBe(2);
      expect((error as RateLimitExceededError).queueLimit).toBe(2);
    }

    await vi.advanceTimersByTimeAsync(300);
    await expect(pending).resolves.toBeUndefined();
  });

  it('should allow operations up to queue capacity without rejection', async () => {
    const promise1 = limiter.acquire('write'); // free
    const promise2 = limiter.acquire('write'); // queued (slot 1/2), within capacity

    await expect(promise1).resolves.toBeUndefined();

    await vi.advanceTimersByTimeAsync(150);
    await expect(promise2).resolves.toBeUndefined();
  });

  it('should process queued operations and allow new ones after processing', async () => {
    const promise1 = limiter.acquire('write'); // free
    const promise2 = limiter.acquire('write'); // queued (slot 1/2)
    const promise3 = limiter.acquire('write'); // queued (slot 2/2)

    await expect(promise1).resolves.toBeUndefined();

    // Queue is full — a 4th call must reject.
    await expect(limiter.acquire('write')).rejects.toThrow(RateLimitExceededError);

    // Fast-forward enough for the queued operations to drain.
    await vi.advanceTimersByTimeAsync(300);
    await expect(promise2).resolves.toBeUndefined();
    await expect(promise3).resolves.toBeUndefined();

    // The queue has room again now that earlier operations completed.
    await expect(limiter.acquire('write')).resolves.toBeUndefined();
  });
});
