/**
 * Typed webhook payload schemas for SoroStream contract lifecycle events.
 *
 * Every application that forwards contract events to a webhook endpoint should
 * use these canonical types instead of deriving its own schema from the ABI or
 * documentation. Using these types prevents schema drift and keeps payloads
 * consistent across SDK versions.
 *
 * @module contractEvents
 * @see {@link parseContractEvent} to deserialise a raw XDR event into one of these payloads.
 *
 * Issue #269.
 */

import { scValToNative, xdr } from '@stellar/stellar-sdk';
import type { rpc } from '@stellar/stellar-sdk';

// ── Payload interfaces ────────────────────────────────────────────────────────

/**
 * Payload for a `StreamCreated` contract event.
 *
 * Emitted when a new payment stream is successfully created on-chain.
 */
export interface StreamCreatedPayload {
  /** Discriminant — always `"StreamCreated"`. */
  type: 'StreamCreated';
  /** The newly created stream ID (string representation of the u64 contract ID). */
  streamId: string;
  /** Stellar address of the stream creator / payer. */
  sender: string;
  /** Stellar address of the stream beneficiary. */
  recipient: string;
  /** SAC token contract address (e.g. USDC). */
  token: string;
  /** Total token deposit locked in stroops. */
  deposit: bigint;
  /** Tokens released per second, in stroops. */
  flowRate: bigint;
  /** Unix timestamp (seconds) when the stream starts. */
  startTime: number;
  /** Unix timestamp (seconds) when the stream ends. */
  endTime: number;
  /** Transaction hash that emitted this event. */
  txHash: string;
  /** Ledger sequence number in which the event was recorded. */
  ledger: number;
  /** Unix timestamp (ms) of the ledger close. */
  timestamp: number;
}

/**
 * Payload for a `StreamWithdrawn` contract event.
 *
 * Emitted when the recipient successfully withdraws claimable tokens.
 */
export interface WithdrawalPayload {
  /** Discriminant — always `"StreamWithdrawn"`. */
  type: 'StreamWithdrawn';
  /** The stream that was withdrawn from. */
  streamId: string;
  /** Stellar address of the recipient who triggered the withdrawal. */
  recipient: string;
  /** Amount withdrawn in stroops. */
  amount: bigint;
  /** Unix timestamp (seconds) of the withdrawal, as recorded by the contract. */
  withdrawTime: number;
  /** Transaction hash that emitted this event. */
  txHash: string;
  /** Ledger sequence number in which the event was recorded. */
  ledger: number;
  /** Unix timestamp (ms) of the ledger close. */
  timestamp: number;
}

/**
 * Payload for a `StreamCancelled` contract event.
 *
 * Emitted when the sender cancels an active stream. Any unstreamed deposit is
 * returned to the sender; claimable tokens remain available for the recipient.
 */
export interface CancelledStreamPayload {
  /** Discriminant — always `"StreamCancelled"`. */
  type: 'StreamCancelled';
  /** The stream that was cancelled. */
  streamId: string;
  /** Stellar address of the sender who cancelled the stream. */
  sender: string;
  /** Refunded deposit amount in stroops (the unstreamed portion returned to the sender). */
  refunded: bigint;
  /** Transaction hash that emitted this event. */
  txHash: string;
  /** Ledger sequence number in which the event was recorded. */
  ledger: number;
  /** Unix timestamp (ms) of the ledger close. */
  timestamp: number;
}

/**
 * Payload for a `StreamCompleted` contract event.
 *
 * Emitted when the stream reaches its `endTime` and the full deposit has
 * been streamed to the recipient.
 */
export interface StreamCompletedPayload {
  /** Discriminant — always `"StreamCompleted"`. */
  type: 'StreamCompleted';
  /** The stream that completed. */
  streamId: string;
  /** Stellar address of the stream sender. */
  sender: string;
  /** Stellar address of the stream recipient. */
  recipient: string;
  /** Transaction hash that emitted this event. */
  txHash: string;
  /** Ledger sequence number in which the event was recorded. */
  ledger: number;
  /** Unix timestamp (ms) of the ledger close. */
  timestamp: number;
}

/**
 * Payload for a `StreamToppedUp` contract event.
 *
 * Emitted when additional tokens are deposited into an existing stream,
 * extending its duration.
 */
