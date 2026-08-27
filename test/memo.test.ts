import { describe, it, expect, vi } from 'vitest';
import { Memo, MemoNone } from '@stellar/stellar-sdk';
import { encodeMemo, encodeMemoHash, decodeMemo } from '../src/memo.js';
import { SoroStreamMemoError } from '../src/errors.js';

describe('encodeMemo', () => {
  it('encodes a short text memo', () => {
    const memo = encodeMemo('invoice-4821');
    expect(memo.type).toBe('text');
    expect(memo.value).toBe('invoice-4821');
  });

  it('accepts text at exactly the 28-byte limit', () => {
    const text = 'a'.repeat(28);
    const memo = encodeMemo(text);
    expect(memo.value).toBe(text);
  });

  it('throws SoroStreamMemoError for text over 28 bytes', () => {
    const text = 'a'.repeat(29);
    expect(() => encodeMemo(text)).toThrow(SoroStreamMemoError);
  });

  it('counts UTF-8 byte length, not character length', () => {
    // Each "€" is 3 bytes in UTF-8, so 10 of them is 30 bytes — over the limit.
    expect(() => encodeMemo('€'.repeat(10))).toThrow(SoroStreamMemoError);
  });
});

describe('encodeMemoHash', () => {
  it('encodes a 32-byte input unchanged', () => {
    const data = new Uint8Array(32).fill(7);
    const memo = encodeMemoHash(data);
    expect(memo.type).toBe('hash');
    const val = memo.value as Uint8Array;
    expect(val.length).toBe(32);
    for (const byte of val) expect(byte).toBe(7);
  });

  it('pads short input to 32 bytes', () => {
    const data = new Uint8Array([1, 2, 3]);
    const memo = encodeMemoHash(data);
    const value = memo.value as Uint8Array;
    expect(value.length).toBe(32);
    expect(value[0]).toBe(1);
    expect(value[1]).toBe(2);
    expect(value[2]).toBe(3);
    // Remaining bytes should be zero
    for (let i = 3; i < 32; i++) expect(value[i]).toBe(0);
  });

  it('truncates long input to 32 bytes and warns', () => {
    const data = new Uint8Array(40).fill(9);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const memo = encodeMemoHash(data);
    const value = memo.value as Uint8Array;
    expect(value.length).toBe(32);
    for (const byte of value) expect(byte).toBe(9);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('accepts a plain Uint8Array', () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const memo = encodeMemoHash(data);
    const value = memo.value as Uint8Array;
    expect(value.length).toBe(32);
    expect(value[0]).toBe(1);
    expect(value[1]).toBe(2);
    expect(value[2]).toBe(3);
    expect(value[3]).toBe(4);
  });
});

describe('decodeMemo', () => {
  it('returns null for a no-memo transaction', () => {
    expect(decodeMemo(Memo.none())).toBeNull();
  });

  it('decodes a text memo', () => {
    expect(decodeMemo(Memo.text('hello'))).toBe('hello');
  });

  it('decodes an id memo', () => {
    expect(decodeMemo(Memo.id('12345'))).toBe('12345');
  });

  it('decodes a hash memo as a Uint8Array', () => {
    const data = Buffer.alloc(32, 1);
    const decoded = decodeMemo(Memo.hash(data));
    expect(decoded).toBeInstanceOf(Uint8Array);
    expect((decoded as Uint8Array).length).toBe(32);
    // Every byte should be 0x01
    for (const byte of decoded as Uint8Array) {
      expect(byte).toBe(1);
    }
  });

  it('decodes a return memo as a Uint8Array', () => {
    const data = Buffer.alloc(32, 2);
    const decoded = decodeMemo(Memo.return(data));
    expect(decoded).toBeInstanceOf(Uint8Array);
    expect((decoded as Uint8Array).length).toBe(32);
    for (const byte of decoded as Uint8Array) {
      expect(byte).toBe(2);
    }
  });

  it('round-trips a memo produced by encodeMemo', () => {
    const memo = encodeMemo('round-trip');
    expect(decodeMemo(memo)).toBe('round-trip');
  });

  it('round-trips a memo produced by encodeMemoHash', () => {
    const data = new Uint8Array([9, 9, 9]);
    const memo = encodeMemoHash(data);
    const decoded = decodeMemo(memo) as Uint8Array;
    expect(decoded).toBeInstanceOf(Uint8Array);
    // First 3 bytes should be 9
    expect(decoded[0]).toBe(9);
    expect(decoded[1]).toBe(9);
    expect(decoded[2]).toBe(9);
  });

  it('returns null via MemoNone constant match', () => {
    const memo = new Memo(MemoNone);
    expect(decodeMemo(memo)).toBeNull();
  });
});
