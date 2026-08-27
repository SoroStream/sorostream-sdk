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
export class StreamSimulator {
  private clockOffsetSeconds = 0;
  private expiryCallbacks = new Map<string, StreamExpiryCallback>();
  private firedExpiry = new Set<string>();

  /** Current simulated unix timestamp (seconds). */
  now(): number {
    return Math.floor(Date.now() / 1000) + this.clockOffsetSeconds;
  }

  /**
   * Advances the simulated clock by `seconds`. Any stream in `streams` whose
   * `endTime` is newly crossed fires its registered expiry callback exactly
   * once.
   */
  advance(seconds: number, streams: Stream[] = []): void {
    if (seconds < 0) throw new Error('seconds must be >= 0');
    this.clockOffsetSeconds += seconds;
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
      return stream.flowRate * BigInt(elapsed);
    }
    const effectiveNow = Math.min(now, stream.endTime);
    const elapsed = Math.max(0, effectiveNow - stream.lastWithdrawTime);
    return stream.flowRate * BigInt(elapsed);
  }

  /** Resets the simulated clock to real time and clears expiry-firing state. */
  reset(): void {
    this.clockOffsetSeconds = 0;
    this.firedExpiry.clear();
  }
}
