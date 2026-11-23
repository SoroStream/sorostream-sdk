/**
 * Issues #986, #988, #989 and #991 — regression tests for existing behaviour.
 *
 * - #986: cachedScValBase64's type-prefixed key never collides across ScValTypes
 *         whose values stringify identically.
 * - #988: ConnectionPool.acquire removes a waiter whose AbortSignal fires
 *         mid-queue without disturbing the grant order of the other waiters.
 * - #989: compareTabMessages' three-level tie-break (ts, then seq, then origin).
 * - #991: OfflineWriteQueue keeps strict FIFO order within a priority across a
 *         long run of enqueues interleaved with (partial) drains.
 */
import { describe, it, expect } from 'vitest';
import { nativeToScVal } from '@stellar/stellar-sdk';
import { cachedScValBase64 } from '../src/scValCache.js';
import { ConnectionPool } from '../src/connectionPool.js';
import { compareTabMessages } from '../src/crossTabSync.js';
import { OfflineWriteQueue, DEFAULT_QUEUE_OPTIONS } from '../src/offlineQueue.js';
import { InMemoryEventBus } from '../src/eventBus.js';

// ── #986: cachedScValBase64 key collisions ──────────────────────────────────

describe('#986 cachedScValBase64 type-prefixed cache key', () => {
  type ScValType = Parameters<typeof cachedScValBase64>[1];
  const expected = (value: unknown, type: ScValType) =>
    nativeToScVal(value, { type }).toXDR('base64');

  // Each group holds values that `String()` renders identically but that are
  // different ScVals depending on the type. The values are unique to this file
  // because the module-level cache lives for the whole test process.
  const groups: Array<{ label: string; entries: Array<[unknown, ScValType]> }> = [
    {
      label: 'the same number as u32, u64 and i128',
      entries: [
        [986_001, 'u32'],
        [986_001, 'u64'],
        [986_001, 'i128'],
      ],
    },
    {
      label: 'the same text as symbol and string',
      entries: [
        ['collide_986', 'symbol'],
        ['collide_986', 'string'],
      ],
    },
    {
      label: 'the text "true" as bool, symbol and string',
      entries: [
        [true, 'bool'],
        ['true', 'symbol'],
        ['true', 'string'],
      ],
    },
  ];

  it.each(groups)('keeps $label apart (precondition: their encodings differ)', ({ entries }) => {
    const encodings = entries.map(([value, type]) => expected(value, type));
    expect(new Set(encodings).size).toBe(entries.length);
  });

  it.each(groups)('returns each type its own encoding for $label', ({ entries }) => {
    for (const [value, type] of entries) {
      expect(cachedScValBase64(value, type)).toBe(expected(value, type));
    }
  });

  it.each(groups)('is order-independent for $label', ({ entries }) => {
    // Warm the cache in forward order, then read it back in reverse; a shared
    // key would hand every type the encoding of whichever was cached first.
    for (const [value, type] of entries) cachedScValBase64(value, type);
    for (const [value, type] of [...entries].reverse()) {
      expect(cachedScValBase64(value, type)).toBe(expected(value, type));
    }
  });

  it('serves a repeated lookup of the SAME type and value from the cache', () => {
    const first = cachedScValBase64('same_986', 'symbol');
    const second = cachedScValBase64('same_986', 'symbol');
    expect(second).toBe(first);
  });

  it('shares an entry only when type and String(value) are both equal (number vs bigint)', () => {
    // `String(5n) === String(5)`, and the same type encodes both identically, so
    // sharing the entry here is correct — unlike sharing across types.
    expect(cachedScValBase64(986_005n, 'u64')).toBe(cachedScValBase64(986_005, 'u64'));
    expect(cachedScValBase64(986_005n, 'u64')).not.toBe(cachedScValBase64(986_005, 'u32'));
  });
});

// ── #988: ConnectionPool.acquire waiter removal on abort ────────────────────

