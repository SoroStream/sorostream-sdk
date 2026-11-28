// Issue #260: Offline write queue that buffers mutations when RPC is unreachable.
//
// When enabled via `offlineQueue: true` in the client config, failed write
// operations due to network errors are stored in an in-memory queue.
// On reconnection (detected via RPC health check polling), the queue drains
// in priority order (higher first, FIFO within a priority) and emits a `queueDrained` event with per-operation results.

import type { IEventBus } from './eventBus.js';
import { getDefaultStorageAdapter } from './adapters.js';
import type { StorageAdapter } from './adapters.js';

export const DEFAULT_OFFLINE_QUEUE_STORAGE_KEY = 'sorostream:offline_queue';

/** Serializable representation of a queued operation persisted to storage. */
export interface PersistedQueuedOperation {
  id: string;
  /** The operation name (e.g. "createStream", "withdraw", "cancelStream"). */
  operation: string;
  /** Timestamp when the operation was queued. */
  queuedAt: number;
  /** Replay priority; higher values drain first. Default: 0. */
  priority: number;
  /** Monotonically increasing insertion order within the queue. */
  sequence: number;
  /** Optional serializable arguments/payload for rehydrating the executor after reload. */
  payload?: unknown;
}

/** Factory that reconstructs an `execute` callback for a persisted operation after reload. */
export type OperationExecutorFactory = (
  entry: PersistedQueuedOperation,
) => (() => Promise<unknown>) | null | undefined;

/** A queued write operation waiting for replay. */
export interface QueuedOperation {
  id: string;
  /** The operation name (e.g. "createStream", "withdraw", "cancelStream"). */
  operation: string;
  /** The function that performs the actual write. */
  execute: () => Promise<unknown>;
  /** Timestamp when the operation was queued. */
  queuedAt: number;
  /** Replay priority; higher values drain first. Default: 0. */
  priority: number;
  /**
   * Monotonically increasing insertion order within the queue.
   * Deterministic tie-breaker so equal-priority operations are always
   * dequeued in the order they were enqueued.
   */
  sequence: number;
  /** Optional serializable payload associated with this operation. */
  payload?: unknown;
}

/** Result of replaying a queued operation. */
export interface QueueReplayResult {
  operation: QueuedOperation;
  success: boolean;
  result?: unknown;
  error?: string;
}

/** Payload for the `queueDrained` event. */
export interface QueueDrainedEvent {
  results: QueueReplayResult[];
  totalOperations: number;
  successful: number;
  failed: number;
}

/** Configuration for the offline write queue. */
export interface OfflineQueueOptions {
  /** Enable the offline queue. Default: false. */
  enabled: boolean;
  /** Maximum number of queued operations. Default: 100. */
  maxQueueSize: number;
  /** Health check polling interval in ms. Default: 10000. */
  healthCheckIntervalMs: number;
  /** Optional storage adapter for persisting queued operations across page reloads. */
  storage?: StorageAdapter | null;
  /** Storage key used when persisting the queue. Default: `"sorostream:offline_queue"`. */
  storageKey?: string;
  /** Optional callback to reconstruct `execute` for operations restored from storage. */
  rehydrateExecutor?: OperationExecutorFactory;
}

export const DEFAULT_QUEUE_OPTIONS: OfflineQueueOptions = {
  enabled: false,
  maxQueueSize: 100,
  healthCheckIntervalMs: 10_000,
};

function serializeQueueEntries(entries: PersistedQueuedOperation[]): string {
  return JSON.stringify(entries, (_key, value) =>
    typeof value === 'bigint' ? { __sorostreamBigInt: value.toString() } : value,
  );
}

function deserializeQueueEntries(raw: string): PersistedQueuedOperation[] {
  const parsed: unknown = JSON.parse(raw, (_key, value) => {
    if (
      value !== null &&
      typeof value === 'object' &&
      '__sorostreamBigInt' in value &&
      typeof (value as { __sorostreamBigInt: unknown }).__sorostreamBigInt === 'string'
    ) {
      return BigInt((value as { __sorostreamBigInt: string }).__sorostreamBigInt);
    }
    return value;
  });
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (item): item is PersistedQueuedOperation =>
      item !== null &&
      typeof item === 'object' &&
      typeof (item as PersistedQueuedOperation).id === 'string' &&
      typeof (item as PersistedQueuedOperation).operation === 'string' &&
      typeof (item as PersistedQueuedOperation).queuedAt === 'number' &&
      typeof (item as PersistedQueuedOperation).priority === 'number' &&
      typeof (item as PersistedQueuedOperation).sequence === 'number',
  );
}

