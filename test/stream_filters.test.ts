/**
 * Tests for issue #204: filterStreams / sortStreams helpers.
 *
 * - Filtering by each field returns only matching streams.
 * - Multiple filters are ANDed together.
 * - activeOnly excludes expired and cancelled streams.
 * - sortStreams orders correctly by each supported field.
 * - Edge cases: empty input, no matches.
 */
import { describe, it, expect } from 'vitest';
import { filterStreams, sortStreams } from '../src/utils.js';
import type { Stream } from '../src/types.js';

const SENDER_A = 'GAAAA1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHI';
const SENDER_B = 'GBBBB1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHI';
const RECIPIENT_A = 'GCCCC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHI';
const RECIPIENT_B = 'GDDDD1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHI';
const TOKEN_A = 'CTOKENAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TOKEN_B = 'CTOKENBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const NOW = Math.floor(Date.now() / 1000);

function makeStream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: '1',
    sender: SENDER_A,
    recipient: RECIPIENT_A,
    token: TOKEN_A,
    deposit: 1_000_000n,
    flowRate: 1_000n,
    startTime: NOW - 3600,
    endTime: NOW + 3600,
    lastWithdrawTime: NOW - 3600,
    status: 'Active',
    autoRenew: false,
    ...overrides,
  };
}

