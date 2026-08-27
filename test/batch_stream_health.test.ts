import { describe, it, expect } from 'vitest';
import { batchGetStreamHealth } from '../src/utils.js';
import type { Stream } from '../src/types.js';

// ---------------------------------------------------------------------------
// batchGetStreamHealth (issue #397)
// ---------------------------------------------------------------------------

const BASE_TIME = 1_700_000_000;

function makeStream(id: string, overrides: Partial<Stream> = {}): Stream {
  return {
    id,
    sender: 'GSENDER',
    recipient: 'GRECIPIENT',
    token: 'GTOKEN',
    deposit: 10_000_000n,
    flowRate: 100n,
    startTime: BASE_TIME - 3600,
    endTime: BASE_TIME + 3600,
    lastWithdrawTime: BASE_TIME - 60,
    status: 'Active',
    autoRenew: false,
    ...overrides,
  };
}

describe('batchGetStreamHealth (issue #397)', () => {
  it('returns an entry for each input stream', () => {
    const streams = [makeStream('s1'), makeStream('s2'), makeStream('s3')];
    const result = batchGetStreamHealth(streams, BASE_TIME);

    expect(result.entries).toHaveLength(3);
    expect(result.entries.map((e) => e.streamId)).toEqual(['s1', 's2', 's3']);
  });

  it('summary.total equals the number of input streams', () => {
    const streams = [makeStream('s1'), makeStream('s2')];
    const result = batchGetStreamHealth(streams, BASE_TIME);

    expect(result.summary.total).toBe(2);
  });

  it('summary counts sum to total', () => {
    const streams = [
      makeStream('s1'),
      makeStream('s2', { status: 'Cancelled' }),
      makeStream('s3', { status: 'Completed' }),
    ];
    const result = batchGetStreamHealth(streams, BASE_TIME);
    const { healthy, warning, critical, completed, cancelled } = result.summary;
    expect(healthy + warning + critical + completed + cancelled).toBe(result.summary.total);
  });

  it('correctly counts healthy streams', () => {
    const streams = [makeStream('s1'), makeStream('s2')];
    const result = batchGetStreamHealth(streams, BASE_TIME);

    expect(result.summary.healthy).toBe(2);
    expect(result.summary.critical).toBe(0);
  });

  it('correctly counts cancelled and completed streams', () => {
    const streams = [
      makeStream('s1', { status: 'Cancelled' }),
      makeStream('s2', { status: 'Completed' }),
    ];
    const result = batchGetStreamHealth(streams, BASE_TIME);

    expect(result.summary.cancelled).toBe(1);
    expect(result.summary.completed).toBe(1);
    expect(result.summary.healthy).toBe(0);
  });

  it('correctly counts critical streams (underfunded)', () => {
    const streams = [
      makeStream('s1'),
      makeStream('s2', { deposit: 1n, lastWithdrawTime: BASE_TIME - 100_000 }),
    ];
    const result = batchGetStreamHealth(streams, BASE_TIME);

    expect(result.summary.critical).toBeGreaterThanOrEqual(1);
  });

  it('returns empty entries and zero summary for empty input', () => {
    const result = batchGetStreamHealth([], BASE_TIME);

    expect(result.entries).toHaveLength(0);
    expect(result.summary.total).toBe(0);
    expect(result.summary.healthy).toBe(0);
  });

  it('preserves input order in entries', () => {
    const ids = ['z', 'a', 'm', 'b'];
    const streams = ids.map((id) => makeStream(id));
    const result = batchGetStreamHealth(streams, BASE_TIME);

    expect(result.entries.map((e) => e.streamId)).toEqual(ids);
  });

  it('each entry contains a valid health result', () => {
    const streams = [makeStream('s1')];
    const result = batchGetStreamHealth(streams, BASE_TIME);
    const entry = result.entries[0]!;

    expect(entry.health.score).toBeGreaterThanOrEqual(0);
    expect(entry.health.score).toBeLessThanOrEqual(100);
    expect(['healthy', 'warning', 'critical', 'completed', 'cancelled']).toContain(
      entry.health.status,
    );
  });
});
