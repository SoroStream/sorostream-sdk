import { rpc, scValToNative, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import type { RpcTransportAdapter } from './transport.js';

function toBigInt(val: unknown): bigint {
  if (typeof val === 'bigint') return val;
  if (typeof val === 'number') return BigInt(val);
  if (typeof val === 'string') return BigInt(val);
  return 0n;
}

export type StreamEventType = 'StreamCreated' | 'StreamWithdrawn' | 'StreamCancelled';

export interface StreamEventBase {
  type: StreamEventType;
  streamId: string;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  id: string;
  pagingToken: string;
}

export interface StreamCreatedData {
  sender: string;
  recipient: string;
  token: string;
  deposit: bigint;
  flowRate: bigint;
  startTime: number;
  endTime: number;
  autoRenew: boolean;
}

export interface StreamWithdrawnData {
  recipient: string;
  amount: bigint;
}

export interface StreamCancelledData {
  sender: string;
}

export type StreamEvent =
  | (StreamEventBase & { type: 'StreamCreated'; data: StreamCreatedData })
  | (StreamEventBase & { type: 'StreamWithdrawn'; data: StreamWithdrawnData })
  | (StreamEventBase & { type: 'StreamCancelled'; data: StreamCancelledData });

export interface StreamIndexerOptions {
  startLedger?: number;
  cursor?: string;
  limit?: number;
}

export interface PaginatedEvents {
  events: StreamEvent[];
  cursor: string;
  latestLedger: number;
}

/**
 * Client for querying historical stream events from Soroban RPC's getEvents API.
 *
 * Reconstructs a stream's full history client-side by filtering contract events
 * over a ledger range.
 */
export class StreamIndexer {
  private readonly server: RpcTransportAdapter;
  private readonly contractId: string;

  constructor(server: RpcTransportAdapter, contractId: string) {
    this.server = server;
    this.contractId = contractId;
  }

  /**
   * Fetches all events for a given stream, supporting cursor-based pagination.
   */
  async getStreamHistory(
    streamId: string,
    options?: StreamIndexerOptions,
  ): Promise<PaginatedEvents> {
    const result = await this.queryEvents({
      streamId,
      startLedger: options?.startLedger,
      cursor: options?.cursor,
      limit: options?.limit,
    });
    return result;
  }

  /**
   * Fetches events by sender address.
   */
  async getEventsBySender(
    sender: string,
    options?: StreamIndexerOptions,
  ): Promise<PaginatedEvents> {
    return this.queryEvents({
      sender,
      startLedger: options?.startLedger,
      cursor: options?.cursor,
      limit: options?.limit,
    });
  }

  /**
   * Fetches events by recipient address.
   */
  async getEventsByRecipient(
    recipient: string,
    options?: StreamIndexerOptions,
  ): Promise<PaginatedEvents> {
    return this.queryEvents({
      recipient,
      startLedger: options?.startLedger,
      cursor: options?.cursor,
      limit: options?.limit,
    });
  }

  private async queryEvents(filter: {
    streamId?: string;
    sender?: string;
    recipient?: string;
    startLedger?: number;
    cursor?: string;
    limit?: number;
  }): Promise<PaginatedEvents> {
    const eventTypes = ['StreamCreated', 'StreamWithdrawn', 'StreamCancelled'] as const;

    const topics: string[][] = eventTypes.map((eventType) => {
      return [nativeToScVal(eventType, { type: 'symbol' }).toXDR('base64')];
    });

    const request: rpc.Server.GetEventsRequest = {
      startLedger: filter.startLedger ?? 1,
      limit: filter.limit ?? 100,
      filters: [
        {
          type: 'contract',
          contractIds: [this.contractId],
          topics,
        },
      ],
    };

    if (filter.cursor) {
      request.cursor = filter.cursor;
    }

    const response = await this.server.getEvents(request);

    const events = response.events
      .filter((e) => e.inSuccessfulContractCall)
      .map((e) => this.parseEvent(e, filter))
      .filter((e): e is StreamEvent => e !== null);

    return { events, cursor: response.cursor, latestLedger: response.latestLedger };
  }

  private parseEvent(
    event: rpc.Api.EventResponse,
    filter: { streamId?: string; sender?: string; recipient?: string },
  ): StreamEvent | null {
    const topic = event.topic;
    if (topic.length < 1 || !topic[0]) return null;

    let eventType: string;
    try {
      eventType = String(scValToNative(topic[0]));
    } catch {
      return null;
    }

    if (!['StreamCreated', 'StreamWithdrawn', 'StreamCancelled'].includes(eventType)) {
      return null;
    }

    const base: StreamEventBase = {
      type: eventType as StreamEventType,
      streamId: '',
      ledger: event.ledger,
      ledgerClosedAt: event.ledgerClosedAt,
      txHash: event.txHash,
      id: event.id,
      pagingToken: event.pagingToken,
    };

    let rawData: Record<string, unknown>;
    try {
      rawData = scValToNative(event.value) as Record<string, unknown>;
    } catch {
      return null;
    }

    switch (eventType) {
      case 'StreamCreated': {
        const streamId = String(rawData['id'] ?? '');
        if (filter.streamId && streamId !== filter.streamId) return null;
        if (filter.sender && String(rawData['sender'] ?? '') !== filter.sender) return null;
        if (filter.recipient && String(rawData['recipient'] ?? '') !== filter.recipient)
          return null;

        return {
          ...base,
          streamId,
          type: 'StreamCreated',
          data: {
            sender: String(rawData['sender'] ?? ''),
            recipient: String(rawData['recipient'] ?? ''),
            token: String(rawData['token'] ?? ''),
            deposit: toBigInt(rawData['deposit']),
            flowRate: toBigInt(rawData['flow_rate']),
            startTime: Number(rawData['start_time'] ?? 0),
            endTime: Number(rawData['end_time'] ?? 0),
            autoRenew: Boolean(rawData['auto_renew'] ?? false),
          },
        };
      }
      case 'StreamWithdrawn': {
        const streamId = this.extractStreamId(topic);
        if (filter.streamId && streamId !== filter.streamId) return null;

        return {
          ...base,
          streamId,
          type: 'StreamWithdrawn',
          data: {
            recipient: String(rawData['recipient'] ?? ''),
            amount: toBigInt(rawData['amount']),
          },
        };
      }
      case 'StreamCancelled': {
        const streamId = this.extractStreamId(topic);
        if (filter.streamId && streamId !== filter.streamId) return null;

        return {
          ...base,
          streamId,
          type: 'StreamCancelled',
          data: {
            sender: String(rawData['sender'] ?? ''),
          },
        };
      }
      default:
        return null;
    }
  }

  private extractStreamId(topic: xdr.ScVal[]): string {
    const scVal = topic[1];
    if (!scVal) return '';
    try {
      return String(scValToNative(scVal));
    } catch {
      return '';
    }
  }
}
