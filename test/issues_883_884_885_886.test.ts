import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRpcCompatTransport, detectRpcVersion } from '../src/rpc-compat.js';
import { getPortfolioStats } from '../src/portfolioAnalytics.js';
import { claimableNow } from '../src/utils.js';
import type { Stream } from '../src/types.js';

const SECONDS_PER_MONTH = 30n * 24n * 60n * 60n;

function fetchOk(body: unknown): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
}

function settle(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('probeRpcVersion non-string status (issue #883)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('treats a 200 response with no status field as v1', async () => {
    vi.stubGlobal('fetch', fetchOk({ latestLedger: 123 }));
    await expect(detectRpcVersion('https://rpc.example.com')).resolves.toBe('v1');
  });

  it('treats a 200 response with a non-string status field as v1', async () => {
    vi.stubGlobal('fetch', fetchOk({ status: 1 }));
    await expect(detectRpcVersion('https://rpc.example.com')).resolves.toBe('v1');
  });
});

describe('unrecognizedVersion via onVersionDetected (issue #884)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('warns and forwards unrecognizedVersion on the auto-detect path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', fetchOk({ status: 'healthy', version: '3.0.0' }));

    const payloads: unknown[] = [];
    createRpcCompatTransport('https://rpc.example.com', {
      rpcVersion: 'auto',
      onVersionDetected: (payload) => payloads.push(payload),
    });
    await settle();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('does not recognise'));
    expect(payloads).toEqual([
      {
        version: 'v2',
        rpcUrl: 'https://rpc.example.com',
        autoDetected: true,
        unrecognizedVersion: '3.0.0',
      },
    ]);
  });

  it('does not probe or report unrecognizedVersion on the explicit-version path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = fetchOk({ status: 'healthy', version: '3.0.0' });
    vi.stubGlobal('fetch', fetchMock);

    const payloads: unknown[] = [];
    createRpcCompatTransport('https://rpc.example.com', {
      rpcVersion: 'v2',
      onVersionDetected: (payload) => payloads.push(payload),
    });
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(payloads).toEqual([
      { version: 'v2', rpcUrl: 'https://rpc.example.com', autoDetected: false },
    ]);
  });
});

describe('getPortfolioStats edge cases (issues #885, #886)', () => {
  const address = 'GDUMMYADDRESS1234567890123456789012345678901';

  function makeStream(overrides: Partial<Stream> = {}): Stream {
    const now = Math.floor(Date.now() / 1000);
    return {
      id: '1',
      sender: address,
      recipient: 'GRECIPIENT',
      token: 'GUSDC',
      deposit: 1000n,
      flowRate: 100n,
      startTime: now - 100,
      endTime: now + 1000,
      lastWithdrawTime: now - 50,
      status: 'Active',
      autoRenew: false,
      ...overrides,
    };
  }

  it('counts a Paused stream as active but excludes it from monthly flows (issue #885)', async () => {
    const paused = makeStream({ status: 'Paused' });
    const result = await getPortfolioStats(
      address,
      () => Promise.resolve([paused]),
      () => Promise.resolve([paused]),
    );

    expect(result.activeSentCount).toBe(1);
    expect(result.activeReceivedCount).toBe(1);
    expect(result.totalMonthlyOutflow).toBe(0n);
    expect(result.totalMonthlyInflow).toBe(0n);
  });

  it('sums a self-stream returned by both fetchers additively (issue #886)', async () => {
    const self = makeStream({ recipient: address });
    const result = await getPortfolioStats(
      address,
      () => Promise.resolve([self]),
      () => Promise.resolve([self]),
    );

    expect(result.activeSentCount).toBe(1);
    expect(result.activeReceivedCount).toBe(1);
    expect(result.totalMonthlyOutflow).toBe(100n * SECONDS_PER_MONTH);
    expect(result.totalMonthlyInflow).toBe(100n * SECONDS_PER_MONTH);
    expect(result.totalClaimable).toBe(claimableNow(self));
  });
});
