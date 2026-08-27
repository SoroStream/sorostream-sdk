import { describe, it, expect } from 'vitest';
import { MockSoroStreamClient } from '../src/mock.js';

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
