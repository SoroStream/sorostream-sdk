import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  Account,
  Asset,
  Contract,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
} from '@stellar/stellar-sdk';
import type { rpc } from '@stellar/stellar-sdk';
import { assertEnvelopeUnmutated } from '../src/xdrValidation.js';
import { createContractEncoder } from '../src/contractEncoders.js';
import {
  XdrValidationError,
  SoroStreamError,
  UnrecognizedContractEventError,
  UnknownContractEventError,
} from '../src/errors.js';
import { parseContractEvent } from '../src/contractEvents.js';
import { PriorityRequestQueue, type RateLimitDelayedPayload } from '../src/request-queue.js';
import { WebSocketTransportAdapter } from '../src/wsTransport.js';
import { EventPoller } from '../src/events.js';
import type { RpcTransportAdapter } from '../src/transport.js';

// =============================================================================
// Issue #781: xdrValidation detects operation reordering in multi-op transactions
// =============================================================================

describe('Issue #781: xdrValidation operation reordering detection', () => {
  const CONTRACT_ID = 'CAVTXNC2WCHINDNP4VBLSOQA2667VE3RPQZNGD5TFI4U2QSHTVAC667T';
  const NETWORK = Networks.TESTNET;

  it('detects operation reordering when operations have the same type', () => {
    const keypair = Keypair.random();
    const account = new Account(keypair.publicKey(), '100');
    const dest1 = Keypair.random().publicKey();
    const dest2 = Keypair.random().publicKey();

    const op1 = Operation.payment({
      destination: dest1,
      asset: Asset.native(),
      amount: '10',
    });
    const op2 = Operation.payment({
      destination: dest2,
      asset: Asset.native(),
      amount: '20',
    });

    // Original prepared transaction has op1 then op2
    const original = new TransactionBuilder(account, { fee: '200', networkPassphrase: NETWORK })
      .addOperation(op1)
      .addOperation(op2)
      .setTimeout(30)
      .build();

    // Reordered transaction has op2 then op1
    const reorderedAccount = new Account(keypair.publicKey(), '100');
    const reordered = new TransactionBuilder(reorderedAccount, {
      fee: '200',
      networkPassphrase: NETWORK,
    })
      .addOperation(op2)
      .addOperation(op1)
      .setTimeout(30)
      .build();

    let caught: unknown;
    try {
      assertEnvelopeUnmutated(original, reordered.toXDR(), NETWORK);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(XdrValidationError);
    expect(caught).toBeInstanceOf(SoroStreamError);
    expect((caught as XdrValidationError).code).toBe('ENVELOPE_MUTATED');
  });

  it('detects operation reordering when operations have different types', () => {
    const keypair = Keypair.random();
    const account = new Account(keypair.publicKey(), '200');
    const encoder = createContractEncoder(new Contract(CONTRACT_ID), 'v1');

    const contractOp = encoder.pauseStream('1', keypair.publicKey());
    const paymentOp = Operation.payment({
      destination: Keypair.random().publicKey(),
      asset: Asset.native(),
      amount: '50',
    });

    const original = new TransactionBuilder(account, { fee: '200', networkPassphrase: NETWORK })
      .addOperation(contractOp)
      .addOperation(paymentOp)
      .setTimeout(30)
      .build();

    const reorderedAccount = new Account(keypair.publicKey(), '200');
    const reordered = new TransactionBuilder(reorderedAccount, {
      fee: '200',
      networkPassphrase: NETWORK,
    })
      .addOperation(paymentOp)
      .addOperation(contractOp)
      .setTimeout(30)
      .build();

    let caught: unknown;
    try {
      assertEnvelopeUnmutated(original, reordered.toXDR(), NETWORK);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(XdrValidationError);
    expect((caught as XdrValidationError).code).toBe('ENVELOPE_MUTATED');
  });

  it('accepts correctly-ordered multi-operation envelope without mutation', () => {
    const keypair = Keypair.random();
    const account = new Account(keypair.publicKey(), '300');
    const encoder = createContractEncoder(new Contract(CONTRACT_ID), 'v1');

    const op1 = encoder.pauseStream('1', keypair.publicKey());
    const op2 = encoder.resumeStream('2', keypair.publicKey());

    const tx = new TransactionBuilder(account, { fee: '200', networkPassphrase: NETWORK })
      .addOperation(op1)
      .addOperation(op2)
      .setTimeout(30)
      .build();

    expect(() => assertEnvelopeUnmutated(tx, tx.toXDR(), NETWORK)).not.toThrow();
  });

  it('continues detecting amount and address swaps correctly', () => {
    const keypair = Keypair.random();
    const account = new Account(keypair.publicKey(), '400');
    const dest = Keypair.random().publicKey();

    const original = new TransactionBuilder(account, { fee: '100', networkPassphrase: NETWORK })
      .addOperation(
        Operation.payment({
          destination: dest,
          asset: Asset.native(),
          amount: '100',
        }),
      )
      .setTimeout(30)
      .build();

    // Swapped amount
    const swappedAmountAccount = new Account(keypair.publicKey(), '400');
    const swappedAmount = new TransactionBuilder(swappedAmountAccount, {
      fee: '100',
      networkPassphrase: NETWORK,
    })
      .addOperation(
        Operation.payment({
          destination: dest,
          asset: Asset.native(),
          amount: '999',
        }),
      )
      .setTimeout(30)
      .build();

    expect(() => assertEnvelopeUnmutated(original, swappedAmount.toXDR(), NETWORK)).toThrow(
      XdrValidationError,
    );

    // Swapped destination address
    const swappedDestAccount = new Account(keypair.publicKey(), '400');
    const swappedDest = new TransactionBuilder(swappedDestAccount, {
      fee: '100',
      networkPassphrase: NETWORK,
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: '100',
        }),
      )
      .setTimeout(30)
      .build();

    expect(() => assertEnvelopeUnmutated(original, swappedDest.toXDR(), NETWORK)).toThrow(
      XdrValidationError,
    );
  });
});

// =============================================================================
// Issue #782: contractEvents parseContractEvent unrecognized type discriminant
// =============================================================================

describe('Issue #782: contractEvents unrecognized discriminant error handling', () => {
  const CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
  const SENDER = 'GBJ6W7PZ22C3Y7GZ5S7L6Z7V4O7F5B6X7Y8Z9A0B1C2D3E4F5G6H7I8J';
  const RECIPIENT = 'GDJ6W7PZ22C3Y7GZ5S7L6Z7V4O7F5B6X7Y8Z9A0B1C2D3E4F5G6H7I8J';
  const TOKEN = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

  function buildRawEvent(
    topic0: unknown,
    topic1: unknown = 1n,
    valueData: Record<string, unknown> = {},
  ): rpc.Api.EventResponse {
    return {
      type: 'contract',
      ledger: 100,
      ledgerClosedAt: '2026-01-01T12:00:00Z',
      contractId: CONTRACT,
      id: '0000000100-0000000001',
      pagingToken: '0000000100-0000000001',
      inSuccessfulContractCall: true,
      txHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
      topic: [
        typeof topic0 === 'string'
          ? nativeToScVal(topic0, { type: 'symbol' }).toXDR('base64')
          : nativeToScVal(topic0).toXDR('base64'),
        nativeToScVal(topic1, { type: 'u64' }).toXDR('base64'),
      ],
      value: nativeToScVal(valueData).toXDR('base64'),
    };
  }

  it('throws clear, typed UnrecognizedContractEventError on structurally-valid XDR with unrecognized discriminant', () => {
    const raw = buildRawEvent('FutureStreamFeatureV2', 42n, {
      deposit: 500n,
      unrecognizedField: true,
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
    expect((caught as UnrecognizedContractEventError).rawType).toBe('FutureStreamFeatureV2');
    expect((caught as UnrecognizedContractEventError).message).toContain('FutureStreamFeatureV2');
  });

  it('throws UnrecognizedContractEventError when topic discriminant is empty or non-string', () => {
    const rawMissing = {
      type: 'contract',
      ledger: 100,
      ledgerClosedAt: '2026-01-01T12:00:00Z',
      contractId: CONTRACT,
      id: '1',
      pagingToken: '1',
      inSuccessfulContractCall: true,
      txHash: 'abc',
      topic: [],
      value: nativeToScVal({}).toXDR('base64'),
    } as unknown as rpc.Api.EventResponse;

    expect(() => parseContractEvent(rawMissing)).toThrow(UnrecognizedContractEventError);
  });

  it('continues parsing all 8 recognized event types correctly', () => {
    // 1. StreamCreated
    const createdEvent = buildRawEvent('StreamCreated', 1n, {
      sender: SENDER,
      recipient: RECIPIENT,
      token: TOKEN,
      deposit: 1000n,
      flow_rate: 10n,
      start_time: 1700000000,
      end_time: 1700000100,
    });
    const created = parseContractEvent(createdEvent);
    expect(created.type).toBe('StreamCreated');
    if (created.type === 'StreamCreated') {
      expect(created.streamId).toBe('1');
      expect(created.sender).toBe(SENDER);
      expect(created.recipient).toBe(RECIPIENT);
      expect(created.deposit).toBe(1000n);
      expect(created.flowRate).toBe(10n);
      expect(created.startTime).toBe(1700000000);
      expect(created.endTime).toBe(1700000100);
    }

    // 2. StreamWithdrawn
    const withdrawnEvent = buildRawEvent('StreamWithdrawn', 2n, {
      recipient: RECIPIENT,
      amount: 250n,
      withdraw_time: 1700000050,
    });
    const withdrawn = parseContractEvent(withdrawnEvent);
    expect(withdrawn.type).toBe('StreamWithdrawn');
    if (withdrawn.type === 'StreamWithdrawn') {
      expect(withdrawn.streamId).toBe('2');
      expect(withdrawn.recipient).toBe(RECIPIENT);
      expect(withdrawn.amount).toBe(250n);
      expect(withdrawn.withdrawTime).toBe(1700000050);
    }

    // 3. StreamCancelled
    const cancelledEvent = buildRawEvent('StreamCancelled', 3n, {
      sender: SENDER,
      refunded: 750n,
    });
    const cancelled = parseContractEvent(cancelledEvent);
    expect(cancelled.type).toBe('StreamCancelled');
    if (cancelled.type === 'StreamCancelled') {
      expect(cancelled.streamId).toBe('3');
      expect(cancelled.sender).toBe(SENDER);
      expect(cancelled.refunded).toBe(750n);
    }

    // 4. StreamCompleted
    const completedEvent = buildRawEvent('StreamCompleted', 4n, {
      sender: SENDER,
      recipient: RECIPIENT,
    });
    const completed = parseContractEvent(completedEvent);
    expect(completed.type).toBe('StreamCompleted');
    if (completed.type === 'StreamCompleted') {
      expect(completed.streamId).toBe('4');
      expect(completed.sender).toBe(SENDER);
      expect(completed.recipient).toBe(RECIPIENT);
    }

    // 5. StreamToppedUp
    const toppedUpEvent = buildRawEvent('StreamToppedUp', 5n, {
      added_amount: 500n,
      new_end_time: 1700000200,
    });
    const toppedUp = parseContractEvent(toppedUpEvent);
    expect(toppedUp.type).toBe('StreamToppedUp');
    if (toppedUp.type === 'StreamToppedUp') {
      expect(toppedUp.streamId).toBe('5');
      expect(toppedUp.addedAmount).toBe(500n);
      expect(toppedUp.newEndTime).toBe(1700000200);
    }

    // 6. StreamPaused
    const pausedEvent = buildRawEvent('StreamPaused', 6n, {
      sender: SENDER,
      paused_at: 1700000040,
    });
    const paused = parseContractEvent(pausedEvent);
    expect(paused.type).toBe('StreamPaused');
    if (paused.type === 'StreamPaused') {
      expect(paused.streamId).toBe('6');
      expect(paused.sender).toBe(SENDER);
      expect(paused.pausedAt).toBe(1700000040);
    }

    // 7. StreamResumed
    const resumedEvent = buildRawEvent('StreamResumed', 7n, {
      sender: SENDER,
      resumed_at: 1700000060,
    });
    const resumed = parseContractEvent(resumedEvent);
    expect(resumed.type).toBe('StreamResumed');
    if (resumed.type === 'StreamResumed') {
      expect(resumed.streamId).toBe('7');
      expect(resumed.sender).toBe(SENDER);
      expect(resumed.resumedAt).toBe(1700000060);
    }

    // 8. StreamTransferred
    const transferredEvent = buildRawEvent('StreamTransferred', 8n, {
      old_recipient: RECIPIENT,
      new_recipient: SENDER,
    });
    const transferred = parseContractEvent(transferredEvent);
    expect(transferred.type).toBe('StreamTransferred');
    if (transferred.type === 'StreamTransferred') {
      expect(transferred.streamId).toBe('8');
      expect(transferred.oldRecipient).toBe(RECIPIENT);
      expect(transferred.newRecipient).toBe(SENDER);
    }
  });
});

// =============================================================================
// Issue #784: request-queue priority-lane ordering under capacity contention
// =============================================================================

describe('Issue #784: request-queue priority-lane ordering at capacity', () => {
  it('dequeues high-priority write before low-priority read when enqueued in the same tick (read enqueued first)', async () => {
    // maxConcurrent: 1 ensures only 1 task is in flight; capacity is immediately full
    const queue = new PriorityRequestQueue({
      maxConcurrent: 1,
      priorityLanes: ['write', 'read'],
    });

    const executionOrder: string[] = [];
    const delayedEvents: RateLimitDelayedPayload[] = [];
    queue.onDelayed = (payload) => {
      delayedEvents.push(payload);
    };

    let releaseBlocker!: () => void;
    const blockerPromise = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });

    // Fill capacity to 100%
    const blockerDone = queue.enqueue('read', async () => {
      executionOrder.push('blocker:start');
      await blockerPromise;
      executionOrder.push('blocker:end');
      return 'blocker';
    });

    // In the SAME TICK, enqueue low-priority read first, high-priority write second
    const readPromise = queue.enqueue(
      'read',
      async () => {
        executionOrder.push('read:executed');
        return 'read-result';
      },
      { priority: 'low' },
    );

    const writePromise = queue.enqueue(
      'write',
      async () => {
        executionOrder.push('write:executed');
        return 'write-result';
      },
      { priority: 'high' },
    );

    // Verify rateLimitDelayed events fired for both queued requests
    expect(delayedEvents).toHaveLength(2);
    const readDelayed = delayedEvents.find((e) => e.lane === 'read');
    const writeDelayed = delayedEvents.find((e) => e.lane === 'write');

    expect(readDelayed).toBeDefined();
    expect(readDelayed?.lane).toBe('read');
    expect(typeof readDelayed?.estimatedWaitMs).toBe('number');
    expect(typeof readDelayed?.queueDepth).toBe('number');

    expect(writeDelayed).toBeDefined();
    expect(writeDelayed?.lane).toBe('write');

    // Free the concurrency slot
    releaseBlocker();
    await Promise.all([blockerDone, writePromise, readPromise]);

    // High-priority write MUST be dequeued and processed before low-priority read
    const writeIndex = executionOrder.indexOf('write:executed');
    const readIndex = executionOrder.indexOf('read:executed');

    expect(writeIndex).toBeGreaterThan(-1);
    expect(readIndex).toBeGreaterThan(-1);
    expect(writeIndex).toBeLessThan(readIndex);
  });

  it('dequeues high-priority write before low-priority read when enqueued in the same tick (write enqueued first)', async () => {
    const queue = new PriorityRequestQueue({
      maxConcurrent: 1,
      priorityLanes: ['write', 'read'],
    });

    const executionOrder: string[] = [];
    let releaseBlocker!: () => void;
    const blockerPromise = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });

    const blockerDone = queue.enqueue('write', async () => {
      executionOrder.push('blocker');
      await blockerPromise;
      return 'blocker';
    });

    // In the SAME TICK, enqueue high-priority write first, low-priority read second
    const writePromise = queue.enqueue(
      'write',
      async () => {
        executionOrder.push('write:executed');
        return 'write';
      },
      { priority: 'high' },
    );

    const readPromise = queue.enqueue(
      'read',
      async () => {
        executionOrder.push('read:executed');
        return 'read';
      },
      { priority: 'low' },
    );

    releaseBlocker();
    await Promise.all([blockerDone, writePromise, readPromise]);

    const writeIndex = executionOrder.indexOf('write:executed');
    const readIndex = executionOrder.indexOf('read:executed');

    expect(writeIndex).toBeLessThan(readIndex);
  });
});

