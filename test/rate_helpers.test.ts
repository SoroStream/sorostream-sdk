/**
 * Tests for issue #390: toRatePerSecond and fromRatePerSecond utility helpers
 */
import { describe, it, expect } from 'vitest';
import { toRatePerSecond, fromRatePerSecond, toStroops, formatUSDC } from '../src/utils.js';

describe('Issue #390 — toRatePerSecond', () => {
  it('converts stroops per second (identity for unit="second")', () => {
    const amount = toStroops('1'); // 10_000_000 stroops
    expect(toRatePerSecond(amount, 'second')).toBe(amount);
  });

  it('converts 60 USDC/minute to stroops per second', () => {
    // 60 USDC per minute = 1 USDC per second
    const perMinute = toStroops('60');
    const rate = toRatePerSecond(perMinute, 'minute');
    // 600_000_000 / 60 = 10_000_000
    expect(rate).toBe(10_000_000n);
  });

  it('converts 3600 USDC/hour to stroops per second', () => {
    // 3600 USDC per hour = 1 USDC per second
    const perHour = toStroops('3600');
    const rate = toRatePerSecond(perHour, 'hour');
    expect(rate).toBe(10_000_000n);
  });

  it('converts 86400 USDC/day to stroops per second', () => {
    // 86400 USDC per day = 1 USDC per second
    const perDay = toStroops('86400');
    const rate = toRatePerSecond(perDay, 'day');
    expect(rate).toBe(10_000_000n);
  });

  it('converts 604800 USDC/week to stroops per second', () => {
    // 604800 USDC per week = 1 USDC per second
    const perWeek = toStroops('604800');
    const rate = toRatePerSecond(perWeek, 'week');
    expect(rate).toBe(10_000_000n);
  });

  it('defaults to "second" unit when none is supplied', () => {
    const amount = toStroops('5');
    expect(toRatePerSecond(amount)).toBe(amount);
  });

  it('uses integer division (floors the result)', () => {
    // 1 USDC per minute = 10_000_000 / 60 ≈ 166_666 stroops/s (truncated)
    const perMinute = toStroops('1');
    const rate = toRatePerSecond(perMinute, 'minute');
    expect(rate).toBe(10_000_000n / 60n);
  });

  it('throws when amount is zero', () => {
    expect(() => toRatePerSecond(0n, 'second')).toThrow(/amount must be > 0/);
  });

  it('throws when amount is negative', () => {
    expect(() => toRatePerSecond(-1n, 'second')).toThrow(/amount must be > 0/);
  });

  it('10 USDC per day example from README', () => {
    // toRatePerSecond(toStroops("10"), "day") → stroops/second for a 10 USDC/day flow
    const rate = toRatePerSecond(toStroops('10'), 'day');
    expect(rate).toBe(toStroops('10') / 86_400n);
  });
});

describe('Issue #390 — fromRatePerSecond', () => {
  it('converts stroops per second to stroops per second (identity for "second")', () => {
    const rate = 10_000_000n;
    expect(fromRatePerSecond(rate, 'second')).toBe(rate);
  });

  it('converts stroops per second to stroops per minute', () => {
    // 1 USDC/s → 60 USDC/min
    const rate = 10_000_000n; // 1 USDC/s
    const perMinute = fromRatePerSecond(rate, 'minute');
    expect(perMinute).toBe(600_000_000n); // 60 USDC
  });

  it('converts stroops per second to stroops per hour', () => {
    const rate = 10_000_000n; // 1 USDC/s
    const perHour = fromRatePerSecond(rate, 'hour');
    expect(perHour).toBe(36_000_000_000n); // 3600 USDC
    expect(formatUSDC(perHour)).toBe('3600.0000000');
  });

  it('converts stroops per second to stroops per day', () => {
    const rate = 10_000_000n; // 1 USDC/s
    const perDay = fromRatePerSecond(rate, 'day');
    expect(perDay).toBe(864_000_000_000n); // 86400 USDC
  });

  it('converts stroops per second to stroops per week', () => {
    const rate = 10_000_000n; // 1 USDC/s
    const perWeek = fromRatePerSecond(rate, 'week');
    expect(perWeek).toBe(6_048_000_000_000n); // 604800 USDC
  });

  it('defaults to "second" unit when none is supplied', () => {
    const rate = 12345n;
    expect(fromRatePerSecond(rate)).toBe(rate);
  });

  it('returns 0 when rate is 0', () => {
    expect(fromRatePerSecond(0n, 'day')).toBe(0n);
  });

  it('throws when rate is negative', () => {
    expect(() => fromRatePerSecond(-1n, 'day')).toThrow(/stroopsPerSecond must be >= 0/);
  });

  it('round-trip: toRatePerSecond then fromRatePerSecond recovers original amount (exact multiple)', () => {
    // Use an exact multiple so integer division is lossless
    const dailyAmount = toStroops('86400'); // exactly 1 USDC/s
    const rate = toRatePerSecond(dailyAmount, 'day');
    const recovered = fromRatePerSecond(rate, 'day');
    expect(recovered).toBe(dailyAmount);
  });

  it('exported from the main index', async () => {
    const { toRatePerSecond: fn1, fromRatePerSecond: fn2 } = await import('../src/index.js');
    expect(typeof fn1).toBe('function');
    expect(typeof fn2).toBe('function');
  });
});
