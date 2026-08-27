import { describe, it, expect, vi, afterEach } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';

import { useStream } from '../src/useStream.js';
import { useStreamList } from '../src/useStreamList.js';
import { useWithdraw } from '../src/useWithdraw.js';
import type { StreamReaderLike, WithdrawClientLike } from '../src/types.js';

import { MockSoroStreamClient } from '../../../src/mock.js';
import type { Stream } from '../../../src/types.js';

const RECIPIENT = 'GAXXZ5XSL2VTQPGWB3LPU5273HSJXMK7VHLZTF2XKW65QFZVA3XKULQZ';
const TOKEN = 'CAVTXNC2WCHINDNP4VBLSOQA2667VE3RPQZNGD5TFI4U2QSHTVAC667T';

const flush = async (): Promise<void> => {
  await nextTick();
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
};

function makeStream(id: string, overrides: Partial<Stream> = {}): Stream {
  return {
    id,
    sender: 'GSENDER',
    recipient: RECIPIENT,
    token: TOKEN,
    deposit: 1_000_000n,
    flowRate: 100n,
    startTime: 1_700_000_000,
    endTime: 1_700_010_000,
    lastWithdrawTime: 1_700_000_000,
    status: 'Active',
    autoRenew: false,
    ...overrides,
  } as Stream;
}

async function createMockStream(mock: MockSoroStreamClient): Promise<string> {
  const { streamId } = await mock.createStream({
    recipient: RECIPIENT,
    token: TOKEN,
    amount: 1_000_000n,
    durationSeconds: 3600,
    autoRenew: false,
  });
  return streamId;
}

const scopes: Array<ReturnType<typeof effectScope>> = [];

/** Runs a composable inside a disposable effect scope, like a component would. */
function withScope<T>(fn: () => T): { result: T; dispose: () => void } {
  const scope = effectScope();
  scopes.push(scope);
  const result = scope.run(fn) as T;
  return { result, dispose: () => scope.stop() };
}

afterEach(() => {
  while (scopes.length) scopes.pop()?.stop();
  vi.restoreAllMocks();
});

// ── useStream ────────────────────────────────────────────────────────────────

