/**
 * Tests for combined filters (status, token/asset code, date range) on the
 * stream query methods: getStreamsBySender, getStreamsByRecipient, and
 * getStreamsByNamespace. Callers should be able to narrow results on the
 * client without fetching every stream and filtering themselves.
 */
import { describe, it, expect, vi } from 'vitest';
import { MockSoroStreamClient } from '../src/mock.js';
import { SoroStreamClient } from '../src/SoroStreamClient.js';
import type { Stream } from '../src/types.js';

const SENDER = 'GMOCK_SENDER';
const RECIPIENT_A = 'GAAAA1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHI';
const RECIPIENT_B = 'GBBBB1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHI';
const TOKEN_A = 'CTOKENAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TOKEN_B = 'CTOKENBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

// Fixed epoch (Unix seconds) so date-range assertions are deterministic.
const T0 = 1_700_000_000;

function makeStream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: '1',
    sender: SENDER,
    recipient: RECIPIENT_A,
    token: TOKEN_A,
    deposit: 1_000_000n,
    flowRate: 1_000n,
    startTime: T0,
    endTime: T0 + 3600,
    lastWithdrawTime: T0,
    status: 'Active',
    autoRenew: false,
    ...overrides,
  };
}

describe('combined filters on getStreamsBySender', () => {
  it('filters by status + token + date range together', async () => {
    const mock = new MockSoroStreamClient(SENDER);
    mock.seedStream(
      makeStream({
        id: '1',
        recipient: RECIPIENT_A,
        token: TOKEN_A,
        status: 'Active',
        startTime: T0,
      }),
    );
    mock.seedStream(
      makeStream({
        id: '2',
        recipient: RECIPIENT_B,
        token: TOKEN_A,
        status: 'Active',
        startTime: T0,
      }),
    );
    mock.seedStream(
      makeStream({
        id: '3',
        recipient: RECIPIENT_A,
        token: TOKEN_B,
        status: 'Active',
        startTime: T0,
      }),
    );
    mock.seedStream(
      makeStream({
        id: '4',
        recipient: RECIPIENT_A,
        token: TOKEN_A,
        status: 'Cancelled',
        startTime: T0,
      }),
    );
    mock.seedStream(
      makeStream({
        id: '5',
        recipient: RECIPIENT_A,
        token: TOKEN_A,
        status: 'Active',
        startTime: T0 + 10_000,
      }),
    );

    const result = (await mock.getStreamsBySender(SENDER, undefined, {
      status: 'Active',
      token: TOKEN_A,
      startTimeFrom: T0 - 1,
      startTimeTo: T0 + 1,
    })) as Stream[];

    expect(result.map((s) => s.id)).toEqual(['1', '2']);
  });

  it('returns all streams when filter is omitted (backward compatible)', async () => {
    const mock = new MockSoroStreamClient(SENDER);
    mock.seedStream(makeStream({ id: '1', status: 'Active' }));
    mock.seedStream(makeStream({ id: '2', status: 'Cancelled' }));

    const result = (await mock.getStreamsBySender(SENDER)) as Stream[];
    expect(result.map((s) => s.id)).toEqual(['1', '2']);
  });

  it('returns empty array when nothing matches the combined filter', async () => {
    const mock = new MockSoroStreamClient(SENDER);
    mock.seedStream(makeStream({ id: '1', token: TOKEN_A, status: 'Active', startTime: T0 }));

    const result = (await mock.getStreamsBySender(SENDER, undefined, {
      status: 'Active',
      token: TOKEN_B,
      startTimeFrom: T0,
    })) as Stream[];
    expect(result).toEqual([]);
  });
});

describe('combined filters on getStreamsByRecipient', () => {
  it('filters by status + token + end-time window', async () => {
    const mock = new MockSoroStreamClient(SENDER);
    mock.seedStream(
      makeStream({
        id: '1',
        recipient: RECIPIENT_A,
        token: TOKEN_A,
        status: 'Active',
        endTime: T0 + 1000,
      }),
    );
    mock.seedStream(
      makeStream({
        id: '2',
        recipient: RECIPIENT_A,
        token: TOKEN_A,
        status: 'Completed',
        endTime: T0 + 1000,
      }),
    );
    mock.seedStream(
      makeStream({
        id: '3',
        recipient: RECIPIENT_A,
        token: TOKEN_B,
        status: 'Active',
        endTime: T0 + 1000,
      }),
    );
    mock.seedStream(
      makeStream({
        id: '4',
        recipient: RECIPIENT_A,
        token: TOKEN_A,
        status: 'Active',
        endTime: T0 + 10_000,
      }),
    );

    const result = (await mock.getStreamsByRecipient(RECIPIENT_A, undefined, {
      status: 'Active',
      token: TOKEN_A,
      endTimeFrom: T0,
      endTimeTo: T0 + 5000,
    })) as Stream[];

    expect(result.map((s) => s.id)).toEqual(['1']);
  });
});

describe('combined filters on getStreamsByNamespace', () => {
  function makeClient() {
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: 'CAVTXNC2WCHINDNP4VBLSOQA2667VE3RPQZNGD5TFI4U2QSHTVAC667T',
      skipPeerCheck: true,
    });
    const registry = (client as any).namespaceRegistry as Map<string, string>;
    registry.set('1', 'tenant-abc');
    registry.set('2', 'tenant-abc');
    registry.set('3', 'tenant-abc');
    vi.spyOn(client, 'getStream').mockImplementation(async (id: string) => {
      const byId: Record<string, Stream> = {
        '1': makeStream({ id: '1', token: TOKEN_A, status: 'Active', startTime: T0 }),
        '2': makeStream({ id: '2', token: TOKEN_A, status: 'Cancelled', startTime: T0 }),
        '3': makeStream({ id: '3', token: TOKEN_A, status: 'Active', startTime: T0 + 10_000 }),
      };
      return byId[id]!;
    });
    return client;
  }

  it('applies combined filter after fetching namespace streams', async () => {
    const client = makeClient();
    const result = await client.getStreamsByNamespace('tenant-abc', {
      status: 'Active',
      token: TOKEN_A,
      startTimeFrom: T0 - 1,
      startTimeTo: T0 + 1,
    });
    expect(result.map((s) => s.id)).toEqual(['1']);
  });

  it('returns all namespace streams when no filter is given', async () => {
    const client = makeClient();
    const result = await client.getStreamsByNamespace('tenant-abc');
    expect(result.map((s) => s.id)).toEqual(['1', '2', '3']);
  });
});
