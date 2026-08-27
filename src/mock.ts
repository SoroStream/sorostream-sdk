/**
 * In-memory mock of the SoroStream contract for consumer unit tests.
 *
 * Drop-in replacement for {@link SoroStreamClient} that requires no network
 * access. Mirrors the real contract's flow-rate math and status transitions.
 *
 * @example
 * ```ts
 * import { MockSoroStreamClient } from "@sorostream/sdk/mock";
 *
 * const mock = new MockSoroStreamClient();
 * const { streamId } = await mock.createStream({
 *   recipient: "GRECIPIENT...",
 *   token: "GUSDC...",
 *   amount: 1_000_000_000n,
 *   durationSeconds: 3600,
 *   autoRenew: false,
 * });
 * const claimable = await mock.getClaimable(streamId);
 * ```
 */

import type {
  BatchCancelResult,
  CancelStreamParams,
  CloneStreamOverrides,
  CreateStreamParams,
  PaginatedStreams,
  PaginationParams,
  SetOperatorParams,
  SplitStreamParams,
  SplitStreamResult,
  Stream,
  StreamBalance,
  StreamEvent,
  StreamEventFilter,
  StreamFilterCriteria,
  StreamSnapshot,
  StreamSubscription,
  SoroStreamPlugin,
  TopUpParams,
  TransferStreamParams,
  PauseStreamParams,
  ResumeStreamParams,
  UpdateFlowRateParams,
  OperatorTopUpParams,
  AddDelegateParams,
  RevokeDelegateParams,
  WithdrawParams,
  WriteOptions,
  OperationExplanation,
  GetStreamsOptions,
  BatchStreamsResult,
} from './types.js';
import { streamToJSON, filterStreams } from './utils.js';
import { SoroStreamObservable, shareLatest } from './observable.js';

let nextId = 1;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function claimableAt(stream: Stream, atSec: number): bigint {
  if (stream.status === 'Cancelled' || stream.status === 'Completed') return 0n;
  // Enforce lockUntil: no withdrawals until the lock expires
  if (stream.lockUntil !== undefined && atSec < stream.lockUntil) return 0n;
  if (stream.status === 'Paused') {
    const effectiveNow = Math.min(stream.pausedAt ?? atSec, stream.endTime);
    const elapsed = Math.max(0, effectiveNow - stream.lastWithdrawTime);
    return stream.flowRate * BigInt(elapsed);
  }
  const effectiveNow = Math.min(atSec, stream.endTime);
  const elapsed = Math.max(0, effectiveNow - stream.lastWithdrawTime);
  return stream.flowRate * BigInt(elapsed);
}

type Listener = {
  filter: (e: StreamEvent) => boolean;
  callback: (e: StreamEvent) => void;
};

export class MockSoroStreamClient {
  private streams = new Map<string, Stream>();
  private listeners = new Map<string, Listener>();
  private senderKey: string;

  constructor(senderKey = 'GMOCK_SENDER') {
    this.senderKey = senderKey;
  }

  /** Override the mock's current "sender" address (simulates wallet.getPublicKey). */
  setSender(address: string): void {
    this.senderKey = address;
  }

  /** Directly inject a pre-built stream — useful for testing edge cases. */
  seedStream(stream: Stream): void {
    this.streams.set(stream.id, { ...stream });
  }

  /** Simulate `seconds` of time passing on a stream by shifting its timestamps backward. */
  advanceTime(streamId: string, seconds: number): void {
    const s = this.streams.get(streamId);
    if (!s) throw new Error(`Stream not found: ${streamId}`);
    this.streams.set(streamId, {
      ...s,
      startTime: s.startTime - seconds,
      endTime: s.endTime - seconds,
      lastWithdrawTime: s.lastWithdrawTime - seconds,
    });
  }

  private emit(event: StreamEvent): void {
    for (const listener of this.listeners.values()) {
      if (listener.filter(event)) listener.callback(event);
    }
  }