export interface StreamToppedUpPayload {
  /** Discriminant — always `"StreamToppedUp"`. */
  type: 'StreamToppedUp';
  /** The stream that was topped up. */
  streamId: string;
  /** Additional amount deposited in stroops. */
  addedAmount: bigint;
  /** Updated stream end timestamp (seconds) after the top-up. */
  newEndTime: number;
  /** Transaction hash that emitted this event. */
  txHash: string;
  /** Ledger sequence number in which the event was recorded. */
  ledger: number;
  /** Unix timestamp (ms) of the ledger close. */
  timestamp: number;
}

/**
 * Payload for a `StreamPaused` contract event.
 *
 * Emitted when the sender pauses an active stream. No new claimable tokens
 * accumulate while the stream is paused.
 */
export interface StreamPausedPayload {
  /** Discriminant — always `"StreamPaused"`. */
  type: 'StreamPaused';
  /** The stream that was paused. */
  streamId: string;
  /** Stellar address of the sender who paused the stream. */
  sender: string;
  /** Unix timestamp (seconds) when the stream was paused. */
  pausedAt: number;
  /** Transaction hash that emitted this event. */
  txHash: string;
  /** Ledger sequence number in which the event was recorded. */
  ledger: number;
  /** Unix timestamp (ms) of the ledger close. */
  timestamp: number;
}

/**
 * Payload for a `StreamResumed` contract event.
 *
 * Emitted when the sender resumes a paused stream. Claimable tokens resume
 * accumulating from the moment of resumption.
 */
export interface StreamResumedPayload {
  /** Discriminant — always `"StreamResumed"`. */
  type: 'StreamResumed';
  /** The stream that was resumed. */
  streamId: string;
  /** Stellar address of the sender who resumed the stream. */
  sender: string;
  /** Unix timestamp (seconds) when the stream was resumed. */
  resumedAt: number;
  /** Transaction hash that emitted this event. */
  txHash: string;
  /** Ledger sequence number in which the event was recorded. */
  ledger: number;
  /** Unix timestamp (ms) of the ledger close. */
  timestamp: number;
}

/**
 * Payload for a `StreamTransferred` contract event.
 *
 * Emitted when the recipient role of a stream is transferred to a new address.
 */
export interface StreamTransferredPayload {
  /** Discriminant — always `"StreamTransferred"`. */
  type: 'StreamTransferred';
  /** The stream that was transferred. */
  streamId: string;
  /** The previous recipient address. */
  oldRecipient: string;
  /** The new recipient address. */
  newRecipient: string;
  /** Transaction hash that emitted this event. */
  txHash: string;
  /** Ledger sequence number in which the event was recorded. */
  ledger: number;
  /** Unix timestamp (ms) of the ledger close. */
  timestamp: number;
}

/**
 * Returned by {@link parseContractEvent} when the event topic does not match
 * any known SoroStream event type, instead of throwing an error.
 *
 * Consumers should handle this type defensively:
 * ```ts
 * const payload = parseContractEvent(raw);
 * if (payload.type === "UnknownEvent") {
 *   console.warn("Unrecognised event:", payload.rawType);
 *   return;
 * }
 * ```
 */
export interface UnknownEventPayload {
  /** Discriminant — always `"UnknownEvent"`. */
  type: 'UnknownEvent';
  /** The raw event type string extracted from the topic, if any. */
  rawType: string | null;
  /** The raw deserialized event data, if parseable. */
  rawData: Record<string, unknown>;
  /** Transaction hash that emitted this event. */
  txHash: string;
  /** Ledger sequence number in which the event was recorded. */
  ledger: number;
  /** Unix timestamp (ms) of the ledger close. */
  timestamp: number;
}

/**
 * Union of all typed contract event payloads.
 *
 * Use this as the return type annotation when processing events from
 * {@link parseContractEvent}.
 */
export type ContractEventPayload =
  | StreamCreatedPayload
  | WithdrawalPayload
  | CancelledStreamPayload
  | StreamCompletedPayload
  | StreamToppedUpPayload
  | StreamPausedPayload
  | StreamResumedPayload
  | StreamTransferredPayload
  | UnknownEventPayload;

// ── Internal helpers ──────────────────────────────────────────────────────────

function safeNative(val: xdr.ScVal | undefined): unknown {
  if (!val) return undefined;
  try {
    return scValToNative(val);
  } catch {
    return undefined;
  }
}

function toBigInt(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.round(v));
  if (typeof v === 'string') return BigInt(v);
  return 0n;
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') return Number(v);
  return 0;
}

