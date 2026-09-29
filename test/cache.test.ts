import { Cache } from '../src/cache';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Cache', () => {
  let originalPerformance: Performance | undefined;
  let originalDateNow: typeof Date.now;

  beforeEach(() => {
    // Store originals
    originalPerformance = globalThis.performance;
    originalDateNow = Date.now;
  });

  afterEach(() => {
    // Restore originals
    if (originalPerformance !== undefined) {
      globalThis.performance = originalPerformance;
    } else {
      // @ts-expect-error delete globalThis.performance
      delete globalThis.performance;
    }
    Date.now = originalDateNow;
    vi.useRealTimers();
  });

  it('uses monotonic clock and is immune to Date.now jumps', () => {
    // Mock performance.now to return a monotonic time that increases slowly
    let monotonicTime = 0;
    const mockPerformance = {
      now: () => {
        monotonicTime += 1; // increment by 1ms each call
        return monotonicTime;
      }
    } as Performance;
    // @ts-expect-error override globalThis.performance
    globalThis.performance = mockPerformance;

    // Mock Date.now to jump forward significantly
    let fakeDateNow = 0;
    Date.now = () => {
      fakeDateNow += 100; // jump by 100ms each call (simulating system sleep)
      return fakeDateNow;
    };

    const cache = new Cache<string, number>(50); // default TTL 50ms
    const key = 'key';
    const value = 42;

    // Insert entry
    cache.set(key, value);

    // Immediately get should return value
    expect(cache.get(key)).toBe(value);

    // Advance time via many Date.now calls (simulating sleep)
    // Each Date.now call advances fakeDateNow by 100ms, but monotonic time advances by 1ms per get/set call.
    // We'll call cache.get many times to also advance monotonic time a bit.
    for (let i = 0; i < 10; i++) {
      cache.get(key); // this will also increment monotonicTime by 1 via our mock
      // Also call Date.now directly to jump it
      Date.now();
    }

    // After 10 iterations:
    // monotonicTime increased by 10 (from get calls) + maybe 10 from set? Actually set called once.
    // Let's compute: initial set: monotonicTime increased by 1 (from set's now() call)
    // Then each get: monotonicTime increased by 1 (from get's now() call)
    // So after set + 10 gets: monotonicTime = 1 + 10*1 = 11
    // fakeDateNow: initial 0, then each Date.now call in the loop adds 100, plus the two Date.now calls in set and each get?
    // Actually, in set we call now() which is performance.now, not Date.now.
    // In get we call now() which is performance.now, not Date.now.
    // But we also called Date.now() explicitly in the loop.
    // So fakeDateNow increased by 10 * 100 = 1000ms.
    // The entry was set at monotonicTime around 1 (from set) and expiresAt = monotonicTimeAtSet + 50.
    // monotonicTimeAtSet: let's say when set was called, mockPerformance.now() returned the value before increment? In our mock, we increment then return? Actually we do monotonicTime += 1; return monotonicTime; So the first call returns 1.
    // So expiresAt = 1 + 50 = 51.
    // After 10 gets, monotonicTime is 11 (as computed). So 11 < 51, so entry should not be expired.
    expect(cache.get(key)).toBe(value);

    // Now advance monotonic time beyond expiry without jumping Date.now too much
    // Call get enough times to increase monotonicTime beyond 51
    for (let i = 0; i < 50; i++) {
      cache.get(key);
    }
    // Now monotonicTime should be 11 + 50 = 61, which is > 51, so entry should be expired
    expect(cache.get(key)).toBeUndefined();
  });

  it('falls back to Date.now when performance.now is not available', () => {
    // Store original values
    const originalPerformanceNow = globalThis.performance?.now;
    const originalProcessHrTime = globalThis.process?.hrtime;
    // Make performance.now and process.hrtime unavailable to force fallback to Date.now
    if (globalThis.performance) {
      delete globalThis.performance.now;
    }
    if (globalThis.process) {
      globalThis.process.hrtime = undefined;
    }

    // Mock Date.now to jump
    let fakeDateNow = 0;
    Date.now = () => {
      fakeDateNow += 10;
      return fakeDateNow;
    };

    const cache = new Cache<string, number>(50);
    const key = 'key';
    const value = 42;

    cache.set(key, value);
    expect(cache.get(key)).toBe(value);

    // Advance fakeDateNow beyond TTL
    for (let i = 0; i < 6; i++) {
      Date.now(); // each adds 10, total 60ms
    }
    // Now fakeDateNow is 60, which is > 50 (set at time 0? Actually set called when fakeDateNow was 0? Let's see: 
    // Before set, fakeDateNow is 0.
    // In set, we call now() which is Date.now (since performance.now and process.hrtime are deleted). That will increment fakeDateNow by 10 and return it.
    // So set happens at time 10, expiresAt = 10 + 50 = 60.
    // Then we call Date.now 6 times: each adds 10, so after 6 calls, fakeDateNow = 10 (initial) + 6*10 = 70.
    // So entry should be expired.
    expect(cache.get(key)).toBeUndefined();

    // Restore original values
    if (globalThis.performance) {
      globalThis.performance.now = originalPerformanceNow;
    }
    if (globalThis.process) {
      globalThis.process.hrtime = originalProcessHrTime;
    }
  });
});