  async createStream(
    params: CreateStreamParams,
    _signal?: AbortSignal,
    options?: WriteOptions,
  ): Promise<{ streamId: string; txHash: string }> {
    if (options?.explain || (params as any)?.explain) {
      return {
        operation: 'createStream',
        summary: `Explain mode dry-run for createStream to ${params.recipient}`,
        affectedAddresses: [this.senderKey, params.recipient],
        balanceDeltas: [],
        estimatedFee: 100,
        minResourceFee: 100,
      } as any;
    }
    if (params.amount <= 0n) throw new Error('Amount must be > 0');
    if (params.durationSeconds <= 0) throw new Error('Duration must be > 0');
    const mockNow = nowSec();
    const startTimeParam =
      params.startTime ?? (params as CreateStreamParams & { start_time?: number }).start_time;
    if (startTimeParam !== undefined && startTimeParam < mockNow) {
      console.warn(
        `[SoroStream SDK] createStream: start_time (${startTimeParam}) is earlier than ` +
          `the current ledger timestamp (${mockNow}). The contract will reject this transaction.`,
      );
      throw new Error(
        `start_time (${startTimeParam}) is earlier than the current ledger timestamp (${mockNow})`,
      );
    }

    const id = String(nextId++);
    const now = nowSec();
    const flowRate = params.amount / BigInt(params.durationSeconds);
    const stream: Stream = {
      id,
      sender: this.senderKey,
      recipient: params.recipient,
      token: params.token,
      deposit: params.amount,
      flowRate,
      startTime: now,
      endTime: now + params.durationSeconds,
      lastWithdrawTime: now,
      status: 'Active',
      autoRenew: params.autoRenew,
      ...(params.lockUntil !== undefined ? { lockUntil: params.lockUntil } : {}),
      toJSON() {
        return streamToJSON(this) as Record<string, unknown>;
      },
    };
    this.streams.set(id, stream);
    this.emit({
      type: 'StreamCreated',
      streamId: id,
      txHash: `mock-tx-create-${id}`,
      ledger: 0,
      timestamp: now,
      data: { sender: stream.sender, recipient: stream.recipient },
    });
    return { streamId: id, txHash: `mock-tx-create-${id}` };
  }

  async withdraw(
    params: WithdrawParams,
    _signal?: AbortSignal,
    options?: WriteOptions,
  ): Promise<{ txHash: string; amount: string }> {
    if (options?.explain || (params as any)?.explain) {
      return {
        operation: 'withdraw',
        summary: `Explain mode dry-run for withdraw stream ${params.streamId}`,
        affectedAddresses: [this.senderKey],
        balanceDeltas: [],
        estimatedFee: 100,
        minResourceFee: 100,
      } as any;
    }
    const stream = this.streams.get(params.streamId);
    if (!stream) throw new Error(`Stream not found: ${params.streamId}`);
    if (stream.status !== 'Active') throw new Error('Stream is not active');

    const now = nowSec();
    const amount = claimableAt(stream, now);
    const newLastWithdraw = Math.min(now, stream.endTime);
    const newStatus: Stream['status'] = newLastWithdraw >= stream.endTime ? 'Completed' : 'Active';

    this.streams.set(params.streamId, {
      ...stream,
      lastWithdrawTime: newLastWithdraw,
      status: newStatus,
    });

    this.emit({
      type: 'StreamWithdrawn',
      streamId: params.streamId,
      txHash: `mock-tx-withdraw-${params.streamId}-${now}`,
      ledger: 0,
      timestamp: now,
      data: { amount: amount.toString() },
    });

    if (newStatus === 'Completed') {
      this.emit({
        type: 'StreamCompleted',
        streamId: params.streamId,
        txHash: `mock-tx-complete-${params.streamId}`,
        ledger: 0,
        timestamp: now,
        data: {},
      });
    }

    return {
      txHash: `mock-tx-withdraw-${params.streamId}-${now}`,
      amount: amount.toString(),
    };
  }

  async cancelStream(
    params: CancelStreamParams,
    _signal?: AbortSignal,
    options?: WriteOptions,
  ): Promise<{ txHash: string }> {
    if (options?.explain || (params as any)?.explain) {
      return {
        operation: 'cancelStream',
        summary: `Explain mode dry-run for cancelStream ${params.streamId}`,
        affectedAddresses: [this.senderKey],
        balanceDeltas: [],
        estimatedFee: 100,
        minResourceFee: 100,
      } as any;
    }
    const stream = this.streams.get(params.streamId);
    if (!stream) throw new Error(`Stream not found: ${params.streamId}`);
    if (stream.status !== 'Active') throw new Error('Stream is not active');

    this.streams.set(params.streamId, { ...stream, status: 'Cancelled' });
    const now = nowSec();
    this.emit({
      type: 'StreamCancelled',
      streamId: params.streamId,
      txHash: `mock-tx-cancel-${params.streamId}`,
      ledger: 0,
      timestamp: now,
      data: {},
    });
    return { txHash: `mock-tx-cancel-${params.streamId}` };
  }

