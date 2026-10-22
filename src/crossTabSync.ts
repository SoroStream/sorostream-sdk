/**
 * Cross-tab event synchronization via the Web `BroadcastChannel` API.
 *
 * When `SoroStreamClientOptions.crossTabSync` is enabled, the client opens a
 * channel named after its network + contract, forwards every event emitted on
 * its event bus to other tabs of the same origin, and re-emits events received
 * from other tabs on the local event bus. Subscribers stay consistent across
 * tabs without each tab polling the RPC independently.
 *
 * Listener lifecycle is the important part: the `message` listener is
 * registered exactly once at construction and is removed — and the channel
 * closed — by {@link CrossTabSync.destroy}. `SoroStreamClient.destroy()` (and
 * its `FinalizationRegistry` fallback) always calls `destroy()`, so a
 * destroyed client can be garbage-collected and re-initialisation cycles do
 * not accumulate stale listeners.
 *
 * Shutdown flushing: `BroadcastChannel.postMessage` queues a delivery task
 * rather than transmitting synchronously, so a message posted immediately
 * before `close()` could be silently dropped for other tabs. To prevent that,
 * {@link broadcast} tracks each successfully posted message and {@link destroy}
 * defers the physical teardown (listener removal + `close()`) until every
 * message posted before the call has been given a delivery turn. Messages
 * posted *concurrently with* or *after* `destroy()` are dropped: `broadcast`
 * becomes a no-op the moment `destroy()` is called. A destroyed relay can
 * additionally be awaited via {@link destroyAsync} when the caller needs a
 * promise that resolves once the channel is fully torn down.
 */

import type { IEventBus, Unsubscribe } from './eventBus.js';

/** Wire marker that identifies a message posted by a {@link CrossTabSync} relay. */
const PROTOCOL = '__sorostream_cross_tab__';

interface CrossTabMessage {
  [PROTOCOL]: 1;
  /** Unique per-relay id — used to ignore a relay's own messages. */
  origin: string;
  event: string;
  data: unknown;
  /**
   * Wall-clock timestamp (ms) of the enqueue moment. Used as the primary sort
   * key when draining the offline queue across tabs.
   */
  ts: number;
  /**
   * Monotonically increasing counter scoped to this relay instance. Acts as a
   * tie-break when two tabs enqueue at the same millisecond: the message with
   * the lower `seq` value (from the lexicographically smaller `origin`) wins,
   * providing a fully deterministic drain order.
   */
  seq: number;
}

export interface CrossTabSyncOptions {
  /** BroadcastChannel name — unique per scope (network + contract). */
  channelName: string;
  /**
   * Invoked with `(event, data)` when a message arrives from another tab.
   * Callers should re-emit on the *inner* (unwrapped) event bus so a
   * re-emitted remote event is never broadcast back out, which would create
   * an infinite ping-pong between tabs.
   */
  onMessage: (event: string, data: unknown) => void;
  /** Set to `false` to make the relay a no-op (no channel is opened). */
  enabled?: boolean;
  /**
   * Injectable channel constructor for tests and environments without a
   * global `BroadcastChannel`. Defaults to the global when available.
   */
  broadcastChannelFactory?: (name: string) => BroadcastChannel | null;
}

/** Creates a {@link BroadcastChannel} from the global when available. */
function defaultBroadcastChannelFactory(name: string): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    return new BroadcastChannel(name);
  } catch {
    return null;
  }
}

/**
 * Owns a single `BroadcastChannel` `message` listener.
 *
 * The listener is registered in the constructor and removed in
 * {@link destroy}, so once destroyed the relay holds no references to the
 * channel (or anything it captured) and can be garbage-collected along with
 * the client that owns it.
 */
/**
 * Compares two {@link CrossTabMessage} values by their enqueue order.
 *
 * Primary key: `ts` (wall-clock milliseconds).
 * Tie-break 1: `seq` (monotonic per-relay counter — lower wins).
 * Tie-break 2: `origin` (lexicographic — deterministic across any pair of tabs).
 *
 * The result is negative when `a` should be drained before `b`, positive when
 * `b` should come first, and zero only when both messages are from the same
 * relay with the same sequence number (impossible in practice).
 */
export function compareTabMessages(
  a: Pick<CrossTabMessage, 'ts' | 'seq' | 'origin'>,
  b: Pick<CrossTabMessage, 'ts' | 'seq' | 'origin'>,
): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  if (a.seq !== b.seq) return a.seq - b.seq;
  return a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0;
}