/**
 * Offline write queue for the SoroStream SDK.
 * Buffers failed write operations, optionally persists them via {@link StorageAdapter}
 * across page reloads, and replays them when RPC connectivity is restored.
 */
export class OfflineWriteQueue {
  private queue: QueuedOperation[] = [];
  private isDraining = false;
  private isOnline = true;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private healthCheckFn: (() => Promise<boolean>) | null = null;
  /** Monotonic counter incremented on every enqueue; see {@link QueuedOperation.sequence}. */
  private nextSequence = 0;
  private readonly storage: StorageAdapter | null;
  private readonly storageKey: string;
  private rehydrateExecutor: OperationExecutorFactory | null;
  private readonly executorFactories = new Map<string, OperationExecutorFactory>();

  constructor(
    private options: OfflineQueueOptions,
    private eventBus: IEventBus,
  ) {
    this.storage = options.storage !== undefined ? options.storage : getDefaultStorageAdapter();
    this.storageKey = options.storageKey ?? DEFAULT_OFFLINE_QUEUE_STORAGE_KEY;
    this.rehydrateExecutor = options.rehydrateExecutor ?? null;

    if (this.options.enabled) {
      this.rehydrate();
    }
  }

  /**
   * Register an executor factory for a specific operation name so persisted
   * operations can be replayed after a page reload.
   */
  registerExecutor(operation: string, factory: OperationExecutorFactory): void {
    this.executorFactories.set(operation, factory);
  }

  /**
   * Set a fallback executor factory used to reconstruct `execute` for
   * persisted operations after a page reload.
   */
  setRehydrateExecutor(factory: OperationExecutorFactory): void {
    this.rehydrateExecutor = factory;
  }