describe('useStream (#422)', () => {
  it('fetches the stream and exposes loading state', async () => {
    const client: StreamReaderLike = {
      getStream: vi.fn().mockResolvedValue(makeStream('1')),
    };

    const { result } = withScope(() => useStream(client, '1'));
    expect(result.loading.value).toBe(true);
    expect(result.stream.value).toBeNull();

    await flush();

    expect(result.loading.value).toBe(false);
    expect(result.stream.value?.id).toBe('1');
    expect(result.error.value).toBeNull();
    expect(client.getStream).toHaveBeenCalledTimes(1);
  });

  it('stays idle and empty when the client is null', async () => {
    const { result } = withScope(() => useStream(null, '1'));
    await flush();
    expect(result.stream.value).toBeNull();
    expect(result.loading.value).toBe(false);
    expect(result.error.value).toBeNull();
  });

  it('captures errors in the error ref', async () => {
    const client: StreamReaderLike = {
      getStream: vi.fn().mockRejectedValue(new Error('Stream not found: 404')),
    };

    const { result } = withScope(() => useStream(client, '404'));
    await flush();

    expect(result.error.value).toBeInstanceOf(Error);
    expect(result.error.value?.message).toContain('Stream not found');
    expect(result.stream.value).toBeNull();
    expect(result.loading.value).toBe(false);
  });

  it('re-fetches when the reactive stream id changes', async () => {
    const client: StreamReaderLike = {
      getStream: vi.fn(async (id: string) => makeStream(id)),
    };
    const streamId = ref('1');

    const { result } = withScope(() => useStream(client, streamId));
    await flush();
    expect(result.stream.value?.id).toBe('1');

    streamId.value = '2';
    await flush();
    expect(result.stream.value?.id).toBe('2');
    expect(client.getStream).toHaveBeenCalledTimes(2);
  });

  it('subscribes to observeStream for live updates and unsubscribes on scope dispose', async () => {
    let push: ((stream: Stream) => void) | null = null;
    const unsubscribe = vi.fn();
    const client: StreamReaderLike = {
      getStream: vi.fn().mockResolvedValue(makeStream('1')),
      observeStream: vi.fn(() => ({
        subscribe: (observer: { next?: (s: Stream) => void }) => {
          push = (stream) => observer.next?.(stream);
          return { unsubscribe };
        },
      })),
    };

    const { result, dispose } = withScope(() => useStream(client, '1'));
    await flush();

    // The live path is used instead of a one-off read.
    expect(client.observeStream).toHaveBeenCalledWith('1', { intervalMs: 5000 });
    expect(client.getStream).not.toHaveBeenCalled();

    push!(makeStream('1'));
    await flush();
    expect(result.stream.value?.status).toBe('Active');
    expect(result.loading.value).toBe(false);

    push!(makeStream('1', { status: 'Paused' }));
    await flush();
    expect(result.stream.value?.status).toBe('Paused');

    dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('falls back to a single read when live is disabled', async () => {
    const client: StreamReaderLike = {
      getStream: vi.fn().mockResolvedValue(makeStream('1')),
      observeStream: vi.fn(),
    };

    const { result } = withScope(() => useStream(client, '1', { live: false }));
    await flush();

    expect(client.observeStream).not.toHaveBeenCalled();
    expect(client.getStream).toHaveBeenCalledTimes(1);
    expect(result.stream.value?.id).toBe('1');
  });

  it('refresh() forces a fresh read that bypasses the cache', async () => {
    const client: StreamReaderLike = {
      getStream: vi.fn().mockResolvedValue(makeStream('1')),
    };

    const { result } = withScope(() => useStream(client, '1'));
    await flush();

    await result.refresh();
    expect(client.getStream).toHaveBeenLastCalledWith('1', { refresh: true });
    expect(result.stream.value?.id).toBe('1');
  });

  it('reacts to live updates from the in-memory mock client', async () => {
    const mock = new MockSoroStreamClient();
    const streamId = await createMockStream(mock);

    const { result } = withScope(() => useStream(mock as unknown as StreamReaderLike, streamId));
    await flush();
    expect(result.stream.value?.status).toBe('Active');

    await mock.pause({ streamId });
    await flush();
    expect(result.stream.value?.status).toBe('Paused');
  });
});

// ── useStreamList ────────────────────────────────────────────────────────────

describe('useStreamList (#422)', () => {
  it('uses the batch reader so a list of ids costs one call', async () => {
    const client: StreamReaderLike = {
      getStream: vi.fn(),
      getStreams: vi.fn(async (ids: string[]) => ids.map((id) => makeStream(id))),
    };

    const { result } = withScope(() => useStreamList(client, { ids: ['1', '2', '3'] }));
    expect(result.loading.value).toBe(true);
    await flush();

    expect(client.getStreams).toHaveBeenCalledTimes(1);
    expect(client.getStreams).toHaveBeenCalledWith(['1', '2', '3']);
    expect(client.getStream).not.toHaveBeenCalled();
    expect(result.streams.value.map((s) => s.id)).toEqual(['1', '2', '3']);
    expect(result.loading.value).toBe(false);
  });

  it('falls back to individual reads when the client has no batch reader', async () => {
    const client: StreamReaderLike = {
      getStream: vi.fn(async (id: string) => makeStream(id)),
    };

    const { result } = withScope(() => useStreamList(client, { ids: ['1', '2'] }));
    await flush();

    expect(client.getStream).toHaveBeenCalledTimes(2);
    expect(result.streams.value.map((s) => s.id)).toEqual(['1', '2']);
  });

  it('queries by sender and unwraps paginated results', async () => {
    const client: StreamReaderLike = {
      getStream: vi.fn(),
      getStreamsBySender: vi
        .fn()
        .mockResolvedValue({ streams: [makeStream('5')], cursor: null, hasMore: false }),
    };

    const { result } = withScope(() => useStreamList(client, { sender: 'GSENDER' }));
    await flush();

    expect(client.getStreamsBySender).toHaveBeenCalledWith('GSENDER');
    expect(result.streams.value.map((s) => s.id)).toEqual(['5']);
  });

  it('queries by recipient and forwards the filter', async () => {
    const client: StreamReaderLike = {
      getStream: vi.fn(),
      getStreamsByRecipient: vi.fn().mockResolvedValue([makeStream('6')]),
    };

    const { result } = withScope(() =>
      useStreamList(client, { recipient: RECIPIENT }, { filter: { activeOnly: true } }),
    );
    await flush();

    expect(client.getStreamsByRecipient).toHaveBeenCalledWith(RECIPIENT, undefined, {
      activeOnly: true,
    });
    expect(result.streams.value.map((s) => s.id)).toEqual(['6']);
  });

  it('reloads when the reactive source changes', async () => {
    const client: StreamReaderLike = {
      getStream: vi.fn(),
      getStreams: vi.fn(async (ids: string[]) => ids.map((id) => makeStream(id))),
    };
    const ids = ref(['1']);

    const { result } = withScope(() => useStreamList(client, () => ({ ids: ids.value })));
    await flush();
    expect(result.streams.value).toHaveLength(1);

    ids.value = ['1', '2'];
    await flush();
    expect(result.streams.value.map((s) => s.id)).toEqual(['1', '2']);
    expect(client.getStreams).toHaveBeenCalledTimes(2);
  });

  it('polls when intervalMs is set and stops on scope dispose', async () => {
    const client: StreamReaderLike = {
      getStream: vi.fn(),
      getStreams: vi.fn(async (ids: string[]) => ids.map((id) => makeStream(id))),
    };

    const { dispose } = withScope(() => useStreamList(client, { ids: ['1'] }, { intervalMs: 50 }));
    await flush();
    expect(client.getStreams).toHaveBeenCalledTimes(1);

    await new Promise((r) => setTimeout(r, 120));
    const afterPolling = (client.getStreams as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(afterPolling).toBeGreaterThan(1);

    dispose();
    await new Promise((r) => setTimeout(r, 120));
    expect((client.getStreams as ReturnType<typeof vi.fn>).mock.calls.length).toBe(afterPolling);
  });

  it('captures query errors', async () => {
    const client: StreamReaderLike = {
      getStream: vi.fn(),
      getStreams: vi.fn().mockRejectedValue(new Error('rpc down')),
    };

    const { result } = withScope(() => useStreamList(client, { ids: ['1'] }));
    await flush();

    expect(result.error.value?.message).toBe('rpc down');
    expect(result.streams.value).toEqual([]);
    expect(result.loading.value).toBe(false);
  });

  it('returns an empty list without querying for an empty id array', async () => {
    const client: StreamReaderLike = {
      getStream: vi.fn(),
      getStreams: vi.fn(),
    };

    const { result } = withScope(() => useStreamList(client, { ids: [] }));
    await flush();

    expect(client.getStreams).not.toHaveBeenCalled();
    expect(result.streams.value).toEqual([]);
  });

  it('works against the in-memory mock client', async () => {
    const mock = new MockSoroStreamClient();
    const first = await createMockStream(mock);
    const second = await createMockStream(mock);

    const { result } = withScope(() =>
      useStreamList(mock as unknown as StreamReaderLike, { ids: [second, first] }),
    );
    await flush();

    expect(result.streams.value.map((s) => s.id)).toEqual([second, first]);
  });
});

// ── useWithdraw ──────────────────────────────────────────────────────────────

describe('useWithdraw (#422)', () => {
  it('submits a withdrawal and exposes the transaction result', async () => {
    const client: WithdrawClientLike = {
      withdraw: vi.fn().mockResolvedValue({ txHash: 'tx-1', amount: '500' }),
    };

    const { result } = withScope(() => useWithdraw(client));
    expect(result.submitting.value).toBe(false);

    const promise = result.withdraw('42');
    expect(result.submitting.value).toBe(true);
    await promise;

    expect(client.withdraw).toHaveBeenCalledWith({ streamId: '42' });
    expect(result.txHash.value).toBe('tx-1');
    expect(result.amount.value).toBe('500');
    expect(result.submitting.value).toBe(false);
    expect(result.error.value).toBeNull();
  });

  it('accepts full WithdrawParams', async () => {
    const client: WithdrawClientLike = {
      withdraw: vi.fn().mockResolvedValue({ txHash: 'tx-2', amount: '1' }),
    };

    const { result } = withScope(() => useWithdraw(client));
    await result.withdraw({ streamId: '7' });
    expect(client.withdraw).toHaveBeenCalledWith({ streamId: '7' });
  });

  it('records and rethrows failures', async () => {
    const client: WithdrawClientLike = {
      withdraw: vi.fn().mockRejectedValue(new Error('insufficient claimable')),
    };

    const { result } = withScope(() => useWithdraw(client));
    await expect(result.withdraw('42')).rejects.toThrow('insufficient claimable');

    expect(result.error.value?.message).toBe('insufficient claimable');
    expect(result.submitting.value).toBe(false);
    expect(result.txHash.value).toBeNull();
  });

  it('errors when no client is available', async () => {
    const { result } = withScope(() => useWithdraw(null));
    await expect(result.withdraw('1')).rejects.toThrow(/no SoroStream client/i);
    expect(result.error.value).toBeInstanceOf(Error);
  });

  it('reset() clears the previous result', async () => {
    const client: WithdrawClientLike = {
      withdraw: vi.fn().mockResolvedValue({ txHash: 'tx-3', amount: '9' }),
    };

    const { result } = withScope(() => useWithdraw(client));
    await result.withdraw('1');
    expect(result.txHash.value).toBe('tx-3');

    result.reset();
    expect(result.txHash.value).toBeNull();
    expect(result.amount.value).toBeNull();
    expect(result.error.value).toBeNull();
  });

  it('withdraws from the in-memory mock client', async () => {
    const mock = new MockSoroStreamClient();
    const streamId = await createMockStream(mock);
    mock.advanceTime(streamId, 600);

    const { result } = withScope(() => useWithdraw(mock as unknown as WithdrawClientLike));
    await result.withdraw(streamId);

    expect(result.txHash.value).toBeTruthy();
    expect(result.error.value).toBeNull();
  });
});
