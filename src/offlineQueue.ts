// Issue #260: Offline write queue that buffers mutations when RPC is unreachable.
//
// When enabled via `offlineQueue: true` in the client config, failed write
// operations due to network errors are stored in an in-memory queue.
// On reconnection (detected via RPC health check polling), the queue drains
// in FIFO order and emits a `queueDrained` event with per-operation results.

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
}

export const DEFAULT_QUEUE_OPTIONS: OfflineQueueOptions = {
  enabled: false,
  maxQueueSize: 100,
  healthCheckIntervalMs: 10_000,
};

/**
 * In-memory offline write queue for the SoroStream SDK.
 * Buffers failed write operations and replays them when RPC connectivity is restored.
 */
export class OfflineWriteQueue {
  private queue: QueuedOperation[] = [];
  private isDraining = false;
  private isOnline = true;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private healthCheckFn: (() => Promise<boolean>) | null = null;

  constructor(
    private options: OfflineQueueOptions,
    private eventBus: IEventBus,
  ) {}

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
   * Returns true if the operation was queued, false if the queue is full.
   */
  enqueue(operation: string, execute: () => Promise<unknown>): boolean {
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
    };

    this.queue.push(queuedOp);
    return true;
  }

  /**
   * Drain the queue in FIFO order, replaying each operation.
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
        // Re-queue the failed operation if still offline
        if (!this.isOnline && this.queue.length < this.options.maxQueueSize) {
          this.queue.unshift(op);
          break;
        }
      }
    }

    this.isDraining = false;

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
  }
}
