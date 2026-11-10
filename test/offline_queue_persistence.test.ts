/**
 * Tests for Issue #681: OfflineQueue persistence adapter and rehydration across reloads.
 *
 * Verifies:
 * - OfflineWriteQueue / OfflineQueue supports an optional persistence adapter (`load`/`save`/`clear`
 *   or `Storage`-compatible `getItem`/`setItem`/`removeItem`) to snapshot the queue to storage.
 * - Queue is rehydrated from storage on construction in priority-descending, FIFO-within-priority order.
 * - `queueDrained` fires with the rehydrated operations after a simulated page reload.
 * - Existing in-memory-only behavior remains the default when no adapter is configured.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  OfflineWriteQueue,
  OfflineQueue,
  DEFAULT_QUEUE_OPTIONS,
  DEFAULT_OFFLINE_QUEUE_STORAGE_KEY,
  type OfflineQueuePersistenceAdapter,
  type SerializedQueuedOperation,
  type QueueDrainedEvent,
} from '../src/offlineQueue.js';
import { InMemoryEventBus } from '../src/eventBus.js';

describe('OfflineQueue persistence across page reloads (issue #681)', () => {
  it('defaults to in-memory-only behavior when no persistence adapter is configured', async () => {
    const eventBus = new InMemoryEventBus();
    const queue = new OfflineWriteQueue({ ...DEFAULT_QUEUE_OPTIONS, enabled: true }, eventBus);

    expect(queue.isEmpty).toBe(true);
    queue.enqueue('withdraw', () => Promise.resolve('ok-1'), 1);
    queue.enqueue('createStream', () => Promise.resolve('ok-2'), 5);
    expect(queue.size).toBe(2);

    const drained = await queue.drain();
    expect(drained.results.map((r) => r.result)).toEqual(['ok-2', 'ok-1']);
    expect(queue.size).toBe(0);
  });

  it('snapshots queued operations to a custom persistence adapter and rehydrates on construction', async () => {
    let savedSnapshot: SerializedQueuedOperation[] = [];
    const saveSpy = vi.fn((ops: SerializedQueuedOperation[]) => {
      savedSnapshot = ops.map((op) => ({ ...op }));
    });
    const clearSpy = vi.fn(() => {
      savedSnapshot = [];
    });

    const adapter: OfflineQueuePersistenceAdapter = {
      load: () => savedSnapshot,
      save: saveSpy,
      clear: clearSpy,
    };

    // Simulate Tab before page reload: enqueue 3 operations with interleaved priorities
    const busBeforeReload = new InMemoryEventBus();
    const queueBeforeReload = new OfflineQueue(
      { ...DEFAULT_QUEUE_OPTIONS, enabled: true, persistenceAdapter: adapter },
      busBeforeReload,
    );

    queueBeforeReload.enqueue('withdraw', () => Promise.resolve('w-1'), 2, { streamId: 's-1' });
    queueBeforeReload.enqueue('cancelStream', () => Promise.resolve('c-1'), 10, {
      streamId: 's-2',
    });
    queueBeforeReload.enqueue('topUp', () => Promise.resolve('t-1'), 2, { streamId: 's-3' });

    expect(saveSpy).toHaveBeenCalledTimes(3);
    expect(savedSnapshot.map((op) => op.operation)).toEqual(['cancelStream', 'withdraw', 'topUp']);

    // Simulate page reload: construct a brand-new OfflineQueue backed by the same adapter
    const busAfterReload = new InMemoryEventBus();
    const drainedEvents: QueueDrainedEvent[] = [];
    busAfterReload.on('queueDrained', (ev) => drainedEvents.push(ev as QueueDrainedEvent));

    const queueAfterReload = new OfflineQueue(
      { ...DEFAULT_QUEUE_OPTIONS, enabled: true, persistenceAdapter: adapter },
      busAfterReload,
    );

    expect(queueAfterReload.size).toBe(3);

    // Enqueue one more operation after reload to verify monotonic sequence continuity
    queueAfterReload.enqueue('withdraw', () => Promise.resolve('w-2'), 2, { streamId: 's-4' });
    expect(queueAfterReload.size).toBe(4);

    const drained = await queueAfterReload.drain();
    expect(drained.totalOperations).toBe(4);
    expect(drained.successful).toBe(4);
    expect(drained.results.map((r) => r.result)).toEqual(['c-1', 'w-1', 't-1', 'w-2']);
    expect(drainedEvents).toHaveLength(1);
    expect(savedSnapshot).toHaveLength(0);

    queueAfterReload.clear();
    expect(clearSpy).toHaveBeenCalled();
  });

  it('rehydrates JSON-serialized entries from a Web Storage-compatible adapter and replays via operationExecutor', async () => {
    const backingStore = new Map<string, string>();
    const webStorageAdapter: OfflineQueuePersistenceAdapter = {
      getItem: (key: string) => backingStore.get(key) ?? null,
      setItem: (key: string, value: string) => {
        backingStore.set(key, value);
      },
      removeItem: (key: string) => {
        backingStore.delete(key);
      },
    };

    const bus1 = new InMemoryEventBus();
    const queue1 = new OfflineWriteQueue(
      { ...DEFAULT_QUEUE_OPTIONS, enabled: true, storage: webStorageAdapter },
      bus1,
    );

    queue1.enqueue('withdraw', () => Promise.resolve('live-1'), 1, { amount: '50' });
    queue1.enqueue('createStream', () => Promise.resolve('live-2'), 5, { recipient: 'GABC' });

    const rawJson = backingStore.get(DEFAULT_OFFLINE_QUEUE_STORAGE_KEY);
    expect(rawJson).toBeDefined();
    const parsed = JSON.parse(rawJson!);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].operation).toBe('createStream');
    expect(parsed[0].payload).toEqual({ recipient: 'GABC' });

    // Simulate reload where closures were stripped by JSON serialization
    const executedOps: Array<{ operation: string; payload: unknown }> = [];
    const bus2 = new InMemoryEventBus();
    const queue2 = new OfflineWriteQueue(
      {
        ...DEFAULT_QUEUE_OPTIONS,
        enabled: true,
        storage: webStorageAdapter,
        operationExecutor: async (op) => {
          executedOps.push({ operation: op.operation, payload: op.payload });
          return `replayed:${op.operation}`;
        },
      },
      bus2,
    );

    expect(queue2.size).toBe(2);
    const event = await queue2.drain();
    expect(event.successful).toBe(2);
    expect(executedOps).toEqual([
      { operation: 'createStream', payload: { recipient: 'GABC' } },
      { operation: 'withdraw', payload: { amount: '50' } },
    ]);
    expect(JSON.parse(backingStore.get(DEFAULT_OFFLINE_QUEUE_STORAGE_KEY)!)).toEqual([]);
  });

  it('supports async persistence adapters during construction and waits before draining', async () => {
    const initialOps: SerializedQueuedOperation[] = [
      {
        id: 'op-low',
        operation: 'withdraw',
        queuedAt: 1000,
        priority: 1,
        sequence: 0,
        payload: { id: 1 },
      },
      {
        id: 'op-high',
        operation: 'cancelStream',
        queuedAt: 1001,
        priority: 9,
        sequence: 1,
        payload: { id: 2 },
      },
    ];

    const asyncAdapter: OfflineQueuePersistenceAdapter = {
      load: async () => {
        await new Promise((r) => setTimeout(r, 15));
        return initialOps;
      },
      save: async () => {},
    };

    const bus = new InMemoryEventBus();
    const queue = new OfflineWriteQueue(
      {
        ...DEFAULT_QUEUE_OPTIONS,
        enabled: true,
        persistenceAdapter: asyncAdapter,
      },
      bus,
    );

    queue.registerOperationHandler('cancelStream', async (payload) => ({
      handled: 'cancelStream',
      payload,
    }));
    queue.registerOperationHandler('withdraw', async (payload) => ({
      handled: 'withdraw',
      payload,
    }));

    const drained = await queue.drain();
    expect(drained.totalOperations).toBe(2);
    expect(drained.results.map((r) => r.operation.id)).toEqual(['op-high', 'op-low']);
    expect(drained.results[0]?.result).toEqual({
      handled: 'cancelStream',
      payload: { id: 2 },
    });
  });
});
