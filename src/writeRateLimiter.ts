/**
 * Client-side rate limiting for SDK write operations (issue #464).
 *
 * Throttles how many write calls (`createStream`, `withdraw`, `cancelStream`,
 * etc.) can be submitted per second from a single `SoroStreamClient`
 * instance, so a runaway loop or retry storm in application code can't flood
 * the configured RPC node with transaction submissions.
 *
 * Disabled by default — existing clients are unaffected until they opt in
 * via `SoroStreamClientOptions.writeRateLimit`.
 */

/** Configuration for the write-operation rate limiter. */
export interface WriteRateLimitOptions {
  /**
   * Maximum write operations allowed per second, applied per operation name
   * unless `shared: true` is set. Must be > 0.
   */
  maxPerSecond: number;
  /**
   * Number of operations allowed to burst above the steady-state rate before
   * throttling kicks in (default: 1, i.e. no burst allowance).
   */
  burst?: number;
  /**
   * When `true`, all write operations draw from a single shared bucket
   * instead of one bucket per operation name (default: `false`).
   */
  shared?: boolean;
}

/**
 * Single token-bucket lane, implemented with the GCRA algorithm so no
 * background timer is needed to refill tokens.
 */
class TokenBucket {
  private theoreticalArrival = 0;
  private readonly intervalMs: number;
  private readonly burstMs: number;

  constructor(maxPerSecond: number, burst: number) {
    this.intervalMs = 1000 / maxPerSecond;
    this.burstMs = this.intervalMs * Math.max(1, burst);
  }

  /** Resolves once a slot is available, delaying the caller if necessary. */
  async acquire(): Promise<void> {
    const now = Date.now();
    const tat = Math.max(this.theoreticalArrival, now);
    this.theoreticalArrival = tat + this.intervalMs;
    const waitMs = tat - this.burstMs - now;
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

/** Throttles write operations to a configured rate, queueing bursts rather than rejecting them. */
export class WriteRateLimiter {
  private readonly shared: boolean;
  private readonly maxPerSecond: number;
  private readonly burst: number;
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(options: WriteRateLimitOptions) {
    if (options.maxPerSecond <= 0) {
      throw new Error('writeRateLimit.maxPerSecond must be > 0');
    }
    this.maxPerSecond = options.maxPerSecond;
    this.burst = options.burst ?? 1;
    this.shared = options.shared ?? false;
  }

  /** Waits until a slot is available for the given operation, then returns. */
  async acquire(operationName: string): Promise<void> {
    const key = this.shared ? '__shared__' : operationName;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket(this.maxPerSecond, this.burst);
      this.buckets.set(key, bucket);
    }
    await bucket.acquire();
  }
}