describe('#988 ConnectionPool.acquire — aborting a queued waiter', () => {
  const RPC_URL = 'https://soroban-testnet.stellar.org';
  const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  type Handle = { release: () => void };
  type Priority = 'high' | 'normal' | 'low';

  /**
   * Queues one waiter per entry behind a held connection, optionally aborts the
   * labelled ones, then releases the held connection and keeps releasing each
   * newly granted handle so the grant order is exactly the pool's decision.
   */
  async function run(waiters: Array<{ label: string; priority?: Priority }>, abort: string[]) {
    const pool = new ConnectionPool({
      poolSize: 1,
      maxConnections: 1,
      rpcUrl: RPC_URL,
      contractId: CONTRACT_ID,
    });
    try {
      const held = await pool.acquire();

      const order: string[] = [];
      const rejected: string[] = [];
      const handles = new Map<string, Handle>();
      const controllers = new Map<string, AbortController>();

      for (const { label, priority } of waiters) {
        const controller = new AbortController();
        controllers.set(label, controller);
        void pool
          .acquire({ signal: controller.signal, priority })
          .then((handle) => {
            order.push(label);
            handles.set(label, handle);
          })
          .catch(() => {
            rejected.push(label);
          });
      }
      await tick();
      expect(order).toEqual([]); // everyone is queued behind `held`

      for (const label of abort) controllers.get(label)!.abort();
      await tick();

      let current: Handle = held;
      for (;;) {
        const before = order.length;
        current.release();
        await tick();
        if (order.length === before) break;
        current = handles.get(order[order.length - 1]!)!;
      }

      return { order, rejected, active: pool.getStats().active };
    } finally {
      pool.destroy();
    }
  }

  it('skips an aborted waiter in the middle and keeps FIFO order for the rest', async () => {
    const result = await run(
      [{ label: 'w1' }, { label: 'w2' }, { label: 'w3' }, { label: 'w4' }],
      ['w2'],
    );
    expect(result.rejected).toEqual(['w2']);
    expect(result.order).toEqual(['w1', 'w3', 'w4']);
  });

  it('keeps priority-then-FIFO order when a mid-queue high-priority waiter aborts', async () => {
    const result = await run(
      [
        { label: 'normal-1', priority: 'normal' },
        { label: 'low-1', priority: 'low' },
        { label: 'high-1', priority: 'high' }, // aborted
        { label: 'normal-2', priority: 'normal' },
        { label: 'high-2', priority: 'high' },
      ],
      ['high-1'],
    );
    expect(result.rejected).toEqual(['high-1']);
    expect(result.order).toEqual(['high-2', 'normal-1', 'normal-2', 'low-1']);
  });

  it('handles aborting the first and the last waiter in the queue', async () => {
    const result = await run(
      [{ label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' }],
      ['a', 'd'],
    );
    expect(result.rejected.sort()).toEqual(['a', 'd']);
    expect(result.order).toEqual(['b', 'c']);
  });

  it('survives several aborts in a row and still grants the survivors in order', async () => {
    const result = await run(
      [
        { label: 'n1', priority: 'normal' },
        { label: 'l1', priority: 'low' },
        { label: 'n2', priority: 'normal' },
        { label: 'h1', priority: 'high' },
        { label: 'n3', priority: 'normal' },
      ],
      ['n2', 'h1'],
    );
    expect(result.rejected.sort()).toEqual(['h1', 'n2']);
    expect(result.order).toEqual(['n1', 'n3', 'l1']);
  });

  it('never grants a connection to an aborted waiter and frees every slot afterwards', async () => {
    const result = await run([{ label: 'x' }, { label: 'y' }], ['x', 'y']);
    expect(result.rejected.sort()).toEqual(['x', 'y']);
    expect(result.order).toEqual([]);
    expect(result.active).toBe(0);
  });

  it('rejects the aborted waiter with an "aborted while waiting" error', async () => {
    const pool = new ConnectionPool({
      poolSize: 1,
      maxConnections: 1,
      rpcUrl: RPC_URL,
      contractId: CONTRACT_ID,
    });
    try {
      const held = await pool.acquire();
      const controller = new AbortController();
      const queued = pool.acquire({ signal: controller.signal });
      controller.abort();
      await expect(queued).rejects.toThrow(/aborted while waiting/);
      held.release();
    } finally {
      pool.destroy();
    }
  });

  it('ignores an abort that fires after the waiter was already granted', async () => {
    const pool = new ConnectionPool({
      poolSize: 1,
      maxConnections: 1,
      rpcUrl: RPC_URL,
      contractId: CONTRACT_ID,
    });
    try {
      const held = await pool.acquire();
      const controller = new AbortController();
      const queued = pool.acquire({ signal: controller.signal });
      const next = pool.acquire(); // a second waiter that must stay queued

      held.release();
      const granted = await queued;

      // Too late to cancel: the grant already happened and removed its listener.
      controller.abort();
      await tick();
      expect(pool.getStats().active).toBe(1);

      let nextGranted = false;
      void next.then(() => {
        nextGranted = true;
      });
      await tick();
      expect(nextGranted).toBe(false); // still waiting for `granted` to release

      granted.release();
      (await next).release();
    } finally {
      pool.destroy();
    }
  });
});

// ── #989: compareTabMessages three-way tie-break ────────────────────────────

describe('#989 compareTabMessages tie-break levels', () => {
  type Key = { ts: number; seq: number; origin: string };
  const key = (ts: number, seq: number, origin: string): Key => ({ ts, seq, origin });

  // Every case makes the LOWER levels point the opposite way from the level that
  // must decide, so a comparator that checked levels in the wrong order (or
  // skipped one) would return the wrong sign.
  const cases: Array<{ name: string; first: Key; second: Key }> = [
    {
      name: 'level 1 (ts) beats seq and origin that both favour the other',
      first: key(1000, 9, 'z-tab'),
      second: key(2000, 0, 'a-tab'),
    },
    {
      name: 'level 2 (seq) decides when ts is equal, even though origin favours the other',
      first: key(5000, 1, 'z-tab'),
      second: key(5000, 2, 'a-tab'),
    },
    {
      name: 'level 3 (origin) decides when ts and seq are both equal',
      first: key(5000, 3, 'tab-a'),
      second: key(5000, 3, 'tab-b'),
    },
  ];

  it.each(cases)('$name', ({ first, second }) => {
    expect(compareTabMessages(first, second)).toBeLessThan(0);
    expect(compareTabMessages(second, first)).toBeGreaterThan(0);
  });

  it('level 3 only runs when level 2 ties: a higher seq wins over a smaller origin', () => {
    const lowSeqLateOrigin = key(5000, 1, 'zzz');
    const highSeqEarlyOrigin = key(5000, 2, 'aaa');
    expect(compareTabMessages(lowSeqLateOrigin, highSeqEarlyOrigin)).toBeLessThan(0);
  });

  it('level 2 only runs when level 1 ties: a later ts wins over a smaller seq', () => {
    const earlyTsHighSeq = key(1000, 99, 'a');
    const lateTsLowSeq = key(1001, 0, 'a');
    expect(compareTabMessages(earlyTsHighSeq, lateTsLowSeq)).toBeLessThan(0);
  });

  it('compares origin lexicographically, not numerically or by length', () => {
    expect(compareTabMessages(key(1, 1, 'tab-10'), key(1, 1, 'tab-9'))).toBeLessThan(0); // "1" < "9"
    expect(compareTabMessages(key(1, 1, 'tab'), key(1, 1, 'tab-a'))).toBeLessThan(0); // prefix first
    expect(compareTabMessages(key(1, 1, 'B'), key(1, 1, 'a'))).toBeLessThan(0); // uppercase < lowercase
  });

  it('returns exactly 0 only when all three levels are equal', () => {
    expect(compareTabMessages(key(7, 7, 'same'), key(7, 7, 'same'))).toBe(0);
    expect(compareTabMessages(key(7, 7, 'same'), key(7, 8, 'same'))).not.toBe(0);
    expect(compareTabMessages(key(7, 7, 'same'), key(8, 7, 'same'))).not.toBe(0);
    expect(compareTabMessages(key(7, 7, 'same'), key(7, 7, 'other'))).not.toBe(0);
  });

  it('is antisymmetric across every pair of a mixed set', () => {
    const all = [
      ...cases.flatMap((c) => [c.first, c.second]),
      key(5000, 3, 'tab-a'),
      key(5000, 2, 'tab-a'),
    ];
    for (const a of all) {
      for (const b of all) {
        // sign(a,b) + sign(b,a) === 0 for every pair (avoids the -0 vs 0 trap of negation).
        expect(Math.sign(compareTabMessages(a, b)) + Math.sign(compareTabMessages(b, a))).toBe(0);
      }
    }
  });

  it('sorts every permutation of a set exercising all three levels to one order', () => {
    const expectedOrder = [
      key(1000, 5, 'z'), // earliest ts
      key(2000, 0, 'z'), // same ts as next two, lowest seq
      key(2000, 1, 'a'), // same ts, seq 1, origin a
      key(2000, 1, 'b'), // same ts and seq, origin b
      key(3000, 0, 'a'), // latest ts
    ];

    const permutations = <T>(items: T[]): T[][] =>
      items.length <= 1
        ? [items]
        : items.flatMap((item, i) =>
            permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [
              item,
              ...rest,
            ]),
          );

    for (const permutation of permutations(expectedOrder)) {
      expect([...permutation].sort(compareTabMessages)).toEqual(expectedOrder);
    }
  });
});

// ── #991: OfflineWriteQueue FIFO across enqueue/drain cycles ────────────────

describe('#991 OfflineWriteQueue strict FIFO across a long run of equal-priority enqueues', () => {
  function makeQueue(maxQueueSize = 1000) {
    const eventBus = new InMemoryEventBus();
    const queue = new OfflineWriteQueue(
      { ...DEFAULT_QUEUE_OPTIONS, enabled: true, storage: null, maxQueueSize },
      eventBus,
    );
    return queue;
  }

  const isStrictlyIncreasing = (values: number[]) =>
    values.every((v, i) => i === 0 || v > values[i - 1]!);

  it('never regresses across many enqueue / partial-drain cycles', async () => {
    const queue = makeQueue();
    const replayed: number[] = [];
    const failOnce = new Set<number>();
    let next = 0;

    const enqueueOne = () => {
      const n = next++;
      queue.enqueue(
        `op-${n}`,
        async () => {
          if (failOnce.delete(n)) throw new Error(`offline while replaying ${n}`);
          replayed.push(n);
          return n;
        },
        3,
      );
    };

    const CYCLES = 25;
    const PER_CYCLE = 8;
    for (let cycle = 0; cycle < CYCLES; cycle++) {
      for (let i = 0; i < PER_CYCLE; i++) enqueueOne();

      // Partial drain: while "offline", the 3rd queued operation fails, is put
      // back at its original position and the drain stops there.
      queue.markOffline();
      const queuedNow = queue.size;
      failOnce.add(replayed.length + 2);
      const event = await queue.drain();
      expect(event.failed).toBe(1);
      expect(queue.size).toBeLessThan(queuedNow);
      expect(queue.size).toBeGreaterThan(0);
    }

    // Back online: everything left, plus a final batch, replays in order.
    for (let i = 0; i < PER_CYCLE; i++) enqueueOne();
    await queue.markOnline();

    expect(queue.isEmpty).toBe(true);
    expect(replayed).toHaveLength(next);
    expect(isStrictlyIncreasing(replayed)).toBe(true);
    expect(replayed).toEqual(Array.from({ length: next }, (_, i) => i));
  });

  it('keeps enqueues made while a drain is running behind everything already queued', async () => {
    const queue = makeQueue();
    const replayed: string[] = [];
    let extra = 0;

    for (let i = 0; i < 10; i++) {
      queue.enqueue(
        `base-${i}`,
        async () => {
          replayed.push(`base-${i}`);
          // Re-entrant enqueue while the queue is draining.
          const label = `late-${extra++}`;
          queue.enqueue(label, async () => void replayed.push(label), 0);
        },
        0,
      );
    }

    await queue.drain();

    expect(queue.isEmpty).toBe(true);
    expect(replayed).toEqual([
      ...Array.from({ length: 10 }, (_, i) => `base-${i}`),
      ...Array.from({ length: 10 }, (_, i) => `late-${i}`),
    ]);
  });

  it('keeps each priority FIFO when two priorities are interleaved with partial drains', async () => {
    const queue = makeQueue();
    const replayed: Array<{ priority: number; n: number }> = [];
    const failOnce = new Set<string>();
    const counters = { 5: 0, 1: 0 } as Record<number, number>;

    const enqueue = (priority: 5 | 1) => {
      const n = counters[priority]!++;
      const id = `${priority}:${n}`;
      queue.enqueue(
        `op-${id}`,
        async () => {
          if (failOnce.delete(id)) throw new Error(`offline ${id}`);
          replayed.push({ priority, n });
        },
        priority,
      );
    };

    for (let cycle = 0; cycle < 12; cycle++) {
      // Mixed arrival order each cycle.
      enqueue(1);
      enqueue(5);
      enqueue(5);
      enqueue(1);
      enqueue(5);

      queue.markOffline();
      failOnce.add(`5:${counters[5]! - 1}`); // fail the last high-priority op once
      await queue.drain();
    }
    await queue.markOnline();

    expect(queue.isEmpty).toBe(true);
    for (const priority of [5, 1]) {
      const seen = replayed.filter((r) => r.priority === priority).map((r) => r.n);
      expect(seen).toEqual(Array.from({ length: counters[priority]! }, (_, i) => i));
    }
  });

  it('keeps FIFO after the queue is cleared and refilled (sequence is never reset)', async () => {
    const queue = makeQueue();
    const replayed: number[] = [];

    const enqueueRound = (round: number) => {
      for (let i = 0; i < 5; i++) {
        const n = round * 5 + i;
        queue.enqueue(`op-${n}`, async () => void replayed.push(n), 2);
      }
    };

    enqueueRound(0);
    await queue.drain(); // replays 0-4
    enqueueRound(1);
    queue.clear(); // drops 5-9 without replaying them
    enqueueRound(2);
    await queue.drain(); // replays 10-14, after a clear, still in order

    expect(replayed).toEqual([0, 1, 2, 3, 4, 10, 11, 12, 13, 14]);
    expect(isStrictlyIncreasing(replayed)).toBe(true);
  });

  it('keeps FIFO order for a queue that grows large before it shrinks', async () => {
    const queue = makeQueue(5000);
    const replayed: number[] = [];
    const TOTAL = 1500;

    for (let n = 0; n < TOTAL; n++) {
      queue.enqueue(`op-${n}`, async () => void replayed.push(n), 0);
    }
    expect(queue.size).toBe(TOTAL);

    await queue.drain();

    expect(replayed).toHaveLength(TOTAL);
    expect(isStrictlyIncreasing(replayed)).toBe(true);
  });
});
