import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WriteRateLimiter, WriteRateLimitOptions } from '../src/writeRateLimiter.js';
import { RateLimitExceededError } from '../src/errors.js';

describe('WriteRateLimiter (#542) - Queue Capacity Behavior', () => {
  let limiter: WriteRateLimiter;
  
  // Options with a small queue capacity for testing
  const options: WriteRateLimitOptions = {
    maxPerSecond: 10,    // Not directly relevant for queue test
    burst: 1,              // Not directly relevant for queue test
    queueSize: 2,          // Small queue size for testing
    shared: false
  };

  beforeEach(() => {
    limiter = new WriteRateLimiter(options);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should reject when queue capacity is exceeded', async () => {
    // Fill up the queue
    const promise1 = limiter.acquire('op1');
    const promise2 = limiter.acquire('op2');
    
    // Both should succeed (queue now has 2 items, at capacity)
    await expect(promise1).resolves.toBeUndefined();
    await expect(promise2).resolves.toBeUndefined();
    
    // The third attempt should reject because queue is full
    await expect(limiter.acquire('op3')).rejects.toThrow(RateLimitExceededError);
  });

  it('should include queue depth and limit in error message', async () => {
    // Fill up the queue
    await limiter.acquire('op1');
    await limiter.acquire('op2');
    
    // Try to add one more - should fail with proper error
    await expect(limiter.acquire('op3')).rejects.toThrow(RateLimitExceededError);
    try {
      await limiter.acquire('op3');
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitExceededError);
      expect((error as RateLimitExceededError).message).toBe('Rate limit exceeded: 2/2');
      expect((error as RateLimitExceededError).queueDepth).toBe(2);
      expect((error as RateLimitExceededError).queueLimit).toBe(2);
    }
  });

  it('should allow operations up to queue capacity without rejection', async () => {
    // These should all succeed as they're within queue capacity
    const promise1 = limiter.acquire('op1');
    const promise2 = limiter.acquire('op2');
    
    await expect(promise1).resolves.toBeUndefined();
    await expect(promise2).resolves.toBeUndefined();
  });

  it('should process queued operations and allow new ones after processing', async () => {
    // Fill up the queue
    await limiter.acquire('op1');
    await limiter.acquire('op2');
    
    // Try to add one more - should fail
    await expect(limiter.acquire('op3')).rejects.toThrow(RateLimitExceededError);
    
    // Fast forward time to allow processing
    vi.advanceTimersByTime(150); // Enough time for ~1 operation at 10 per second
    
    // Now we should be able to add one more
    await expect(limiter.acquire('op4')).resolves.toBeUndefined();
  });
});