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
 * Advances a virtual clock by an arbitrary number of seconds and evaluates
 * stream accrual / expiry against it, mirroring the contract's flow-rate
 * math without requiring a live RPC connection.
 */
export declare class StreamSimulator {
    private clockOffsetSeconds;
    private expiryCallbacks;
    private firedExpiry;
    /** Current simulated unix timestamp (seconds). */
    now(): number;
    /**
     * Advances the simulated clock by `seconds`. Any stream in `streams` whose
     * `endTime` is newly crossed fires its registered expiry callback exactly
     * once.
     */
    advance(seconds: number, streams?: Stream[]): void;
    /** Registers a callback fired the first time `advance` crosses the stream's `endTime`. */
    onExpire(streamId: string, callback: StreamExpiryCallback): void;
    /** Computes the claimable amount for a stream at the simulator's current simulated time. */
    claimableAt(stream: Stream): bigint;
    /** Resets the simulated clock to real time and clears expiry-firing state. */
    reset(): void;
}
