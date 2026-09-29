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

/**
 * Per-request priority level (issue #566).
 *
 * - `"high"` — user-initiated, latency-sensitive actions (health checks,
 *   user-initiated withdrawals). Jumps ahead of `"normal"` and `"low"`.
 * - `"normal"` — the default for ordinary SDK operations.
 * - `"low"` — background polling and best-effort work that can wait.
 */
export type RequestPriority = 'high' | 'normal' | 'low';

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
  /**
   * Per-request priority (issue #566). Higher-priority items are drained
   * before lower-priority ones regardless of the lane they were enqueued to.
   */
  priority: RequestPriority;
}

/** Numeric rank used to compare {@link RequestPriority} values. */
const PRIORITY_RANK: Record<RequestPriority, number> = {
  high: 0,
  normal: 1,
  low: 2,
};

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
   * @param options - Optional settings. `priority` selects the per-request
   *   priority level (issue #566): `"high"` items are drained before
   *   `"normal"` and `"low"` items even when they were enqueued later.
   */
  enqueue<T>(lane: string, task: Task<T>, options?: { priority?: RequestPriority }): Promise<T> {
    const priority = options?.priority ?? 'normal';

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
        priority,
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

  /**
   * Returns a promise that resolves once every enqueued task has completed
   * (queue empty and no in-flight work remaining). Useful in tests and
   * shutdown paths to wait for the queue to fully drain.
   */
  waitForDrain(): Promise<void> {
    if (this.totalQueued === 0 && this.totalInFlight === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const tick = () => {
        if (this.totalQueued === 0 && this.totalInFlight === 0) resolve();
        else setTimeout(tick, 5);
      };
      setTimeout(tick, 5);
    });
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
   * Picks the next item to run when a concurrency slot opens up.
   *
   * Items are selected by per-request priority first (high before normal
   * before low, issue #566), then by enqueue order (FIFO), then by lane
   * order. This lets a `"high"`-priority health check jump ahead of a
   * `"low"`-priority background poll even when they were enqueued into the
   * same lane — the queue is not lane-strict FIFO, it is priority-ordered.
   */
  private dequeueNext(): QueuedItem | null {
    let best: QueuedItem | null = null;
    let bestRank = Infinity;
    let bestEnqueuedAt = Infinity;
    let bestLaneIndex = Infinity;

    for (let li = 0; li < this.priorityLanes.length; li++) {
      const lane = this.priorityLanes[li]!;
      const queue = this.queues.get(lane);
      if (!queue || queue.length === 0) continue;

      // Scan every item in the lane — a later-enqueued high-priority item
      // must be able to jump ahead of an earlier low-priority one.
      for (let qi = 0; qi < queue.length; qi++) {
        const item = queue[qi]!;
        const rank = PRIORITY_RANK[item.priority];
        if (
          rank < bestRank ||
          (rank === bestRank &&
            (item.enqueuedAt < bestEnqueuedAt ||
              (item.enqueuedAt === bestEnqueuedAt && li < bestLaneIndex)))
        ) {
          best = item;
          bestRank = rank;
          bestEnqueuedAt = item.enqueuedAt;
          bestLaneIndex = li;
        }
      }
    }

    if (!best) return null;

    // Remove the chosen item from its lane's queue.
    const lane = best.lane;
    const queue = this.queues.get(lane)!;
    const idx = queue.indexOf(best);
    if (idx >= 0) queue.splice(idx, 1);
    return best;
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
