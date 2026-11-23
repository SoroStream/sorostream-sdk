import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPooledRpcTransport } from '../src/transport.js';
import { ConnectionPool } from '../src/connectionPool.js';
import { SoroStreamClient } from '../src/SoroStreamClient.js';

describe('Issue #435: RPC connection pooling for improved throughput', () => {
  const rpcUrl = 'https://soroban-testnet.stellar.org';

  it('instantiates pooled transport with default and custom pool sizes', () => {
    const defaultTransport = createPooledRpcTransport(rpcUrl);
    expect(defaultTransport).toBeDefined();
    expect(defaultTransport.getPoolStats().poolSize).toBe(4);

    const customTransport = createPooledRpcTransport(rpcUrl, { poolSize: 8 });
    expect(customTransport.getPoolStats().poolSize).toBe(8);
  });

  it('exposes all RpcTransportAdapter methods', () => {
    const transport = createPooledRpcTransport(rpcUrl, { poolSize: 2 });
    expect(typeof transport.getAccount).toBe('function');
    expect(typeof transport.getHealth).toBe('function');
    expect(typeof transport.getLatestLedger).toBe('function');
    expect(typeof transport.getTransaction).toBe('function');
    expect(typeof transport.simulateTransaction).toBe('function');
    expect(typeof transport.prepareTransaction).toBe('function');
    expect(typeof transport.sendTransaction).toBe('function');
    expect(typeof transport.getEvents).toBe('function');
    expect(transport.serverURL).toBeDefined();
    expect(transport.serverURL?.toString()).toContain('soroban-testnet.stellar.org');
  });

  it('re-initializes pool on init hook when rpcUrl changes', async () => {
    const transport = createPooledRpcTransport(rpcUrl, { poolSize: 3 });
    const newUrl = 'https://soroban-mainnet.stellar.org';
    await transport.init?.({ network: 'mainnet', rpcUrl: newUrl });
    expect(transport.serverURL?.toString()).toContain('soroban-mainnet.stellar.org');
  });

  it('cleans up resources on teardown', async () => {
    const transport = createPooledRpcTransport(rpcUrl, { poolSize: 3 });
    await transport.teardown?.();
    expect(transport.getPoolStats().poolSize).toBe(0);
    expect(transport.getPoolStats().activeRequests).toBe(0);
  });

  it('tracks active, total, and reused requests in pool stats', async () => {
    const transport = createPooledRpcTransport(rpcUrl, { poolSize: 2 });
    expect(transport.getPoolStats()).toEqual({
      poolSize: 2,
      activeRequests: 0,
      totalRequests: 0,
      reusedConnections: 0,
    });
  });

  it('ConnectionPool allows acquiring RPC servers for request execution', async () => {
    const pool = new ConnectionPool({
      poolSize: 3,
      rpcUrl,
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
    });

    const { server, release } = await pool.acquireServer();
    expect(server).toBeDefined();
    expect(pool.getStats().active).toBe(1);

    release();
    expect(pool.getStats().active).toBe(0);

    pool.destroy();
  });

  it('SoroStreamClient initializes with useConnectionPooling option', () => {
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
      useConnectionPooling: true,
      poolSize: 5,
    });

    expect(client).toBeDefined();
    const stats = client.getConnectionStats();
    expect(stats.maxConnections).toBeDefined();
  });
});

