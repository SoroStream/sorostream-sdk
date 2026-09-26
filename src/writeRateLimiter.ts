/**
 * Client-side rate limiting for SDK write operations (issue #464).
 *
 * Throttles how many write calls (`createStream`, `withdraw`, `cancelStream`,
 * etc.) can be submitted per second from a single `SoroStreamClient`
 * instance, so a runaway loop or retry storm in application code can't flood
 * the configured RPC node with transaction submissions.
 *
 * When the queue exceeds its capacity, new operations are rejected with
 * RateLimitExceededError rather than being delayed, applying backpressure
 * to the caller.
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
   * Maximum number of operations allowed to wait in the queue before
   * new operations are rejected (default: 10). Set to 0 for no limit.
   */
  queueSize?: number;
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

  /**
   * Resolves once a slot is available, delaying the caller if necessary.
   */
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

/** Throttles write operations to a configured rate, rejecting when queue is full. */
export class WriteRateLimiter {
  private readonly shared: boolean;
  private readonly maxPerSecond: number;
  private readonly burst: number;
  private readonly queueSize: number;
  private readonly buckets = new Map<string, TokenBucket>();
  private waiting = 0;

  constructor(options: WriteRateLimitOptions) {
    if (options.maxPerSecond <= 0) {
      throw new Error('writeRateLimit.maxPerSecond must be > 0');
    }
    this.maxPerSecond = options.maxPerSecond;
    this.burst = options.burst ?? 1;
    this.queueSize = options.queueSize ?? 10; // Default queue size of 10
    this.shared = options.shared ?? false;
  }

  /** Waits until a slot is available for the given operation, then returns. */
  async acquire(operationName: string): Promise<void> {
    // Check if waiting queue is full
    if (this.queueSize > 0 && this.waiting >= this.queueSize) {
      // Throw an error so the async function returns a rejecting promise
      throw new RateLimitExceededError(this.waiting, this.queueSize);
    }

    // Increment waiting count
    this.waiting++;

    try {
      // Get the appropriate bucket based on shared setting
      const key = this.shared ? '__shared__' : operationName;
      let bucket = this.buckets.get(key);
      if (!bucket) {
        bucket = new TokenBucket(this.maxPerSecond, this.burst);
        this.buckets.set(key, bucket);
      }
      // Wait for permission from the bucket
      await bucket.acquire();
    } finally {
      // Decrement waiting count when done (whether successful or not)
      this.waiting--;
    }
  }
}