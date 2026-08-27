/**
 * Stream Monitoring Daemon (issue #266)
 *
 * Centralizes polling of many streams into a single background process with
 * configurable alert thresholds and event callbacks. Consumers no longer need
 * to build their own polling loops — they subscribe to the monitor's events
 * and react to threshold breaches.
 *
 * Usage:
 * ```ts
 * const monitor = client.createStreamMonitor(["stream-1", "stream-2"], {
 *   pollIntervalMs: 15_000,
 *   expiryWarningMs: 60 * 60 * 1000, // warn 1 hour before expiry
 *   lowBalanceThreshold: 1_000_000n,  // stroops
 * });
 *
 * monitor.on("streamExpiringSoon", ({ streamId, secondsLeft }) => {
 *   console.log(`Stream ${streamId} expires in ${secondsLeft}s`);
 * });
 *
 * monitor.on("streamLowBalance", ({ streamId, claimable }) => {
 *   console.log(`Stream ${streamId} low balance: ${claimable} stroops`);
 * });
 *
 * // Later…
 * monitor.stop();
 * ```
 */

import type { Stream } from './types.js';

// ── Event payloads ─────────────────────────────────────────────────────────────

/** Emitted when a stream is within the expiry-warning window. */
export interface StreamExpiringSoonPayload {
  streamId: string;
  /** Seconds remaining until the stream ends. */
  secondsLeft: number;
  /** Unix timestamp (seconds) when the stream ends. */
  endTime: number;
}

/** Emitted when a stream's endTime has passed and it is now expired. */
export interface StreamExpiredPayload {
  streamId: string;
  /** Unix timestamp (seconds) when the stream ended. */
  endTime: number;
}

/** Emitted when the claimable balance falls below the configured threshold. */
export interface StreamLowBalancePayload {
  streamId: string;
  /** Current claimable amount in stroops. */
  claimable: bigint;
  /** Configured threshold in stroops. */
  threshold: bigint;
}

/** Emitted when a stream's status changes between poll cycles. */
export interface StreamStatusChangedPayload {
  streamId: string;
  /** Previous status (or `undefined` on the first observation). */
  previousStatus: Stream['status'] | undefined;
  /** New status. */
  currentStatus: Stream['status'];
}

/** Emitted when the monitor encounters an RPC error for a stream. */
export interface StreamMonitorErrorPayload {
  streamId: string;
  error: unknown;
}

// ── Event map ─────────────────────────────────────────────────────────────────

/** All events the monitor can emit, keyed by event name. */
export interface StreamMonitorEventMap {
  streamExpiringSoon: StreamExpiringSoonPayload;
  streamExpired: StreamExpiredPayload;
  streamLowBalance: StreamLowBalancePayload;
  streamStatusChanged: StreamStatusChangedPayload;
  monitorError: StreamMonitorErrorPayload;
}

type StreamMonitorEventName = keyof StreamMonitorEventMap;
type Listener<K extends StreamMonitorEventName> = (payload: StreamMonitorEventMap[K]) => void;

// ── Config ────────────────────────────────────────────────────────────────────

/** Configuration for {@link StreamMonitor}. */
export interface StreamMonitorConfig {
  /**
   * How often to poll each stream in ms. Defaults to 15_000 (15 seconds).
   */
  pollIntervalMs?: number;
  /**
   * Emit `streamExpiringSoon` when the time remaining falls below this value
   * (ms). Defaults to 60 * 60 * 1_000 (1 hour).
   */
  expiryWarningMs?: number;
  /**
   * Emit `streamLowBalance` when the claimable amount is less than this
   * threshold (stroops). When `undefined` (default), the low-balance event
   * is disabled.
   */
  lowBalanceThreshold?: bigint;
  /**
   * Called when the monitor encounters an unrecoverable RPC error for a
   * single stream. The monitor will continue running for other streams.
   * This is an alternative to subscribing to `"monitorError"` events.
   */
  onError?: (payload: StreamMonitorErrorPayload) => void;
}

// ── Fetch callbacks ───────────────────────────────────────────────────────────

/**
 * Callbacks the monitor uses to fetch stream state. Passed by the client so
 * the monitor has no direct dependency on SoroStreamClient.
 */
export interface StreamMonitorFetchers {
  /**
   * Fetches the current stream object (status, endTime, etc.).
   * May throw on RPC failure.
   */
  getStream(streamId: string): Promise<Stream>;
  /**
   * Fetches the current claimable balance in stroops.
   * May throw on RPC failure. Only called when `lowBalanceThreshold` is set.
   */
  getClaimable(streamId: string): Promise<bigint>;
}

// ── Monitor class ─────────────────────────────────────────────────────────────

/**
 * A background daemon that polls a set of streams at a configurable interval
 * and fires threshold-based events.
 *
 * Obtain an instance via `client.createStreamMonitor(streamIds, config)`.
 */
export class StreamMonitor {
  private readonly streamIds: string[];
  private readonly pollIntervalMs: number;
  private readonly expiryWarningMs: number;
  private readonly lowBalanceThreshold: bigint | undefined;
  private readonly fetchers: StreamMonitorFetchers;

  /** Last known status per stream, for change detection. */
  private readonly lastStatus = new Map<string, Stream['status']>();
  /** Tracks which streams have already fired `streamExpiringSoon` so we don't spam. */
  private readonly expiringSoonFired = new Set<string>();
  /** Tracks which streams have already fired `streamExpired`. */
  private readonly expiredFired = new Set<string>();

