/**
 * Tests for issues #385, #386, #387, #388
 *
 * #385 — onStreamCompleted callback fires when a watched stream reaches endTime.
 * #386 — aggregateStreams computes TVL, averageRate, and statusBreakdown.
 * #387 — withFeeBump wraps an inner transaction in a fee-bump envelope.
 * #388 — buildMetadataUri / parseMetadataUri round-trip for structured metadata.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  Keypair,
  TransactionBuilder,
  Networks,
  Account,
  BASE_FEE,
  Operation,
  Asset,
  FeeBumpTransaction,
  Transaction,
} from '@stellar/stellar-sdk';
import {
  watchClaimable,
  aggregateStreams,
  withFeeBump,
  buildMetadataUri,
  parseMetadataUri,
} from '../src/utils.js';
import type { Stream, StreamCompletedSummary, StreamsAggregate } from '../src/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeStream(overrides: Partial<Stream> = {}): Stream {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: 'stream-1',
    sender: 'GSENDER000000000000000000000000000000000000000000000000000',
    recipient: 'GRECIPIENT0000000000000000000000000000000000000000000000000',
    token: 'GTOKEN000000000000000000000000000000000000000000000000000000',
    deposit: 3_600_000n, // 1 stroop/sec × 3600 sec
    flowRate: 1_000n,    // 1000 stroops/sec
    startTime: now - 100,
    endTime: now + 3500,
    lastWithdrawTime: now - 100,
    status: 'Active',
    autoRenew: false,
    ...overrides,
  };
}

/** Builds a minimal signed test transaction on TESTNET. */
function makeTestTransaction(): Transaction {
  const kp = Keypair.random();
  const account = new Account(kp.publicKey(), '0');
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: kp.publicKey(),
        asset: Asset.native(),
        amount: '1',
      }),
    )
    .setTimeout(30)
    .build();
  tx.sign(kp);
  return tx;
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue #385 — onStreamCompleted callback
// ─────────────────────────────────────────────────────────────────────────────

