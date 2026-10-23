/**
 * Issue #784: PriorityRequestQueue — priority-lane ordering when a
 * high-priority write and a low-priority read are both enqueued at full
 * capacity *simultaneously* (same tick).
 *
 * Scenario: queue is already at capacity (all concurrency slots occupied).
 * A high-priority write and a low-priority read arrive in the same
 * microtask tick. The write must be dequeued and processed first regardless
 * of which happened to be pushed microseconds earlier.
 * The deferred lower-priority read must also fire the `rateLimitDelayed`
 * (onDelayed) callback.
 */
import { describe, it, expect, vi } from 'vitest';
import { PriorityRequestQueue } from '../src/request-queue.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns a task that records execution order and resolves after `holdMs`. */
function makeOrderedTask(label: string, order: string[], holdMs = 10) {
  return async () => {
    order.push(`start:${label}`);
    await new Promise<void>((r) => setTimeout(r, holdMs));
    order.push(`end:${label}`);
    return label;
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PriorityRequestQueue — same-tick capacity contention (#784)', () => {
  /**
   * Core acceptance criterion:
   * Fill the queue to capacity, then enqueue a write (high) and a read (low)
   * in the same tick. Assert the write is dequeued before the read.
   */
  it('write (high priority) is processed before read (low priority) when both are enqueued at capacity in the same tick', async () => {
    // maxConcurrent: 2 so we can fill it with 2 long-running blockers.
    const queue = new PriorityRequestQueue({
      maxConcurrent: 2,
      priorityLanes: ['write', 'read'],
    });

    const order: string[] = [];

    // Fill both concurrency slots with long-running blocker tasks.
    queue.enqueue('write', makeOrderedTask('blocker-1', order, 80));
    queue.enqueue('read', makeOrderedTask('blocker-2', order, 80));

    // Give the blockers a moment to actually claim their slots (they start
    // synchronously in the current microtask, but we want to be safe).
    await Promise.resolve();

    // ── Same-tick enqueue of write (high) and read (low) ────────────────────
    // Both are enqueued while the queue is at capacity → both must wait.
    // The write is intentionally enqueued AFTER the read to stress-test that
    // ordering is by priority, not enqueue order.
    const delayedEvents: Array<{ lane: string; queueDepth: number }> = [];
    queue.onDelayed = (payload) => {
      delayedEvents.push({ lane: payload.lane, queueDepth: payload.queueDepth });
    };

    queue.enqueue('read', makeOrderedTask('low-read', order, 5), { priority: 'low' });
    queue.enqueue('write', makeOrderedTask('high-write', order, 5), { priority: 'high' });

    await queue.waitForDrain();

    // high-write must have started before low-read.
    const highWriteStart = order.indexOf('start:high-write');
    const lowReadStart = order.indexOf('start:low-read');

    expect(highWriteStart).toBeGreaterThan(-1);
    expect(lowReadStart).toBeGreaterThan(-1);
    expect(highWriteStart).toBeLessThan(lowReadStart);

    // Both deferred tasks fired an onDelayed event.
    expect(delayedEvents.length).toBeGreaterThanOrEqual(2);
    const lanes = delayedEvents.map((e) => e.lane);
    expect(lanes).toContain('read');
    expect(lanes).toContain('write');
  });

  /**
   * The `rateLimitDelayed` event must fire for the lower-priority (read)
   * request that is held in queue. The event must carry the correct lane
   * name and a non-negative estimatedWaitMs.
   */
  it('fires rateLimitDelayed for the deferred lower-priority read with correct lane metadata', async () => {
    const queue = new PriorityRequestQueue({
      maxConcurrent: 1,
      priorityLanes: ['write', 'read'],
    });

    const delayed: Array<{ lane: string; estimatedWaitMs: number; queueDepth: number }> = [];
    queue.onDelayed = (p) => delayed.push({ ...p });

    // Fill the single slot.
    queue.enqueue('write', async () => {
      await new Promise<void>((r) => setTimeout(r, 30));
      return 'blocker';
    });

    // At capacity: enqueue high-priority write and low-priority read together.
    queue.enqueue('write', async () => 'high-write', { priority: 'high' });
    queue.enqueue('read', async () => 'low-read', { priority: 'low' });

    await queue.waitForDrain();

    // Both enqueued-while-full tasks must have fired onDelayed.
    expect(delayed.length).toBe(2);

    const readEvent = delayed.find((e) => e.lane === 'read');
    const writeEvent = delayed.find((e) => e.lane === 'write');

    expect(readEvent).toBeDefined();
    expect(writeEvent).toBeDefined();
    expect(readEvent!.estimatedWaitMs).toBeGreaterThanOrEqual(0);
    expect(writeEvent!.estimatedWaitMs).toBeGreaterThanOrEqual(0);
    expect(readEvent!.queueDepth).toBeGreaterThanOrEqual(0);
    expect(writeEvent!.queueDepth).toBeGreaterThanOrEqual(0);
  });

  /**
   * Verify enqueue order within the same priority does not violate FIFO:
   * two high-priority writes enqueued at capacity should run in FIFO order.
   */
  it('preserves FIFO for equal-priority tasks enqueued at capacity', async () => {
    const queue = new PriorityRequestQueue({
      maxConcurrent: 1,
      priorityLanes: ['write', 'read'],
    });

    const order: string[] = [];

    // Block the single slot.
    queue.enqueue('write', makeOrderedTask('blocker', order, 50));

    // Two high-priority writes in the same tick — must run FIFO.
    queue.enqueue('write', makeOrderedTask('high-1', order, 5), { priority: 'high' });
    queue.enqueue('write', makeOrderedTask('high-2', order, 5), { priority: 'high' });

    await queue.waitForDrain();

    const h1Start = order.indexOf('start:high-1');
    const h2Start = order.indexOf('start:high-2');
    expect(h1Start).toBeGreaterThan(-1);
    expect(h2Start).toBeGreaterThan(-1);
    expect(h1Start).toBeLessThan(h2Start);
  });

  /**
   * Baseline sanity: high-priority write beats low-priority read across
   * write/read lanes even when the read was enqueued first.
   */
  it('high-priority write beats low-priority read regardless of enqueue order', async () => {
    const queue = new PriorityRequestQueue({
      maxConcurrent: 1,
      priorityLanes: ['write', 'read'],
    });

    const order: string[] = [];

    // Block the slot.
    queue.enqueue('write', makeOrderedTask('blocker', order, 50));

    // Enqueue read BEFORE write — priority must still win.
    queue.enqueue('read', makeOrderedTask('low-read', order, 5), { priority: 'low' });
    queue.enqueue('write', makeOrderedTask('high-write', order, 5), { priority: 'high' });

    await queue.waitForDrain();

    const highStart = order.indexOf('start:high-write');
    const lowStart = order.indexOf('start:low-read');
    expect(highStart).toBeLessThan(lowStart);
  });
});
