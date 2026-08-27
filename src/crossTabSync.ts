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
export class CrossTabSync {
  private channel: BroadcastChannel | null = null;
  private readonly originId: string;
  private readonly onMessage: (event: string, data: unknown) => void;
  private readonly handleMessage: (event: MessageEvent) => void;

  constructor(options: CrossTabSyncOptions) {
    this.onMessage = options.onMessage;
    this.originId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    this.handleMessage = (event: MessageEvent) => {
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

  /** True while the relay owns an open channel. */
  get active(): boolean {
    return this.channel !== null;
  }

  /** Forwards an event to other tabs. No-op while inactive or destroyed. */
  broadcast(event: string, data: unknown): void {
    const channel = this.channel;
    if (!channel) return;
    try {
      channel.postMessage({
        [PROTOCOL]: 1,
        origin: this.originId,
        event,
        data,
      } satisfies CrossTabMessage);
    } catch {
      // Payloads that are not structured-cloneable (e.g. wallet adapter
      // instances with methods) are skipped rather than crashing the
      // emitting call site.
    }
  }

  /**
   * Removes the `message` listener and closes the channel. Safe to call
   * multiple times. After this, `broadcast` is a no-op and no further
   * messages are delivered.
   */
  destroy(): void {
    const channel = this.channel;
    if (!channel) return;
    this.channel = null;
    channel.removeEventListener('message', this.handleMessage);
    channel.close();
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
