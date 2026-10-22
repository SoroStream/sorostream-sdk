import { describe, it, expect } from 'vitest';
import {
  OfflineWriteQueue,
  DEFAULT_QUEUE_OPTIONS,
  type PersistedQueuedOperation,
} from '../src/offlineQueue.js';
import { InMemoryEventBus } from '../src/eventBus.js';

/** Minimal in-memory storage standing in for localStorage/IndexedDB. */
function memoryAdapter(store: { ops: PersistedQueuedOperation[] }) {
  return {
    load: () => [...store.ops],
    save: (ops: PersistedQueuedOperation[]) => {
      store.ops = [...ops];
    },
  };
}

describe('OfflineQueue persistence (issue #681)', () => {
  it('rehydrates queued operations in a new instance sharing the same store', async () => {
    const store = { ops: [] as PersistedQueuedOperation[] };
    const bus1 = new InMemoryEventBus();
    const q1 = new OfflineWriteQueue(
      { ...DEFAULT_QUEUE_OPTIONS, enabled: true },
      bus1,
      memoryAdapter(store),
    );
    await q1.ready;

    q1.enqueue('op-a', () => Promise.resolve('a'), 1);
    q1.enqueue('op-b', () => Promise.resolve('b'), 5);
    expect(store.ops.map((o) => o.operation)).toEqual(['op-b', 'op-a']);

    // Simulate a page reload: new instance over the same store.
    const bus2 = new InMemoryEventBus();
    const drained: unknown[] = [];
    bus2.on('queueDrained', (e) => drained.push(e));
    const q2 = new OfflineWriteQueue(
      { ...DEFAULT_QUEUE_OPTIONS, enabled: true },
      bus2,
      memoryAdapter(store),
      (persisted) => () => Promise.resolve(`replayed:${persisted.operation}`),
    );
    await q2.ready;

    expect(q2.size).toBe(2);
    const event = await q2.drain();
    expect(event.results.map((r) => r.result)).toEqual(['replayed:op-b', 'replayed:op-a']);
    expect(event.totalOperations).toBe(2);
    expect(drained.length).toBe(1);
  });

  it('defaults to in-memory-only behavior when no adapter is configured', () => {
    const queue = new OfflineWriteQueue(
      { ...DEFAULT_QUEUE_OPTIONS, enabled: true },
      new InMemoryEventBus(),
    );
    expect(queue.enqueue('op', () => Promise.resolve(1))).toBe(true);
    expect(queue.size).toBe(1);
  });
});
