/**
 * Issue #782: Contract event deserialization and malformed/unrecognized discriminant validation.
 */
import { describe, it, expect } from 'vitest';
import { nativeToScVal } from '@stellar/stellar-sdk';
import type { rpc } from '@stellar/stellar-sdk';
import { parseContractEvent } from '../src/contractEvents.js';
import {
  UnrecognizedContractEventError,
  UnknownContractEventError,
  SoroStreamError,
} from '../src/errors.js';

describe('Issue #782: contractEvents parseContractEvent unrecognized type discriminant rejection', () => {
  const CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
  const SENDER = 'GBJ6W7PZ22C3Y7GZ5S7L6Z7V4O7F5B6X7Y8Z9A0B1C2D3E4F5G6H7I8J';
  const RECIPIENT = 'GDJ6W7PZ22C3Y7GZ5S7L6Z7V4O7F5B6X7Y8Z9A0B1C2D3E4F5G6H7I8J';
  const TOKEN = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

  function buildEvent(
    topic0: unknown,
    topic1: unknown = 1n,
    valueData: Record<string, unknown> = {},
  ): rpc.Api.EventResponse {
    return {
      type: 'contract',
      ledger: 200,
      ledgerClosedAt: '2026-02-01T00:00:00Z',
      contractId: CONTRACT,
      id: '0000000200-0000000001',
      pagingToken: '0000000200-0000000001',
      inSuccessfulContractCall: true,
      txHash: 'deadbeef1234567890abcdefdeadbeef1234567890abcdefdeadbeef12345678',
      topic: [
        typeof topic0 === 'string'
          ? nativeToScVal(topic0, { type: 'symbol' })
          : nativeToScVal(topic0),
        nativeToScVal(topic1, { type: 'u64' }),
      ],
      value: nativeToScVal(valueData),
    } as unknown as rpc.Api.EventResponse;
  }

  it('rejects structurally-valid XDR event carrying unrecognized event type discriminant with UnrecognizedContractEventError', () => {
    const raw = buildEvent('FutureProtocolStreamMigrated', 99n, {
      new_contract: CONTRACT,
      migrated_deposit: 1000n,
    });

    let caught: unknown;
    try {
      parseContractEvent(raw);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(UnrecognizedContractEventError);
    expect(caught).toBeInstanceOf(UnknownContractEventError);
    expect(caught).toBeInstanceOf(SoroStreamError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as UnrecognizedContractEventError).rawType).toBe('FutureProtocolStreamMigrated');
  });

  it('rejects events with base64 encoded XDR carrying an unrecognized discriminant', () => {
    const rawBase64 = {
      type: 'contract',
      ledger: 200,
      ledgerClosedAt: '2026-02-01T00:00:00Z',
      contractId: CONTRACT,
      id: '0000000200-0000000002',
      pagingToken: '0000000200-0000000002',
      inSuccessfulContractCall: true,
      txHash: 'abcd1234ef',
      topic: [
        nativeToScVal('UnrecognizedStreamAction', { type: 'symbol' }).toXDR('base64'),
        nativeToScVal(1n, { type: 'u64' }).toXDR('base64'),
      ],
      value: nativeToScVal({}).toXDR('base64'),
    } as unknown as rpc.Api.EventResponse;

    expect(() => parseContractEvent(rawBase64)).toThrow(UnrecognizedContractEventError);
  });

  it('continues parsing all currently-recognized event types correctly', () => {
    const streamCreated = parseContractEvent(
      buildEvent('StreamCreated', 1n, {
        sender: SENDER,
        recipient: RECIPIENT,
        token: TOKEN,
        deposit: 10000n,
        flow_rate: 100n,
        start_time: 1700000000,
        end_time: 1700000100,
      }),
    );
    expect(streamCreated.type).toBe('StreamCreated');

    const streamWithdrawn = parseContractEvent(
      buildEvent('StreamWithdrawn', 1n, {
        recipient: RECIPIENT,
        amount: 500n,
        withdraw_time: 1700000050,
      }),
    );
    expect(streamWithdrawn.type).toBe('StreamWithdrawn');

    const streamCancelled = parseContractEvent(
      buildEvent('StreamCancelled', 1n, {
        sender: SENDER,
        refunded: 5000n,
      }),
    );
    expect(streamCancelled.type).toBe('StreamCancelled');

    const streamCompleted = parseContractEvent(
      buildEvent('StreamCompleted', 1n, {
        sender: SENDER,
        recipient: RECIPIENT,
      }),
    );
    expect(streamCompleted.type).toBe('StreamCompleted');

    const streamToppedUp = parseContractEvent(
      buildEvent('StreamToppedUp', 1n, {
        added_amount: 2000n,
        new_end_time: 1700000300,
      }),
    );
    expect(streamToppedUp.type).toBe('StreamToppedUp');

    const streamPaused = parseContractEvent(
      buildEvent('StreamPaused', 1n, {
        sender: SENDER,
        paused_at: 1700000025,
      }),
    );
    expect(streamPaused.type).toBe('StreamPaused');

    const streamResumed = parseContractEvent(
      buildEvent('StreamResumed', 1n, {
        sender: SENDER,
        resumed_at: 1700000045,
      }),
    );
    expect(streamResumed.type).toBe('StreamResumed');

    const streamTransferred = parseContractEvent(
      buildEvent('StreamTransferred', 1n, {
        old_recipient: RECIPIENT,
        new_recipient: SENDER,
      }),
    );
    expect(streamTransferred.type).toBe('StreamTransferred');
  });
});
