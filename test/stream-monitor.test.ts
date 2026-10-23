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