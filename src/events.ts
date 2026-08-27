import { rpc, scValToNative, xdr } from '@stellar/stellar-sdk';
import type {
  StreamEvent,
  StreamEventType,
  StreamSubscription,
  BatchingOptions,
  BatchMetrics,
} from './types.js';
import type { RpcTransportAdapter } from './transport.js';

/**
 * Retry policy for automatic event poller reconnection on unexpected failures.
 * Issue #186.
 */
export interface StreamRetryPolicy {
  /** Max reconnect attempts. 0 disables retry (default: 5). */
  maxAttempts?: number;
  /** Base delay in ms for exponential backoff (default: 1000). */
  baseDelayMs?: number;
  /** Maximum backoff delay cap in ms (default: 30000). */
  maxDelayMs?: number;
}

export interface EventPollerOptions {
  retryPolicy?: StreamRetryPolicy;
  onReconnecting?: (attempt: number, delayMs: number) => void;
  onReconnected?: () => void;
  onDisconnected?: (error: unknown) => void;
  /** Issue #187: opt-in event batching configuration. */
  batchingOptions?: BatchingOptions;
}

interface BatchEntry {
  filter: EventFilterFn;
  callback: (events: StreamEvent[]) => void;
}

const STREAM_EVENT_NAMES = new Set([
  'StreamCreated',
  'StreamWithdrawn',
  'StreamCancelled',
  'StreamCompleted',
  'StreamToppedUp',
  'StreamPaused',
  'StreamResumed',
  'StreamTransferred',
]);

export function unrefTimer(
  timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>,
): void {
  const handle = timer as { unref?: () => void };
  handle.unref?.();
}

function isStreamEventType(value: string): value is StreamEventType {
  return STREAM_EVENT_NAMES.has(value);
}

function parseStreamEvent(raw: rpc.Api.EventResponse): StreamEvent | null {
  if (!raw.inSuccessfulContractCall) return null;

  const rawType = raw.topic.length > 0 ? scValToNative(raw.topic[0]!) : null;
  if (typeof rawType !== 'string' || !isStreamEventType(rawType)) return null;

  const rawStreamId = raw.topic.length > 1 ? scValToNative(raw.topic[1]!) : null;
  const streamId = rawStreamId != null ? String(rawStreamId) : '0';

  const data = raw.value ? (scValToNative(raw.value) as Record<string, unknown>) : {};

  return {
    type: rawType,
    streamId,
    txHash: raw.txHash,
    ledger: raw.ledger,
    timestamp: new Date(raw.ledgerClosedAt).getTime(),
    data,
  };
}

export interface EventFilterFn {
  (event: StreamEvent): boolean;
}

export interface PollerEntry {
  filter: EventFilterFn;
  callback: (event: StreamEvent) => void;
}

/**
 * Polls the Soroban RPC for contract events and dispatches them
 * to matching subscribers.
 *
 * Issue #407: Registers `visibilitychange` and `pageshow` listeners so that
 * polling resumes immediately after the browser/device wakes from sleep,
 * preventing stale subscriptions when the interval timer was silently halted
 * by the OS/browser during sleep.
 */
export class EventPoller {
  private server: RpcTransportAdapter;
  private contractId: string;
  private cursor: string | undefined;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private entries: Map<string, PollerEntry> = new Map();
  private startLedger: number | null = null;

  // Issue #186: retry / reconnect support
  private readonly retryMaxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly onReconnecting?: (attempt: number, delayMs: number) => void;
  private readonly onReconnected?: () => void;
  private readonly onDisconnected?: (error: unknown) => void;
  private consecutiveFailures = 0;
  private reconnecting = false;

  // Issue #187: event batching
  private readonly batchEntries: Map<string, BatchEntry> = new Map();
  private readonly maxBatchSize: number;
  private readonly maxBatchDelayMs: number;
  private batchBuffer: StreamEvent[] = [];
  private batchFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly batchMetrics: BatchMetrics = {
    totalBatches: 0,
    totalEvents: 0,
    averageBatchSize: 0,
    lastFlushAt: null,
  };

  // Issue #407: wake-from-sleep recovery
  private readonly _wakeHandler: () => void;

  constructor(server: RpcTransportAdapter, contractId: string, options?: EventPollerOptions) {
    this.server = server;
    this.contractId = contractId;
    const rp = options?.retryPolicy ?? {};
    this.retryMaxAttempts = rp.maxAttempts ?? 5;
    this.retryBaseDelayMs = rp.baseDelayMs ?? 1_000;
    this.retryMaxDelayMs = rp.maxDelayMs ?? 30_000;
    this.onReconnecting = options?.onReconnecting;
    this.onReconnected = options?.onReconnected;
    this.onDisconnected = options?.onDisconnected;
    this.maxBatchSize = options?.batchingOptions?.maxBatchSize ?? 50;
    this.maxBatchDelayMs = options?.batchingOptions?.maxBatchDelayMs ?? 10;

    // Issue #407: trigger an immediate poll on wake so the interval gap caused
    // by OS/browser sleep doesn't leave subscribers stale.
    this._wakeHandler = () => {
      if (this.intervalId !== null) {
        void this.poll();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._wakeHandler);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('pageshow', this._wakeHandler);
    }
  }

