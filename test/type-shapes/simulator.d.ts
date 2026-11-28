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
export type StreamExpiryCallback = (stream: Stream) => void;
/**
 * Why a simulated withdraw failed:
 * - `storageExpired`: contract storage entry passed its TTL and must be restored first.
 * - `streamNotActive`: the stream is cancelled or completed, so nothing can be withdrawn.
 * - `insufficientClaimable`: requested amount exceeds the claimable balance.
 */
export type SimulatedWithdrawFailureReason = 'storageExpired' | 'streamNotActive' | 'insufficientClaimable';
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
    /** Ledger sequence the check was evaluated at (`opts.ledger` if given, else the simulator's current ledger). */
    ledger: number;
}
/**
 * Advances a virtual clock by an arbitrary number of seconds and evaluates
 * stream accrual / expiry against it, mirroring the contract's flow-rate
 * math without requiring a live RPC connection.
 */
export declare class StreamSimulator {
    private clockOffsetSeconds;
    private currentLedgerSeq;
    private expiryCallbacks;
    /**
     * `endTime`s whose expiry has already fired, per stream ID. Keyed by both so
     * a renewed stream (same ID, later `endTime`) can fire again (issue #948).
     */
    private firedExpiry;
    private storageTtl;
    private storageTtlLedger;
    /** Current simulated unix timestamp (seconds). */
    now(): number;
    /** Current simulated ledger sequence. */
    getLedger(): number;
    /** Sets the current simulated ledger sequence. */
    setLedger(ledger: number): void;
    /** Advances the simulated ledger sequence by `ledgers` count. */
    advanceLedgers(ledgers: number): void;
    /**
     * Advances the simulated clock by `seconds`. Any stream in `streams` whose
     * `endTime` is newly crossed fires its registered expiry callback exactly
     * once per distinct `endTime`. Optionally also advances ledger count (defaults to seconds / 5 if ledgers omitted and seconds > 0).
     */
    advance(seconds: number, streams?: Stream[], ledgers?: number): void;
    /**
     * Registers a callback fired the first time `advance` crosses the stream's `endTime`.
     * If the stream is later renewed (same ID, extended `endTime`), the callback
     * fires again when the new `endTime` is crossed.
     */
    onExpire(streamId: string, callback: StreamExpiryCallback): void;
    /** Computes the claimable amount for a stream at the simulator's current simulated time. */
    claimableAt(stream: Stream): bigint;
    /**
     * Records the contract storage entry TTL for a stream: the unix timestamp
     * (seconds) at which the entry expires and the contract state must be
     * restored before writes (e.g. withdraw) can succeed on-chain.
     */
    setStorageTtl(streamId: string, expiresAt: number): void;
    /** Removes any recorded storage TTL for a stream (treated as never expiring). */
    clearStorageTtl(streamId: string): void;
    /**
     * Records the contract storage entry TTL for a stream in terms of ledger
     * sequence number rather than unix timestamp, mirroring the on-chain
     * `bump_ttl`/TTL-extension model where storage rent is tracked in ledgers.
     * Independent of {@link setStorageTtl}; a stream may have either, both, or
     * neither kind of TTL recorded, and expiry under either is sufficient to
     * fail a simulated withdraw.
     */
    setStorageTtlLedger(streamId: string, ledger: number): void;
    /** Removes any recorded ledger-based storage TTL for a stream (treated as never expiring). */
    clearStorageTtlLedger(streamId: string): void;
    /**
     * True when the stream's recorded storage TTL has passed — either the
     * timestamp-based TTL at the given simulated time, or the ledger-based TTL
     * at the given (or current) ledger sequence.
     *
     * ### Parameter symmetry with {@link simulateWithdraw}
     *
     * `simulateWithdraw` accepts an `opts.ledger` override for the ledger-based
     * TTL check so callers can run a point-in-time check without mutating the
     * simulator's state. `isStorageExpired` now accepts the same optional
     * `ledger` parameter for the same reason (issue #907).
     *
     * @param streamId - ID of the stream whose storage TTL is being checked.
     * @param at - Unix timestamp (seconds) to test the timestamp-based TTL against.
     *   Defaults to the simulator's current simulated time (`this.now()`).
     * @param ledger - Ledger sequence to test the ledger-based TTL against.
     *   Defaults to the simulator's current ledger sequence (`this.currentLedgerSeq`).
     *   Pass an explicit value for atomic, point-in-time checks that must not
     *   depend on the simulator's current state — mirrors `opts.ledger` in
     *   {@link simulateWithdraw}.
     */
    isStorageExpired(streamId: string, at?: number, ledger?: number): boolean;
    /**
     * Simulates a withdraw against the current simulated state, factoring in
     * contract storage TTL expiry: a withdraw against an expired storage entry
     * reports a distinct `storageExpired` failure with an actionable remedy,
     * mirroring the on-chain behaviour where the entry must be restored before
     * the write can succeed.
     *
     * `opts.ledger`, when given, is used in place of the simulator's current
     * ledger sequence for the ledger-based TTL check only — an atomic,
     * point-in-time check that doesn't mutate simulator state.
     */
    simulateWithdraw(stream: Stream, amount?: bigint, opts?: {
        ledger?: number;
    }): SimulatedWithdrawResult;
    /** Resets the simulated clock to real time and clears expiry-firing state. */
    reset(): void;
}
//# sourceMappingURL=simulator.d.ts.map