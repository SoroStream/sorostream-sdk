import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SoroStreamClient } from '../src/SoroStreamClient.js';
import type { Stream } from '../src/types.js';

function makeStream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: '42',
    sender: 'GABC',
    recipient: 'GDEF',
    token: 'GUSDC',
    deposit: 100_000_000n,
    flowRate: 38n,
    startTime: 1704067200,
    endTime: 1706745600,
    lastWithdrawTime: 0,
    status: 'Active',
    autoRenew: false,
    ...overrides,
  };
}

describe('onStreamUpdate (#364)', () => {
  let client: SoroStreamClient;

  beforeEach(() => {
    vi.useFakeTimers();
    client = new SoroStreamClient({
      network: 'testnet',
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      skipVersionCheck: true,
      skipPeerCheck: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is a public method on SoroStreamClient', () => {
    expect(typeof client.onStreamUpdate).toBe('function');
  });

  it('returns a StreamSubscription with unsubscribe', () => {
    vi.spyOn(client, 'getStream').mockResolvedValue(makeStream());
    const sub = client.onStreamUpdate('42', () => {});
    expect(typeof sub.unsubscribe).toBe('function');
    sub.unsubscribe();
  });

  it('fires callback with immediate=true on first poll', async () => {
    const stream = makeStream();
    vi.spyOn(client, 'getStream').mockResolvedValue(stream);
    const callback = vi.fn();

    const sub = client.onStreamUpdate('42', callback, { immediate: true, pollIntervalMs: 5000 });
    // Allow the immediate async poll to complete
    await vi.advanceTimersByTimeAsync(0);

    expect(callback).toHaveBeenCalledWith({
      stream,
      previous: undefined,
      streamId: '42',
    });
    sub.unsubscribe();
  });

  it('fires callback when stream status changes', async () => {
    const stream1 = makeStream({ status: 'Active' });
    const stream2 = makeStream({ status: 'Cancelled' });

    const getStream = vi.spyOn(client, 'getStream')
      .mockResolvedValueOnce(stream1)
      .mockResolvedValueOnce(stream2);

    const callback = vi.fn();
    const sub = client.onStreamUpdate('42', callback, {
      immediate: true,
      pollIntervalMs: 100,
    });

    // First poll (immediate)
    await vi.advanceTimersByTimeAsync(0);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenNthCalledWith(1, { stream: stream1, previous: undefined, streamId: '42' });

    // Second poll (after 100ms interval)
    await vi.advanceTimersByTimeAsync(100);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenNthCalledWith(2, { stream: stream2, previous: stream1, streamId: '42' });

    sub.unsubscribe();
    getStream.mockRestore();
  });

  it('does not fire callback when stream state is unchanged', async () => {
    const stream = makeStream();
    vi.spyOn(client, 'getStream').mockResolvedValue(stream);
    const callback = vi.fn();

    const sub = client.onStreamUpdate('42', callback, {
      immediate: true,
      pollIntervalMs: 100,
    });

    // First poll (immediate) — fires because previous is undefined
    await vi.advanceTimersByTimeAsync(0);
    expect(callback).toHaveBeenCalledTimes(1);

    // Second poll — same data, should not fire
    await vi.advanceTimersByTimeAsync(100);
    expect(callback).toHaveBeenCalledTimes(1);

    sub.unsubscribe();
  });

  it('stops polling after unsubscribe', async () => {
    const stream = makeStream();
    const getStream = vi.spyOn(client, 'getStream').mockResolvedValue(stream);
    const callback = vi.fn();

    const sub = client.onStreamUpdate('42', callback, { immediate: true, pollIntervalMs: 100 });
    // First poll (immediate)
    await vi.advanceTimersByTimeAsync(0);
    sub.unsubscribe();

    const callCountAfterUnsub = getStream.mock.calls.length;
    // Advance well past the poll interval — no more calls should happen
    await vi.advanceTimersByTimeAsync(500);

    expect(getStream.mock.calls.length).toBe(callCountAfterUnsub);
    getStream.mockRestore();
  });
});