  async topUp(
    params: TopUpParams,
    _signal?: AbortSignal,
    options?: WriteOptions,
  ): Promise<{ txHash: string; newEndTime: Date }> {
    if (options?.explain || (params as any)?.explain) {
      return {
        operation: 'topUp',
        summary: `Explain mode dry-run for topUp stream ${params.streamId}`,
        affectedAddresses: [this.senderKey],
        balanceDeltas: [],
        estimatedFee: 100,
        minResourceFee: 100,
      } as any;
    }
    if (params.amount <= 0n) throw new Error('Amount must be > 0');
    const stream = this.streams.get(params.streamId);
    if (!stream) throw new Error(`Stream not found: ${params.streamId}`);
    if (stream.status !== 'Active') throw new Error('Stream is not active');

    const extraSeconds = Number(params.amount / stream.flowRate);
    const newEndTime = stream.endTime + extraSeconds;
    const newDeposit = stream.deposit + params.amount;
    this.streams.set(params.streamId, {
      ...stream,
      deposit: newDeposit,
      endTime: newEndTime,
    });

    this.emit({
      type: 'StreamToppedUp',
      streamId: params.streamId,
      txHash: `mock-tx-topup-${params.streamId}`,
      ledger: 0,
      timestamp: nowSec(),
      data: { amount: params.amount.toString(), newEndTime },
    });

    return {
      txHash: `mock-tx-topup-${params.streamId}`,
      newEndTime: new Date(newEndTime * 1000),
    };
  }

  async batchCancel(streamIds: string[], _batchSize = 8): Promise<BatchCancelResult[]> {
    const results: BatchCancelResult[] = [];
    for (const id of streamIds) {
      const stream = this.streams.get(id);
      if (!stream) throw new Error(`Stream not found: ${id}`);
      if (stream.status !== 'Active') throw new Error('Stream is not active');
      this.streams.set(id, { ...stream, status: 'Cancelled' });
      this.emit({
        type: 'StreamCancelled',
        streamId: id,
        txHash: `mock-tx-cancel-${id}`,
        ledger: 0,
        timestamp: nowSec(),
        data: {},
      });
    }
    results.push({ txHash: 'mock-tx-batch-cancel', streamIds });
    return results;
  }

  async updateFlowRate(params: UpdateFlowRateParams): Promise<{ txHash: string }> {
    if (params.newFlowRate <= 0n) throw new Error('Flow rate must be > 0');
    const stream = this.streams.get(params.streamId);
    if (!stream) throw new Error(`Stream not found: ${params.streamId}`);
    if (stream.status !== 'Active') throw new Error('Stream is not active');

    const streamedSoFar = stream.flowRate * BigInt(nowSec() - stream.startTime);
    const remaining = stream.deposit - streamedSoFar;
    const newEndTime = nowSec() + Number(remaining / params.newFlowRate);

    this.streams.set(params.streamId, {
      ...stream,
      flowRate: params.newFlowRate,
      endTime: newEndTime,
    });

    return { txHash: `mock-tx-update-fr-${params.streamId}` };
  }

  private operators = new Map<string, string[]>();
  private delegates = new Map<string, Set<string>>();

  async addDelegate(delegate: string): Promise<{ txHash: string }> {
    const delegator = this.senderKey;
    if (!this.delegates.has(delegator)) {
      this.delegates.set(delegator, new Set());
    }
    this.delegates.get(delegator)!.add(delegate);
    return { txHash: `mock-tx-add-delegate-${delegate}` };
  }

  async getDelegates(delegator = this.senderKey): Promise<string[]> {
    const set = this.delegates.get(delegator);
    return set ? Array.from(set) : [];
  }

  async revokeDelegate(delegate: string): Promise<{ txHash: string }> {
    const delegator = this.senderKey;
    if (this.delegates.has(delegator)) {
      this.delegates.get(delegator)!.delete(delegate);
    }
    return { txHash: `mock-tx-revoke-delegate-${delegate}` };
  }

  // ── Issue #329: Stream-scoped delegation ─────────────────────────────────

  private streamDelegates = new Map<string, Set<string>>();

  async grantDelegate(
    streamId: string,
    delegate: string,
  ): Promise<{ txHash: string }> {
    if (!this.streams.has(streamId)) throw new Error(`Stream not found: ${streamId}`);
    if (!this.streamDelegates.has(streamId)) {
      this.streamDelegates.set(streamId, new Set());
    }
    this.streamDelegates.get(streamId)!.add(delegate);
    return { txHash: `mock-tx-grant-stream-delegate-${streamId}-${delegate}` };
  }

