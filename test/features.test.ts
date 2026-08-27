import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PluginRegistry } from '../src/pluginRegistry.js';
import { getPortfolioStats } from '../src/portfolioAnalytics.js';
import { scheduleFeeBumpMonitor } from '../src/feeBump.js';
import { RecipientValidationError } from '../src/errors.js';
import type {
  SoroStreamPlugin,
  Stream,
  PortfolioStats,
  RecipientValidation,
} from '../src/types.js';

// ── Issue #338: Plugin registry tests ────────────────────────────────────────

describe('PluginRegistry (issue #338)', () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = new PluginRegistry();
  });

  it('list() returns empty array for empty registry', () => {
    expect(registry.list()).toEqual([]);
  });

  it('register adds a plugin and list returns it', () => {
    const plugin: SoroStreamPlugin = {};
    registry.register(plugin);
    expect(registry.list()).toEqual([plugin]);
  });

  it('respects before constraint for ordering', () => {
    const a: SoroStreamPlugin = {};
    const b: SoroStreamPlugin = {};
    registry.register(a, { name: 'a' });
    registry.register(b, { name: 'b', before: 'a' });
    // b must come before a
    const order = registry.list();
    expect(order.indexOf(b)).toBeLessThan(order.indexOf(a));
  });

  it('respects after constraint for ordering', () => {
    const a: SoroStreamPlugin = {};
    const b: SoroStreamPlugin = {};
    registry.register(a, { name: 'a', after: 'b' });
    registry.register(b, { name: 'b' });
    // b must come before a (because a.after = "b")
    const order = registry.list();
    expect(order.indexOf(b)).toBeLessThan(order.indexOf(a));
  });

  it('detects circular dependency and throws', () => {
    const a: SoroStreamPlugin = {};
    const b: SoroStreamPlugin = {};
    registry.register(a, { name: 'a', before: 'b' });
    expect(() => {
      registry.register(b, { name: 'b', before: 'a' });
    }).toThrow(/Circular dependency/);
  });

  it('unregister removes a plugin', () => {
    const a: SoroStreamPlugin = {};
    registry.register(a);
    expect(registry.unregister(a)).toBe(true);
    expect(registry.list()).toEqual([]);
  });

  it('unregister returns false for unknown plugin', () => {
    const a: SoroStreamPlugin = {};
    expect(registry.unregister(a)).toBe(false);
  });

  it('handles multiple plugins with complex ordering', () => {
    const auth: SoroStreamPlugin = {};
    const log: SoroStreamPlugin = {};
    const rate: SoroStreamPlugin = {};
    registry.register(auth, { name: 'auth' });
    registry.register(log, { name: 'log', before: 'auth' });
    registry.register(rate, { name: 'rate', after: 'log' });
    const order = registry.list();
    // log before auth (from before), rate after log (from after)
    // rate and auth are independent, so either ordering between them is valid
    expect(order.indexOf(log)).toBeLessThan(order.indexOf(auth));
    expect(order.indexOf(log)).toBeLessThan(order.indexOf(rate));
  });
});

// ── Issue #336: Portfolio analytics tests ─────────────────────────────────────

