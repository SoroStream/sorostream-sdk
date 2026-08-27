import { describe, it, expect, vi, afterEach } from 'vitest';
import { watchTotalClaimable, claimableNow } from '../src/utils.js';
import type { Stream } from '../src/types.js';

function createMockStream(id: string, deposit: bigint): Stream {
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
    sender: 'GSENDER',
    recipient: 'GRECIPIENT',
    token: 'GTOKEN',
    deposit,
    flowRate: 100n,
    startTime: now - 10,
    endTime: now + 1000,
    lastWithdrawTime: now - 10,
    status: 'Active',
    autoRenew: false,
  };
}

describe('Issue #346 — Streaming balance aggregator correctly summing claimable amounts', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('handles zero streams (total = 0) edge case', () => {
    const onTotalChange = vi.fn();
    const unsubscribe = watchTotalClaimable([], onTotalChange);

    expect(onTotalChange).toHaveBeenCalledWith(0n);
    unsubscribe();
  });

  it('correctly sums claimable amounts across 10 streams', () => {
    vi.useFakeTimers();

    const mockStreams: Stream[] = Array.from({ length: 10 }, (_, i) =>
      createMockStream(String(i + 1), BigInt((i + 1) * 1_000_000)),
    );

    const expectedInitialSum = mockStreams.reduce((sum, s) => sum + claimableNow(s), 0n);

    const onTotalChange = vi.fn();
    const reconcileMap: Record<string, () => Promise<bigint>> = {};
    for (const s of mockStreams) {
      reconcileMap[s.id] = vi.fn().mockResolvedValue(claimableNow(s));
    }

    const unsubscribe = watchTotalClaimable(mockStreams, reconcileMap, onTotalChange, {
      tickMs: 1000,
      reconcileMs: 5000,
    });

    expect(onTotalChange).toHaveBeenCalledWith(expectedInitialSum);

    unsubscribe();
  });

  it("updates total when one stream's balance changes", async () => {
    vi.useFakeTimers();

    const mockStreams: Stream[] = Array.from({ length: 10 }, (_, i) =>
      createMockStream(String(i + 1), BigInt((i + 1) * 10_000_000)),
    );

    const onTotalChange = vi.fn();
    const reconcileFns: Record<string, () => Promise<bigint>> = {};

    for (const s of mockStreams) {
      const initial = claimableNow(s);
      reconcileFns[s.id] = vi.fn().mockResolvedValue(initial);
    }

    const unsubscribe = watchTotalClaimable(
      mockStreams,
      async (streamId) => reconcileFns[streamId]!(),
      onTotalChange,
      { tickMs: 1000, reconcileMs: 2000 },
    );

    const initialTotal = onTotalChange.mock.calls[0]![0] as bigint;

    // Simulate balance change on stream 5
    reconcileFns['5'] = vi.fn().mockResolvedValue(5_000_000n);

    // Advance timers so reconciliation runs
    await vi.advanceTimersByTimeAsync(2100);

    const latestTotal = onTotalChange.mock.calls[onTotalChange.mock.calls.length - 1]![0] as bigint;
    expect(latestTotal).not.toEqual(initialTotal);

    unsubscribe();
  });
});
