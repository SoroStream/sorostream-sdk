/**
 * Issue #918: property-based / fuzz tests asserting `parseContractEvent` never
 * throws regardless of arbitrary malformed raw event shapes, always returning
 * a valid `ContractEventPayload` (falling back to `UnknownEventPayload` when
 * unrecognised or malformed).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fc from 'fast-check';
import { xdr } from '@stellar/stellar-sdk';
import type { rpc } from '@stellar/stellar-sdk';
import { parseContractEvent } from '../src/contractEvents.js';
import type { ContractEventPayload } from '../src/contractEvents.js';

const SEED = Number(process.env.FC_SEED ?? 918);

const VALID_EVENT_TYPES = new Set<ContractEventPayload['type']>([
  'StreamCreated',
  'StreamWithdrawn',
  'StreamCancelled',
  'StreamCompleted',
  'StreamToppedUp',
  'StreamPaused',
  'StreamResumed',
  'StreamTransferred',
  'UnknownEvent',
]);

beforeAll(() => {
  fc.configureGlobal({ seed: SEED, numRuns: 500 });
});

const knownEventNameArb = fc.constantFrom(
  'StreamCreated',
  'StreamWithdrawn',
  'StreamCancelled',
  'StreamCompleted',
  'StreamToppedUp',
  'StreamPaused',
  'StreamResumed',
  'StreamTransferred',
);

const randomScValArb = fc.oneof(
  fc.constant(xdr.ScVal.scvVoid()),
  fc.boolean().map((b) => xdr.ScVal.scvBool(b)),
  fc.integer({ min: 0, max: 1_000_000 }).map((n) => xdr.ScVal.scvU32(n)),
  fc
    .bigInt({ min: 0n, max: 2n ** 64n - 1n })
    .map((n) => xdr.ScVal.scvU64(xdr.Uint64.fromString(n.toString()))),
  fc.string({ maxLength: 32 }).map((s) => xdr.ScVal.scvSymbol(s)),
  fc.string({ maxLength: 64 }).map((s) => xdr.ScVal.scvString(s)),
  knownEventNameArb.map((name) => xdr.ScVal.scvSymbol(name)),
  fc.constant(xdr.ScVal.scvMap([])),
);

const malformedTopicElementArb = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.boolean(),
  fc.integer(),
  fc.double(),
  fc.string(),
  fc.object(),
  fc.array(fc.anything(), { maxLength: 3 }),
  randomScValArb,
);

const topicArb = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.integer(),
  fc.string(),
  fc.boolean(),
  fc.object(),
  fc.array(malformedTopicElementArb, { minLength: 0, maxLength: 5 }),
);

const valueArb = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.boolean(),
  fc.integer(),
  fc.double(),
  fc.string(),
  fc.object(),
  fc.array(fc.anything(), { maxLength: 3 }),
  randomScValArb,
);

const ledgerClosedAtArb = fc.oneof(
  fc.date().map((d) => d.toISOString()),
  fc.string(),
  fc.integer(),
  fc.constant(undefined),
  fc.constant(null),
);

const rawEventArb = fc.record(
  {
    type: fc.oneof(fc.constant('contract'), fc.string(), fc.constant(undefined)),
    ledger: fc.oneof(fc.integer({ min: 0, max: 100_000_000 }), fc.constant(undefined), fc.string()),
    ledgerClosedAt: ledgerClosedAtArb,
    txHash: fc.oneof(fc.hexaString({ minLength: 0, maxLength: 64 }), fc.constant(undefined)),
    topic: topicArb,
    value: valueArb,
  },
  { requiredKeys: [] },
);

describe('fuzz: parseContractEvent never throws (#918)', () => {
  it('always returns a valid ContractEventPayload for arbitrary malformed raw events', () => {
    fc.assert(
      fc.property(rawEventArb, (raw) => {
        const payload = parseContractEvent(raw as unknown as rpc.Api.EventResponse);
        expect(payload).toBeDefined();
        expect(typeof payload).toBe('object');
        expect(VALID_EVENT_TYPES.has(payload.type)).toBe(true);
        expect('txHash' in payload).toBe(true);
        expect('ledger' in payload).toBe(true);
        expect('timestamp' in payload).toBe(true);
        if (payload.type === 'UnknownEvent') {
          expect('rawType' in payload).toBe(true);
          expect('rawData' in payload).toBe(true);
        }
      }),
    );
  });

  it('falls back to UnknownEventPayload when topic is missing, non-array, or value is non-XDR', () => {
    const malformedCases = [
      { ledgerClosedAt: '2025-01-01T00:00:00Z', txHash: 'abc', ledger: 1 },
      {
        ledgerClosedAt: '2025-01-01T00:00:00Z',
        txHash: 'abc',
        ledger: 1,
        topic: null,
        value: 'not-xdr',
      },
      {
        ledgerClosedAt: '2025-01-01T00:00:00Z',
        txHash: 'abc',
        ledger: 1,
        topic: 12345,
        value: { bad: true },
      },
      {
        ledgerClosedAt: 'invalid-date',
        txHash: '',
        ledger: 0,
        topic: ['not-scval', 42],
        value: 99,
      },
    ];

    for (const raw of malformedCases) {
      const payload = parseContractEvent(raw as unknown as rpc.Api.EventResponse);
      expect(payload.type).toBe('UnknownEvent');
      if (payload.type === 'UnknownEvent') {
        expect(payload.rawType).toBeNull();
        expect(payload.rawData).toEqual({});
      }
    }
  });
});