describe('Issue #539: atomic acquire with maxConnections', () => {
  const rpcUrl = 'https://soroban-testnet.stellar.org';
  const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

  it('resolves only maxConnections calls immediately and queues the excess waiters', async () => {
    const pool = new ConnectionPool({ poolSize: 5, maxConnections: 5, rpcUrl, contractId });

    const held: Array<{ release: () => void }> = [];
    const order: number[] = [];
    const acquires = Array.from({ length: 10 }, (_, i) =>
      pool.acquire().then((h) => {
        order.push(i);
        held.push(h);
      }),
    );

    // Flush microtasks — only maxConnections (5) resolve; the rest queue.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([0, 1, 2, 3, 4]);
    expect(held).toHaveLength(5);

    // Releasing a held connection hands the slot to the next queued waiter.
    for (const h of held) h.release();

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(held).toHaveLength(10);

    pool.destroy();
  });

  it('never exceeds maxConnections under 10 concurrent acquire calls', async () => {
    const pool = new ConnectionPool({ poolSize: 5, maxConnections: 5, rpcUrl, contractId });

    let held = 0;
    let maxHeld = 0;
    const releases: Array<() => void> = [];
    Array.from({ length: 10 }, () =>
      pool.acquire().then((h) => {
        held++;
        maxHeld = Math.max(maxHeld, held);
        releases.push(() => {
          held--;
          h.release();
        });
        return h;
      }),
    );

    // Only 5 of the 10 concurrent calls may hold a connection.
    await Promise.resolve();
    await Promise.resolve();
    expect(held).toBe(5);
    expect(maxHeld).toBe(5);
    expect(releases).toHaveLength(5);

    // The queued waiters are granted one-at-a-time as holders release; the
    // concurrent window must never exceed maxConnections.
    for (const release of releases) release();
    await Promise.resolve();
    await Promise.resolve();
    expect(held).toBe(5);
    expect(maxHeld).toBe(5);
    expect(releases).toHaveLength(10);

    for (const release of releases) release();
    pool.destroy();
  });

  it('waits (queues) instead of throwing when the pool is at maxConnections', async () => {
    const pool = new ConnectionPool({ poolSize: 1, maxConnections: 1, rpcUrl, contractId });

    const first = await pool.acquire();
    let secondResolved = false;
    const second = pool.acquire().then((h) => {
      secondResolved = true;
      return h;
    });

    await Promise.resolve();
    expect(secondResolved).toBe(false);

    first.release();
    await second;
    expect(secondResolved).toBe(true);

    pool.destroy();
  });

  it('grants excess waiters in FIFO order on release', async () => {
    const pool = new ConnectionPool({ poolSize: 2, maxConnections: 2, rpcUrl, contractId });

    const order: number[] = [];
    const held: Array<{ release: () => void }> = [];
    Array.from({ length: 5 }, (_, i) =>
      pool.acquire().then((h) => {
        order.push(i);
        held.push(h);
      }),
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([0, 1]);
    expect(held).toHaveLength(2);

    // Release both initial holders one at a time; waiters resolve 2, then 3, …
    held[0]!.release();
    held[1]!.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([0, 1, 2, 3]);

    // Free both again and watch the remaining waiter (4) resolve last.
    held[2]!.release();
    held[3]!.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([0, 1, 2, 3, 4]);

    pool.destroy();
  });

  it('defaults maxConnections to poolSize', () => {
    const pool = new ConnectionPool({ poolSize: 7, rpcUrl, contractId });
    expect(pool.maxConnections).toBe(7);
    pool.destroy();
  });
});

describe('Issue #435: acquireServer enforces maxConnections', () => {
  const rpcUrl = 'https://soroban-testnet.stellar.org';
  const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

  it('resolves only maxConnections acquireServer calls immediately and queues the rest', async () => {
    const pool = new ConnectionPool({ poolSize: 3, maxConnections: 3, rpcUrl, contractId });

    const held: Array<{ release: () => void }> = [];
    const order: number[] = [];
    const acquires = Array.from({ length: 6 }, (_, i) =>
      pool.acquireServer().then((h) => {
        order.push(i);
        held.push(h);
      }),
    );

    await Promise.resolve();
    await Promise.resolve();
    // Only maxConnections (3) resolve immediately.
    expect(order).toEqual([0, 1, 2]);
    expect(held).toHaveLength(3);

    for (const h of held) h.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([0, 1, 2, 3, 4, 5]);

    pool.destroy();
  });

  it('never exceeds maxConnections under concurrent acquireServer calls', async () => {
    const pool = new ConnectionPool({ poolSize: 2, maxConnections: 2, rpcUrl, contractId });

    let held = 0;
    let maxHeld = 0;
    const releases: Array<() => void> = [];

    Array.from({ length: 6 }, () =>
      pool.acquireServer().then((h) => {
        held++;
        maxHeld = Math.max(maxHeld, held);
        releases.push(() => {
          held--;
          h.release();
        });
      }),
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(held).toBe(2);
    expect(maxHeld).toBe(2);

    for (const release of releases) release();
    await Promise.resolve();
    await Promise.resolve();
    expect(maxHeld).toBe(2);

    pool.destroy();
  });

  it('queues instead of over-allocating when at maxConnections', async () => {
    const pool = new ConnectionPool({ poolSize: 1, maxConnections: 1, rpcUrl, contractId });

    const first = await pool.acquireServer();
    let secondResolved = false;
    const second = pool.acquireServer().then((h) => {
      secondResolved = true;
      return h;
    });

    await Promise.resolve();
    expect(secondResolved).toBe(false);

    first.release();
    await second;
    expect(secondResolved).toBe(true);

    pool.destroy();
  });

  it('grants queued acquireServer waiters in FIFO order on release', async () => {
    const pool = new ConnectionPool({ poolSize: 2, maxConnections: 2, rpcUrl, contractId });

    const order: number[] = [];
    const held: Array<{ release: () => void }> = [];
    Array.from({ length: 5 }, (_, i) =>
      pool.acquireServer().then((h) => {
        order.push(i);
        held.push(h);
      }),
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([0, 1]);

    held[0]!.release();
    held[1]!.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([0, 1, 2, 3]);

    held[2]!.release();
    held[3]!.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([0, 1, 2, 3, 4]);

    pool.destroy();
  });

  it('acquireServer and acquire share the same activeConnections counter', async () => {
    const pool = new ConnectionPool({ poolSize: 2, maxConnections: 2, rpcUrl, contractId });

    // Fill both slots via acquireServer.
    const s1 = await pool.acquireServer();
    const s2 = await pool.acquireServer();

    // acquire() must now queue — both slots taken by acquireServer callers.
    let acquireResolved = false;
    const queued = pool.acquire().then((h) => {
      acquireResolved = true;
      return h;
    });

    await Promise.resolve();
    expect(acquireResolved).toBe(false);

    s1.release();
    await queued;
    expect(acquireResolved).toBe(true);

    s2.release();
    pool.destroy();
  });

  it('aborts a queued acquireServer caller when the signal fires', async () => {
    const pool = new ConnectionPool({ poolSize: 1, maxConnections: 1, rpcUrl, contractId });

    const first = await pool.acquireServer();
    const ac = new AbortController();
    const queued = pool.acquireServer({ signal: ac.signal });

    ac.abort();
    await expect(queued).rejects.toThrow(/aborted/);

    first.release();
    pool.destroy();
  });
});