describe('getPortfolioStats (issue #336)', () => {
  const address = 'GDUMMYADDRESS1234567890123456789012345678901';

  function makeActiveStream(overrides: Partial<Stream> = {}): Stream {
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

  it('returns zeroes for address with no streams', async () => {
    const result = await getPortfolioStats(
      address,
      () => Promise.resolve([]),
      () => Promise.resolve([]),
    );
    expect(result).toEqual({
      activeSentCount: 0,
      activeReceivedCount: 0,
      totalClaimable: 0n,
      totalMonthlyOutflow: 0n,
      totalMonthlyInflow: 0n,
    });
  });

  it('counts active sent streams correctly', async () => {
    const sent = [makeActiveStream(), makeActiveStream({ id: '2' })];
    const result = await getPortfolioStats(
      address,
      () => Promise.resolve(sent),
      () => Promise.resolve([]),
    );
    expect(result.activeSentCount).toBe(2);
    expect(result.activeReceivedCount).toBe(0);
  });

  it('counts active received streams correctly', async () => {
    const received = [makeActiveStream({ id: '3', recipient: address, sender: 'GSENDER' })];
    const result = await getPortfolioStats(
      address,
      () => Promise.resolve([]),
      () => Promise.resolve(received),
    );
    expect(result.activeSentCount).toBe(0);
    expect(result.activeReceivedCount).toBe(1);
  });

  it('excludes cancelled and completed streams', async () => {
    const sent = [
      makeActiveStream(),
      makeActiveStream({ id: '2', status: 'Cancelled' }),
      makeActiveStream({ id: '3', status: 'Completed' }),
    ];
    const result = await getPortfolioStats(
      address,
      () => Promise.resolve(sent),
      () => Promise.resolve([]),
    );
    expect(result.activeSentCount).toBe(1);
  });

  it('calculates totalClaimable from active received streams', async () => {
    const received = [
      makeActiveStream({
        id: '4',
        recipient: address,
        sender: 'GSENDER',
        flowRate: 50n,
      }),
      makeActiveStream({
        id: '5',
        recipient: address,
        sender: 'GSENDER',
        flowRate: 50n,
      }),
    ];
    const result = await getPortfolioStats(
      address,
      () => Promise.resolve([]),
      () => Promise.resolve(received),
    );
    // totalClaimable should be > 0
    expect(result.totalClaimable).toBeGreaterThan(0n);
  });

  it('calculates monthly outflow and inflow from flow rates', async () => {
    const SECONDS_PER_MONTH = 30n * 24n * 3600n;
    const sent = [makeActiveStream({ flowRate: 10n })];
    const received = [
      makeActiveStream({
        id: '6',
        recipient: address,
        sender: 'GSENDER',
        flowRate: 20n,
      }),
    ];
    const result = await getPortfolioStats(
      address,
      () => Promise.resolve(sent),
      () => Promise.resolve(received),
    );
    expect(result.totalMonthlyOutflow).toBe(10n * SECONDS_PER_MONTH);
    expect(result.totalMonthlyInflow).toBe(20n * SECONDS_PER_MONTH);
  });
});

// ── Issue #337: Fee bump monitor tests ───────────────────────────────────────

describe('scheduleFeeBumpMonitor (issue #337)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls onExpiryApproaching when tx not included before threshold', async () => {
    const onExpiryApproaching = vi.fn();
    const checkInclusion = vi.fn().mockResolvedValue(false);

    scheduleFeeBumpMonitor('txhash', 30, 0.8, checkInclusion, onExpiryApproaching);

    // Advance past the 80% threshold (30s * 0.8 = 24s)
    await vi.advanceTimersByTimeAsync(25_000);
    expect(onExpiryApproaching).toHaveBeenCalledWith('txhash');
  });

  it('does NOT call onExpiryApproaching when tx already included', async () => {
    const onExpiryApproaching = vi.fn();
    const checkInclusion = vi.fn().mockResolvedValue(true);

    scheduleFeeBumpMonitor('txhash', 30, 0.8, checkInclusion, onExpiryApproaching);

    await vi.advanceTimersByTimeAsync(25_000);
    expect(onExpiryApproaching).not.toHaveBeenCalled();
  });

  it('cancel function stops the monitor', async () => {
    const onExpiryApproaching = vi.fn();
    const checkInclusion = vi.fn().mockResolvedValue(false);

    const cancel = scheduleFeeBumpMonitor('txhash', 30, 0.8, checkInclusion, onExpiryApproaching);
    cancel();

    await vi.advanceTimersByTimeAsync(25_000);
    expect(checkInclusion).not.toHaveBeenCalled();
  });

  it('uses custom expiry threshold', async () => {
    const onExpiryApproaching = vi.fn();
    const checkInclusion = vi.fn().mockResolvedValue(false);

    // 50% threshold: 30s * 0.5 = 15s
    scheduleFeeBumpMonitor('txhash', 30, 0.5, checkInclusion, onExpiryApproaching);

    // Before 15s, nothing should happen
    vi.advanceTimersByTime(14_000);
    expect(checkInclusion).not.toHaveBeenCalled();

    // After 15s, it should trigger
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onExpiryApproaching).toHaveBeenCalledWith('txhash');
  });
});

// ── Issue #339: Recipient validation error tests ────────────────────────────

describe('RecipientValidationError (issue #339)', () => {
  it('creates error with correct properties', () => {
    const error = new RecipientValidationError(false, true, ['Missing trustline for token GUSDC']);
    expect(error.hasTrustline).toBe(false);
    expect(error.accountExists).toBe(true);
    expect(error.warnings).toEqual(['Missing trustline for token GUSDC']);
    expect(error.message).toContain('Recipient validation failed');
    expect(error.name).toBe('RecipientValidationError');
  });

  it('joins multiple warnings in message', () => {
    const error = new RecipientValidationError(false, false, [
      'Account does not exist',
      'Missing trustline',
    ]);
    expect(error.message).toContain('Account does not exist; Missing trustline');
  });
});
