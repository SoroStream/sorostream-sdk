import { rpc } from '@stellar/stellar-sdk';
import { EventPoller, unrefTimer } from './events.js';
import { ConnectionPoolExhaustedError } from './errors.js';

export type PoolEventType = 'pool:full' | 'pool:reconnect' | 'pool:drain';

export interface PoolEvent {
  type: PoolEventType;
}

export interface ConnectionPoolOptions {
  /** Number of RPC connections to maintain. */
  poolSize: number;
  /**
   * Maximum number of connections that can be held concurrently via
   * {@link ConnectionPool.acquire}. Excess concurrent callers are queued
   * (FIFO) until a held connection is released (default: `poolSize`).
   * Issue #539.
   */
  maxConnections?: number;
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
  /** Maximum connections held concurrently via {@link acquire} (issue #539). */
  readonly maxConnections: number;
  /** Number of connections currently held via {@link acquire}. */
  private activeConnections = 0;
  /** FIFO queue of pending {@link acquire} grants waiting for a free connection. */
  private waiters: Array<() => void> = [];

  constructor(options: ConnectionPoolOptions) {
    this.rpcUrl = options.rpcUrl;
    this.contractId = options.contractId;
    this.maxSubs = options.maxSubscriptionsPerConnection ?? 10;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
    this.maxConnections = options.maxConnections ?? options.poolSize;

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
   * Accepts an optional `AbortSignal` to automatically release the slot on abort.
   */
  acquirePoller(options?: { signal?: AbortSignal }): { poller: EventPoller; release: () => void } {
    const best = this._leastLoadedSlot();

    if (best.subscriptions >= this.maxSubs) {
      this._emit({ type: 'pool:full' });
      throw new ConnectionPoolExhaustedError(
        `Connection pool exhausted: all ${this.slots.length} connection slots reached capacity (${this.maxSubs} subs/connection)`,
      );
    }

    best.subscriptions++;
    best.lastActive = Date.now();

    let released = false;
    const slot = best;
    const release = () => {
      if (released) return;
      released = true;
      slot.subscriptions = Math.max(0, slot.subscriptions - 1);
      if (options?.signal && abortHandler) {
        options.signal.removeEventListener('abort', abortHandler);
      }
      if (this.slots.every((s) => s.subscriptions === 0)) {
        this._emit({ type: 'pool:drain' });
      }
    };

    let abortHandler: (() => void) | undefined;
    if (options?.signal) {
      if (options.signal.aborted) {
        release();
      } else {
        abortHandler = () => {
          release();
        };
        options.signal.addEventListener('abort', abortHandler, { once: true });
      }
    }

    return {
      poller: slot.poller,
      release,
    };
  }

  /**
   * Acquires the least-loaded RPC server instance from the pool for executing a request (issue #435).
   */
  acquireServer(): { server: rpc.Server; release: () => void } {
    const best = this._leastLoadedSlot();

    best.subscriptions++;
    best.lastActive = Date.now();

    let released = false;
    const slot = best;
    return {
      server: slot.server,
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

  /**
   * Atomically acquires a pool connection bounded by `maxConnections`
   * (issue #539).
   *
   * The capacity check and counter increment happen synchronously inside this
   * call, so it is impossible for concurrent `acquire()` invocations to exceed
   * `maxConnections`. When the pool is at capacity the caller is queued and
   * the promise resolves (in FIFO order) as soon as a held connection is
   * released. Unlike {@link acquirePoller} this never throws for a busy pool —
   * it waits instead.
   *
   * @param options.signal - Optional `AbortSignal`. If the signal fires while
   *   queued, the returned promise rejects and the queued grant is withdrawn.
   * @returns A promise resolving with a pooled RPC server and a `release`
   *   function that frees the slot (and hands it to the next waiter).
   */
  acquire(options?: {
    signal?: AbortSignal;
  }): Promise<{ server: rpc.Server; release: () => void }> {
    const signal = options?.signal;
    if (signal?.aborted) {
      return Promise.reject(
        new Error('ConnectionPool.acquire(): aborted before acquiring a connection'),
      );
    }

    return new Promise((resolve, reject) => {
      const grant = () => {
        if (abortHandler) signal!.removeEventListener('abort', abortHandler);
        const slot = this._leastLoadedSlot();
        this.activeConnections++;
        slot.subscriptions++;
        slot.lastActive = Date.now();

        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          slot.subscriptions = Math.max(0, slot.subscriptions - 1);
          this.activeConnections = Math.max(0, this.activeConnections - 1);
          // Hand the freed slot to the longest-waiting caller (FIFO).
          const next = this.waiters.shift();
          if (next) next();
          if (this.slots.every((s) => s.subscriptions === 0)) {
            this._emit({ type: 'pool:drain' });
          }
        };

        resolve({ server: slot.server, release });
      };

      let abortHandler: (() => void) | undefined;
      if (signal && !signal.aborted) {
        abortHandler = () => {
          const idx = this.waiters.indexOf(grant);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(new Error('ConnectionPool.acquire(): aborted while waiting for a connection'));
        };
        signal.addEventListener('abort', abortHandler, { once: true });
      }

      if (this.activeConnections < this.maxConnections) {
        grant();
      } else {
        this.waiters.push(grant);
      }
    });
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

  private _leastLoadedSlot(): PoolSlot {
    let best = this.slots[0]!;
    for (const slot of this.slots) {
      if (slot.subscriptions < best.subscriptions) best = slot;
    }
    return best;
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