export class CrossTabSync {
  private channel: BroadcastChannel | null = null;
  private readonly originId: string;
  private readonly onMessage: (event: string, data: unknown) => void;
  private readonly handleMessage: (event: MessageEvent) => void;
  /**
   * Number of successfully posted messages that have not yet been given a
   * delivery turn. {@link destroy} defers teardown until this reaches zero.
   */
  private pendingBroadcasts = 0;
  /** Set by {@link destroy}; `broadcast` becomes a no-op from this point on. */
  private destroyRequested = false;
  private destroyed = false;
  private destroyWaiters: Array<() => void> = [];
  /**
   * Monotonically increasing counter used as the `seq` tie-break field on
   * every outgoing message. Scoped to this relay instance.
   */
  private seq = 0;

  constructor(options: CrossTabSyncOptions) {
    this.onMessage = options.onMessage;
    this.originId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    this.handleMessage = (event: MessageEvent) => {
      if (this.destroyRequested) return;
      const message = event?.data as CrossTabMessage | undefined;
      if (!message || message[PROTOCOL] !== 1) return;
      if (message.origin === this.originId) return;
      this.onMessage(message.event, message.data);
    };
    if (options.enabled === false) return;
    const factory = options.broadcastChannelFactory ?? defaultBroadcastChannelFactory;
    const channel = factory(options.channelName);
    if (!channel) return;
    this.channel = channel;
    channel.addEventListener('message', this.handleMessage);
  }

  /** True while the relay owns an open channel. False once destroy is requested. */
  get active(): boolean {
    return this.channel !== null && !this.destroyRequested;
  }

  /** Forwards an event to other tabs. No-op while inactive or destroyed. */
  broadcast(event: string, data: unknown): void {
    const channel = this.channel;
    if (!channel || this.destroyRequested) return;
    try {
      channel.postMessage({
        [PROTOCOL]: 1,
        origin: this.originId,
        event,
        data,
        ts: Date.now(),
        seq: this.seq++,
      } satisfies CrossTabMessage);
    } catch {
      // Payloads that are not structured-cloneable (e.g. wallet adapter
      // instances with methods) are skipped rather than crashing the
      // emitting call site. Nothing was queued for delivery, so the
      // pending-broadcast count is not incremented.
      return;
    }
    // `postMessage` only *queues* a delivery task; track it so `destroy` can
    // wait until the message has had a chance to reach other tabs.
    this.pendingBroadcasts++;
    const timer = setTimeout(() => {
      this.pendingBroadcasts--;
      this.maybeTeardown();
    }, 0);
    const unref = (timer as unknown as { unref?: () => void }).unref;
    unref?.call(timer);
  }

  /**
   * Removes the `message` listener and closes the channel. Safe to call
   * multiple times. After this, `broadcast` is a no-op and no further
   * messages are delivered.
   *
   * Messages already posted via {@link broadcast} are flushed before the
   * channel is torn down: if any are still pending delivery, the listener
   * removal and `close()` are deferred to a subsequent macrotask so other
   * tabs still receive them. Messages posted concurrently with or after
   * `destroy()` are dropped (`broadcast` is disabled immediately).
   * Use {@link destroyAsync} to await the physical teardown.
   */
  destroy(): void {
    this.destroyRequested = true;
    this.maybeTeardown();
  }

  /**
   * Like {@link destroy}, but returns a promise that resolves once pending
   * broadcasts have been flushed and the channel is fully torn down.
   */
  destroyAsync(): Promise<void> {
    this.destroy();
    if (this.destroyed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.destroyWaiters.push(resolve);
    });
  }

  /** Runs the physical teardown once destroy was requested and nothing is pending. */
  private maybeTeardown(): void {
    if (this.destroyed || !this.destroyRequested || this.pendingBroadcasts > 0) return;
    this.teardown();
  }

  private teardown(): void {
    const channel = this.channel;
    this.destroyed = true;
    this.channel = null;
    if (channel) {
      channel.removeEventListener('message', this.handleMessage);
      channel.close();
    }
    const waiters = this.destroyWaiters;
    this.destroyWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

/**
 * {@link IEventBus} decorator that forwards every local `emit` to a
 * {@link CrossTabSync} relay. Events received from other tabs are re-emitted
 * on the inner bus directly (see {@link CrossTabSyncOptions.onMessage}), so
 * they are never broadcast back out.
 */
export class CrossTabEventBus implements IEventBus {
  /** The relay currently forwarding local emits. Swapped on network switch. */
  relay: CrossTabSync | null;

  constructor(
    /** The underlying bus all subscription state lives on. */
    readonly inner: IEventBus,
    relay: CrossTabSync | null,
  ) {
    this.relay = relay;
  }

  emit(event: string, data: unknown): void {
    this.inner.emit(event, data);
    this.relay?.broadcast(event, data);
  }

  on(event: string, handler: (data: unknown) => void): Unsubscribe {
    return this.inner.on(event, handler);
  }
}
