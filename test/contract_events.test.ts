import { describe, expect, it } from 'vitest';
import { Keypair, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import type { rpc } from '@stellar/stellar-sdk';
import { parseContractEvent } from '../src/contractEvents.js';

const TX_HASH = 'deadbeef';
const LEDGER = 42;
const LEDGER_CLOSED_AT = '2024-01-01T00:00:00Z';
const LEDGER_TIMESTAMP_MS = Date.parse(LEDGER_CLOSED_AT);

const sender = Keypair.random().publicKey();
const recipient = Keypair.random().publicKey();
const newRecipient = Keypair.random().publicKey();
const token = Keypair.random().publicKey();

/** Encodes a `{ field: ScVal }` record as a Soroban map with symbol keys. */
function scMap(entries: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.entries(entries).map(
      ([key, val]) =>
        new xdr.ScMapEntry({ key: nativeToScVal(key, { type: 'symbol' }), val }),
    ),
  );
}

/** Builds a raw `rpc.Api.EventResponse`-shaped object for a SoroStream event. */
function makeRawEvent(
  eventName: string,
  streamId: bigint,
  data: Record<string, xdr.ScVal>,
): rpc.Api.EventResponse {
  return {
    type: 'contract',
    topic: [
      nativeToScVal(eventName, { type: 'symbol' }),
      nativeToScVal(streamId, { type: 'u64' }),
    ],
    value: scMap(data),
    txHash: TX_HASH,
    ledger: LEDGER,
    ledgerClosedAt: LEDGER_CLOSED_AT,
    contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
    id: '1-1',
    pagingToken: '1-1',
    inSuccessfulContractCall: true,
  } as unknown as rpc.Api.EventResponse;
}

const addr = (value: string) => nativeToScVal(value, { type: 'address' });
const i128 = (value: bigint) => nativeToScVal(value, { type: 'i128' });
const u64 = (value: bigint) => nativeToScVal(value, { type: 'u64' });

describe('parseContractEvent — known SoroStream event types', () => {
  it('parses StreamCreated, mapping snake_case fields to camelCase', () => {
    const raw = makeRawEvent('StreamCreated', 7n, {
      sender: addr(sender),
      recipient: addr(recipient),
      token: addr(token),
      deposit: i128(1_000_000n),
      flow_rate: i128(250n),
      start_time: u64(1_700_000_000n),
      end_time: u64(1_700_004_000n),
    });

    expect(parseContractEvent(raw)).toEqual({
      type: 'StreamCreated',
      streamId: '7',
      sender,
      recipient,
      token,
      deposit: 1_000_000n,
      flowRate: 250n,
      startTime: 1_700_000_000,
      endTime: 1_700_004_000,
      txHash: TX_HASH,
      ledger: LEDGER,
      timestamp: LEDGER_TIMESTAMP_MS,
    });
  });

  it('parses StreamWithdrawn', () => {
    const raw = makeRawEvent('StreamWithdrawn', 8n, {
      recipient: addr(recipient),
      amount: i128(500n),
      withdraw_time: u64(1_700_001_000n),
    });

    expect(parseContractEvent(raw)).toEqual({
      type: 'StreamWithdrawn',
      streamId: '8',
      recipient,
      amount: 500n,
      withdrawTime: 1_700_001_000,
      txHash: TX_HASH,
      ledger: LEDGER,
      timestamp: LEDGER_TIMESTAMP_MS,
    });
  });

  it('parses StreamCancelled', () => {
    const raw = makeRawEvent('StreamCancelled', 9n, {
      sender: addr(sender),
      refunded: i128(750n),
    });

    expect(parseContractEvent(raw)).toEqual({
      type: 'StreamCancelled',
      streamId: '9',
      sender,
      refunded: 750n,
      txHash: TX_HASH,
      ledger: LEDGER,
      timestamp: LEDGER_TIMESTAMP_MS,
    });
  });

  it('parses StreamCompleted', () => {
    const raw = makeRawEvent('StreamCompleted', 10n, {
      sender: addr(sender),
      recipient: addr(recipient),
    });

    expect(parseContractEvent(raw)).toEqual({
      type: 'StreamCompleted',
      streamId: '10',
      sender,
      recipient,
      txHash: TX_HASH,
      ledger: LEDGER,
      timestamp: LEDGER_TIMESTAMP_MS,
    });
  });

  it('parses StreamToppedUp, mapping added_amount and new_end_time', () => {
    const raw = makeRawEvent('StreamToppedUp', 11n, {
      added_amount: i128(2_000n),
      new_end_time: u64(1_700_008_000n),
    });

    expect(parseContractEvent(raw)).toEqual({
      type: 'StreamToppedUp',
      streamId: '11',
      addedAmount: 2_000n,
      newEndTime: 1_700_008_000,
      txHash: TX_HASH,
      ledger: LEDGER,
      timestamp: LEDGER_TIMESTAMP_MS,
    });
  });

  it('parses StreamPaused, mapping paused_at', () => {
    const raw = makeRawEvent('StreamPaused', 12n, {
      sender: addr(sender),
      paused_at: u64(1_700_002_000n),
    });

    expect(parseContractEvent(raw)).toEqual({
      type: 'StreamPaused',
      streamId: '12',
      sender,
      pausedAt: 1_700_002_000,
      txHash: TX_HASH,
      ledger: LEDGER,
      timestamp: LEDGER_TIMESTAMP_MS,
    });
  });

  it('parses StreamResumed, mapping resumed_at', () => {
    const raw = makeRawEvent('StreamResumed', 13n, {
      sender: addr(sender),
      resumed_at: u64(1_700_003_000n),
    });

    expect(parseContractEvent(raw)).toEqual({
      type: 'StreamResumed',
      streamId: '13',
      sender,
      resumedAt: 1_700_003_000,
      txHash: TX_HASH,
      ledger: LEDGER,
      timestamp: LEDGER_TIMESTAMP_MS,
    });
  });

  it('parses StreamTransferred, mapping old_recipient and new_recipient', () => {
    const raw = makeRawEvent('StreamTransferred', 14n, {
      old_recipient: addr(recipient),
      new_recipient: addr(newRecipient),
    });

    expect(parseContractEvent(raw)).toEqual({
      type: 'StreamTransferred',
      streamId: '14',
      oldRecipient: recipient,
      newRecipient,
      txHash: TX_HASH,
      ledger: LEDGER,
      timestamp: LEDGER_TIMESTAMP_MS,
    });
  });
});
