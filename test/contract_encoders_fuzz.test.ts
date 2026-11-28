/**
 * Issue #588: property-based round-trip tests for the primitive ScVal
 * encoders. Runs with a fixed seed (override with FC_SEED) so CI failures
 * are reproducible.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fc from 'fast-check';
import { Keypair, StrKey, xdr } from '@stellar/stellar-sdk';
import type { rpc } from '@stellar/stellar-sdk';
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
import { InvalidI128Error } from '../src/errors.js';
import { parseContractEvent } from '../src/contractEvents.js';

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
    expect(() => encodeI128(I128_MAX + 1n)).toThrow(InvalidI128Error);
    expect(() => encodeI128(I128_MIN - 1n)).toThrow(InvalidI128Error);
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

describe('parseContractEvent defensive scValToNative handling (#873)', () => {
  // A ScVal that scValToNative cannot decode: a symbol whose bytes are not
  // valid UTF-8. Decoding it throws, exercising the try/catch fallbacks.
  // Note: scValToNative lossy-decodes invalid-UTF-8 symbol/string bytes via
  // TextDecoder (producing U+FFFD) rather than throwing, so an invalid
  // address is used instead — Address.fromScVal throws on a malformed
  // account ID, which is the only scValToNative path that reliably throws
  // for a value built through the type-safe xdr.ScVal constructors.
  const malformedScVal = () =>
    xdr.ScVal.scvAddress(
      new xdr.ScAddress(
        'scAddressTypeAccount',
        xdr.PublicKey.publicKeyTypeEd25519(Buffer.alloc(31)),
      ),
    );

  const validSymbol = (s: string) => xdr.ScVal.scvSymbol(s);

  const makeEvent = (topics: xdr.ScVal[], value: xdr.ScVal): rpc.Api.EventResponse =>
    ({
      type: 'contract',
      contractId: StrKey.encodeContract(Buffer.alloc(32)),
      topic: topics,
      value,
      ledger: 1,
      ledgerClosedAt: '2024-01-01T00:00:00Z',
      txHash: 'a'.repeat(64),
      transactionIndex: 0,
      operationIndex: 0,
      inSuccessfulContractCall: true,
    }) as unknown as rpc.Api.EventResponse;

  it('falls back when topic[0] cannot be decoded', () => {
    const event = makeEvent([malformedScVal(), validSymbol('transfer')], validSymbol('ok'));
    const payload = parseContractEvent(event);
    expect(payload).toBeDefined();
    // Unknown events (rawType decode failed or unrecognised) carry rawData
    // instead of a resolved `streamId` field. The event's "value" here
    // decodes fine (to the string "ok"), so only rawType is asserted.
    expect(payload.rawType).toBeNull();
  });

  it('falls back when topic[1] cannot be decoded', () => {
    const event = makeEvent([validSymbol('transfer'), malformedScVal()], validSymbol('ok'));
    const payload = parseContractEvent(event);
    expect(payload).toBeDefined();
    // topic[0] decodes fine, so rawType reflects it regardless of topic[1].
    expect(payload.rawType).toBe('transfer');
  });

  it('falls back when the value cannot be decoded', () => {
    const event = makeEvent([validSymbol('transfer'), validSymbol('from')], malformedScVal());
    const payload = parseContractEvent(event);
    expect(payload).toBeDefined();
    // topic[0]/topic[1] decode fine; only the value's decode fails and
    // falls back to an empty rawData record.
    expect(payload.rawType).toBe('transfer');
    expect((payload as { rawData: unknown }).rawData).toEqual({});
  });

  it('falls back when all scVals cannot be decoded', () => {
    const event = makeEvent([malformedScVal(), malformedScVal()], malformedScVal());
    const payload = parseContractEvent(event);
    expect(payload).toBeDefined();
    expect(payload.rawType).toBeNull();
    expect((payload as { rawData: unknown }).rawData).toEqual({});
  });
});
