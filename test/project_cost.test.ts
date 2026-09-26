/**
 * Tests for issue #382: projectCost utility
 */
import { describe, it, expect, vi } from 'vitest';
import { projectCost, toStroops, calculateFlowRate, formatUSDC } from '../src/utils.js';

describe('Issue #382 — projectCost', () => {
  it('returns ratePerSecond × durationSeconds', () => {
    const rate = 10_000_000n; // 1 USDC/s
    expect(projectCost(rate, 10)).toBe(100_000_000n); // 10 USDC
  });

  it('calculates 100 USDC over 30 days correctly', () => {
    const thirtyDays = 30 * 24 * 60 * 60; // 2592000 seconds
    const rate = calculateFlowRate(toStroops('100'), thirtyDays);
    const cost = projectCost(rate, thirtyDays);
    // Due to integer division in calculateFlowRate, cost ≤ toStroops("100")
    expect(cost).toBeLessThanOrEqual(toStroops('100'));
    // But within 1 stroop of the target
    expect(cost).toBeGreaterThan(toStroops('100') - BigInt(thirtyDays));
  });

  it('formatUSDC on projected cost produces readable output', () => {
    const rate = calculateFlowRate(toStroops('1000'), 3600);
    const cost = projectCost(rate, 3600);
    const display = formatUSDC(cost);
    expect(display).toMatch(/^\d+\.\d{7}$/);
  });

  it('works with 1-second duration', () => {
    const rate = 500n;
    expect(projectCost(rate, 1)).toBe(500n);
  });

  it('works with large amounts (1 million USDC over 1 year)', () => {
    const oneYear = 365 * 24 * 60 * 60;
    const rate = calculateFlowRate(toStroops('1000000'), oneYear);
    const cost = projectCost(rate, oneYear);
    expect(cost).toBeLessThanOrEqual(toStroops('1000000'));
    expect(cost).toBeGreaterThan(0n);
  });

  it('is purely multiplicative: projectCost(rate, d1) + projectCost(rate, d2) ≤ projectCost(rate, d1+d2)', () => {
    const rate = 11n;
    const d1 = 1000,
      d2 = 2000;
    const split = projectCost(rate, d1) + projectCost(rate, d2);
    const combined = projectCost(rate, d1 + d2);
    // Equal because no rounding involved
    expect(split).toBe(combined);
  });

  it('throws when ratePerSecond is zero', () => {
    expect(() => projectCost(0n, 3600)).toThrow(/ratePerSecond must be > 0/);
  });

  it('throws when ratePerSecond is negative', () => {
    expect(() => projectCost(-1n, 3600)).toThrow(/ratePerSecond must be > 0/);
  });

  it('throws when durationSeconds is zero', () => {
    expect(() => projectCost(10_000_000n, 0)).toThrow(/durationSeconds must be > 0/);
  });

  it('throws when durationSeconds is negative', () => {
    expect(() => projectCost(10_000_000n, -1)).toThrow(/durationSeconds must be > 0/);
  });

  it('handles fractional durationSeconds by flooring', () => {
    // 1.9 seconds should behave as 1 second
    const rate = 10_000_000n;
    expect(projectCost(rate, 1.9)).toBe(10_000_000n);
  });

  it('exported from the main index', async () => {
    const { projectCost: fn } = await import('../src/index.js');
    expect(typeof fn).toBe('function');
  });
});

describe('Issue #556 — client.getProjectCost', () => {
  it('returns total, byStream, and byToken for 3 known streams', async () => {
    const { SoroStreamClient } = await import('../src/SoroStreamClient.js');
    const adapter = {
      getPublicKey: vi.fn().mockResolvedValue('GSENDER'),
      signTransaction: vi.fn().mockResolvedValue('signed'),
      isConnected: vi.fn().mockResolvedValue(true),
    };

    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: 'CONTRACT',
      walletAdapter: adapter,
      skipPeerCheck: true,
    });

    const now = Math.floor(Date.now() / 1000);
    vi.spyOn(client, 'getStreams').mockResolvedValue([
      {
        id: '1',
        sender: 'GSENDER',
        recipient: 'GRECIP',
        token: 'GTOKEN1',
        deposit: 1000n,
        flowRate: 10n,
        startTime: now,
        endTime: now + 100,
        lastWithdrawTime: now,
        status: 'Active',
        autoRenew: false,
      },
      {
        id: '2',
        sender: 'GSENDER',
        recipient: 'GRECIP',
        token: 'GTOKEN1',
        deposit: 2000n,
        flowRate: 20n,
        startTime: now,
        endTime: now + 100,
        lastWithdrawTime: now,
        status: 'Active',
        autoRenew: false,
      },
      {
        id: '3',
        sender: 'GSENDER',
        recipient: 'GRECIP',
        token: 'GTOKEN2',
        deposit: 500n,
        flowRate: 5n,
        startTime: now,
        endTime: now + 100,
        lastWithdrawTime: now + 50,
        status: 'Active',
        autoRenew: false,
      },
    ]);

    const result = await client.getProjectCost(['1', '2', '3']);

    expect(result.byStream).toHaveLength(3);
    expect(result.byToken).toHaveLength(2);

    const stream1 = result.byStream.find((s) => s.streamId === '1')!;
    expect(stream1.projectedCost).toBe(10n * BigInt(100));
    expect(stream1.withdrawn).toBe(0n);
    expect(stream1.netCost).toBe(stream1.projectedCost);

    const stream3 = result.byStream.find((s) => s.streamId === '3')!;
    expect(stream3.projectedCost).toBe(5n * BigInt(100));
    expect(stream3.withdrawn).toBe(5n * BigInt(50));
    expect(stream3.netCost).toBe(stream3.projectedCost - stream3.withdrawn);

    const token1 = result.byToken.find((t) => t.token === 'GTOKEN1')!;
    expect(token1.streamCount).toBe(2);

    expect(result.total).toBe(
      stream1.netCost +
        result.byStream.find((s) => s.streamId === '2')!.netCost +
        stream3.netCost
    );
  });
});
