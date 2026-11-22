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

describe('StreamMonitor overlapping poll cycles (#874)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not start a new poll cycle while the previous one is in flight', async () => {
    vi.useFakeTimers();
    const stream = {
      id: 'stream-1',
      status: 'active',
      endTime: Math.floor(Date.now() / 1_000) + 60,
    } as Stream;

    let inFlight = 0;
    let maxInFlight = 0;
    const getStream = vi.fn().mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        return stream;
      } finally {
        inFlight -= 1;
      }
    });

    const monitor = new StreamMonitor(
      ['stream-1'],
      {
        getStream,
        getClaimable: vi.fn().mockResolvedValue(5n),
      },
      {
        pollIntervalMs: 20,
        lowBalanceThreshold: 10n,
        lowBalanceDebounceMs: 100,
      },
    );

    // Advance well past several poll intervals while the first poll is slow.
    await vi.advanceTimersByTimeAsync(250);

    // With the in-flight guard, only one poll cycle should ever be active at a time.
    expect(maxInFlight).toBe(1);

    monitor.stop();
  });

  it('stop() aborts the active poll cycle', async () => {
    vi.useFakeTimers();
    const stream = {
      id: 'stream-1',
      status: 'active',
      endTime: Math.floor(Date.now() / 1_000) + 60,
    } as Stream;

    let capturedSignal: AbortSignal | undefined;
    const getStream = vi.fn().mockImplementation(async (signal?: AbortSignal) => {
      capturedSignal = signal;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      return stream;
    });

    const monitor = new StreamMonitor(
      ['stream-1'],
      {
        getStream,
        getClaimable: vi.fn().mockResolvedValue(5n),
      },
      {
        pollIntervalMs: 20,
        lowBalanceThreshold: 10n,
        lowBalanceDebounceMs: 100,
      },
    );

    // Kick off the first poll cycle.
    await vi.advanceTimersByTimeAsync(0);
    expect(getStream).toHaveBeenCalledTimes(1);
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);

    monitor.stop();

    // The active cycle's controller must be aborted by stop().
    expect(capturedSignal?.aborted).toBe(true);

    // Advance timers to let the pending promise settle.
    await vi.advanceTimersByTimeAsync(200);
  });
});

describe('StreamMonitor removeStreams debounce reset (#875)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires immediately after remove and re-add within the debounce window', async () => {
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
        lowBalanceDebounceMs: 1_000,
      },
    );
    const alerts: bigint[] = [];
    monitor.on('streamLowBalance', ({ claimable }) => alerts.push(claimable));

    // First breach fires immediately and populates lastLowBalanceAlertAt.
    await vi.advanceTimersByTimeAsync(0);
    expect(alerts).toEqual([5n]);

    // Remove the stream mid-debounce-window.
    monitor.removeStreams(['stream-1']);

    // Re-add the stream via addStreams.
    monitor.addStreams(['stream-1']);

    // Trigger another low-balance breach. If the stale debounce timestamp
    // survived removal, this would be suppressed. With the reset it fires
    // immediately.
    await vi.advanceTimersByTimeAsync(20);
    expect(alerts).toEqual([5n, 5n]);

    monitor.stop();
  });
});