/**
 * @sorostream/sdk/simulator
 *
 * Deterministic stream-state simulator for testing time-dependent SDK logic
 * (accrual calculations, expiry callbacks) without on-chain calls or real
 * timers.
 *
 * @example
 * ```ts
 * import { StreamSimulator } from "@sorostream/sdk/simulator";
 *
 * const sim = new StreamSimulator();
 * sim.onExpire(stream.id, (s) => console.log(`${s.id} expired`));
 * sim.advance(3600, [stream]);
 * const claimable = sim.claimableAt(stream);
 * ```
 */

import type { Stream } from './types.js';
import { safeClaimable } from './utils.js';

export type StreamExpiryCallback = (stream: Stream) => void;

/**
 * Why a simulated withdraw failed:
 * - `storageExpired`: contract storage entry passed its TTL (by ledger or timestamp) and must be restored first.
 * - `streamNotActive`: the stream is cancelled or completed, so nothing can be withdrawn.
 * - `insufficientClaimable`: requested amount exceeds the claimable balance.
 */
export type SimulatedWithdrawFailureReason =
  | 'storageExpired'
  | 'streamNotActive'
  | 'insufficientClaimable';

/** Result of {@link StreamSimulator.simulateWithdraw}. */
export interface SimulatedWithdrawResult {
  /** Whether the withdraw would succeed against the simulated state. */
  success: boolean;
  /** Amount that would be transferred on success (stroops). */
  amount: bigint;
  /** Claimable balance at the simulated time, before the withdraw. */
  claimable: bigint;
  /** Set when `success` is false. */
  reason?: SimulatedWithdrawFailureReason;
  /** Human-readable, actionable explanation when `success` is false. */
  error?: string;
  /** Ledger sequence at which the simulation was evaluated. */
  ledger?: number;
}

/**
 * Advances a virtual clock by an arbitrary number of seconds and evaluates
 * stream accrual / expiry against it, mirroring the contract's flow-rate
 * math without requiring a live RPC connection.
 */
export class StreamSimulator {
  private clockOffsetSeconds = 0;
  private currentLedgerSeq = 0;
  private expiryCallbacks = new Map<string, StreamExpiryCallback>();
  private firedExpiry = new Set<string>();
  private storageTtl = new Map<string, number>();
  private storageTtlLedgers = new Map<string, number>();

  /** Current simulated unix timestamp (seconds). */
  now(): number {
    return Math.floor(Date.now() / 1000) + this.clockOffsetSeconds;
  }

  /** Current simulated ledger sequence. */
  getLedger(): number {
    return this.currentLedgerSeq;
  }

  /** Sets the current simulated ledger sequence. */
  setLedger(ledger: number): void {
    if (ledger < 0) throw new Error('ledger must be >= 0');
    this.currentLedgerSeq = ledger;
  }

  /** Advances the simulated ledger sequence by `ledgers` count. */
  advanceLedgers(ledgers: number): void {
    if (ledgers < 0) throw new Error('ledgers must be >= 0');
    this.currentLedgerSeq += ledgers;
  }

  /**
   * Advances the simulated clock by `seconds`. Any stream in `streams` whose
   * `endTime` is newly crossed fires its registered expiry callback exactly
   * once. Optionally also advances ledger count (defaults to seconds / 5 if ledgers omitted and seconds > 0).
   */
  advance(seconds: number, streams: Stream[] = [], ledgers?: number): void {
    if (seconds < 0) throw new Error('seconds must be >= 0');
    this.clockOffsetSeconds += seconds;
    if (ledgers !== undefined) {
      if (ledgers < 0) throw new Error('ledgers must be >= 0');
      this.currentLedgerSeq += ledgers;
    }
    const now = this.now();
    for (const stream of streams) {
      if (!this.firedExpiry.has(stream.id) && now >= stream.endTime) {
        this.firedExpiry.add(stream.id);
        this.expiryCallbacks.get(stream.id)?.(stream);
      }
    }
  }

  /** Registers a callback fired the first time `advance` crosses the stream's `endTime`. */
  onExpire(streamId: string, callback: StreamExpiryCallback): void {
    this.expiryCallbacks.set(streamId, callback);
  }

  /** Computes the claimable amount for a stream at the simulator's current simulated time. */
  claimableAt(stream: Stream): bigint {
    if (stream.status === 'Cancelled' || stream.status === 'Completed') return 0n;
    const now = this.now();
    if (stream.lockUntil !== undefined && now < stream.lockUntil) return 0n;
    if (stream.status === 'Paused') {
      const effectiveNow = Math.min(stream.pausedAt ?? now, stream.endTime);
      const elapsed = Math.max(0, effectiveNow - stream.lastWithdrawTime);
      return safeClaimable(stream.flowRate, BigInt(elapsed), stream.deposit);
    }
    const effectiveNow = Math.min(now, stream.endTime);
    const elapsed = Math.max(0, effectiveNow - stream.lastWithdrawTime);
    return safeClaimable(stream.flowRate, BigInt(elapsed), stream.deposit);
  }

