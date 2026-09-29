import { describe, it, expect } from 'vitest';
import { safeBigInt, safeIdString } from '../src/utils.js';

const MAX_SAFE = Number.MAX_SAFE_INTEGER; // 2^53 - 1

describe('safeBigInt (issue #610)', () => {
  it('passes through bigint values unchanged', () => {
    expect(safeBigInt(42n)).toBe(42n);
    expect(safeBigInt(0n)).toBe(0n);
    expect(safeBigInt(-1n)).toBe(-1n);
  });

  it('converts safe numbers to bigint', () => {
    expect(safeBigInt(42)).toBe(42n);
    expect(safeBigInt(0)).toBe(0n);
    expect(safeBigInt(MAX_SAFE)).toBe(BigInt(MAX_SAFE));
  });

  it('throws on unsafe numbers (> 2^53 - 1)', () => {
    const unsafe = MAX_SAFE + 1; // 2^53 — not safe
    expect(() => safeBigInt(unsafe)).toThrow('Precision loss');
  });

  it('throws on negative unsafe numbers', () => {
    const unsafe = -(MAX_SAFE + 1);
    expect(() => safeBigInt(unsafe)).toThrow('Precision loss');
  });

  it('throws on non-integer numbers', () => {
    expect(() => safeBigInt(1.5)).toThrow('Precision loss');
  });

  it('converts string values to bigint', () => {
    expect(safeBigInt('18446744073709551615')).toBe(18446744073709551615n);
    expect(safeBigInt('0')).toBe(0n);
  });

  it('handles u64 max as bigint', () => {
    const u64Max = (1n << 64n) - 1n;
    expect(safeBigInt(u64Max)).toBe(u64Max);
  });

  it('handles i128 max as bigint', () => {
    const i128Max = (1n << 127n) - 1n;
    expect(safeBigInt(i128Max)).toBe(i128Max);
  });
});

describe('safeIdString (issue #610)', () => {
  it('converts bigint stream IDs to string without precision loss', () => {
    expect(safeIdString(42n)).toBe('42');
    expect(safeIdString(0n)).toBe('0');
  });

  it('converts large bigint stream IDs correctly', () => {
    const largeId = 18446744073709551615n; // u64 max
    expect(safeIdString(largeId)).toBe('18446744073709551615');
  });

  it('converts safe numbers to string', () => {
    expect(safeIdString(42)).toBe('42');
    expect(safeIdString(MAX_SAFE)).toBe(String(MAX_SAFE));
  });

  it('throws on unsafe number stream IDs (> 2^53 - 1)', () => {
    const unsafe = MAX_SAFE + 1;
    expect(() => safeIdString(unsafe)).toThrow('Stream ID precision loss');
  });

  it('passes through string values', () => {
    expect(safeIdString('12345')).toBe('12345');
    expect(safeIdString('18446744073709551615')).toBe('18446744073709551615');
  });

  it('demonstrates the precision loss that would occur without this fix', () => {
    const largeId = 18446744073709551615n;

    // Without fix: scValToNative returns number, String() loses precision
    const asNumber = Number(largeId); // 18446744073709552000 (WRONG!)
    const wrongString = String(asNumber);
    expect(wrongString).not.toBe('18446744073709551615');

    // With fix: safeIdString detects the precision loss and throws
    expect(() => safeIdString(asNumber)).toThrow('Stream ID precision loss');

    // With fix: safeIdString handles bigint correctly
    expect(safeIdString(largeId)).toBe('18446744073709551615');
  });

  it('demonstrates deposit precision loss that would occur without safeBigInt', () => {
    const largeDeposit = (1n << 127n) - 1n; // i128 max

    // Without fix: BigInt(Number(largeDeposit)) loses precision
    const asNumber = Number(largeDeposit);
    const roundTripped = BigInt(asNumber);
    expect(roundTripped).not.toBe(largeDeposit);

    // With fix: safeBigInt handles bigint directly
    expect(safeBigInt(largeDeposit)).toBe(largeDeposit);
  });
});
