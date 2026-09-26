import { describe, it, expect, vi } from 'vitest';
import { PriorityRequestQueue } from '../src/request-queue.js';

describe('PriorityRequestQueue — per-request priority (issue #566)', () => {
  it('high-priority requests jump ahead of normal/low in the queue', async () => {
    // maxConcurrent: 1 so the first task blocks the only slot; everything else queues.
    const queue = new PriorityRequestQueue({ maxConcurrent: 1 });

    const order: string[] = [];
    const makeTask = (label: string, holdMs: number) => async () => {
      order.push(`start:${label}`);
      await new Promise((r) => setTimeout(r, holdMs));
      order.push(`end:${label}`);
      return label;
    };

    // Block the single slot with a long-running "low" task.
    queue.enqueue('read', makeTask('low-blocker', 50), { priority: 'low' });

    // Queue 3 low tasks then 1 high task. The high task must run before the
    // remaining lows even though it was enqueued last.
    queue.enqueue('read', makeTask('low-1', 5), { priority: 'low' });
    queue.enqueue('read', makeTask('low-2', 5), { priority: 'low' });
    queue.enqueue('read', makeTask('low-3', 5), { priority: 'low' });
    queue.enqueue('read', makeTask('high-1', 5), { priority: 'high' });

    await queue.waitForDrain();

    // The high-priority task must have started before the queued lows.
    const highStart = order.indexOf('start:high-1');
    const low1Start = order.indexOf('start:low-1');
    const low2Start = order.indexOf('start:low-2');
    const low3Start = order.indexOf('start:low-3');

    expect(highStart).toBeGreaterThan(0);
    expect(highStart).toBeLessThan(low1Start);
    expect(highStart).toBeLessThan(low2Start);
    expect(highStart).toBeLessThan(low3Start);

    // FIFO preserved within the same priority level: low-1..3 run in order.
    expect(low1Start).toBeLessThan(low2Start);
    expect(low2Start).toBeLessThan(low3Start);
  });

  it('defaults to normal priority when no options are passed', async () => {
    const queue = new PriorityRequestQueue({ maxConcurrent: 1 });
    queue.enqueue('read', async () => 'ok');
    const result = await queue.enqueue('read', async () => 'ok');
    expect(result).toBe('ok');
  });

  it('high priority is drained before normal across lanes', async () => {
    const queue = new PriorityRequestQueue({ maxConcurrent: 1, priorityLanes: ['write', 'read'] });
    const order: string[] = [];

    queue.enqueue('write', async () => {
      order.push('write-blocker-start');
      await new Promise((r) => setTimeout(r, 40));
      order.push('write-blocker-end');
      return 'w';
    });

    queue.enqueue('read', async () => {
      order.push('normal-read-start');
      await new Promise((r) => setTimeout(r, 5));
      order.push('normal-read-end');
      return 'n';
    });

    queue.enqueue('write', async () => {
      order.push('high-write-start');
      await new Promise((r) => setTimeout(r, 5));
      order.push('high-write-end');
      return 'h';
    }, { priority: 'high' });

    await queue.waitForDrain();

    // high-write must start before normal-read despite being enqueued later
    // and being in a different lane.
    expect(order.indexOf('high-write-start')).toBeLessThan(order.indexOf('normal-read-start'));
  });

  it('priority does not affect immediate execution when a slot is free', async () => {
    const queue = new PriorityRequestQueue({ maxConcurrent: 5 });
    const order: string[] = [];
    // Enqueued in reverse priority order, but all should run immediately
    // (no queueing) in enqueue order because slots are available.
    queue.enqueue('read', async () => { order.push('low'); return 'low'; }, { priority: 'low' });
    queue.enqueue('read', async () => { order.push('high'); return 'high'; }, { priority: 'high' });
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['low', 'high']);
  });

  it('getStats reflects queued items per lane', async () => {
    const queue = new PriorityRequestQueue({ maxConcurrent: 1 });
    queue.enqueue('read', async () => {
      await new Promise((r) => setTimeout(r, 50));
      return 'blocker';
    });
    queue.enqueue('read', async () => 'q1', { priority: 'low' });
    queue.enqueue('write', async () => 'q2', { priority: 'high' });

    const stats = queue.getStats();
    expect(stats.read.queued).toBe(1);
    expect(stats.write.queued).toBe(1);
    expect(stats.read.inFlight).toBe(1);
  });
});