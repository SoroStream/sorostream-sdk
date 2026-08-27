/**
 * Rate-Limit-Aware Request Queue with Priority Lanes (issue #265)
 *
 * Provides concurrency control and backpressure for Soroban RPC calls.
 * When many SDK operations are in flight simultaneously the SDK can hit
 * 429 rate-limit errors. This queue caps concurrent in-flight requests,
 * routes work through configurable priority lanes (writes before reads),
 * and emits `rateLimitDelayed` events so callers can observe queue pressure.
 *
 * Usage:
 * ```ts
 * const client = new SoroStreamClient({
 *   network: "testnet",
 *   contractId,
 *   walletAdapter,
 *   requestQueue: {
 *     maxConcurrent: 5,
 *     priorityLanes: ["write", "read"],
 *   },
 * });
 *
 * // Emitted whenever a request waits in queue
 * client.on("rateLimitDelayed", ({ lane, estimatedWaitMs }) => {
 *   console.log(`${lane} request queued, ~${estimatedWaitMs}ms wait`);
 * });
 *
 * const stats = client.getQueueStats();
 * // { write: { queued: 2, inFlight: 1 }, read: { queued: 8, inFlight: 4 } }
 * ```
 */

// ── Types ──────────────────────────────────────────────────────────────────────

/** Configuration for the request queue feature. */
export interface RequestQueueConfig {
  /**
   * Maximum number of requests that can be in-flight simultaneously across
   * all priority lanes. Defaults to 10.
   */
  maxConcurrent?: number;
  /**
   * Ordered list of priority-lane names. Lanes listed earlier are drained
   * before later ones. The SDK uses `"write"` and `"read"` as the two
   * built-in lane names; you can add custom ones.
   *
   * Default: `["write", "read"]`
   */
  priorityLanes?: string[];
}

/** Per-lane queue depth reported by {@link PriorityRequestQueue.getStats}. */
export interface LaneStats {
  /** Number of requests waiting in queue for this lane. */
  queued: number;
  /** Number of requests currently in flight from this lane. */
  inFlight: number;
}

/** Return value of {@link PriorityRequestQueue.getStats}. */
export type QueueStats = Record<string, LaneStats>;

/** Payload emitted when a request is held in queue. */
export interface RateLimitDelayedPayload {
  /** The lane this request belongs to. */
  lane: string;
  /**
   * Rough estimate of how long the request will wait before starting (ms).
   * Calculated as: `(queueDepth / maxConcurrent) * averageTaskDurationMs`.
   * When no duration history is available, defaults to 0.
   */
  estimatedWaitMs: number;
  /** Current number of requests queued ahead of this one in the same lane. */
  queueDepth: number;
}

// ── Internal ───────────────────────────────────────────────────────────────────

type Task<T> = () => Promise<T>;

interface QueuedItem {
  lane: string;
  task: Task<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  /** Monotonic timestamp when this item was enqueued, for wait estimation. */
  enqueuedAt: number;
}

// ── PriorityRequestQueue ───────────────────────────────────────────────────────

/**
 * A concurrency-limited, priority-ordered request queue.
 *
 * Tasks submitted via {@link enqueue} are held until a concurrency slot opens
 * up. When multiple lanes have pending tasks, higher-priority lanes (those
 * listed first in `priorityLanes`) are drained first.
 */
export class PriorityRequestQueue {
  private readonly maxConcurrent: number;
  private readonly priorityLanes: string[];

  /** queued items per lane, in FIFO order within each lane. */
  private readonly queues = new Map<string, QueuedItem[]>();
  /** Per-lane count of currently executing tasks. */
  private readonly inFlightPerLane = new Map<string, number>();
  /** Total in-flight across all lanes. */
  private totalInFlight = 0;

  /** Recent task durations (ms) for wait-time estimation, capped at 20. */
  private readonly recentDurations: number[] = [];
  private readonly MAX_DURATION_SAMPLES = 20;

  /** Callback fired when a request is held in queue. */
  onDelayed?: (payload: RateLimitDelayedPayload) => void;

