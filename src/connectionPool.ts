import { rpc } from '@stellar/stellar-sdk';
import { EventPoller, unrefTimer } from './events.js';

export type PoolEventType = 'pool:full' | 'pool:reconnect' | 'pool:drain';

export interface PoolEvent {
  type: PoolEventType;
}

export interface ConnectionPoolOptions {
  /** Number of RPC connections to maintain. */
  poolSize: number;
  /** Max concurrent subscriptions per connection before emitting pool:full (default: 10). */
  maxSubscriptionsPerConnection?: number;
  /** Idle connection replacement interval in ms (default: 30000). */
  idleTimeoutMs?: number;
  /** RPC endpoint URL shared by all pool connections. */
  rpcUrl: string;
  /** Contract ID used by event pollers in the pool. */
  contractId: string;
}

interface PoolSlot {
  server: rpc.Server;
  poller: EventPoller;
  subscriptions: number;
  lastActive: number;
}

/**
 * Manages a fixed set of reusable RPC connections and event pollers.
 * New subscriptions are routed to the least-loaded slot.
 */
export class ConnectionPool {
  private slots: PoolSlot[];
  private readonly maxSubs: number;
  private readonly idleTimeoutMs: number;
  private readonly rpcUrl: string;
  private readonly contractId: string;
  private readonly listeners = new Set<(e: PoolEvent) => void>();
  private readonly idleTimer: ReturnType<typeof setInterval>;

  constructor(options: ConnectionPoolOptions) {
    this.rpcUrl = options.rpcUrl;
    this.contractId = options.contractId;
    this.maxSubs = options.maxSubscriptionsPerConnection ?? 10;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30_000;

    this.slots = Array.from({ length: options.poolSize }, () => {
      const server = new rpc.Server(options.rpcUrl, { allowHttp: false });
      return {
        server,
        poller: new EventPoller(server, options.contractId),
        subscriptions: 0,
        lastActive: Date.now(),
      };
    });

    this.idleTimer = setInterval(() => this._sweepIdle(), this.idleTimeoutMs);
    unrefTimer(this.idleTimer);
  }

  /**
   * Acquires the least-loaded event poller from the pool.
   * Call the returned `release` function when the subscription ends.
   */
  acquirePoller(): { poller: EventPoller; release: () => void } {
    let best = this.slots[0]!;
    for (const slot of this.slots) {
      if (slot.subscriptions < best.subscriptions) best = slot;
    }

    if (best.subscriptions >= this.maxSubs) {
      this._emit({ type: 'pool:full' });
    }

    best.subscriptions++;
    best.lastActive = Date.now();

    let released = false;
    const slot = best;
    return {
      poller: slot.poller,
      release: () => {
        if (released) return;
        released = true;
        slot.subscriptions = Math.max(0, slot.subscriptions - 1);
        if (this.slots.every((s) => s.subscriptions === 0)) {
          this._emit({ type: 'pool:drain' });
        }
      },
    };
  }

  /** Returns current pool connection statistics. */
  getStats(): { total: number; active: number; idle: number } {
    const active = this.slots.filter((s) => s.subscriptions > 0).length;
    return { total: this.slots.length, active, idle: this.slots.length - active };
  }

  /** Registers a listener for pool-level events. Returns an unsubscribe function. */
  on(listener: (e: PoolEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Destroys the pool, stops all pollers, and cancels the idle sweep timer. */
  destroy(): void {
    clearInterval(this.idleTimer);
    for (const slot of this.slots) {
      slot.poller.destroy();
    }
    this.listeners.clear();
  }

  private _emit(event: PoolEvent): void {
    for (const cb of this.listeners) cb(event);
  }

  private _sweepIdle(): void {
    const now = Date.now();
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]!;
      if (slot.subscriptions === 0 && now - slot.lastActive > this.idleTimeoutMs) {
        slot.poller.destroy();
        const server = new rpc.Server(this.rpcUrl, { allowHttp: false });
        this.slots[i] = {
          server,
          poller: new EventPoller(server, this.contractId),
          subscriptions: 0,
          lastActive: now,
        };
        this._emit({ type: 'pool:reconnect' });
      }
    }
  }
}
