/**
 * Issues #947, #948, #956 and #957.
 *
 * - #947: RateLimiter.cancelPending rejects queued-but-not-started tasks.
 * - #948: StreamSimulator re-fires an expiry callback for a renewed stream.
 * - #956: createFederationPlugin's resolveFresh never joins a non-fresh lookup.
 * - #957: bigIntScalarConfig rejects non-integer numbers with a clear TypeError.
 */
import { describe, it, expect, vi } from 'vitest';
import { RateLimiter, RateLimiterCancelledError } from '../src/index.js';
import { StreamSimulator } from '../src/simulator.js';
import { createFederationPlugin } from '../src/federationPlugin.js';
import { bigIntScalarConfig } from '../src/graphql.js';
import { SoroStreamError } from '../src/errors.js';
import type { Stream } from '../src/types.js';

// ── #947 ────────────────────────────────────────────────────────────────────

describe('#947 RateLimiter.cancelPending', () => {
  /** A task that stays running until `release()` is called. */
  function blockingTask<T>(value: T) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const task = vi.fn(async () => {
      await gate;
      return value;
    });
    return { task, release };
  }

  it('rejects queued tasks with RateLimiterCancelledError and never starts them', async () => {
    const limiter = new RateLimiter(1);
    const running = blockingTask('running');
    const queuedTask = vi.fn(async () => 'queued');

    const first = limiter.run(running.task);
    const queued = limiter.run(queuedTask);
    expect(limiter.pending).toBe(1);

    expect(limiter.cancelPending()).toBe(1);
    expect(limiter.pending).toBe(0);

    await expect(queued).rejects.toBeInstanceOf(RateLimiterCancelledError);
    expect(queuedTask).not.toHaveBeenCalled();

    running.release();
    await expect(first).resolves.toBe('running');
  });

  it('does not interrupt a task that is already running', async () => {
    const limiter = new RateLimiter(2);
    const a = blockingTask('a');
    const b = blockingTask('b');
    const pa = limiter.run(a.task);
    const pb = limiter.run(b.task);

    expect(limiter.active).toBe(2);
    expect(limiter.cancelPending()).toBe(0);

    a.release();
    b.release();
    await expect(Promise.all([pa, pb])).resolves.toEqual(['a', 'b']);
  });

  it('rejects every queued task, in one call', async () => {
    const limiter = new RateLimiter(1);
    const running = blockingTask(0);
    const first = limiter.run(running.task);
    const queued = [1, 2, 3].map((n) => limiter.run(async () => n));
    const settled = Promise.allSettled(queued);

    expect(limiter.cancelPending()).toBe(3);

    const results = await settled;
    expect(results.every((r) => r.status === 'rejected')).toBe(true);

    running.release();
    await first;
  });

  it('uses a custom reason when one is given', async () => {
    const limiter = new RateLimiter(1);
    const running = blockingTask(0);
    const first = limiter.run(running.task);
    const queued = limiter.run(async () => 1);
    const reason = new Error('client destroyed');

    limiter.cancelPending(reason);

    await expect(queued).rejects.toBe(reason);
    running.release();
    await first;
  });

  it('returns 0 and is harmless when nothing is queued', () => {
    expect(new RateLimiter(3).cancelPending()).toBe(0);
  });

  it('stays usable after cancelling', async () => {
    const limiter = new RateLimiter(1);
    const running = blockingTask('x');
    const first = limiter.run(running.task);
    const queued = limiter.run(async () => 'never');
    const settled = queued.catch(() => 'cancelled');
    limiter.cancelPending();
    await expect(settled).resolves.toBe('cancelled');

    running.release();
    await first;

    await expect(limiter.run(async () => 'after')).resolves.toBe('after');
    expect(limiter.active).toBe(0);
    expect(limiter.pending).toBe(0);
  });

  it('RateLimiterCancelledError is a SoroStreamError with a stable name', () => {
    const err = new RateLimiterCancelledError();
    expect(err).toBeInstanceOf(SoroStreamError);
    expect(err.name).toBe('RateLimiterCancelledError');
    expect(err.message).toMatch(/cancelled/);
  });
});

