/**
 * Tests for Issue #681: OfflineWriteQueue persistence across page reloads.
 */
import { describe, it, expect } from 'vitest';
import { OfflineWriteQueue, DEFAULT_QUEUE_OPTIONS } from '../src/offlineQueue.js';
import type { QueueDrainedEvent } from '../src/offlineQueue.js';
import type { StorageAdapter } from '../src/adapters.js';
import { InMemoryEventBus } from '../src/eventBus.js';

function createMemoryStorage(): StorageAdapter {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

describe('OfflineWriteQueue persistence across page reloads (#681)', () => {
  it('persists queued operations and replays them in priority + FIFO order after reload', async () => {
    const storage = createMemoryStorage();
    const firstBus = new InMemoryEventBus();

    const firstQueue = new OfflineWriteQueue(
      { ...DEFAULT_QUEUE_OPTIONS, enabled: true, storage },
      firstBus,
    );

    firstQueue.enqueue('withdraw', async () => 'w1', 1, { streamId: '1', amount: 100n });
    firstQueue.enqueue('createStream', async () => 'c1', 10, { recipient: 'GABC' });
    firstQueue.enqueue('withdraw', async () => 'w2', 1, { streamId: '2', amount: 200n });
    expect(firstQueue.size).toBe(3);

    // Simulate page reload: new queue instance backed by the same StorageAdapter
    const secondBus = new InMemoryEventBus();
    const drainedEvents: QueueDrainedEvent[] = [];
    secondBus.on('queueDrained', (ev) => drainedEvents.push(ev as QueueDrainedEvent));

    const replayed: Array<{ operation: string; payload: unknown }> = [];
    const secondQueue = new OfflineWriteQueue(
      {
        ...DEFAULT_QUEUE_OPTIONS,
        enabled: true,
        storage,
        rehydrateExecutor: (entry) => async () => {
          replayed.push({ operation: entry.operation, payload: entry.payload });
          return entry.id;
        },
      },
      secondBus,
    );

    expect(secondQueue.size).toBe(3);

    await secondQueue.markOnline();

    expect(secondQueue.size).toBe(0);
    expect(replayed).toEqual([
      { operation: 'createStream', payload: { recipient: 'GABC' } },
      { operation: 'withdraw', payload: { streamId: '1', amount: 100n } },
      { operation: 'withdraw', payload: { streamId: '2', amount: 200n } },
    ]);
    expect(drainedEvents).toHaveLength(1);
    expect(drainedEvents[0].totalOperations).toBe(3);
    expect(drainedEvents[0].successful).toBe(3);
    expect(drainedEvents[0].failed).toBe(0);

    // After draining, a subsequent reload should start with an empty queue
    const thirdQueue = new OfflineWriteQueue(
      { ...DEFAULT_QUEUE_OPTIONS, enabled: true, storage },
      new InMemoryEventBus(),
    );
    expect(thirdQueue.size).toBe(0);
  });

  it('emits queueDrained with failure details if no executor is registered after reload', async () => {
    const storage = createMemoryStorage();
    const q1 = new OfflineWriteQueue(
      { ...DEFAULT_QUEUE_OPTIONS, enabled: true, storage },
      new InMemoryEventBus(),
    );
    q1.enqueue('cancelStream', async () => 'ok', 0, { streamId: '99' });

    const bus2 = new InMemoryEventBus();
    const drainedEvents: QueueDrainedEvent[] = [];
    bus2.on('queueDrained', (ev) => drainedEvents.push(ev as QueueDrainedEvent));

    const q2 = new OfflineWriteQueue({ ...DEFAULT_QUEUE_OPTIONS, enabled: true, storage }, bus2);
    expect(q2.size).toBe(1);

    await q2.markOnline();
    expect(drainedEvents).toHaveLength(1);
    expect(drainedEvents[0].totalOperations).toBe(1);
    expect(drainedEvents[0].failed).toBe(1);
    expect(drainedEvents[0].results[0].success).toBe(false);
  });

  it('removes persisted entries when clear() is called', () => {
    const storage = createMemoryStorage();
    const q1 = new OfflineWriteQueue(
      { ...DEFAULT_QUEUE_OPTIONS, enabled: true, storage },
      new InMemoryEventBus(),
    );
    q1.enqueue('withdraw', async () => 'ok');
    q1.clear();

    const q2 = new OfflineWriteQueue(
      { ...DEFAULT_QUEUE_OPTIONS, enabled: true, storage },
      new InMemoryEventBus(),
    );
    expect(q2.size).toBe(0);
  });
});
