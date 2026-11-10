// Issue #260 / #681: Offline write queue that buffers mutations when RPC is unreachable,
// with optional persistence adapter support across page reloads.
//
// When enabled via `offlineQueue: true` in the client config, failed write
// operations due to network errors are stored in an in-memory queue (and
// optionally snapshotted via a persistence adapter).
// On reconnection (detected via RPC health check polling), the queue drains
// in priority order (higher first, FIFO within a priority) and emits a `queueDrained` event with per-operation results.

import type { IEventBus } from './eventBus.js';

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
  /** Optional serializable metadata/arguments associated with the operation. */
  payload?: unknown;
}

/**
 * Serializable representation of a queued operation stored by a persistence
 * adapter (#681).
 */
export interface SerializedQueuedOperation {
  id: string;
  operation: string;
  queuedAt: number;
  priority: number;
  sequence: number;
  payload?: unknown;
  /**
   * Present only when an in-memory or custom object adapter preserves the
   * original closure directly.
   */
  execute?: () => Promise<unknown>;
}

/**
 * Persistence adapter contract for snapshotting and rehydrating queued
 * operations across page reloads (#681).
 *
 * Supports both explicit `{ load, save, clear? }` adapters and Web
 * `Storage`-compatible (`localStorage` / `sessionStorage`) adapters.
 */
export type OfflineQueuePersistenceAdapter =
  | {
      load():
        | SerializedQueuedOperation[]
        | null
        | undefined
        | Promise<SerializedQueuedOperation[] | null | undefined>;
      save(operations: SerializedQueuedOperation[]): void | Promise<void>;
      clear?(): void | Promise<void>;
    }
  | {
      getItem(key: string): string | null;
      setItem(key: string, value: string): void;
      removeItem?(key: string): void;
    };

/** Default storage key used when a Web `Storage`-compatible adapter is supplied. */
export const DEFAULT_OFFLINE_QUEUE_STORAGE_KEY = 'sorostream:offline_queue:v1';

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
  /**
   * Optional persistence adapter used to snapshot the queue on mutation and
   * rehydrate queued operations on construction (#681).
   * When omitted, the queue operates purely in memory.
   */
  persistenceAdapter?: OfflineQueuePersistenceAdapter;
  /** Alias for `persistenceAdapter`. */
  storage?: OfflineQueuePersistenceAdapter;
  /** Storage key when using a `Storage`-compatible (`getItem`/`setItem`) adapter. */
  storageKey?: string;
  /**
   * Optional executor invoked when replaying a rehydrated operation that was
   * deserialized from JSON without an in-memory `execute` closure.
   */
  operationExecutor?: (op: SerializedQueuedOperation) => Promise<unknown>;
}

export const DEFAULT_QUEUE_OPTIONS: OfflineQueueOptions = {
  enabled: false,
  maxQueueSize: 100,
  healthCheckIntervalMs: 10_000,
};

function isWebStorageAdapter(adapter: OfflineQueuePersistenceAdapter): adapter is {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
} {
  return (
    typeof (adapter as { getItem?: unknown }).getItem === 'function' &&
    typeof (adapter as { setItem?: unknown }).setItem === 'function'
  );
}

/**
 * Offline write queue for the SoroStream SDK.
 * Buffers failed write operations, optionally persists snapshots across page
 * reloads (#681), and replays them when RPC connectivity is restored.
 */
export class OfflineWriteQueue {
  private queue: QueuedOperation[] = [];
  private isDraining = false;
  private isOnline = true;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private healthCheckFn: (() => Promise<boolean>) | null = null;
  /** Monotonic counter incremented on every enqueue; see {@link QueuedOperation.sequence}. */
  private nextSequence = 0;
  private readonly adapter: OfflineQueuePersistenceAdapter | null;
  private readonly storageKey: string;
  private operationExecutor: ((op: SerializedQueuedOperation) => Promise<unknown>) | null;
  private readonly operationHandlers = new Map<
    string,
    (payload: unknown, op: SerializedQueuedOperation) => Promise<unknown>
  >();
  private rehydrationPromise: Promise<void> | null = null;

  constructor(
    private options: OfflineQueueOptions,
    private eventBus: IEventBus,
  ) {
    this.adapter = options.persistenceAdapter ?? options.storage ?? null;
    this.storageKey = options.storageKey ?? DEFAULT_OFFLINE_QUEUE_STORAGE_KEY;
    this.operationExecutor = options.operationExecutor ?? null;

    if (this.adapter && this.options.enabled) {
      this.rehydrateFromAdapter();
    }
  }

  /**
   * Register a fallback executor for operations rehydrated from persistent storage.
   */
  setOperationExecutor(fn: (op: SerializedQueuedOperation) => Promise<unknown>): void {
    this.operationExecutor = fn;
  }

  /**
   * Register a named handler for a specific operation type when rehydrating from storage.
   */
  registerOperationHandler(
    operation: string,
    handler: (payload: unknown, op: SerializedQueuedOperation) => Promise<unknown>,
  ): void {
    this.operationHandlers.set(operation, handler);
  }

