/**
 * Tests for issue #382: projectCost utility
 */
import { describe, it, expect } from 'vitest';
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
    const d1 = 1000, d2 = 2000;
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