  async revokeDelegateFromStream(
    streamId: string,
    delegate: string,
  ): Promise<{ txHash: string }> {
    if (!this.streams.has(streamId)) throw new Error(`Stream not found: ${streamId}`);
    this.streamDelegates.get(streamId)?.delete(delegate);
    return { txHash: `mock-tx-revoke-stream-delegate-${streamId}-${delegate}` };
  }

  async getStreamDelegates(streamId: string): Promise<string[]> {
    const set = this.streamDelegates.get(streamId);
    return set ? Array.from(set) : [];
  }

  async setOperator(params: SetOperatorParams): Promise<{ txHash: string }> {
    const stream = this.streams.get(params.streamId);
    if (!stream) throw new Error(`Stream not found: ${params.streamId}`);

    const existing = this.operators.get(params.streamId) ?? [];
    if (params.approved) {
      if (!existing.includes(params.operator)) {
        this.operators.set(params.streamId, [...existing, params.operator]);
      }
    } else {
      this.operators.set(
        params.streamId,
        existing.filter((o) => o !== params.operator),
      );
    }

    return { txHash: `mock-tx-set-op-${params.streamId}` };
  }

  async operatorCancelStream(params: { streamId: string }): Promise<{ txHash: string }> {
    const stream = this.streams.get(params.streamId);
    if (!stream) throw new Error(`Stream not found: ${params.streamId}`);
    const ops = this.operators.get(params.streamId) ?? [];
    if (!ops.includes(this.senderKey)) throw new Error('Not an authorised operator');

    this.streams.set(params.streamId, { ...stream, status: 'Cancelled' });
    return { txHash: `mock-tx-op-cancel-${params.streamId}` };
  }

  async operatorTopUp(params: OperatorTopUpParams): Promise<{ txHash: string }> {
    if (params.amount <= 0n) throw new Error('Amount must be > 0');
    const stream = this.streams.get(params.streamId);
    if (!stream) throw new Error(`Stream not found: ${params.streamId}`);
    const ops = this.operators.get(params.streamId) ?? [];
    if (!ops.includes(this.senderKey)) throw new Error('Not an authorised operator');

    const extraSeconds = Number(params.amount / stream.flowRate);
    const newEndTime = stream.endTime + extraSeconds;
    this.streams.set(params.streamId, {
      ...stream,
      deposit: stream.deposit + params.amount,
      endTime: newEndTime,
    });

    return { txHash: `mock-tx-op-topup-${params.streamId}` };
  }

  async splitStream(params: SplitStreamParams): Promise<SplitStreamResult> {
    const stream = this.streams.get(params.streamId);
    if (!stream) throw new Error(`Stream not found: ${params.streamId}`);
    if (stream.status !== 'Active') throw new Error('Stream is not active');
    if (params.ratioNumerator <= 0 || params.ratioDenominator <= 0) {
      throw new Error('Ratio must be positive');
    }
    if (params.ratioNumerator >= params.ratioDenominator) {
      throw new Error('Ratio numerator must be less than denominator');
    }

    // Cancel the original stream
    this.streams.set(params.streamId, { ...stream, status: 'Cancelled' });

    const now = nowSec();
    const remainingDuration = stream.endTime - Math.max(now, stream.lastWithdrawTime);
    const remainingBalance = stream.flowRate * BigInt(Math.max(0, remainingDuration));

    // Calculate split amounts based on ratio
    const ratioA = BigInt(params.ratioNumerator);
    const ratioB = BigInt(params.ratioDenominator - params.ratioNumerator);
    const totalRatio = BigInt(params.ratioDenominator);

    const amountA = (remainingBalance * ratioA) / totalRatio;
    const amountB = (remainingBalance * ratioB) / totalRatio;

    const flowRateA = amountA / BigInt(Math.max(1, remainingDuration));
    const flowRateB = amountB / BigInt(Math.max(1, remainingDuration));

    const idA = String(nextId++);
    const idB = String(nextId++);

    const streamA: Stream = {
      id: idA,
      sender: stream.sender,
      recipient: params.recipientA,
      token: stream.token,
      deposit: amountA,
      flowRate: flowRateA,
      startTime: now,
      endTime: now + remainingDuration,
      lastWithdrawTime: now,
      status: 'Active',
      autoRenew: false,
    };

    const streamB: Stream = {
      id: idB,
      sender: stream.sender,
      recipient: params.recipientB,
      token: stream.token,
      deposit: amountB,
      flowRate: flowRateB,
      startTime: now,
      endTime: now + remainingDuration,
      lastWithdrawTime: now,
      status: 'Active',
      autoRenew: false,
    };

    this.streams.set(idA, streamA);
    this.streams.set(idB, streamB);

    const txHash = `mock-tx-split-${params.streamId}`;

    this.emit({
      type: 'StreamCancelled',
      streamId: params.streamId,
      txHash,
      ledger: 0,
      timestamp: now,
      data: {},
    });

    this.emit({
      type: 'StreamCreated',
      streamId: idA,
      txHash,
      ledger: 0,
      timestamp: now,
      data: { sender: streamA.sender, recipient: streamA.recipient },
    });

    this.emit({
      type: 'StreamCreated',
      streamId: idB,
      txHash,
      ledger: 0,
      timestamp: now,
      data: { sender: streamB.sender, recipient: streamB.recipient },
    });

    return { txHash, streamIdA: idA, streamIdB: idB };
  }

