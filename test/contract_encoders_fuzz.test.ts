/**
 * Issue #588: property-based round-trip tests for the primitive ScVal
 * encoders. Runs with a fixed seed (override with FC_SEED) so CI failures
 * are reproducible.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fc from 'fast-check';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import {
  encodeAddress,
  encodeI128,
  encodeBytes,
  encodeString,
  decodeAddress,
  decodeI128,
  decodeBytes,
  decodeString,
} from '../src/contractEncoders.js';

const SEED = Number(process.env.FC_SEED ?? 588);
const I128_MIN = -(2n ** 127n);
const I128_MAX = 2n ** 127n - 1n;

// Serialise through XDR so the property covers the full wire round-trip.
const viaXdr = <T extends { toXDR(format: 'base64'): string }>(v: T) => v.toXDR('base64');

beforeAll(() => {
  fc.configureGlobal({ seed: SEED, numRuns: 500 });
});

const seed32 = fc.uint8Array({ minLength: 32, maxLength: 32 }).map((b) => Buffer.from(b));
const addressArb = fc.oneof(
  seed32.map((s) => Keypair.fromRawEd25519Seed(s).publicKey()),
  seed32.map((s) => StrKey.encodeContract(s)),
);

describe('contractEncoders round-trip (#588)', () => {
  it('encodeAddress', () => {
    fc.assert(
      fc.property(addressArb, (address) => {
        const encoded = encodeAddress(address);
        expect(viaXdr(encoded)).toBeTypeOf('string');
        expect(decodeAddress(encoded)).toBe(address);
      }),
    );
  });

  it('encodeI128', () => {
    const edges = fc.constantFrom(I128_MIN, I128_MAX, 0n, -1n, 1n, 2n ** 64n, -(2n ** 64n));
    fc.assert(
      fc.property(fc.oneof(fc.bigInt({ min: I128_MIN, max: I128_MAX }), edges), (value) => {
        expect(decodeI128(encodeI128(value))).toBe(value);
      }),
    );
  });

  it('encodeI128 rejects out-of-range values', () => {
    expect(() => encodeI128(I128_MAX + 1n)).toThrow(RangeError);
    expect(() => encodeI128(I128_MIN - 1n)).toThrow(RangeError);
  });

  it('encodeBytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
        expect(decodeBytes(encodeBytes(bytes))).toEqual(bytes);
      }),
    );
  });

  it('encodeString', () => {
    const edges = fc.constantFrom('', '\u0000', 'a\u0000b', '🚀', 'é'.repeat(300));
    fc.assert(
      fc.property(fc.oneof(fc.fullUnicodeString(), edges), (value) => {
        expect(decodeString(encodeString(value))).toBe(value);
      }),
    );
  });
});