// ── #948 ────────────────────────────────────────────────────────────────────

describe('#948 StreamSimulator expiry for renewed streams', () => {
  function streamEnding(sim: StreamSimulator, inSeconds: number, id = 's1'): Stream {
    return {
      id,
      sender: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
      recipient: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
      token: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
      deposit: 10_000_000n,
      flowRate: 100n,
      startTime: sim.now() - 100,
      endTime: sim.now() + inSeconds,
      lastWithdrawTime: sim.now() - 100,
      status: 'Active',
      autoRenew: true,
    } as Stream;
  }

  it('fires once for an endTime and not again for the same stream', () => {
    const sim = new StreamSimulator();
    const cb = vi.fn();
    const stream = streamEnding(sim, 10);
    sim.onExpire(stream.id, cb);

    sim.advance(20, [stream]);
    sim.advance(20, [stream]);

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('fires again when the renewed stream (same ID, later endTime) expires', () => {
    const sim = new StreamSimulator();
    const cb = vi.fn();
    const original = streamEnding(sim, 10);
    sim.onExpire(original.id, cb);

    sim.advance(20, [original]);
    expect(cb).toHaveBeenCalledTimes(1);

    const renewed = { ...original, endTime: sim.now() + 50 };
    sim.advance(10, [renewed]); // new endTime not reached yet
    expect(cb).toHaveBeenCalledTimes(1);

    sim.advance(60, [renewed]); // now crossed
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenLastCalledWith(renewed);

    sim.advance(60, [renewed]); // still only once per endTime
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('tracks expiry per stream ID independently', () => {
    const sim = new StreamSimulator();
    const a = vi.fn();
    const b = vi.fn();
    const s1 = streamEnding(sim, 10, 'a');
    const s2 = streamEnding(sim, 100, 'b');
    sim.onExpire('a', a);
    sim.onExpire('b', b);

    sim.advance(20, [s1, s2]);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();

    sim.advance(100, [s1, s2]);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('reset() clears fired state so the same endTime can fire again', () => {
    const sim = new StreamSimulator();
    const cb = vi.fn();
    const stream = streamEnding(sim, 10);
    sim.onExpire(stream.id, cb);

    sim.advance(20, [stream]);
    sim.reset();
    sim.advance(1_000_000, [stream]);

    expect(cb).toHaveBeenCalledTimes(2);
  });
});

// ── #956 ────────────────────────────────────────────────────────────────────

describe('#956 resolveFresh does not join a non-fresh in-flight lookup', () => {
  const ADDRESS = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
  const FED = 'alice*example.com';

  /** A fetch whose stellar.toml responses are held until `release()` is called. */
  function gatedFetch() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let tomlCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('stellar.toml')) {
        tomlCalls++;
        await gate;
        return { ok: true, text: async () => 'FEDERATION_SERVER="https://fed.example.com"' };
      }
      return { ok: true, json: async () => ({ account_id: ADDRESS }) };
    });
    return { fetchMock, release, tomlCalls: () => tomlCalls };
  }

  function ctx() {
    return { method: 'createStream', args: [{ recipient: FED }] } as never;
  }

  it('starts its own lookup even though a plain resolve is already in flight', async () => {
    const { fetchMock, release, tomlCalls } = gatedFetch();
    const plugin = createFederationPlugin({ fetch: fetchMock as never });

    const plain = plugin.before!(ctx()); // non-fresh resolve(), now in flight
    await Promise.resolve();
    expect(tomlCalls()).toBe(1);

    const fresh = plugin.resolveFresh(FED);
    await Promise.resolve();
    // Before the fix this stayed at 1: resolveFresh joined the plain lookup.
    expect(tomlCalls()).toBe(2);

    release();
    await expect(fresh).resolves.toBe(ADDRESS);
    await plain;
  });

  it('still de-duplicates concurrent fresh lookups for the same address', async () => {
    const { fetchMock, release, tomlCalls } = gatedFetch();
    const plugin = createFederationPlugin({ fetch: fetchMock as never });

    const a = plugin.resolveFresh(FED);
    const b = plugin.resolveFresh(FED);
    await Promise.resolve();
    expect(tomlCalls()).toBe(1);

    release();
    await expect(Promise.all([a, b])).resolves.toEqual([ADDRESS, ADDRESS]);
  });

  it('a plain resolve may join an in-flight fresh lookup (it is at least as current)', async () => {
    const { fetchMock, release, tomlCalls } = gatedFetch();
    const plugin = createFederationPlugin({ fetch: fetchMock as never });

    const fresh = plugin.resolveFresh(FED);
    await Promise.resolve();
    const plain = plugin.before!(ctx());
    await Promise.resolve();
    expect(tomlCalls()).toBe(1);

    release();
    await fresh;
    await plain;
  });

  it('bypasses a warm cache, and clears its in-flight entry afterwards', async () => {
    const { fetchMock, release, tomlCalls } = gatedFetch();
    release(); // never block in this test
    const plugin = createFederationPlugin({ fetch: fetchMock as never });

    await plugin.before!(ctx()); // warms the cache
    expect(tomlCalls()).toBe(1);

    await plugin.resolveFresh(FED);
    expect(tomlCalls()).toBe(2);
    await plugin.resolveFresh(FED); // no stale in-flight entry left behind
    expect(tomlCalls()).toBe(3);
  });
});

// ── #957 ────────────────────────────────────────────────────────────────────

describe('#957 bigIntScalarConfig rejects non-integer numbers', () => {
  const nonIntegers = [1.5, -0.25, 0.1, NaN, Infinity, -Infinity];

  it.each(nonIntegers)('serialize(%s) throws a TypeError, not a RangeError', (value) => {
    expect(() => bigIntScalarConfig.serialize(value)).toThrow(TypeError);
    expect(() => bigIntScalarConfig.serialize(value)).toThrow(/non-integer number/);
    try {
      bigIntScalarConfig.serialize(value);
    } catch (err) {
      expect(err).not.toBeInstanceOf(RangeError);
    }
  });

  it.each(nonIntegers)('parseValue(%s) throws a TypeError, not a RangeError', (value) => {
    expect(() => bigIntScalarConfig.parseValue(value)).toThrow(TypeError);
    expect(() => bigIntScalarConfig.parseValue(value)).toThrow(/non-integer number/);
    try {
      bigIntScalarConfig.parseValue(value);
    } catch (err) {
      expect(err).not.toBeInstanceOf(RangeError);
    }
  });

  it('names the offending value in the message', () => {
    expect(() => bigIntScalarConfig.serialize(1.5)).toThrow(/1\.5/);
    expect(() => bigIntScalarConfig.parseValue(1.5)).toThrow(/1\.5/);
  });

  it('still accepts integer numbers, bigints and integer strings', () => {
    expect(bigIntScalarConfig.serialize(42)).toBe('42');
    expect(bigIntScalarConfig.serialize(-7)).toBe('-7');
    expect(bigIntScalarConfig.serialize(0)).toBe('0');
    expect(bigIntScalarConfig.serialize(10n)).toBe('10');
    expect(bigIntScalarConfig.serialize('123')).toBe('123');
    expect(bigIntScalarConfig.parseValue(42)).toBe(42n);
    expect(bigIntScalarConfig.parseValue('123')).toBe(123n);
    expect(bigIntScalarConfig.parseValue(10n)).toBe(10n);
  });

  it('keeps the existing TypeError for unsupported types', () => {
    expect(() => bigIntScalarConfig.serialize({})).toThrow(/type object/);
    expect(() => bigIntScalarConfig.parseValue(true)).toThrow(/type boolean/);
  });
});