  async transferStream(params: TransferStreamParams): Promise<{ txHash: string }> {
    const stream = this.streams.get(params.streamId);
    if (!stream) throw new Error(`Stream not found: ${params.streamId}`);
    if (stream.status !== 'Active') throw new Error('Stream is not active');

    this.streams.set(params.streamId, {
      ...stream,
      recipient: params.newRecipient,
    });

    this.emit({
      type: 'StreamTransferred',
      streamId: params.streamId,
      txHash: `mock-tx-transfer-${params.streamId}`,
      ledger: 0,
      timestamp: nowSec(),
      data: { newRecipient: params.newRecipient },
    });

    return { txHash: `mock-tx-transfer-${params.streamId}` };
  }

  async pause(params: PauseStreamParams): Promise<{ txHash: string }> {
    const stream = this.streams.get(params.streamId);
    if (!stream) throw new Error(`Stream not found: ${params.streamId}`);
    if (stream.status !== 'Active') throw new Error('Stream is not active');

    const now = nowSec();
    this.streams.set(params.streamId, {
      ...stream,
      status: 'Paused',
      pausedAt: now,
    });

    this.emit({
      type: 'StreamPaused',
      streamId: params.streamId,
      txHash: `mock-tx-pause-${params.streamId}`,
      ledger: 0,
      timestamp: now,
      data: {},
    });

    return { txHash: `mock-tx-pause-${params.streamId}` };
  }

  async resume(params: ResumeStreamParams): Promise<{ txHash: string }> {
    const stream = this.streams.get(params.streamId);
    if (!stream) throw new Error(`Stream not found: ${params.streamId}`);
    if (stream.status !== 'Paused') throw new Error('Stream is not paused');

    const now = nowSec();
    const pauseDuration = now - (stream.pausedAt ?? now);

    this.streams.set(params.streamId, {
      ...stream,
      status: 'Active',
      pausedAt: undefined,
      endTime: stream.endTime + pauseDuration,
    });

    this.emit({
      type: 'StreamResumed',
      streamId: params.streamId,
      txHash: `mock-tx-resume-${params.streamId}`,
      ledger: 0,
      timestamp: now,
      data: {},
    });

    return { txHash: `mock-tx-resume-${params.streamId}` };
  }

  async getStream(streamId: string): Promise<Stream> {
    const stream = this.streams.get(streamId);
    if (!stream) throw new Error(`Stream not found: ${streamId}`);
    return { ...stream };
  }

  /**
   * Batch equivalent of {@link MockSoroStreamClient.getStream} (issue #427).
   *
   * Mirrors the real client: duplicate IDs are collapsed, the result follows the
   * requested order, and unknown IDs are omitted (or throw with `strict: true`).
   */
  async getStreams(ids: string[], options?: GetStreamsOptions): Promise<Stream[]> {
    const { streams } = await this.getStreamsBatch(ids, options);
    return streams;
  }

  /** Batch read with metadata, mirroring `SoroStreamClient.getStreamsBatch` (issue #427). */
  async getStreamsBatch(ids: string[], options?: GetStreamsOptions): Promise<BatchStreamsResult> {
    const requested: string[] = [];
    for (const id of ids) {
      const value = String(id);
      if (!requested.includes(value)) requested.push(value);
    }

    const streams: Stream[] = [];
    const missing: string[] = [];
    for (const id of requested) {
      const stream = this.streams.get(id);
      if (stream) streams.push({ ...stream });
      else missing.push(id);
    }

    if (missing.length > 0 && options?.strict) {
      throw new Error(`Stream not found: ${missing[0]}`);
    }

    return { streams, missing, cached: [], rpcCalls: requested.length > 0 ? 1 : 0 };
  }