  /**
   * Wait for any asynchronous persistence rehydration triggered during construction.
   */
  async ready(): Promise<void> {
    if (this.rehydrationPromise) {
      await this.rehydrationPromise;
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
    await this.ready();
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
    this.persistSnapshot();
    return true;
  }

  /**
   * Return a serializable snapshot of the current priority-ordered queue.
   */
  getSnapshot(): SerializedQueuedOperation[] {
    return this.queue.map((op) => ({
      id: op.id,
      operation: op.operation,
      queuedAt: op.queuedAt,
      priority: op.priority,
      sequence: op.sequence,
      ...(op.payload !== undefined ? { payload: op.payload } : {}),
      execute: op.execute,
    }));
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

  private toQueuedOperation(
    entry: SerializedQueuedOperation,
    fallbackSeq: number,
  ): QueuedOperation {
    const seq =
      typeof entry.sequence === 'number' && Number.isFinite(entry.sequence)
        ? entry.sequence
        : fallbackSeq;
    const priority =
      typeof entry.priority === 'number' && Number.isFinite(entry.priority) ? entry.priority : 0;
    const queuedAt =
      typeof entry.queuedAt === 'number' && Number.isFinite(entry.queuedAt)
        ? entry.queuedAt
        : Date.now();
    const id =
      typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : `queue-${queuedAt}-${seq}`;
    const operation = String(entry.operation ?? 'unknown');

    const serializedCopy: SerializedQueuedOperation = {
      id,
      operation,
      queuedAt,
      priority,
      sequence: seq,
      ...(entry.payload !== undefined ? { payload: entry.payload } : {}),
    };

    const execute: () => Promise<unknown> =
      typeof entry.execute === 'function'
        ? entry.execute
        : async () => {
            const handler = this.operationHandlers.get(operation);
            if (handler) {
              return handler(entry.payload, serializedCopy);
            }
            if (this.operationExecutor) {
              return this.operationExecutor(serializedCopy);
            }
            return {
              rehydrated: true,
              id,
              operation,
              ...(entry.payload !== undefined ? { payload: entry.payload } : {}),
            };
          };

    return {
      id,
      operation,
      execute,
      queuedAt,
      priority,
      sequence: seq,
      ...(entry.payload !== undefined ? { payload: entry.payload } : {}),
    };
  }

  private applyRehydratedEntries(entries: SerializedQueuedOperation[] | null | undefined): void {
    if (!Array.isArray(entries) || entries.length === 0) return;

    const existingIds = new Set(this.queue.map((op) => op.id));
    for (let i = 0; i < entries.length; i++) {
      if (this.queue.length >= this.options.maxQueueSize) break;
      const raw = entries[i];
      if (!raw || typeof raw !== 'object') continue;
      const hydrated = this.toQueuedOperation(raw, i);
      if (existingIds.has(hydrated.id)) continue;
      existingIds.add(hydrated.id);
      if (hydrated.sequence >= this.nextSequence) {
        this.nextSequence = hydrated.sequence + 1;
      }
      this.insertSorted(hydrated);
    }
  }

  private rehydrateFromAdapter(): void {
    if (!this.adapter) return;
    try {
      if (isWebStorageAdapter(this.adapter)) {
        const raw = this.adapter.getItem(this.storageKey);
        if (!raw) return;
        const parsed = JSON.parse(raw) as SerializedQueuedOperation[];
        this.applyRehydratedEntries(parsed);
        return;
      }

      const loaded = this.adapter.load();
      if (loaded && typeof (loaded as Promise<unknown>).then === 'function') {
        this.rehydrationPromise = (
          loaded as Promise<SerializedQueuedOperation[] | null | undefined>
        )
          .then((entries) => {
            this.applyRehydratedEntries(entries);
          })
          .catch(() => {
            // Ignore adapter read errors so construction never crashes
          })
          .finally(() => {
            this.rehydrationPromise = null;
          });
      } else {
        this.applyRehydratedEntries(loaded as SerializedQueuedOperation[] | null | undefined);
      }
    } catch {
      // Ignore corrupt or unavailable storage on initialization
    }
  }

  private persistSnapshot(): void {
    if (!this.adapter) return;
    try {
      const snapshot = this.getSnapshot();
      if (isWebStorageAdapter(this.adapter)) {
        const jsonSafe = snapshot.map(({ execute: _exec, ...rest }) => rest);
        this.adapter.setItem(this.storageKey, JSON.stringify(jsonSafe));
        return;
      }
      void Promise.resolve(this.adapter.save(snapshot)).catch(() => {});
    } catch {
      // Storage quota or serialization errors should not break in-memory queueing
    }
  }

  /**
   * Drain the queue in priority order, replaying each operation.
   * Emits a `queueDrained` event with the results.
   */
  async drain(): Promise<QueueDrainedEvent> {
    await this.ready();
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
        // Re-queue the failed operation if still offline. Re-insert with the
        // same priority/sequence ordering instead of `unshift` so a retried
        // operation can never jump ahead of higher-priority entries or of
        // equal-priority operations enqueued while it was executing.
        if (!this.isOnline && this.queue.length < this.options.maxQueueSize) {
          this.insertSorted(op);
          break;
        }
      }
    }

    this.isDraining = false;
    this.persistSnapshot();

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
    if (!this.adapter) return;
    try {
      if (isWebStorageAdapter(this.adapter)) {
        if (typeof this.adapter.removeItem === 'function') {
          this.adapter.removeItem(this.storageKey);
        } else {
          this.adapter.setItem(this.storageKey, '[]');
        }
        return;
      }
      if (typeof this.adapter.clear === 'function') {
        void Promise.resolve(this.adapter.clear()).catch(() => {});
      } else {
        void Promise.resolve(this.adapter.save([])).catch(() => {});
      }
    } catch {
      // Ignore adapter errors on clear
    }
  }
}

export { OfflineWriteQueue as OfflineQueue };
