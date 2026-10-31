/**
 * Regression tests for issues #716, #718, #719 and #709.
 *
 * - #716 RateLimiter honours maxConcurrent changes made after construction
 * - #718 CrossTabSync.destroy() flushes BroadcastChannel messages already queued
 * - #719 OfflineQueue breaks priority ties by insertion order (FIFO-within-priority)
 * - #709 Simulator models contract storage TTL expiry on a simulated withdraw
 */
import { describe, it, expect, vi } from 'vitest';

import { RateLimiter } from '../src/rate-limiter.js';
import { CrossTabSync } from '../src/crossTabSync.js';
import { InMemoryEventBus } from '../src/eventBus.js';
import { OfflineWriteQueue } from '../src/offlineQueue.js';
import { StreamSimulator } from '../src/simulator.js';
import type { Stream } from '../src/types.js';

// ── #716: runtime maxConcurrent updates ─────────────────────────────────────

describe('#716 RateLimiter runtime maxConcurrent', () => {
  /** Gate that lets a task be resolved manually from the test. */
  function gated() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }

  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it('applies a raised maxConcurrent to queued tasks without a new instance', async () => {
    const limiter = new RateLimiter(1);
    const gateA = gated();
    const started: string[] = [];

    const task = (name: string, gate: { promise: Promise<void> }) => () => {
      started.push(name);
      return gate.promise;
    };

    const pA = limiter.run(task('a', gateA));
    const gateB = gated();
    const gateC = gated();
    const pB = limiter.run(task('b', gateB));
    const pC = limiter.run(task('c', gateC));
    await tick();

    expect(started).toEqual(['a']);
    expect(limiter.active).toBe(1);
    expect(limiter.pending).toBe(2);

    limiter.setMaxConcurrent(3);
    await tick();

    expect(limiter.concurrency).toBe(3);
    expect(started).toEqual(['a', 'b', 'c']);
    expect(limiter.active).toBe(3);

    gateA.release();
    gateB.release();
    gateC.release();
    await Promise.all([pA, pB, pC]);
    expect(limiter.active).toBe(0);
  });

  it('lowers maxConcurrent without cancelling in-flight tasks', async () => {
    const limiter = new RateLimiter(3);
    const gateA = gated();
    const gateB = gated();
    const gateC = gated();

    const pA = limiter.run(() => gateA.promise);
    const pB = limiter.run(() => gateB.promise);
    const pC = limiter.run(() => gateC.promise);
    await tick();
    expect(limiter.active).toBe(3);

    limiter.setMaxConcurrent(2);
    expect(limiter.concurrency).toBe(2);
    // In-flight tasks are never cancelled — they finish, but no new task
    // may start while the count is at or above the new limit.
    expect(limiter.active).toBe(3);

    const started: string[] = [];
    const pD = limiter.run(() => {
      started.push('d');
      return Promise.resolve();
    });
    await tick();
    expect(started).toEqual([]);
    expect(limiter.pending).toBe(1);

    gateA.release();
    await tick();
    // 2 still in flight — at the new limit, so d must not start yet.
    // (Under the old limit of 3 it would have started here.)
    expect(started).toEqual([]);

    gateB.release();
    await tick();
    // Dropped below the new limit; d is dequeued and started.
    expect(started).toEqual(['d']);

    gateC.release();
    await Promise.all([pA, pB, pC, pD]);
    expect(limiter.active).toBe(0);
  });

  it('rejects an invalid runtime limit', () => {
    const limiter = new RateLimiter(2);
    expect(() => limiter.setMaxConcurrent(0)).toThrow('maxConcurrent must be >= 1');
    expect(limiter.concurrency).toBe(2);
  });
});

// ── #718: CrossTabSync.destroy() flushes queued broadcasts ──────────────────

/**
 * In-memory BroadcastChannel stand-in that, like the real API, delivers
 * messages asynchronously on a macrotask. Messages posted by a channel that
 * is closed before the delivery task runs are dropped — mirroring the
 * behaviour that used to silently lose events sent just before shutdown.
 */
class AsyncFakeBroadcastChannel {
  static registry = new Map<string, Set<AsyncFakeBroadcastChannel>>();

  static reset(): void {
    AsyncFakeBroadcastChannel.registry = new Map();
  }

  name: string;
  listeners = new Set<(event: { data: unknown }) => void>();
  closed = false;
  posted: unknown[] = [];
  private pendingDeliveries = new Set<object>();