  /**
   * RxJS-compatible observable of a stream's state (issue #423).
   *
   * Emits immediately on subscribe and then on every mock mutation that touches
   * the stream, so consumer tests can exercise reactive code paths without a
   * polling delay.
   */
  observeStream(streamId: string): SoroStreamObservable<Stream> {
    return shareLatest<Stream>((sink) => {
      let closed = false;

      const push = (): void => {
        const stream = this.streams.get(streamId);
        if (!stream) {
          closed = true;
          sink.error(new Error(`Stream not found: ${streamId}`));
          return;
        }
        sink.next({ ...stream });
        if (stream.status === 'Completed' || stream.status === 'Cancelled') {
          closed = true;
          sink.complete();
        }
      };

      push();
      if (closed) return;

      const sub = this.subscribeEvents({ streamId }, () => push());
      return () => sub.unsubscribe();
    });
  }

  async getClaimable(streamId: string): Promise<bigint> {
    const stream = this.streams.get(streamId);
    if (!stream) return 0n;
    return claimableAt(stream, nowSec());
  }

  /**
   * Returns current accrued claimable balances for multiple stream IDs.
   *
   * Mirrors {@link SoroStreamClient.getMultipleStreamBalances}: duplicate IDs
   * are de-duplicated while preserving first-seen order, and unknown streams
   * resolve to `0n`. No RPC calls are made — values are computed from the
   * in-memory stream state.
   *
   * @param streamIds - The stream IDs to look up.
   * @returns One `StreamBalance` entry per unique input ID, in first-seen order.
   */
  async getMultipleStreamBalances(streamIds: string[]): Promise<StreamBalance[]> {
    const uniqueIds = [...new Set(streamIds)];
    const now = nowSec();
    return uniqueIds.map((id) => {
      const stream = this.streams.get(id);
      return { streamId: id, balance: stream ? claimableAt(stream, now) : 0n };
    });
  }

  async getStreamsBySender(
    sender: string,
    pagination?: PaginationParams,
    filter?: StreamFilterCriteria,
  ): Promise<Stream[] | PaginatedStreams> {
    let all = Array.from(this.streams.values()).filter((s) => s.sender === sender);
    // Issue #408-style client-side filter (status, token, date range, …)
    if (filter && Object.keys(filter).length > 0) {
      all = filterStreams(all, filter);
    }
    return this._paginate(all, pagination);
  }

  async getStreamsByRecipient(
    recipient: string,
    pagination?: PaginationParams,
    filter?: StreamFilterCriteria,
  ): Promise<Stream[] | PaginatedStreams> {
    let all = Array.from(this.streams.values()).filter((s) => s.recipient === recipient);
    // Issue #408: apply client-side filter when provided (e.g. activeOnly: true)
    if (filter && Object.keys(filter).length > 0) {
      all = filterStreams(all, filter);
    }
    return this._paginate(all, pagination);
  }

  private _paginate(all: Stream[], pagination?: PaginationParams): Stream[] | PaginatedStreams {
    if (!pagination) return all;
    const limit = pagination.limit ?? 20;
    const start = pagination.cursor ? all.findIndex((s) => s.id === pagination.cursor) + 1 : 0;
    const page = all.slice(start, start + limit);
    const last = page[page.length - 1];
    return {
      streams: page,
      cursor: last ? last.id : null,
      hasMore: start + limit < all.length,
    };
  }

  async cloneStream(
    streamId: string,
    overrides?: CloneStreamOverrides,
  ): Promise<{ streamId: string; txHash: string }> {
    const source = await this.getStream(streamId);
    const durationSeconds = source.endTime - source.startTime;

    return this.createStream({
      recipient: source.recipient,
      token: source.token,
      amount: source.deposit,
      durationSeconds,
      autoRenew: source.autoRenew,
      ...overrides,
    });
  }

  subscribeEvents(
    filter: StreamEventFilter,
    callback: (event: StreamEvent) => void,
  ): StreamSubscription {
    const key = `mock-sub-${Date.now()}-${Math.random()}`;
    this.listeners.set(key, {
      filter: (event) => {
        if (filter.streamId && event.streamId !== filter.streamId) return false;
        if (filter.sender && event.data.sender !== filter.sender) return false;
        if (filter.recipient && event.data.recipient !== filter.recipient) return false;
        return true;
      },
      callback,
    });
    return { unsubscribe: () => this.listeners.delete(key) };
  }

