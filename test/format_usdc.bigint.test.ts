import { describe, expect, it } from 'vitest';

import { formatUSDC } from '../src/utils.js';

/**
 * Issue #610: amounts above 2^53 lost precision on the locale-aware path.
 *
 * The previous implementation added the two bigint halves as doubles —
 * `Number(whole) + Number(remainder) / Number(factor)` — and handed the result to
 * `Intl.NumberFormat`. Past `Number.MAX_SAFE_INTEGER` the double cannot hold the
 * integer part, so the rendered amount was silently wrong (2^53 + 1 displayed as
 * 2^53). These tests pin the exact digits for values at and beyond that boundary
 * and, for the first case, keep the lossy formula next to the fixed one so the
 * regression cannot come back unnoticed.
 */

const DECIMALS = 7;
const FACTOR = 10n ** BigInt(DECIMALS);

// 2^53 + 1 whole USDC = 90_071_992_547_409_930_000_000 stroops.
const JUST_ABOVE_SAFE_INTEGER = 9_007_199_254_740_993n * FACTOR;

/** The formula this issue is about, kept as a reference implementation. */
function legacyFormattedValue(stroops: bigint, options: Intl.NumberFormatOptions): string {
  const whole = stroops / FACTOR;
  const remainder = stroops % FACTOR;
  const numericValue = Number(whole) + Number(remainder) / Number(FACTOR);
  return new Intl.NumberFormat('en-US', options).format(numericValue);
}

/** Parses an en-US formatted amount back into stroops. */
function parseEnUs(formatted: string): bigint {
  const [integerPart, fractionPart = ''] = formatted.replace(/,/g, '').split('.');
  const fraction = fractionPart.padEnd(DECIMALS, '0');
  return BigInt(integerPart) * FACTOR + BigInt(fraction === '' ? '0' : fraction);
}

describe('formatUSDC precision beyond 2^53', () => {
  it('prints the exact integer part where the double-based path rounded it away', () => {
    expect(JUST_ABOVE_SAFE_INTEGER).toBe(90_071_992_547_409_930_000_000n);

    const formatted = formatUSDC(JUST_ABOVE_SAFE_INTEGER, DECIMALS, {
      locale: 'en-US',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });

    expect(formatted).toBe('9,007,199,254,740,993');

    // Same value through the old formula: off by one, and this is why the issue
    // is a correctness bug rather than a cosmetic one.
    expect(legacyFormattedValue(JUST_ABOVE_SAFE_INTEGER, { maximumFractionDigits: 0 })).toBe(
      '9,007,199,254,740,992',
    );
  });

  it('keeps the stroop fraction of a value beyond 2^53', () => {
    expect(
      formatUSDC(JUST_ABOVE_SAFE_INTEGER + 1n, DECIMALS, {
        locale: 'en-US',
        minimumFractionDigits: 0,
        maximumFractionDigits: 7,
      }),
    ).toBe('9,007,199,254,740,993.0000001');
  });

  it('formats u64::MAX stroops without losing the rounded fraction', () => {
    const u64Max = 18_446_744_073_709_551_615n;

    expect(
      formatUSDC(u64Max, DECIMALS, {
        locale: 'en-US',
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      }),
    ).toBe('1,844,674,407,370.96');
  });

  it('round-trips a formatted amount back to the original stroops', () => {
    for (const stroops of [
      JUST_ABOVE_SAFE_INTEGER,
      JUST_ABOVE_SAFE_INTEGER + 1n,
      18_446_744_073_709_551_615n,
    ]) {
      const formatted = formatUSDC(stroops, DECIMALS, {
        locale: 'en-US',
        minimumFractionDigits: 7,
        maximumFractionDigits: 7,
      });

      expect(parseEnUs(formatted)).toBe(stroops);
    }
  });

  it('leaves the calculation-safe default output untouched', () => {
    expect(formatUSDC(JUST_ABOVE_SAFE_INTEGER)).toBe('9007199254740993.0000000');
  });
});

describe('formatUSDC rounding and fraction handling', () => {
  it('rounds half-up at the requested precision', () => {
    expect(
      formatUSDC(1_005_000n, 6, {
        locale: 'en-US',
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      }),
    ).toBe('1.01');
  });

  it('carries a rounded-up fraction into the integer part', () => {
    expect(
      formatUSDC(99_999_999n, DECIMALS, {
        locale: 'en-US',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }),
    ).toBe('10');
  });

  it('clamps a fraction request larger than the token precision', () => {
    // A 6-decimal token has no 7th digit: the extra digits must not shift the
    // existing ones (the naive `padStart(maximumFractionDigits)` did exactly
    // that and produced "1.00005").
    expect(
      formatUSDC(1_500_000n, 6, {
        locale: 'en-US',
        minimumFractionDigits: 2,
        maximumFractionDigits: 10,
      }),
    ).toBe('1.50');
  });

  it('trims trailing zeros down to minimumFractionDigits', () => {
    expect(
      formatUSDC(1_005_000_000n, DECIMALS, {
        locale: 'en-US',
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      }),
    ).toBe('100.5');

    expect(
      formatUSDC(1_000_000_000n, DECIMALS, {
        locale: 'en-US',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
    ).toBe('100.00');

    expect(
      formatUSDC(1_000_000_000n, DECIMALS, {
        locale: 'en-US',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }),
    ).toBe('100');
  });

  it('formats negative amounts with the locale minus sign', () => {
    expect(
      formatUSDC(-1_500_000_000n, DECIMALS, {
        locale: 'en-US',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
    ).toBe('-150.00');

    expect(
      formatUSDC(-9_007_199_254_740_993n * FACTOR, DECIMALS, {
        locale: 'en-US',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }),
    ).toBe('-9,007,199,254,740,993');
  });

  it('honours locale separators for large amounts', () => {
    expect(formatUSDC(12_340_000_000n, DECIMALS, { locale: 'de-DE' })).toBe('1.234,00');
    expect(
      formatUSDC(JUST_ABOVE_SAFE_INTEGER, DECIMALS, {
        locale: 'de-DE',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }),
    ).toBe('9.007.199.254.740.993,00');
  });

  it('formats a bigint with grouping disabled', () => {
    expect(
      formatUSDC(JUST_ABOVE_SAFE_INTEGER, DECIMALS, {
        locale: 'en-US',
        useGrouping: false,
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }),
    ).toBe('9007199254740993');
  });
});