  constructor(name: string) {
    this.name = name;
    const set = AsyncFakeBroadcastChannel.registry.get(name) ?? new Set();
    set.add(this);
    AsyncFakeBroadcastChannel.registry.set(name, set);
  }

  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    if (type === 'message') this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    this.listeners.delete(listener);
  }

  postMessage(data: unknown): void {
    this.posted.push(data);
    const token = {};
    this.pendingDeliveries.add(token);
    setTimeout(() => {
      if (!this.pendingDeliveries.delete(token)) return; // dropped by close()
      for (const channel of AsyncFakeBroadcastChannel.registry.get(this.name) ?? []) {
        if (channel === this || channel.closed) continue;
        for (const listener of channel.listeners) {
          listener({ data });
        }
      }
    }, 0);
  }

  close(): void {
    this.closed = true;
    this.pendingDeliveries.clear(); // undelivered messages are lost
    AsyncFakeBroadcastChannel.registry.get(this.name)?.delete(this);
  }
}

const flushMacrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

describe('#718 CrossTabSync.destroy flush', () => {
  it('delivers a message posted immediately before destroy() to another tab', async () => {
    AsyncFakeBroadcastChannel.reset();
    const onMessageA = vi.fn();
    const onMessageB = vi.fn();
    const relayA = new CrossTabSync({
      channelName: 'shared',
      enabled: true,
      onMessage: onMessageA,
      broadcastChannelFactory: (name) => new AsyncFakeBroadcastChannel(name),
    });
    const relayB = new CrossTabSync({
      channelName: 'shared',
      enabled: true,
      onMessage: onMessageB,
      broadcastChannelFactory: (name) => new AsyncFakeBroadcastChannel(name),
    });
    const channelA = [...AsyncFakeBroadcastChannel.registry.get('shared')!][0]!;

    relayA.broadcast('cacheInvalidated', { reason: 'manual' });
    relayA.destroy();

    // Broadcasts are disabled immediately, but the channel stays open until
    // the pending message has had its delivery turn.
    expect(relayA.active).toBe(false);
    expect(channelA.closed).toBe(false);

    await flushMacrotask();

    expect(onMessageB).toHaveBeenCalledTimes(1);
    expect(onMessageB).toHaveBeenCalledWith('cacheInvalidated', { reason: 'manual' });
    expect(onMessageA).not.toHaveBeenCalled();
    expect(channelA.closed).toBe(true);
    expect(channelA.listeners.size).toBe(0);

    // A message posted concurrently with destroy is dropped.
    relayA.broadcast('cacheInvalidated', { reason: 'late' });
    await flushMacrotask();
    expect(onMessageB).toHaveBeenCalledTimes(1);

    relayB.destroy();
  });

  it('destroyAsync resolves once the channel is torn down', async () => {
    AsyncFakeBroadcastChannel.reset();
    const relay = new CrossTabSync({
      channelName: 'shared',
      enabled: true,
      onMessage: vi.fn(),
      broadcastChannelFactory: (name) => new AsyncFakeBroadcastChannel(name),
    });
    const channel = [...AsyncFakeBroadcastChannel.registry.get('shared')!][0]!;

    relay.broadcast('cacheInvalidated', { reason: 'manual' });
    await relay.destroyAsync();

    expect(channel.closed).toBe(true);
    expect(channel.listeners.size).toBe(0);
    expect(relay.active).toBe(false);
  });

  it('still tears down synchronously when nothing is pending', () => {
    AsyncFakeBroadcastChannel.reset();
    const relay = new CrossTabSync({
      channelName: 'shared',
      enabled: true,
      onMessage: vi.fn(),
      broadcastChannelFactory: (name) => new AsyncFakeBroadcastChannel(name),
    });
    const channel = [...AsyncFakeBroadcastChannel.registry.get('shared')!][0]!;

    relay.destroy();

    expect(relay.active).toBe(false);
    expect(channel.closed).toBe(true);
    expect(channel.listeners.size).toBe(0);
  });
});

// ── #719: FIFO-within-priority for the offline queue ────────────────────────