  // ── Issue #73: Stream snapshot export / import ───────────────────────────

  async exportStream(streamId: string, cliffSeconds = 0): Promise<StreamSnapshot> {
    const stream = await this.getStream(streamId);
    const claimable = await this.getClaimable(streamId);
    return {
      version: 1,
      exportedAt: Date.now(),
      stream: {
        ...stream,
        deposit: stream.deposit.toString(),
        flowRate: stream.flowRate.toString(),
      },
      claimableAtExport: claimable.toString(),
      vestingProjection: [],
      history: [],
    };
  }

  importStream(snapshot: StreamSnapshot): Stream {
    return {
      ...snapshot.stream,
      deposit: BigInt(snapshot.stream.deposit),
      flowRate: BigInt(snapshot.stream.flowRate),
    };
  }

  // ── Issue #50: Middleware / plugin system ─────────────────────────────────

  use(_plugin: SoroStreamPlugin): this {
    return this;
  }

  // ── Issue #148: Recipient change notification ─────────────────────────────

  onRecipientChanged(
    streamId: string,
    callback: (event: {
      streamId: string;
      oldRecipient: string;
      newRecipient: string;
      timestamp: number;
    }) => void,
    options?: { intervalMs?: number },
  ): () => void {
    const intervalMs = options?.intervalMs ?? 5_000;
    let stopped = false;
    let lastRecipient: string | null = null;

    const poll = async () => {
      if (stopped) return;
      try {
        const stream = await this.getStream(streamId);
        if (lastRecipient !== null && stream.recipient !== lastRecipient) {
          callback({
            streamId,
            oldRecipient: lastRecipient,
            newRecipient: stream.recipient,
            timestamp: Math.floor(Date.now() / 1000),
          });
        }
        lastRecipient = stream.recipient;
      } catch {
        /* swallow */
      }
    };

    void poll();
    const timer = setInterval(poll, intervalMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  // ── Issue #149: Connection pooling ────────────────────────────────────────

  getConnectionStats(): { maxConnections: number; active: number; idle: number; reused: number } {
    return { maxConnections: 5, active: 0, idle: 0, reused: 0 };
  }

  // ── Issue #391: Diagnostics ───────────────────────────────────────────────

  diagnostics(): import('./types.js').DiagnosticsResult {
    return {
      sdkVersion: '0.1.0',
      network: 'testnet',
      walletAdapter: 'mock',
      pollingIntervalMs: 5_000,
      lastRpcTimestampMs: null,
    };
  }
}

// ── Issue #348: SDK Sandbox Mode ─────────────────────────────────────────────

export type SandboxUnexpectedCallPolicy = 'error' | 'allow' | 'warn';

export interface SandboxCallLog {
  method: string;
  args: unknown[];
  timestamp: number;
}

/**
 * Offline, in-memory testing environment and mock client (issue #348).
 * Serves as a drop-in replacement for {@link SoroStreamClient} in unit tests
 * without hitting Soroban RPC endpoints.
 */
export class SoroStreamSandbox extends MockSoroStreamClient {
  private callLog: SandboxCallLog[] = [];
  private scenarios = new Map<string, (...args: any[]) => any>();
  private unexpectedCallPolicy: SandboxUnexpectedCallPolicy = 'allow';

  constructor(senderKey = 'GSANDBOX_SENDER') {
    super(senderKey);
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && !(prop in target)) {
          return (...args: unknown[]) =>
            target['recordAndExecute'](prop, () => Promise.resolve(undefined), args);
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as SoroStreamSandbox;
  }

  /** Configures the unexpected call handling policy. */
  setUnexpectedCallPolicy(policy: SandboxUnexpectedCallPolicy): void {
    this.unexpectedCallPolicy = policy;
  }

  /** Configures a custom mock handler or scenario for an SDK operation. */
  configureScenario(method: string, handler: (...args: any[]) => any): void {
    this.scenarios.set(method, handler);
  }

  /** Clears all registered custom scenarios. */
  clearScenarios(): void {
    this.scenarios.clear();
  }

  /** Returns all recorded calls made to this sandbox instance. */
  getCalls(method?: string): SandboxCallLog[] {
    if (method) {
      return this.callLog.filter((c) => c.method === method);
    }
    return [...this.callLog];
  }

  /** Clears the recorded call log history. */
  clearCallHistory(): void {
    this.callLog = [];
  }

  /** Asserts that a method was called at least `times` count (default 1). */
  assertCalled(method: string, times = 1): void {
    const calls = this.getCalls(method);
    if (calls.length < times) {
      throw new Error(
        `Expected method "${method}" to be called at least ${times} times, but was called ${calls.length} times.`,
      );
    }
  }

  /** Asserts that a method was called with arguments matching the predicate. */
  assertCalledWith(method: string, matcher: (args: unknown[]) => boolean): void {
    const calls = this.getCalls(method);
    const matched = calls.some((c) => matcher(c.args));
    if (!matched) {
      throw new Error(
        `Expected method "${method}" to be called with matching arguments, but no call matched.`,
      );
    }
  }

  private recordAndExecute<T>(
    method: string,
    defaultFn: () => Promise<T>,
    args: unknown[],
  ): Promise<T> {
    this.callLog.push({ method, args, timestamp: Date.now() });

    const scenario = this.scenarios.get(method);
    if (scenario) {
      return Promise.resolve(scenario(...args));
    }

    if (this.unexpectedCallPolicy === 'error' && !this.isDefaultOperation(method)) {
      throw new Error(`Unexpected call to unconfigured sandbox operation: "${method}"`);
    }

    return defaultFn();
  }

  private isDefaultOperation(method: string): boolean {
    return [
      'createStream',
      'withdraw',
      'cancelStream',
      'topUp',
      'getStream',
      'getClaimable',
      'getMultipleStreamBalances',
      'getStreamsBySender',
      'getStreamsByRecipient',
      'watchClaimable',
      'batchCancel',
      'updateFlowRate',
      'pause',
      'resume',
      'splitStream',
      'transferStream',
    ].includes(method);
  }

  override async createStream(
    params: CreateStreamParams,
    signal?: AbortSignal,
    options?: WriteOptions,
  ): Promise<any> {
    return this.recordAndExecute(
      'createStream',
      () => super.createStream(params, signal, options),
      [params, signal, options],
    );
  }

  override async withdraw(
    params: WithdrawParams,
    signal?: AbortSignal,
    options?: WriteOptions,
  ): Promise<any> {
    return this.recordAndExecute('withdraw', () => super.withdraw(params, signal, options), [
      params,
      signal,
      options,
    ]);
  }

  override async cancelStream(
    params: CancelStreamParams,
    signal?: AbortSignal,
    options?: WriteOptions,
  ): Promise<any> {
    return this.recordAndExecute(
      'cancelStream',
      () => super.cancelStream(params, signal, options),
      [params, signal, options],
    );
  }

  override async topUp(
    params: TopUpParams,
    signal?: AbortSignal,
    options?: WriteOptions,
  ): Promise<any> {
    return this.recordAndExecute('topUp', () => super.topUp(params, signal, options), [
      params,
      signal,
      options,
    ]);
  }

  override async getStream(streamId: string): Promise<Stream> {
    return this.recordAndExecute('getStream', () => super.getStream(streamId), [streamId]);
  }

  override async getStreams(ids: string[], options?: GetStreamsOptions): Promise<Stream[]> {
    return this.recordAndExecute('getStreams', () => super.getStreams(ids, options), [
      ids,
      options,
    ]);
  }

  override async getClaimable(streamId: string): Promise<bigint> {
    return this.recordAndExecute('getClaimable', () => super.getClaimable(streamId), [streamId]);
  }

  override async getMultipleStreamBalances(streamIds: string[]): Promise<StreamBalance[]> {
    return this.recordAndExecute(
      'getMultipleStreamBalances',
      () => super.getMultipleStreamBalances(streamIds),
      [streamIds],
    );
  }

  override async getStreamsBySender(
    sender: string,
    pagination?: PaginationParams,
    filter?: StreamFilterCriteria,
  ): Promise<Stream[] | PaginatedStreams> {
    return this.recordAndExecute(
      'getStreamsBySender',
      () => super.getStreamsBySender(sender, pagination, filter),
      [sender, pagination, filter],
    );
  }

  override async getStreamsByRecipient(
    recipient: string,
    pagination?: PaginationParams,
    filter?: StreamFilterCriteria,
  ): Promise<Stream[] | PaginatedStreams> {
    return this.recordAndExecute(
      'getStreamsByRecipient',
      () => super.getStreamsByRecipient(recipient, pagination, filter),
      [recipient, pagination, filter],
    );
  }
}
