/**
 * Tests for Issue #731: OfflineQueue FIFO-within-priority ordering with
 * interleaved priority levels.
 *
 * Verifies:
 * - Dequeue order honours priority first, then insertion order within a priority.
 * - Same-priority ties preserve FIFO order (insertion order).
 * - The `queueDrained` event payload reflects the same correct order.
 */
import { describe, it, expect, vi } from 'vitest';
import { OfflineWriteQueue, DEFAULT_QUEUE_OPTIONS } from '../src/offlineQueue.js';
import type { QueueDrainedEvent } from '../src/offlineQueue.js';
import { InMemoryEventBus } from '../src/eventBus.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeQueue(maxQueueSize = 100) {
  const eventBus = new InMemoryEventBus();
  const queue = new OfflineWriteQueue(
    { ...DEFAULT_QUEUE_OPTIONS, enabled: true, maxQueueSize },
    eventBus,
  );
  return { queue, eventBus };
}

/** Returns an executor that resolves with the given label. */
function exec(label: string) {
  return () => Promise.resolve(label);
}

// ── Issue #731: FIFO-within-priority ordering ──────────────────────────────

describe('OfflineQueue FIFO-within-priority ordering (issue #731)', () => {
  it('drains a single priority level in FIFO (insertion) order', async () => {
    const { queue } = makeQueue();

    queue.enqueue('op-a', exec('a'), 5);
    queue.enqueue('op-b', exec('b'), 5);
    queue.enqueue('op-c', exec('c'), 5);

    const event = await queue.drain();

    const labels = event.results.map((r) => r.result as string);
    expect(labels).toEqual(['a', 'b', 'c']);
  });

  it('higher priority drains before lower priority', async () => {
    const { queue } = makeQueue();

    queue.enqueue('low', exec('low'), 1);
    queue.enqueue('high', exec('high'), 10);

    const event = await queue.drain();
    const labels = event.results.map((r) => r.result as string);
    expect(labels).toEqual(['high', 'low']);
  });

  it('interleaved priorities: drains in priority-first, FIFO-within-priority order', async () => {
    const { queue } = makeQueue();

    // Enqueue in a mixed order to expose ordering bugs
    queue.enqueue('med-1', exec('med-1'), 5); // priority 5, inserted 1st
    queue.enqueue('low-1', exec('low-1'), 1); // priority 1, inserted 2nd
    queue.enqueue('high-1', exec('high-1'), 10); // priority 10, inserted 3rd
    queue.enqueue('med-2', exec('med-2'), 5); // priority 5, inserted 4th
    queue.enqueue('low-2', exec('low-2'), 1); // priority 1, inserted 5th
    queue.enqueue('high-2', exec('high-2'), 10); // priority 10, inserted 6th

    const event = await queue.drain();
    const labels = event.results.map((r) => r.result as string);

    // Expected: high-priority items first (FIFO among themselves),
    // then medium-priority (FIFO), then low-priority (FIFO).
    expect(labels).toEqual(['high-1', 'high-2', 'med-1', 'med-2', 'low-1', 'low-2']);
  });

  it('same-priority ties preserve insertion (FIFO) order', async () => {
    const { queue } = makeQueue();

    queue.enqueue('first', exec('first'), 3);
    queue.enqueue('second', exec('second'), 3);
    queue.enqueue('third', exec('third'), 3);
    queue.enqueue('fourth', exec('fourth'), 3);

    const event = await queue.drain();
    const labels = event.results.map((r) => r.result as string);
    expect(labels).toEqual(['first', 'second', 'third', 'fourth']);
  });

  it('queueDrained event payload reflects priority-then-FIFO order', async () => {
    const { queue, eventBus } = makeQueue();

    const drainedEvents: QueueDrainedEvent[] = [];
    eventBus.on('queueDrained', (data) => {
      drainedEvents.push(data as QueueDrainedEvent);
    });

    queue.enqueue('normal-1', exec('n1'), 0);
    queue.enqueue('urgent-1', exec('u1'), 100);
    queue.enqueue('normal-2', exec('n2'), 0);
    queue.enqueue('urgent-2', exec('u2'), 100);

    await queue.drain();

    expect(drainedEvents).toHaveLength(1);
    const payload = drainedEvents[0]!;

    const operationNames = payload.results.map((r) => r.operation.operation);
    // urgent operations must come before normal ones, each set in insertion order
    expect(operationNames).toEqual(['urgent-1', 'urgent-2', 'normal-1', 'normal-2']);

    expect(payload.totalOperations).toBe(4);
    expect(payload.successful).toBe(4);
    expect(payload.failed).toBe(0);
  });

  it('queueDrained payload operation entries preserve insertion order within a priority', async () => {
    const { queue, eventBus } = makeQueue();

    const captured: QueueDrainedEvent[] = [];
    eventBus.on('queueDrained', (data) => captured.push(data as QueueDrainedEvent));

    // All same priority — order must match insertion sequence
    const labels = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
    for (const label of labels) {
      queue.enqueue(label, exec(label), 7);
    }

    await queue.drain();

    const resultLabels = captured[0]!.results.map((r) => r.result as string);
    expect(resultLabels).toEqual(labels);
  });

  it('three distinct priorities drain in strict priority-descending, FIFO-within order', async () => {
    const { queue } = makeQueue();

    // Interleave all three priorities
    queue.enqueue('p1-a', exec('p1-a'), 1);
    queue.enqueue('p3-a', exec('p3-a'), 3);
    queue.enqueue('p2-a', exec('p2-a'), 2);
    queue.enqueue('p1-b', exec('p1-b'), 1);
    queue.enqueue('p3-b', exec('p3-b'), 3);
    queue.enqueue('p2-b', exec('p2-b'), 2);

    const event = await queue.drain();
    const labels = event.results.map((r) => r.result as string);

    expect(labels).toEqual(['p3-a', 'p3-b', 'p2-a', 'p2-b', 'p1-a', 'p1-b']);
  });
});
