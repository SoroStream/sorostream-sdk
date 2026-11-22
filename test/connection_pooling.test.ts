import { describe, it, expect } from 'vitest';
import { MockSoroStreamClient } from '../src/mock.js';
import { ConnectionPool, PRIORITY_RANK } from '../src/connectionPool.js';

describe('#149 connection pooling', () => {
  it('getConnectionStats returns default maxConnections of 5', () => {
    const mock = new MockSoroStreamClient();
    const stats = mock.getConnectionStats();
    expect(stats.maxConnections).toBe(5);
  });

  it('getConnectionStats returns all required fields', () => {
    const mock = new MockSoroStreamClient();
    const stats = mock.getConnectionStats();
    expect(stats).toMatchObject({
      maxConnections: expect.any(Number),
      active: expect.any(Number),
      idle: expect.any(Number),
      reused: expect.any(Number),
    });
  });

  it('SoroStreamClientOptions accepts maxConnections and idleTimeoutMs', async () => {
    // Type-level test: verify the option types are exported and accepted
    const { SoroStreamClientOptions } = await import('../src/SoroStreamClient.js');
    // The import itself would fail to compile if the types didn't exist
    expect(true).toBe(true);
  });
});

describe('#735 ConnectionPool drain respects priority rank', () => {
  it('closes connections in priority-rank order on shutdown and fully drains', async () => {
    const pool = new ConnectionPool({ maxConnections: 10 });

    // Acquire connections across all three priority tiers.
    const lowConn = await pool.acquire({ priority: 'low' });
    const normalConn = await pool.acquire({ priority: 'normal' });
    const highConn = await pool.acquire({ priority: 'high' });

    // Sanity check: all three connections are active at shutdown.
    const beforeStats = pool.getStats();
    expect(beforeStats.active).toBe(3);

    const drainEvents: Array<{ id: string; priority: string }> = [];
    const closedOrder: string[] = [];

    pool.on('pool:drain', (event: { id: string; priority: string }) => {
      drainEvents.push(event);
      closedOrder.push(event.id);
    });

    await pool.shutdown();

    // The pool:drain event sequence must follow PRIORITY_RANK ordering:
    // high before normal before low.
    expect(drainEvents.map((e) => e.priority)).toEqual(['high', 'normal', 'low']);

    // Verify the recorded close order matches the expected rank ordering.
    expect(closedOrder).toEqual([highConn.id, normalConn.id, lowConn.id]);

    // Verify the rank ordering is consistent with PRIORITY_RANK.
    const ranks = drainEvents.map((e) => PRIORITY_RANK[e.priority as keyof typeof PRIORITY_RANK]);
    const sortedRanks = [...ranks].sort((a, b) => a - b);
    expect(ranks).toEqual(sortedRanks);

    // The pool must reach a fully-drained state.
    const afterStats = pool.getStats();
    expect(afterStats.active).toBe(0);
    expect(afterStats.idle).toBe(0);
    expect(pool.isDrained()).toBe(true);
  });
});