function toString(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

function dataRecord(raw: rpc.Api.EventResponse): Record<string, unknown> {
  try {
    return raw.value ? (scValToNative(raw.value) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Deserialises a raw Soroban RPC event into a typed {@link ContractEventPayload}.
 *
 * The event type is read from the first topic element. Known SoroStream event
 * types are mapped to their specific payload interface (e.g. `StreamCreated` →
 * {@link StreamCreatedPayload}). When the event type is unrecognised or cannot
 * be parsed, an {@link UnknownEventPayload} is returned **instead of throwing**,
 * so callers can handle forward-compatibility gracefully.
 *
 * @param raw - A raw event object as returned by `rpc.Server.getEvents()`.
 * @returns A fully typed payload, or an {@link UnknownEventPayload} for
 *   unrecognised event types.
 *
 * @example
 * ```ts
 * import { parseContractEvent } from "@sorostream/sdk";
 *
 * const events = await server.getEvents({ ... });
 * for (const raw of events.events) {
 *   const payload = parseContractEvent(raw);
 *
 *   if (payload.type === "StreamCreated") {
 *     console.log("New stream from", payload.sender, "to", payload.recipient);
 *   } else if (payload.type === "StreamWithdrawn") {
 *     console.log("Withdrawal:", payload.amount, "stroops");
 *   } else if (payload.type === "UnknownEvent") {
 *     console.warn("Unrecognised event type:", payload.rawType);
 *   }
 * }
 * ```
 */
export function parseContractEvent(raw: rpc.Api.EventResponse): ContractEventPayload {
  const timestamp = new Date(raw.ledgerClosedAt).getTime();
  const meta = { txHash: raw.txHash, ledger: raw.ledger, timestamp };

  // Extract event type from topic[0]
  let rawType: string | null = null;
  try {
    const topicVal = raw.topic[0] ? scValToNative(raw.topic[0]) : null;
    rawType = topicVal !== null && topicVal !== undefined ? String(topicVal) : null;
  } catch {
    rawType = null;
  }

  // Extract stream ID from topic[1]
  let streamId = '0';
  try {
    const idVal = raw.topic[1] ? scValToNative(raw.topic[1]) : null;
    streamId = idVal !== null && idVal !== undefined ? String(idVal) : '0';
  } catch {
    streamId = '0';
  }

  const data = dataRecord(raw);

  switch (rawType) {
    case 'StreamCreated': {
      return {
        type: 'StreamCreated',
        streamId,
        sender: toString(data['sender']),
        recipient: toString(data['recipient']),
        token: toString(data['token']),
        deposit: toBigInt(data['deposit']),
        flowRate: toBigInt(data['flow_rate']),
        startTime: toNumber(data['start_time']),
        endTime: toNumber(data['end_time']),
        ...meta,
      } satisfies StreamCreatedPayload;
    }

    case 'StreamWithdrawn': {
      return {
        type: 'StreamWithdrawn',
        streamId,
        recipient: toString(data['recipient']),
        amount: toBigInt(data['amount']),
        withdrawTime: toNumber(data['withdraw_time']),
        ...meta,
      } satisfies WithdrawalPayload;
    }

    case 'StreamCancelled': {
      return {
        type: 'StreamCancelled',
        streamId,
        sender: toString(data['sender']),
        refunded: toBigInt(data['refunded']),
        ...meta,
      } satisfies CancelledStreamPayload;
    }

    case 'StreamCompleted': {
      return {
        type: 'StreamCompleted',
        streamId,
        sender: toString(data['sender']),
        recipient: toString(data['recipient']),
        ...meta,
      } satisfies StreamCompletedPayload;
    }

    case 'StreamToppedUp': {
      return {
        type: 'StreamToppedUp',
        streamId,
        addedAmount: toBigInt(data['added_amount']),
        newEndTime: toNumber(data['new_end_time']),
        ...meta,
      } satisfies StreamToppedUpPayload;
    }

    case 'StreamPaused': {
      return {
        type: 'StreamPaused',
        streamId,
        sender: toString(data['sender']),
        pausedAt: toNumber(data['paused_at']),
        ...meta,
      } satisfies StreamPausedPayload;
    }

    case 'StreamResumed': {
      return {
        type: 'StreamResumed',
        streamId,
        sender: toString(data['sender']),
        resumedAt: toNumber(data['resumed_at']),
        ...meta,
      } satisfies StreamResumedPayload;
    }

    case 'StreamTransferred': {
      return {
        type: 'StreamTransferred',
        streamId,
        oldRecipient: toString(data['old_recipient']),
        newRecipient: toString(data['new_recipient']),
        ...meta,
      } satisfies StreamTransferredPayload;
    }

    default: {
      return {
        type: 'UnknownEvent',
        rawType,
        rawData: data,
        ...meta,
      } satisfies UnknownEventPayload;
    }
  }
}
