/**
 * Tests for issue #451: toStroops handles scientific notation strings
 */
import { describe, it, expect } from 'vitest';
import { toStroops } from '../src/utils.js';

describe('Issue #451 — toStroops: scientific notation support', () => {
  // ── Negative exponent (fractional values) ────────────────────────────────

  it('handles "1e-3" (0.001 USDC = 10_000 stroops)', () => {
    // 1e-3 = 0.001 → 0.001 * 10^7 = 10_000
    expect(toStroops('1e-3')).toBe(10_000n);
  });

  it('handles "1e-7" (minimum unit = 1 stroop)', () => {
    // 1e-7 = 0.0000001 → exactly 1 stroop
    expect(toStroops('1e-7')).toBe(1n);
  });

  it('handles "5e-4" (0.0005 USDC = 5_000 stroops)', () => {
    expect(toStroops('5e-4')).toBe(5_000n);
  });

  it('handles "2.5e-3" (0.0025 USDC = 25_000 stroops)', () => {
    expect(toStroops('2.5e-3')).toBe(25_000n);
  });

  it('handles "1.23e-5"', () => {
    // 1.23e-5 = 0.0000123 → 123 stroops
    expect(toStroops('1.23e-5')).toBe(123n);
  });

  // ── Positive exponent (large integer values) ──────────────────────────────

  it('handles "1e1" (10 USDC = 100_000_000 stroops)', () => {
    // 1e1 = 10 → 10 * 10^7 = 100_000_000
    expect(toStroops('1e1')).toBe(100_000_000n);
  });

  it('handles "1.5e1" (15 USDC = 150_000_000 stroops)', () => {
    // 1.5e1 = 15 → 15 * 10^7 = 150_000_000
    expect(toStroops('1.5e1')).toBe(150_000_000n);
  });

  it('handles "1e2" (100 USDC = 1_000_000_000 stroops)', () => {
    expect(toStroops('1e2')).toBe(1_000_000_000n);
  });

  it('handles "1e3" (1000 USDC = 10_000_000_000 stroops)', () => {
    expect(toStroops('1e3')).toBe(10_000_000_000n);
  });

  it('handles "2.5e4" (25_000 USDC)', () => {
    // 2.5e4 = 25000 → 25000 * 10^7 = 250_000_000_000
    expect(toStroops('2.5e4')).toBe(250_000_000_000n);
  });

  // ── Uppercase E ───────────────────────────────────────────────────────────

  it('handles uppercase "1E-3"', () => {
    expect(toStroops('1E-3')).toBe(10_000n);
  });

  it('handles uppercase "1.5E1"', () => {
    expect(toStroops('1.5E1')).toBe(150_000_000n);
  });

  // ── Negative amounts ──────────────────────────────────────────────────────

  it('handles negative scientific notation "-1e-3"', () => {
    expect(toStroops('-1e-3')).toBe(-10_000n);
  });

  it('handles negative scientific notation "-1.5e1"', () => {
    expect(toStroops('-1.5e1')).toBe(-150_000_000n);
  });

  // ── Positive exponent with explicit + sign ───────────────────────────────

  it('handles "1e+3" (1000 USDC)', () => {
    expect(toStroops('1e+3')).toBe(10_000_000_000n);
  });

  // ── Existing non-scientific behaviour is preserved ────────────────────────

  it('still handles plain decimal "100.5"', () => {
    expect(toStroops('100.5')).toBe(1_005_000_000n);
  });

  it('still handles integer string "100"', () => {
    expect(toStroops('100')).toBe(1_000_000_000n);
  });

  it('still handles "0.0000001" (1 stroop)', () => {
    expect(toStroops('0.0000001')).toBe(1n);
  });

  it('scientific result equals plain decimal equivalent', () => {
    // 1e-3 == 0.001
    expect(toStroops('1e-3')).toBe(toStroops('0.001'));
    // 1.5e1 == 15
    expect(toStroops('1.5e1')).toBe(toStroops('15'));
    // 2.5e-4 == 0.00025
    expect(toStroops('2.5e-4')).toBe(toStroops('0.00025'));
    // 1e2 == 100
    expect(toStroops('1e2')).toBe(toStroops('100'));
  });

  it('handles "1.23456789e-1" → same as "0.123456789" (rounds last digit)', () => {
    // 1.23456789e-1 = 0.123456789 → 8 decimal digits, round half-up at position 7
    const sci = toStroops('1.23456789e-1');
    const plain = toStroops('0.123456789');
    expect(sci).toBe(plain);
  });
});