  private resolveExecutor(entry: PersistedQueuedOperation): () => Promise<unknown> {
    const factory = this.executorFactories.get(entry.operation) ?? this.rehydrateExecutor;
    const resolved = factory?.(entry);
    if (resolved) return resolved;
    return async () => {
      const lateFactory = this.executorFactories.get(entry.operation) ?? this.rehydrateExecutor;
      const lateResolved = lateFactory?.(entry);
      if (lateResolved) {
        return lateResolved();
      }
      throw new Error(
        `No executor registered for persisted offline operation "${entry.operation}" (id: ${entry.id})`,
      );
    };
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      if (this.queue.length === 0) {
        this.storage.removeItem(this.storageKey);
        return;
      }
      const serializable: PersistedQueuedOperation[] = this.queue.map((op) => ({
        id: op.id,
        operation: op.operation,
        queuedAt: op.queuedAt,
        priority: op.priority,
        sequence: op.sequence,
        ...(op.payload !== undefined ? { payload: op.payload } : {}),
      }));
      this.storage.setItem(this.storageKey, serializeQueueEntries(serializable));
    } catch {
      // Storage may be unavailable or full; keep operating in-memory.
    }
  }

  private rehydrate(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return;
      const entries = deserializeQueueEntries(raw);
      let maxSeq = -1;
      for (const entry of entries) {
        if (this.queue.length >= this.options.maxQueueSize) break;
        const op: QueuedOperation = {
          id: entry.id,
          operation: entry.operation,
          execute: this.resolveExecutor(entry),
          queuedAt: entry.queuedAt,
          priority: entry.priority,
          sequence: entry.sequence,
          ...(entry.payload !== undefined ? { payload: entry.payload } : {}),
        };
        this.insertSorted(op);
        if (entry.sequence > maxSeq) maxSeq = entry.sequence;
      }
      this.nextSequence = maxSeq + 1;
    } catch {
      // Corrupt persisted payload — ignore and start with an empty queue.
    }
  }

  /**
   * Set the health check function used to detect reconnection.
   */
  setHealthCheck(fn: () => Promise<boolean>): void {
    this.healthCheckFn = fn;
  }

  /**
   * Start the health check polling that triggers queue drainage on reconnection.
   */
  startHealthCheck(): void {
    if (!this.options.enabled || this.healthCheckTimer) return;

    this.healthCheckTimer = setInterval(async () => {
      if (this.isOnline || this.queue.length === 0) return;

      try {
        const healthy = this.healthCheckFn ? await this.healthCheckFn() : true;
        if (healthy) {
          this.isOnline = true;
          await this.drain();
        }
      } catch {
        // Still offline — keep polling
      }
    }, this.options.healthCheckIntervalMs);
    const unref = (this.healthCheckTimer as { unref?: () => void }).unref;
    unref?.call(this.healthCheckTimer);
  }

  /**
   * Stop the health check polling.
   */
  stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Mark the connection as offline. Subsequent failed writes will be queued.
   */
  markOffline(): void {
    this.isOnline = false;
  }

  /**
   * Mark the connection as online and attempt to drain the queue.
   */
  async markOnline(): Promise<void> {
    this.isOnline = true;
    if (this.queue.length > 0) {
      await this.drain();
    }
  }

  /**
   * Enqueue a failed write operation.
   * Higher `priority` operations are replayed first; equal priorities keep
   * strict insertion (FIFO) order via a monotonic sequence tie-breaker.
   * Returns true if the operation was queued, false if the queue is full.
   */
  enqueue(
    operation: string,
    execute: () => Promise<unknown>,
    priority = 0,
    payload?: unknown,
  ): boolean {
    if (!this.options.enabled) return false;
    if (this.queue.length >= this.options.maxQueueSize) {
      console.warn(
        `[SoroStream SDK] Offline queue is full (${this.options.maxQueueSize}). ` +
          `Operation "${operation}" was dropped.`,
      );
      return false;
    }

    const queuedOp: QueuedOperation = {
      id: `queue-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      operation,
      execute,
      queuedAt: Date.now(),
      priority,
      sequence: this.nextSequence++,
      ...(payload !== undefined ? { payload } : {}),
    };

    this.insertSorted(queuedOp);
    this.persist();
    return true;
  }

  /**
   * Insert an operation keeping the queue ordered by descending priority and,
   * within equal priorities, ascending insertion sequence (strict FIFO).
   */
  private insertSorted(queuedOp: QueuedOperation): void {
    const index = this.queue.findIndex(
      (op) =>
        op.priority < queuedOp.priority ||
        (op.priority === queuedOp.priority && op.sequence > queuedOp.sequence),
    );
    if (index === -1) this.queue.push(queuedOp);
    else this.queue.splice(index, 0, queuedOp);
  }

  /**
   * Drain the queue in priority order, replaying each operation.
   * Emits a `queueDrained` event with the results.
   */
  async drain(): Promise<QueueDrainedEvent> {
    if (this.isDraining || this.queue.length === 0) {
      return { results: [], totalOperations: 0, successful: 0, failed: 0 };
    }

    this.isDraining = true;
    const results: QueueReplayResult[] = [];

    while (this.queue.length > 0) {
      const op = this.queue.shift()!;
      try {
        const result = await op.execute();
        results.push({ operation: op, success: true, result });
      } catch (err) {
        results.push({
          operation: op,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
        // Still offline: put the failed operation back at the front of the
        // queue — its original position relative to everything still queued
        // behind it — and stop draining immediately, so retries can never
        // reorder ahead of (or behind) later-enqueued equal-priority work
        // (issue #991). A persistently failing operation is retried on the
        // next drain() rather than blocking this one indefinitely.
        if (!this.isOnline) {
          this.queue.unshift(op);
          break;
        }
      }
    }

    this.isDraining = false;
    this.persist();

    const event: QueueDrainedEvent = {
      results,
      totalOperations: results.length,
      successful: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
    };

    this.eventBus.emit('queueDrained', event);
    return event;
  }

  /**
   * Get the current queue size.
   */
  get size(): number {
    return this.queue.length;
  }

  /**
   * Check if the queue is empty.
   */
  get isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /**
   * Clear all queued operations without replaying them.
   */
  clear(): void {
    this.queue = [];
    this.persist();
  }
}
