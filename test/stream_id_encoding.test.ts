import { describe, it, expect } from 'vitest';
import { encodeStreamId, decodeStreamId, bigintReplacer, bigintReviver } from '../src/utils.js';

// ── Issue #211: Stream ID encoding and decoding ──────────────────────────────

const U64_MAX = 18446744073709551615n; // 2^64 - 1

describe('encodeStreamId / decodeStreamId', () => {
  it('round-trips zero', () => {
    const encoded = encodeStreamId(0n);
    expect(decodeStreamId(encoded)).toBe(0n);
  });

  it('round-trips a small id', () => {
    const encoded = encodeStreamId(1n);
    expect(decodeStreamId(encoded)).toBe(1n);
  });

  it('round-trips a value above Number.MAX_SAFE_INTEGER without precision loss', () => {
    const id = BigInt(Number.MAX_SAFE_INTEGER) + 1_000_000n;
    const encoded = encodeStreamId(id);
    expect(decodeStreamId(encoded)).toBe(id);
  });

  it('round-trips Number.MAX_SAFE_INTEGER exactly', () => {
    const id = BigInt(Number.MAX_SAFE_INTEGER);
    expect(decodeStreamId(encodeStreamId(id))).toBe(id);
  });

  it('round-trips 2^63 - 1 (max signed 64-bit)', () => {
    const id = 9223372036854775807n;
    expect(decodeStreamId(encodeStreamId(id))).toBe(id);
  });

  it('round-trips the full u64 maximum (2^64 - 1)', () => {
    expect(decodeStreamId(encodeStreamId(U64_MAX))).toBe(U64_MAX);
  });

  it('produces URL-safe output (alphanumeric only, no padding/reserved chars)', () => {
    const ids = [0n, 1n, 12345n, U64_MAX, BigInt(Number.MAX_SAFE_INTEGER)];
    for (const id of ids) {
      const encoded = encodeStreamId(id);
      expect(encoded).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    }
  });

  it('produces distinct encodings for distinct ids', () => {
    const encoded = new Set([1n, 2n, 58n, 59n, 3364n, U64_MAX].map(encodeStreamId));
    expect(encoded.size).toBe(6);
  });

  it('decodeStreamId is the exact inverse across a range of values', () => {
    const values = [0n, 1n, 57n, 58n, 59n, 3363n, 3364n, 1_000_000_000_000n, U64_MAX];
    for (const value of values) {
      expect(decodeStreamId(encodeStreamId(value))).toBe(value);
    }
  });

  it('rejects encoding a negative id', () => {
    expect(() => encodeStreamId(-1n)).toThrow(RangeError);
  });

  it('rejects encoding an id beyond the u64 range', () => {
    expect(() => encodeStreamId(U64_MAX + 1n)).toThrow(RangeError);
  });

  it('rejects decoding an empty string', () => {
    expect(() => decodeStreamId('')).toThrow();
  });

  it('rejects decoding a string with invalid characters', () => {
    expect(() => decodeStreamId('0OIl')).toThrow();
  });

  it('rejects decoding a value that overflows u64 range', () => {
    // 58^11 comfortably exceeds 2^64, guaranteeing overflow regardless of alphabet mapping.
    const overflowing = 'z'.repeat(11);
    expect(() => decodeStreamId(overflowing)).toThrow(RangeError);
  });

  it('decoded stream ids survive a bigintReplacer/bigintReviver JSON round-trip', () => {
    const id = decodeStreamId(encodeStreamId(U64_MAX));
    const json = JSON.stringify({ streamId: id }, bigintReplacer);
    const restored = JSON.parse(json, bigintReviver) as { streamId: bigint };
    expect(restored.streamId).toBe(U64_MAX);
  });
});