  private intervalId: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  /** AbortController used to cancel in-flight RPC requests when stop() is called. */
  private abortController: AbortController | null = null;

  // Type-safe listener registry
  private readonly listeners = new Map<string, Set<Listener<StreamMonitorEventName>>>();

  constructor(
    streamIds: string[],
    fetchers: StreamMonitorFetchers,
    config: StreamMonitorConfig = {},
  ) {
    this.streamIds = [...streamIds];
    this.fetchers = fetchers;
    this.pollIntervalMs = config.pollIntervalMs ?? 15_000;
    this.expiryWarningMs = config.expiryWarningMs ?? 60 * 60 * 1_000;
    this.lowBalanceThreshold = config.lowBalanceThreshold;

    if (config.onError) {
      this.on('monitorError', config.onError);
    }

    // Start immediately
    this.scheduleNextPoll();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Subscribes to a monitor event. Returns an unsubscribe function.
   *
   * @example
   * ```ts
   * const unsub = monitor.on("streamExpiringSoon", ({ streamId }) => { ... });
   * // later:
   * unsub();
   * ```
   */
  on<K extends StreamMonitorEventName>(event: K, listener: Listener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    (set as Set<Listener<K>>).add(listener);
    return () => {
      (set as Set<Listener<K>>).delete(listener);
    };
  }

  /**
   * Adds one or more stream IDs to the monitored set.
   * Takes effect on the next poll cycle.
   */
  addStreams(streamIds: string[]): void {
    for (const id of streamIds) {
      if (!this.streamIds.includes(id)) {
        this.streamIds.push(id);
      }
    }
  }

  /**
   * Removes one or more stream IDs from the monitored set.
   * Clears any accumulated state for those streams.
   */
  removeStreams(streamIds: string[]): void {
    for (const id of streamIds) {
      const idx = this.streamIds.indexOf(id);
      if (idx !== -1) this.streamIds.splice(idx, 1);
      this.lastStatus.delete(id);
      this.expiringSoonFired.delete(id);
      this.expiredFired.delete(id);
    }
  }

  /**
   * Stops the monitoring daemon and clears all polling timers.
   * In-flight RPC requests are aborted via an internal AbortController.
   * After calling `stop()` the instance is permanently inactive.
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    // Cancel any in-flight RPC requests to prevent resource leaks
    // when stop() is called while a pending fetcher is still running (issue #365).
    this.abortController?.abort();
    this.abortController = null;
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private scheduleNextPoll(): void {
    if (this.stopped) return;
    // Run immediately once, then on the configured interval.
    void this.poll();
    this.intervalId = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
    (this.intervalId as { unref?: () => void }).unref?.();
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;

    // Create a fresh AbortController for this poll cycle so stop() can cancel
    // any in-flight RPC requests immediately instead of waiting for them to
    // complete or timeout — preventing resource leaks (issue #365).
    const ac = new AbortController();
    this.abortController = ac;

    // Poll all streams concurrently — failure of one must not cancel others.
    await Promise.allSettled(this.streamIds.map((streamId) => this.pollStream(streamId, ac.signal)));
  }

  private async pollStream(streamId: string, signal?: AbortSignal): Promise<void> {
    if (this.stopped) return;
    // If the poll cycle was aborted (e.g. stop() was called), skip the RPC call
    // immediately instead of issuing a request that would leak (issue #365).
    if (signal?.aborted) return;

    let stream: Stream;
    try {
      stream = await this.fetchers.getStream(streamId);
    } catch (error) {
      this.emit('monitorError', { streamId, error });
      return;
    }

    // If the poll cycle was aborted while the first RPC was in-flight, bail
    // before issuing the second one (issue #365).
    if (signal?.aborted) return;

    const nowSeconds = Math.floor(Date.now() / 1_000);

    // ── Status change detection ───────────────────────────────────────────────
    const previousStatus = this.lastStatus.get(streamId);
    const currentStatus = stream.status;
    if (previousStatus !== currentStatus) {
      this.lastStatus.set(streamId, currentStatus);
      this.emit('streamStatusChanged', { streamId, previousStatus, currentStatus });
    }

    // ── Expiry events ─────────────────────────────────────────────────────────
    const secondsLeft = stream.endTime - nowSeconds;

    if (secondsLeft <= 0 && !this.expiredFired.has(streamId)) {
      this.expiredFired.add(streamId);
      this.emit('streamExpired', { streamId, endTime: stream.endTime });
    } else if (
      secondsLeft > 0 &&
      secondsLeft * 1_000 <= this.expiryWarningMs &&
      !this.expiringSoonFired.has(streamId)
    ) {
      this.expiringSoonFired.add(streamId);
      this.emit('streamExpiringSoon', { streamId, secondsLeft, endTime: stream.endTime });
    }

    // ── Low balance ───────────────────────────────────────────────────────────
    if (this.lowBalanceThreshold !== undefined) {
      let claimable: bigint;
      try {
        claimable = await this.fetchers.getClaimable(streamId);
      } catch (error) {
        this.emit('monitorError', { streamId, error });
        return;
      }
      if (claimable < this.lowBalanceThreshold) {
        this.emit('streamLowBalance', {
          streamId,
          claimable,
          threshold: this.lowBalanceThreshold,
        });
      }
    }
  }

  private emit<K extends StreamMonitorEventName>(
    event: K,
    payload: StreamMonitorEventMap[K],
  ): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of set) {
      try {
        (listener as Listener<K>)(payload);
      } catch {
        // Never let a listener crash the daemon.
      }
    }
  }
}