  /**
   * Records the contract storage entry TTL for a stream: the unix timestamp
   * (seconds) at which the entry expires and the contract state must be
   * restored before writes (e.g. withdraw) can succeed on-chain.
   */
  setStorageTtl(streamId: string, expiresAt: number): void {
    if (expiresAt < 0) throw new Error('expiresAt must be >= 0');
    this.storageTtl.set(streamId, expiresAt);
  }

  /** Removes any recorded storage TTL timestamp for a stream. */
  clearStorageTtl(streamId: string): void {
    this.storageTtl.delete(streamId);
  }

  /**
   * Records the contract storage entry TTL boundary ledger for a stream:
   * the exact ledger sequence at which the entry expires and becomes archived.
   * In Soroban, an entry is valid for inclusion while ledger <= liveUntilLedgerSeq;
   * at the boundary ledger where it expires, the entry is expired/archived.
   */
  setStorageTtlLedger(streamId: string, expiryLedger: number): void {
    if (expiryLedger < 0) throw new Error('expiryLedger must be >= 0');
    this.storageTtlLedgers.set(streamId, expiryLedger);
  }

  /** Removes any recorded storage TTL ledger sequence for a stream. */
  clearStorageTtlLedger(streamId: string): void {
    this.storageTtlLedgers.delete(streamId);
  }

  /**
   * True when the stream's recorded storage TTL has expired at the evaluated time or ledger.
   */
  isStorageExpired(
    streamId: string,
    at?: number | { timestamp?: number; ledger?: number },
  ): boolean {
    let checkTime = this.now();
    let checkLedger = this.currentLedgerSeq;

    if (typeof at === 'number') {
      checkTime = at;
    } else if (at && typeof at === 'object') {
      if (at.timestamp !== undefined) checkTime = at.timestamp;
      if (at.ledger !== undefined) checkLedger = at.ledger;
    }

    const expiresAt = this.storageTtl.get(streamId);
    if (expiresAt !== undefined && checkTime >= expiresAt) {
      return true;
    }

    const expiryLedger = this.storageTtlLedgers.get(streamId);
    if (expiryLedger !== undefined && checkLedger >= expiryLedger) {
      return true;
    }

    return false;
  }

  /**
   * Simulates a withdraw against the current simulated state, factoring in
   * contract storage TTL expiry: a withdraw against an expired storage entry
   * reports a distinct `storageExpired` failure with an actionable remedy,
   * mirroring the on-chain behaviour where the entry must be restored before
   * the write can succeed.
   */
  simulateWithdraw(
    stream: Stream,
    amount?: bigint,
    opts?: { ledger?: number; timestamp?: number },
  ): SimulatedWithdrawResult {
    const claimable = this.claimableAt(stream);
    const evalLedger = opts?.ledger ?? this.currentLedgerSeq;

    const fail = (
      reason: SimulatedWithdrawFailureReason,
      error: string,
    ): SimulatedWithdrawResult => ({
      success: false,
      amount: 0n,
      claimable,
      reason,
      error,
      ledger: evalLedger,
    });

    if (this.isStorageExpired(stream.id, opts)) {
      const expiryLedger = this.storageTtlLedgers.get(stream.id);
      const expiresAt = this.storageTtl.get(stream.id);
      const boundaryMsg =
        expiryLedger !== undefined
          ? `ledger ${expiryLedger}`
          : `timestamp ${expiresAt}`;
      return fail(
        'storageExpired',
        `Contract storage entry for stream ${stream.id} expired at ${boundaryMsg} and must be ` +
          `restored (e.g. via a storage-rent top-up) before a withdraw can be submitted.`,
      );
    }

    if (stream.status === 'Cancelled' || stream.status === 'Completed') {
      return fail(
        'streamNotActive',
        `Stream ${stream.id} is ${stream.status}; no withdraw is possible.`,
      );
    }

    const target = amount ?? claimable;
    if (target > claimable) {
      return fail(
        'insufficientClaimable',
        `Requested ${target} exceeds the claimable balance of ${claimable} at the simulated time.`,
      );
    }

    return {
      success: true,
      amount: target,
      claimable,
      ledger: evalLedger,
    };
  }

  /** Resets the simulated clock and ledger sequence to zero and clears expiry/TTL state. */
  reset(): void {
    this.clockOffsetSeconds = 0;
    this.currentLedgerSeq = 0;
    this.firedExpiry.clear();
    this.storageTtl.clear();
    this.storageTtlLedgers.clear();
  }
}