  constructor(config: RequestQueueConfig = {}) {
    this.maxConcurrent = Math.max(1, config.maxConcurrent ?? 10);
    this.priorityLanes = config.priorityLanes?.length ? config.priorityLanes : ['write', 'read'];

    for (const lane of this.priorityLanes) {
      this.queues.set(lane, []);
      this.inFlightPerLane.set(lane, 0);
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Enqueues a task in the given priority lane and returns a promise that
   * resolves (or rejects) with the task's result.
   *
   * If a concurrency slot is available immediately, the task starts right
   * away. Otherwise it waits in the lane's queue and fires the `onDelayed`
   * callback.
   *
   * @param lane - A lane name from `priorityLanes` (e.g. `"write"` or `"read"`).
   *               If the lane is not registered, it is added as the lowest priority.
   * @param task - An async function to execute once a slot is free.
   */
  enqueue<T>(lane: string, task: Task<T>): Promise<T> {
    // Lazily register unknown lanes at lowest priority.
    if (!this.queues.has(lane)) {
      this.queues.set(lane, []);
      this.inFlightPerLane.set(lane, 0);
      this.priorityLanes.push(lane);
    }

    if (this.totalInFlight < this.maxConcurrent) {
      return this.run(lane, task);
    }

    // Queue the task and emit a delay event.
    return new Promise<T>((resolve, reject) => {
      const laneQueue = this.queues.get(lane)!;
      const queueDepth = laneQueue.length;

      const item: QueuedItem = {
        lane,
        task: task as Task<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
        enqueuedAt: Date.now(),
      };
      laneQueue.push(item);

      // Fire the delayed callback.
      const estimatedWaitMs = this.estimateWait(queueDepth);
      this.onDelayed?.({ lane, estimatedWaitMs, queueDepth });
    });
  }

  /**
   * Returns a snapshot of the current queue depth and in-flight count for
   * every registered lane.
   */
  getStats(): QueueStats {
    const stats: QueueStats = {};
    for (const lane of this.priorityLanes) {
      stats[lane] = {
        queued: this.queues.get(lane)?.length ?? 0,
        inFlight: this.inFlightPerLane.get(lane) ?? 0,
      };
    }
    return stats;
  }

  /** Total number of tasks currently waiting across all lanes. */
  get totalQueued(): number {
    let n = 0;
    for (const q of this.queues.values()) n += q.length;
    return n;
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private run<T>(lane: string, task: Task<T>): Promise<T> {
    this.totalInFlight++;
    this.inFlightPerLane.set(lane, (this.inFlightPerLane.get(lane) ?? 0) + 1);

    const start = Date.now();
    return (task() as Promise<T>).then(
      (result) => {
        this.recordDuration(Date.now() - start);
        this.release(lane);
        return result;
      },
      (error: unknown) => {
        this.recordDuration(Date.now() - start);
        this.release(lane);
        throw error;
      },
    );
  }

  private release(lane: string): void {
    this.totalInFlight--;
    this.inFlightPerLane.set(lane, Math.max(0, (this.inFlightPerLane.get(lane) ?? 1) - 1));
    this.drain();
  }

  private drain(): void {
    // Walk lanes in priority order and start the first waiting task that fits.
    while (this.totalInFlight < this.maxConcurrent) {
      const item = this.dequeueNext();
      if (!item) break;

      // Re-run: the task was already enqueued — start it now.
      this.run(item.lane, item.task).then(item.resolve).catch(item.reject);
    }
  }

  /**
   * Picks the next item from the highest-priority non-empty queue.
   */
  private dequeueNext(): QueuedItem | null {
    for (const lane of this.priorityLanes) {
      const queue = this.queues.get(lane);
      if (queue && queue.length > 0) {
        return queue.shift()!;
      }
    }
    return null;
  }

  private recordDuration(ms: number): void {
    this.recentDurations.push(ms);
    if (this.recentDurations.length > this.MAX_DURATION_SAMPLES) {
      this.recentDurations.shift();
    }
  }

  private estimateWait(queueDepth: number): number {
    if (this.recentDurations.length === 0) return 0;
    const avg = this.recentDurations.reduce((a, b) => a + b, 0) / this.recentDurations.length;
    // Estimate: how many "rounds" of maxConcurrent tasks before this one runs.
    const rounds = Math.ceil((queueDepth + 1) / this.maxConcurrent);
    return Math.round(avg * rounds);
  }
}

// ── Factory ────────────────────────────────────────────────────────────────────

/**
 * Creates a {@link PriorityRequestQueue} from the SDK config object.
 * Returns `null` when the queue feature is disabled (default).
 */
export function createRequestQueue(
  config: RequestQueueConfig | undefined,
): PriorityRequestQueue | null {
  if (!config) return null;
  return new PriorityRequestQueue(config);
}
