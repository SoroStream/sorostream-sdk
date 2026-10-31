/**
 * Issue #759: Verify that RateLimiter is reachable via the public package
 * entry point (`@sorostream/sdk`).
 *
 * RateLimiter is a general-purpose async concurrency limiter (promise worker
 * pool).  It is distinct from WriteRateLimiter (token-bucket throttle for
 * write operations, issue #464) and PriorityRequestQueue (multi-lane priority
 * queue for RPC calls, issue #265).  See docs/rate-limiting.md for the full
 * comparison.
 *
 * Rather than removing it as superseded, we wire it into a public export path
 * because it serves a different use case: lightweight, rate-agnostic
 * concurrency capping for arbitrary async tasks — no time windows, no token
 * buckets, no priority lanes.
 */
import { describe, it, expect } from 'vitest';

// Import from the barrel re-export, not the deep path
import { RateLimiter } from '../src/index.js';

describe('Issue #759: RateLimiter exported from public entry point', () => {
  it('RateLimiter is exported and constructable', () => {
    const limiter = new RateLimiter(5);
    expect(limiter).toBeInstanceOf(RateLimiter);
    expect(limiter.concurrency).toBe(5);
  });

  it('RateLimiter limits concurrent execution to maxConcurrent', async () => {
    const limiter = new RateLimiter(2);
    let active = 0;
    let maxActive = 0;

    const task = async (id: number): Promise<number> => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return id;
    };

    const results = await Promise.all([1, 2, 3, 4, 5].map((id) => limiter.run(() => task(id))));

    expect(results).toEqual([1, 2, 3, 4, 5]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it('RateLimiter queues without rejecting (unlike WriteRateLimiter)', async () => {
    // RateLimiter never rejects due to queue capacity — it queues tasks
    const limiter = new RateLimiter(1);
    const results = await Promise.all([
      limiter.run(async () => 'a'),
      limiter.run(async () => 'b'),
      limiter.run(async () => 'c'),
    ]);
    expect(results).toEqual(['a', 'b', 'c']);
  });

  it('RateLimiter supports runtime maxConcurrent updates', async () => {
    const limiter = new RateLimiter(1);
    expect(limiter.concurrency).toBe(1);

    limiter.setMaxConcurrent(3);
    expect(limiter.concurrency).toBe(3);
  });

  it('RateLimiter exposes pending and active counters', async () => {
    const limiter = new RateLimiter(1);

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const p1 = limiter.run(() => gate);
    const p2 = limiter.run(() => Promise.resolve('done'));

    // Let microtasks settle
    await new Promise((r) => setTimeout(r, 0));

    expect(limiter.active).toBe(1);
    expect(limiter.pending).toBe(1);

    release();
    await Promise.all([p1, p2]);

    expect(limiter.active).toBe(0);
    expect(limiter.pending).toBe(0);
  });

  it('RateLimiter rejects invalid maxConcurrent in constructor', () => {
    expect(() => new RateLimiter(0)).toThrow('maxConcurrent must be >= 1');
  });

  it('RateLimiter rejects invalid runtime maxConcurrent', () => {
    const limiter = new RateLimiter(2);
    expect(() => limiter.setMaxConcurrent(0)).toThrow('maxConcurrent must be >= 1');
  });
});