describe('#719 OfflineQueue priority ties', () => {
  function makeQueue(maxQueueSize = 100) {
    return new OfflineWriteQueue(
      { enabled: true, maxQueueSize, healthCheckIntervalMs: 10_000 },
      new InMemoryEventBus(),
    );
  }

  it('dequeues same-priority operations strictly in insertion order', async () => {
    const queue = makeQueue();
    const drained: string[] = [];
    for (const name of ['first', 'second', 'third', 'fourth', 'fifth']) {
      queue.enqueue(name, async () => {
        drained.push(name);
      });
    }

    const event = await queue.drain();

    expect(drained).toEqual(['first', 'second', 'third', 'fourth', 'fifth']);
    expect(event.successful).toBe(5);
    expect(event.failed).toBe(0);
    const replayOrder = event.results.map((r) => r.operation.operation);
    expect(replayOrder).toEqual(['first', 'second', 'third', 'fourth', 'fifth']);
  });

  it('keeps cross-priority ordering while FIFO-breaking ties within a priority', async () => {
    const queue = makeQueue();
    const drained: string[] = [];
    const enqueue = (name: string, priority: number) =>
      queue.enqueue(
        name,
        async () => {
          drained.push(name);
        },
        priority,
      );

    enqueue('low-1', 0);
    enqueue('high-1', 10);
    enqueue('low-2', 0);
    enqueue('mid-1', 5);
    enqueue('high-2', 10);
    enqueue('mid-2', 5);

    await queue.drain();

    expect(drained).toEqual(['high-1', 'high-2', 'mid-1', 'mid-2', 'low-1', 'low-2']);
  });

  it('re-queues a failed offline operation behind higher-priority entries', async () => {
    const queue = makeQueue();
    const drained: string[] = [];
    let failFirstAttempt = true;

    queue.markOffline();
    queue.enqueue('retried', async () => {
      if (failFirstAttempt) {
        failFirstAttempt = false;
        throw new Error('still offline');
      }
      drained.push('retried');
    });
    queue.enqueue(
      'high',
      async () => {
        drained.push('high');
      },
      10,
    );

    // Drain once while offline: "high" (priority 10) drains first and
    // succeeds, per the documented "higher values drain first" ordering;
    // "retried" (priority 0, default) drains next, fails, and is re-queued,
    // at which point drainage stops because we're still offline.
    const first = await queue.drain();
    expect(first.failed).toBe(1);
    expect(queue.size).toBe(1);

    // While offline, an equal-priority operation is enqueued *after* the
    // re-queued one — it must still replay behind it.
    queue.enqueue('low-after', async () => {
      drained.push('low-after');
    });

    queue.markOnline();
    await queue.drain();

    expect(drained).toEqual(['high', 'retried', 'low-after']);
  });
});

// ── #709: simulator storage TTL and withdraw simulation ─────────────────────

describe('#709 Simulator storage TTL', () => {
  const now = () => Math.floor(Date.now() / 1000);

  function makeStream(id = 'stream-1'): Stream {
    const t = now();
    return {
      id,
      sender: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
      recipient: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
      token: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
      deposit: 10_000_000n,
      flowRate: 100n,
      startTime: t - 100,
      endTime: t + 3600,
      lastWithdrawTime: t - 100,
      status: 'Active',
      autoRenew: false,
    } as Stream;
  }

  it('reports a distinct failure when the storage TTL has expired', () => {
    const sim = new StreamSimulator();
    const stream = makeStream();

    sim.setStorageTtl(stream.id, sim.now() + 60);
    expect(sim.isStorageExpired(stream.id)).toBe(false);

    const beforeExpiry = sim.simulateWithdraw(stream);
    expect(beforeExpiry.success).toBe(true);
    expect(beforeExpiry.amount).toBe(beforeExpiry.claimable);
    expect(beforeExpiry.claimable).toBeGreaterThan(0n);

    sim.advance(120);
    expect(sim.isStorageExpired(stream.id)).toBe(true);

    const afterExpiry = sim.simulateWithdraw(stream);
    expect(afterExpiry.success).toBe(false);
    expect(afterExpiry.reason).toBe('storageExpired');
    expect(afterExpiry.amount).toBe(0n);
    expect(afterExpiry.error).toContain(stream.id);
    expect(afterExpiry.error).toContain('restored');
  });

  it('succeeds again once the storage TTL is cleared or refreshed', () => {
    const sim = new StreamSimulator();
    const stream = makeStream();

    sim.setStorageTtl(stream.id, sim.now() + 10);
    sim.advance(30);
    expect(sim.simulateWithdraw(stream).reason).toBe('storageExpired');

    sim.clearStorageTtl(stream.id);
    expect(sim.isStorageExpired(stream.id)).toBe(false);
    expect(sim.simulateWithdraw(stream).success).toBe(true);

    sim.setStorageTtl(stream.id, sim.now() + 1000);
    expect(sim.simulateWithdraw(stream).success).toBe(true);
  });

  it('reports distinct failures for inactive streams and over-withdrawals', () => {
    const sim = new StreamSimulator();
    const cancelled = makeStream('cancelled');
    cancelled.status = 'Cancelled';

    const inactive = sim.simulateWithdraw(cancelled);
    expect(inactive.success).toBe(false);
    expect(inactive.reason).toBe('streamNotActive');

    const active = makeStream();
    const over = sim.simulateWithdraw(active, active.deposit + 1n);
    expect(over.success).toBe(false);
    expect(over.reason).toBe('insufficientClaimable');
    expect(over.claimable).toBeLessThan(active.deposit + 1n);
  });

  it('rejects a negative storage TTL', () => {
    const sim = new StreamSimulator();
    expect(() => sim.setStorageTtl('stream-1', -1)).toThrow('expiresAt must be >= 0');
  });
});