describe('#204 filterStreams', () => {
  const streams: Stream[] = [
    makeStream({
      id: '1',
      sender: SENDER_A,
      recipient: RECIPIENT_A,
      token: TOKEN_A,
      status: 'Active',
    }),
    makeStream({
      id: '2',
      sender: SENDER_B,
      recipient: RECIPIENT_A,
      token: TOKEN_A,
      status: 'Cancelled',
    }),
    makeStream({
      id: '3',
      sender: SENDER_A,
      recipient: RECIPIENT_B,
      token: TOKEN_B,
      status: 'Completed',
    }),
    makeStream({
      id: '4',
      sender: SENDER_A,
      recipient: RECIPIENT_A,
      token: TOKEN_B,
      status: 'Paused',
    }),
    makeStream({
      id: '5',
      sender: SENDER_A,
      recipient: RECIPIENT_A,
      token: TOKEN_A,
      status: 'Active',
      endTime: NOW - 10, // expired but still flagged "Active" on-chain
    }),
  ];

  it('filters by status', () => {
    const result = filterStreams(streams, { status: 'Cancelled' });
    expect(result.map((s) => s.id)).toEqual(['2']);
  });

  it('filters by sender', () => {
    const result = filterStreams(streams, { sender: SENDER_B });
    expect(result.map((s) => s.id)).toEqual(['2']);
  });

  it('filters by recipient', () => {
    const result = filterStreams(streams, { recipient: RECIPIENT_B });
    expect(result.map((s) => s.id)).toEqual(['3']);
  });

  it('filters by token', () => {
    const result = filterStreams(streams, { token: TOKEN_B });
    expect(result.map((s) => s.id)).toEqual(['3', '4']);
  });

  it('ANDs multiple filters together', () => {
    const result = filterStreams(streams, { sender: SENDER_A, token: TOKEN_A, status: 'Active' });
    expect(result.map((s) => s.id)).toEqual(['1', '5']);
  });

  it('activeOnly excludes cancelled, completed, and paused streams', () => {
    const result = filterStreams(streams, { activeOnly: true });
    expect(result.map((s) => s.id)).not.toContain('2'); // cancelled
    expect(result.map((s) => s.id)).not.toContain('3'); // completed
    expect(result.map((s) => s.id)).not.toContain('4'); // paused
  });

  it('activeOnly excludes streams past their endTime even when status is still Active', () => {
    const result = filterStreams(streams, { activeOnly: true });
    expect(result.map((s) => s.id)).not.toContain('5'); // expired
    expect(result.map((s) => s.id)).toContain('1'); // genuinely active
  });

  it('returns an empty array for empty input', () => {
    expect(filterStreams([], { status: 'Active' })).toEqual([]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(
      filterStreams(streams, { sender: 'GNOBODY0000000000000000000000000000000000000000000000' }),
    ).toEqual([]);
  });

  it('returns all streams when no filters are given', () => {
    expect(filterStreams(streams, {})).toHaveLength(streams.length);
  });
});

describe('#date-range filterStreams', () => {
  const T0 = 1_700_000_000; // fixed epoch (Unix seconds)
  const streams: Stream[] = [
    makeStream({ id: 'a', startTime: T0, endTime: T0 + 1000 }),
    makeStream({ id: 'b', startTime: T0 + 2000, endTime: T0 + 3000 }),
    makeStream({ id: 'c', startTime: T0 + 4000, endTime: T0 + 5000 }),
  ];

  it('filters by startTimeFrom (inclusive lower bound)', () => {
    const result = filterStreams(streams, { startTimeFrom: T0 + 2000 });
    expect(result.map((s) => s.id)).toEqual(['b', 'c']);
  });

  it('filters by startTimeTo (inclusive upper bound)', () => {
    const result = filterStreams(streams, { startTimeTo: T0 + 2000 });
    expect(result.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('filters by start time window', () => {
    const result = filterStreams(streams, { startTimeFrom: T0 + 1000, startTimeTo: T0 + 4000 });
    expect(result.map((s) => s.id)).toEqual(['b', 'c']);
  });

  it('filters by endTimeFrom (inclusive lower bound)', () => {
    const result = filterStreams(streams, { endTimeFrom: T0 + 3000 });
    expect(result.map((s) => s.id)).toEqual(['b', 'c']);
  });

  it('filters by endTimeTo (inclusive upper bound)', () => {
    const result = filterStreams(streams, { endTimeTo: T0 + 3000 });
    expect(result.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('filters by end time window', () => {
    const result = filterStreams(streams, { endTimeFrom: T0 + 1000, endTimeTo: T0 + 4000 });
    expect(result.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('combines date range with status and token', () => {
    const combined: Stream[] = [
      makeStream({ id: 'a', token: TOKEN_A, status: 'Active', startTime: T0 }),
      makeStream({ id: 'b', token: TOKEN_B, status: 'Active', startTime: T0 }),
      makeStream({ id: 'c', token: TOKEN_A, status: 'Cancelled', startTime: T0 }),
      makeStream({ id: 'd', token: TOKEN_A, status: 'Active', startTime: T0 + 5000 }),
    ];
    const result = filterStreams(combined, {
      status: 'Active',
      token: TOKEN_A,
      startTimeFrom: T0 - 1,
      startTimeTo: T0 + 1,
    });
    expect(result.map((s) => s.id)).toEqual(['a']);
  });
});

describe('#204 sortStreams', () => {
  const streams: Stream[] = [
    makeStream({ id: 'a', startTime: 300, endTime: 900, deposit: 30n }),
    makeStream({ id: 'b', startTime: 100, endTime: 700, deposit: 10n }),
    makeStream({ id: 'c', startTime: 200, endTime: 800, deposit: 20n }),
  ];

  it('sorts by startTime ascending by default', () => {
    expect(sortStreams(streams, 'startTime').map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  it('sorts by startTime descending', () => {
    expect(sortStreams(streams, 'startTime', 'desc').map((s) => s.id)).toEqual(['a', 'c', 'b']);
  });

  it('sorts by endTime ascending', () => {
    expect(sortStreams(streams, 'endTime', 'asc').map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  it('sorts by amount (deposit) ascending', () => {
    expect(sortStreams(streams, 'amount', 'asc').map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  it('sorts by amount (deposit) descending', () => {
    expect(sortStreams(streams, 'amount', 'desc').map((s) => s.id)).toEqual(['a', 'c', 'b']);
  });

  it('does not mutate the input array', () => {
    const original = [...streams];
    sortStreams(streams, 'amount', 'desc');
    expect(streams).toEqual(original);
  });

  it('returns an empty array for empty input', () => {
    expect(sortStreams([], 'startTime')).toEqual([]);
  });

  it('handles large bigint deposits correctly (no precision loss)', () => {
    const bigStreams: Stream[] = [
      makeStream({ id: 'huge', deposit: 9_000_000_000_000_000_000n }),
      makeStream({ id: 'small', deposit: 1_000_000n }),
    ];
    expect(sortStreams(bigStreams, 'amount', 'asc').map((s) => s.id)).toEqual(['small', 'huge']);
  });
});