describe('Issue #385: onStreamCompleted callback', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onStreamCompleted once when stream endTime is reached', () => {
    vi.useFakeTimers();

    const now = Math.floor(Date.now() / 1000);
    // Stream ends in 500 ms (0.5 real seconds = 500 ms fake time).
    const stream = makeStream({
      endTime: now + 1, // 1 second in the future (real seconds)
    });

    const onCompleted = vi.fn();
    const onTick = vi.fn();
    const reconcile = vi.fn().mockResolvedValue(1000n);

    const unsubscribe = watchClaimable(stream, reconcile, onTick, {
      tickMs: 100,
      reconcileMs: 10_000,
      onStreamCompleted: onCompleted,
    });

    // Not fired yet (stream hasn't ended).
    expect(onCompleted).not.toHaveBeenCalled();

    // Advance past the stream's endTime (1 second = 1000 ms).
    vi.advanceTimersByTime(1500);

    expect(onCompleted).toHaveBeenCalledTimes(1);
    const [calledId, summary] = onCompleted.mock.calls[0] as [string, StreamCompletedSummary];
    expect(calledId).toBe(stream.id);
    expect(summary.streamId).toBe(stream.id);
    expect(summary.endTime).toBe(stream.endTime);
    expect(summary.totalStreamed).toBe(stream.deposit);

    // Advancing further must NOT fire the callback again (fires exactly once).
    vi.advanceTimersByTime(3000);
    expect(onCompleted).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it('does NOT fire onStreamCompleted when stream has not yet ended', () => {
    vi.useFakeTimers();

    const stream = makeStream({ endTime: Math.floor(Date.now() / 1000) + 9999 });
    const onCompleted = vi.fn();
    const onTick = vi.fn();

    const unsubscribe = watchClaimable(
      stream,
      vi.fn().mockResolvedValue(0n),
      onTick,
      {
        tickMs: 100,
        reconcileMs: 10_000,
        onStreamCompleted: onCompleted,
      },
    );

    vi.advanceTimersByTime(500);
    expect(onCompleted).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('does NOT fire onStreamCompleted when option is not provided', () => {
    vi.useFakeTimers();
    const now = Math.floor(Date.now() / 1000);
    const stream = makeStream({ endTime: now + 1 });
    const onTick = vi.fn();

    // Should not throw even without the option
    const unsubscribe = watchClaimable(
      stream,
      vi.fn().mockResolvedValue(0n),
      onTick,
      { tickMs: 100, reconcileMs: 10_000 },
    );

    vi.advanceTimersByTime(2000);
    // Just making sure no error is thrown
    expect(onTick).toHaveBeenCalled();
    unsubscribe();
  });

  it('fires for a stream that is already past its endTime on subscribe', () => {
    vi.useFakeTimers();
    const now = Math.floor(Date.now() / 1000);
    // Stream ended in the past.
    const stream = makeStream({ endTime: now - 60, status: 'Completed' });

    const onCompleted = vi.fn();
    const onTick = vi.fn();

    const unsubscribe = watchClaimable(
      stream,
      vi.fn().mockResolvedValue(0n),
      onTick,
      { tickMs: 100, reconcileMs: 10_000, onStreamCompleted: onCompleted },
    );

    // Advance at least one tick.
    vi.advanceTimersByTime(200);
    expect(onCompleted).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #386 — aggregateStreams utility
// ─────────────────────────────────────────────────────────────────────────────

describe('Issue #386: aggregateStreams utility', () => {
  it('returns zeros for an empty stream list', () => {
    const result = aggregateStreams([]);
    expect(result.totalStreams).toBe(0);
    expect(result.totalValueLocked).toBe(0n);
    expect(result.averageRate).toBe(0n);
    expect(result.statusBreakdown).toEqual({ active: 0, cancelled: 0, completed: 0 });
  });

  it('computes totalValueLocked from active stream deposits', () => {
    const now = Math.floor(Date.now() / 1000);
    const streams: Stream[] = [
      makeStream({
        id: '1',
        deposit: 1_000_000n,
        flowRate: 100n,
        startTime: now - 10000,
        endTime: now, // fully elapsed: 100 * 10000 = 1_000_000 → TVL = 0
        lastWithdrawTime: now - 10000,
        status: 'Active',
      }),
      makeStream({
        id: '2',
        deposit: 500_000n,
        flowRate: 50n,
        // Start 60 seconds in the future — elapsed is 0 at test time.
        startTime: now + 60,
        endTime: now + 10000,
        lastWithdrawTime: now + 60,
        status: 'Active',
      }),
    ];

    const result: StreamsAggregate = aggregateStreams(streams);
    expect(result.totalStreams).toBe(2);
    // Stream 1: fully elapsed (10000s) → released = 100 * 10000 = 1_000_000 → TVL = 0
    // Stream 2: starts in future → elapsed = 0 → TVL = 500_000
    expect(result.totalValueLocked).toBe(500_000n);
    expect(result.averageRate).toBe(75n); // (100 + 50) / 2
    expect(result.statusBreakdown.active).toBe(2);
    expect(result.statusBreakdown.cancelled).toBe(0);
    expect(result.statusBreakdown.completed).toBe(0);
  });

  it('excludes cancelled and completed streams from TVL and averageRate', () => {
    const now = Math.floor(Date.now() / 1000);
    const streams: Stream[] = [
      makeStream({ id: '1', deposit: 1_000_000n, flowRate: 100n, startTime: now + 60, lastWithdrawTime: now + 60, endTime: now + 9999, status: 'Active' }),
      makeStream({ id: '2', deposit: 500_000n, flowRate: 50n, startTime: now + 60, lastWithdrawTime: now + 60, endTime: now + 9999, status: 'Cancelled' }),
      makeStream({ id: '3', deposit: 200_000n, flowRate: 20n, startTime: now + 60, lastWithdrawTime: now + 60, endTime: now + 9999, status: 'Completed' }),
    ];

    const result = aggregateStreams(streams);
    expect(result.totalStreams).toBe(3);
    // Only the active stream contributes. It starts in future so TVL = full deposit.
    expect(result.totalValueLocked).toBe(1_000_000n);
    expect(result.averageRate).toBe(100n);
    expect(result.statusBreakdown).toEqual({ active: 1, cancelled: 1, completed: 1 });
  });

  it('subtracts already-streamed tokens from TVL', () => {
    const now = Math.floor(Date.now() / 1000);
    const startTime = now - 1000; // 1000 seconds ago
    const flowRate = 100n;
    // 100 * 1000 = 100_000 already streamed; deposit = 500_000; TVL = 400_000
    const stream = makeStream({
      deposit: 500_000n,
      flowRate,
      startTime,
      lastWithdrawTime: startTime, // never withdrawn
      status: 'Active',
    });

    const result = aggregateStreams([stream]);
    expect(result.totalValueLocked).toBe(400_000n);
  });

  it('averageRate is 0n when there are no active streams', () => {
    const stream = makeStream({ status: 'Cancelled' });
    const result = aggregateStreams([stream]);
    expect(result.averageRate).toBe(0n);
    expect(result.totalValueLocked).toBe(0n);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #387 — withFeeBump helper
// ─────────────────────────────────────────────────────────────────────────────

describe('Issue #387: withFeeBump helper', () => {
  it('wraps a Transaction object in a FeeBumpTransaction', () => {
    const feeSource = Keypair.random().publicKey();
    const inner = makeTestTransaction();

    const bump = withFeeBump(inner, feeSource, { networkPassphrase: Networks.TESTNET });

    expect(bump).toBeInstanceOf(FeeBumpTransaction);
    expect(bump.feeSource).toBe(feeSource);
  });

  it('wraps an XDR string in a FeeBumpTransaction', () => {
    const feeSource = Keypair.random().publicKey();
    const inner = makeTestTransaction();
    const xdr = inner.toEnvelope().toXDR('base64');

    const bump = withFeeBump(xdr, feeSource, { networkPassphrase: Networks.TESTNET });

    expect(bump).toBeInstanceOf(FeeBumpTransaction);
    expect(bump.feeSource).toBe(feeSource);
  });

  it('uses the provided baseFee for the fee-bump envelope', () => {
    const feeSource = Keypair.random().publicKey();
    const inner = makeTestTransaction();

    const bump = withFeeBump(inner, feeSource, {
      baseFee: 1000,
      networkPassphrase: Networks.TESTNET,
    });

    // The fee of the outer envelope is baseFee * (inner ops + 1 virtual op).
    expect(Number(bump.fee)).toBeGreaterThanOrEqual(1000);
  });

  it('defaults to TESTNET passphrase when none is provided', () => {
    const feeSource = Keypair.random().publicKey();
    const inner = makeTestTransaction(); // built on TESTNET

    // Should not throw when using a TESTNET inner tx without explicit passphrase.
    const bump = withFeeBump(inner, feeSource);
    expect(bump).toBeInstanceOf(FeeBumpTransaction);
  });

  it('produces a FeeBumpTransaction even when using an alternative network passphrase', () => {
    const feeSource = Keypair.random().publicKey();
    const inner = makeTestTransaction(); // TESTNET
    const xdr = inner.toEnvelope().toXDR('base64');

    // stellar-sdk's fromXDR does not validate the passphrase at parse time;
    // the resulting fee-bump transaction will have the provided passphrase set.
    const bump = withFeeBump(xdr, feeSource, { networkPassphrase: Networks.PUBLIC });
    expect(bump).toBeInstanceOf(FeeBumpTransaction);
    // The envelope should encode the PUBLIC passphrase, not TESTNET.
    expect(bump.networkPassphrase).toBe(Networks.PUBLIC);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #388 — buildMetadataUri / parseMetadataUri
// ─────────────────────────────────────────────────────────────────────────────

describe('Issue #388: buildMetadataUri / parseMetadataUri', () => {
  it('serialises fields to a URI-safe key=value string', () => {
    const uri = buildMetadataUri({ label: 'Alice Salary', category: 'payroll' });
    expect(uri).toBe('category=payroll&label=Alice%20Salary');
  });

  it('sorts keys alphabetically for deterministic output', () => {
    const uri1 = buildMetadataUri({ z: 'last', a: 'first' });
    const uri2 = buildMetadataUri({ a: 'first', z: 'last' });
    expect(uri1).toBe(uri2);
    expect(uri1).toMatch(/^a=first/);
  });

  it('omits undefined and empty-string values', () => {
    const uri = buildMetadataUri({ label: 'hello', category: '', namespace: undefined });
    expect(uri).toBe('label=hello');
  });

  it('produces an empty string for an empty fields object', () => {
    expect(buildMetadataUri({})).toBe('');
  });

  it('percent-encodes special characters in keys and values', () => {
    const uri = buildMetadataUri({ 'my key': 'hello world & more' });
    expect(uri).toBe('my%20key=hello%20world%20%26%20more');
  });

  it('round-trips through parseMetadataUri', () => {
    const original = { label: 'Alice Salary', category: 'payroll', namespace: 'acme' };
    const uri = buildMetadataUri(original);
    const parsed = parseMetadataUri(uri);
    expect(parsed).toEqual(original);
  });

  it('parseMetadataUri returns an empty object for an empty string', () => {
    expect(parseMetadataUri('')).toEqual({});
  });

  it('parseMetadataUri handles percent-encoded values correctly', () => {
    const parsed = parseMetadataUri('label=Alice%20Salary&category=payroll%20%26%20grant');
    expect(parsed.label).toBe('Alice Salary');
    expect(parsed.category).toBe('payroll & grant');
  });

  it('throws SoroStreamValidationError when URI exceeds 128 bytes', () => {
    const longValue = 'x'.repeat(130);
    expect(() => buildMetadataUri({ label: longValue })).toThrow();
  });

  it('handles a namespace field without error', () => {
    const uri = buildMetadataUri({ namespace: 'tenant-1', label: 'Vesting' });
    expect(uri).toContain('namespace=tenant-1');
    expect(uri).toContain('label=Vesting');
  });
});