// =============================================================================
// Issue #785: wsTransport reconnect attempt counter reset after successful reconnect
// =============================================================================

describe('Issue #785: wsTransport reconnect attempt counter reset on successful reconnect', () => {
  class MockSocket {
    static instances: MockSocket[] = [];
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;

    constructor() {
      MockSocket.instances.push(this);
    }
    send(m: string) {
      this.sent.push(m);
    }
    close() {}
  }

  function makeHttp(): RpcTransportAdapter {
    return {
      getEvents: vi.fn().mockResolvedValue({ events: [], latestLedger: 1, cursor: '' }),
    } as unknown as RpcTransportAdapter;
  }

  beforeEach(() => {
    MockSocket.instances = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    MockSocket.instances = [];
    vi.useRealTimers();
  });

  it('resets attempt counter to zero on successful reconnect and survives full maxAttempts in subsequent cycle', () => {
    const CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
    const http = makeHttp();
    const maxAttempts = 3;

    const transport = new WebSocketTransportAdapter({
      wsUrl: 'wss://rpc.example',
      http,
      reconnect: { maxAttempts, baseDelayMs: 100, maxDelayMs: 1000 },
      webSocketFactory: () => new MockSocket() as unknown as WebSocket,
    });

    const poller = new EventPoller(transport, CONTRACT);
    poller.subscribe('test-key', { filter: () => true, callback: () => {} });

    // 1. Initial connection
    expect(MockSocket.instances).toHaveLength(1);
    const wsInitial = MockSocket.instances[0]!;
    wsInitial.onopen!();
    expect(http.getEvents).not.toHaveBeenCalled();

    // 2. Disconnect initial connection
    wsInitial.onclose!();

    // Cycle 1: Failed reconnect attempt 1 (delay: 100ms * 2^0 = 100ms)
    vi.advanceTimersByTime(100);
    expect(MockSocket.instances).toHaveLength(2);
    const wsAttempt1 = MockSocket.instances[1]!;
    wsAttempt1.onclose!(); // fails

    // Cycle 1: Reconnect attempt 2 (delay: 100ms * 2^1 = 200ms)
    vi.advanceTimersByTime(200);
    expect(MockSocket.instances).toHaveLength(3);
    const wsAttempt2 = MockSocket.instances[2]!;

    // Reconnect attempt 2 SUCCEEDS!
    wsAttempt2.onopen!();
    expect(http.getEvents).not.toHaveBeenCalled();

    // 3. Cycle 2: A subsequent disconnect occurs on the reconnected socket
    wsAttempt2.onclose!();

    // If attempts counter was NOT reset to zero, attempts would have been 2 + 1 = 3,
    // and a single failure here would immediately exhaust maxAttempts (3).
    // Because it WAS reset to zero:
    // Attempt 1 of cycle 2 (delay: 100ms * 2^0 = 100ms)
    vi.advanceTimersByTime(99);
    expect(MockSocket.instances).toHaveLength(3); // not yet 4
    vi.advanceTimersByTime(1);
    expect(MockSocket.instances).toHaveLength(4);
    const wsCycle2Attempt1 = MockSocket.instances[3]!;
    wsCycle2Attempt1.onclose!(); // fails attempt 1
    expect(http.getEvents).not.toHaveBeenCalled();

    // Attempt 2 of cycle 2 (delay: 100ms * 2^1 = 200ms)
    vi.advanceTimersByTime(200);
    expect(MockSocket.instances).toHaveLength(5);
    const wsCycle2Attempt2 = MockSocket.instances[4]!;
    wsCycle2Attempt2.onclose!(); // fails attempt 2
    expect(http.getEvents).not.toHaveBeenCalled();

    // Attempt 3 of cycle 2 (delay: 100ms * 2^2 = 400ms)
    vi.advanceTimersByTime(400);
    expect(MockSocket.instances).toHaveLength(6);
    const wsCycle2Attempt3 = MockSocket.instances[5]!;
    expect(http.getEvents).not.toHaveBeenCalled();

    // Now fail attempt 3 of cycle 2: maxAttempts (3) reached!
    wsCycle2Attempt3.onclose!();

    // 4. Fallback to HTTP polling occurs correctly after maxAttempts in this cycle
    expect(http.getEvents).toHaveBeenCalled();

    poller.destroy();
  });
});
