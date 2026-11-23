import { afterEach, describe, expect, it, vi } from 'vitest';
import { StreamMonitor } from '../src/stream-monitor.js';
import type { Stream } from '../src/types.js';

describe('StreamMonitor low-balance debounce (#712)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits the first breach immediately and coalesces rapid repeats', async () => {
    vi.useFakeTimers();
    const stream = {
      id: 'stream-1',
      status: 'active',
      endTime: Math.floor(Date.now() / 1_000) + 60,
    } as Stream;
    const monitor = new StreamMonitor(
      ['stream-1'],
      {
        getStream: vi.fn().mockResolvedValue(stream),
        getClaimable: vi.fn().mockResolvedValue(5n),
      },
      {
        pollIntervalMs: 20,
        lowBalanceThreshold: 10n,
        lowBalanceDebounceMs: 100,
      },
    );
    const alerts: bigint[] = [];
    monitor.on('streamLowBalance', ({ claimable }) => alerts.push(claimable));

    await vi.advanceTimersByTimeAsync(0);
    expect(alerts).toEqual([5n]);

    await vi.advanceTimersByTimeAsync(40);
    expect(alerts).toEqual([5n]);

    monitor.stop();
  });
});

describe('StreamMonitor.addStreams (#917)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is idempotent when adding an already-monitored stream ID', async () => {
    vi.useFakeTimers();
    const stream = {
      id: 'stream-1',
      status: 'active',
      endTime: Math.floor(Date.now() / 1_000) + 60,
    } as Stream;
    const getStream = vi.fn().mockResolvedValue(stream);
    const monitor = new StreamMonitor(
      ['stream-1'],
      {
        getStream,
        getClaimable: vi.fn().mockResolvedValue(0n),
      },
      {
        pollIntervalMs: 20,
      },
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(getStream).toHaveBeenCalledTimes(1);

    getStream.mockClear();
    monitor.addStreams(['stream-1']);

    const internalStreamIds = (monitor as unknown as { streamIds: string[] }).streamIds;
    expect(internalStreamIds).toEqual(['stream-1']);

    await vi.advanceTimersByTimeAsync(20);
    expect(getStream).toHaveBeenCalledTimes(1);
    expect(getStream).toHaveBeenCalledWith('stream-1');

    monitor.stop();
  });
});

describe('StreamMonitor low-balance debounce reset on recovery (#876)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-fires streamLowBalance immediately after claimable recovers above the threshold', async () => {
    vi.useFakeTimers();
    const stream = {
      id: 'stream-1',
      status: 'Active',
      endTime: Math.floor(Date.now() / 1_000) + 3_600,
    } as Stream;
    const getClaimable = vi
      .fn<() => Promise<bigint>>()
      .mockResolvedValueOnce(5n) // cycle 1: low
      .mockResolvedValueOnce(50n) // cycle 2: recovered
      .mockResolvedValueOnce(5n); // cycle 3: low again
    const monitor = new StreamMonitor(
      ['stream-1'],
      {
        getStream: vi.fn().mockResolvedValue(stream),
        getClaimable,
      },
      {
        pollIntervalMs: 1_000,
        lowBalanceThreshold: 10n,
        // Large window: if the first alert's timestamp survived the recovery,
        // the third cycle would be suppressed by this debounce.
        lowBalanceDebounceMs: 100_000,
      },
    );
    const alerts: bigint[] = [];
    monitor.on('streamLowBalance', ({ claimable }) => alerts.push(claimable));

    await vi.advanceTimersByTimeAsync(0);
    expect(getClaimable).toHaveBeenCalledTimes(1);
    expect(alerts).toEqual([5n]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(getClaimable).toHaveBeenCalledTimes(2);
    expect(alerts).toEqual([5n]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(getClaimable).toHaveBeenCalledTimes(3);
    expect(alerts).toEqual([5n, 5n]);

    monitor.stop();
  });
});

describe('StreamMonitor streamExpired emission (#877)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits streamExpired exactly once across many poll cycles after endTime', async () => {
    vi.useFakeTimers();
    const endTime = Math.floor(Date.now() / 1_000) - 10;
    const stream = {
      id: 'stream-1',
      status: 'Completed',
      endTime,
    } as Stream;
    const getStream = vi.fn().mockResolvedValue(stream);
    const monitor = new StreamMonitor(
      ['stream-1'],
      {
        getStream,
        getClaimable: vi.fn().mockResolvedValue(0n),
      },
      {
        pollIntervalMs: 1_000,
      },
    );
    const expired: Array<{ streamId: string; endTime: number }> = [];
    monitor.on('streamExpired', (payload) => expired.push(payload));

    // Initial poll plus five subsequent interval cycles.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000 * 5);
    expect(getStream.mock.calls.length).toBeGreaterThan(1);

    expect(expired).toEqual([{ streamId: 'stream-1', endTime }]);

    monitor.stop();
  });
});