  subscribe(key: string, entry: PollerEntry): StreamSubscription {
    this.entries.set(key, entry);
    if (!this.intervalId) {
      this.startPolling();
    }
    return {
      unsubscribe: () => {
        this.entries.delete(key);
        if (this.entries.size === 0) {
          this.stopPolling();
        }
      },
    };
  }

  private async poll(): Promise<void> {
    try {
      const response = await this.server.getEvents({
        startLedger: this.startLedger ?? undefined,
        filters: [
          {
            type: 'contract',
            contractIds: [this.contractId],
          },
        ],
        cursor: this.cursor,
        limit: 100,
      });

      // Successful poll — reset failure tracking and emit reconnected if recovering
      if (this.consecutiveFailures > 0) {
        this.consecutiveFailures = 0;
        if (this.reconnecting) {
          this.reconnecting = false;
          this.onReconnected?.();
        }
      }

      if (response.events.length > 0) {
        if (this.startLedger === null) {
          this.startLedger = response.latestLedger;
        }
        this.cursor = response.cursor;

        for (const raw of response.events) {
          const event = parseStreamEvent(raw);
          if (!event) continue;
          // Dispatch to immediate subscribers
          for (const [, entry] of this.entries) {
            if (entry.filter(event)) {
              entry.callback(event);
            }
          }
          // Buffer for batch subscribers
          if (this.batchEntries.size > 0) {
            this.batchBuffer.push(event);
            if (this.batchBuffer.length >= this.maxBatchSize) {
              this._flushBatch();
            } else if (this.batchFlushTimer === null) {
              this.batchFlushTimer = setTimeout(() => this._flushBatch(), this.maxBatchDelayMs);
            }
          }
        }
      } else if (this.startLedger === null) {
        this.startLedger = response.latestLedger;
      }
    } catch (err) {
      // Issue #186: exponential backoff with jitter on poll failure
      if (this.retryMaxAttempts === 0) return;

      this.consecutiveFailures++;

      if (this.consecutiveFailures > this.retryMaxAttempts) {
        this.onDisconnected?.(err);
        this.stopPolling();
        return;
      }

      // Full jitter: delay = random(0, min(maxDelay, base * 2^attempt))
      const cap = Math.min(
        this.retryMaxDelayMs,
        this.retryBaseDelayMs * 2 ** (this.consecutiveFailures - 1),
      );
      const delayMs = Math.floor(Math.random() * cap);

      this.reconnecting = true;
      this.onReconnecting?.(this.consecutiveFailures, delayMs);

      // Brief pause before the regular interval resumes the next attempt
      await new Promise<void>((r) => setTimeout(r, delayMs));
    }
  }

  private startPolling(): void {
    void this.poll();
    this.intervalId = setInterval(() => void this.poll(), 5000);
    unrefTimer(this.intervalId);
  }

  private stopPolling(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Subscribes to batched stream events. The callback receives an array of events
   * flushed when either `maxBatchSize` is reached or `maxBatchDelayMs` elapses.
   * Issue #187.
   */
  subscribeBatch(key: string, entry: BatchEntry): StreamSubscription {
    this.batchEntries.set(key, entry);
    if (!this.intervalId) {
      this.startPolling();
    }
    return {
      unsubscribe: () => {
        this.batchEntries.delete(key);
        if (this.entries.size === 0 && this.batchEntries.size === 0) {
          this.stopPolling();
        }
      },
    };
  }

  /** Returns a snapshot of current batch metrics. Issue #187. */
  getBatchMetrics(): BatchMetrics {
    return { ...this.batchMetrics };
  }

  private _flushBatch(): void {
    if (this.batchFlushTimer !== null) {
      clearTimeout(this.batchFlushTimer);
      this.batchFlushTimer = null;
    }
    const batch = this.batchBuffer;
    if (batch.length === 0) return;
    this.batchBuffer = [];

    this.batchMetrics.totalBatches++;
    this.batchMetrics.totalEvents += batch.length;
    this.batchMetrics.averageBatchSize =
      this.batchMetrics.totalEvents / this.batchMetrics.totalBatches;
    this.batchMetrics.lastFlushAt = Date.now();

    for (const [, entry] of this.batchEntries) {
      const matching = batch.filter((e) => entry.filter(e));
      if (matching.length > 0) {
        entry.callback(matching);
      }
    }
  }

  destroy(): void {
    this.stopPolling();
    this.entries.clear();
    this.batchEntries.clear();
    if (this.batchFlushTimer !== null) {
      clearTimeout(this.batchFlushTimer);
      this.batchFlushTimer = null;
    }
    this.batchBuffer = [];
    // Issue #407: remove wake-from-sleep listeners
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._wakeHandler);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('pageshow', this._wakeHandler);
    }
  }
}
