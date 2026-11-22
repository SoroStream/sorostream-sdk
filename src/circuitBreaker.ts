export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  threshold?: number;
  cooldownMs?: number;
  /**
   * Minimum time (ms) between successive probes while the breaker is
   * `HALF_OPEN`. Configured independently of `cooldownMs`, so a long
   * open-state cooldown can be combined with a fast (or slow) probe rate
   * and vice versa (issue #701).
   *
   * Defaults to `cooldownMs`.
   */
  halfOpenProbeIntervalMs?: number;
  /**
   * When `true`, **any** single probe failure while the breaker is `HALF_OPEN`
   * immediately transitions it back to `OPEN` — the `threshold` counter is
   * bypassed entirely for half-open probes.
   *
   * The default (`false`) preserves the existing behaviour: a failed probe
   * increments `failureCount` (which carries over from the closed-state
   * failures that originally opened the circuit), and the breaker re-opens
   * only once `failureCount >= threshold`.  Because `failureCount` is already
   * at or above `threshold` when the breaker enters `HALF_OPEN` from a normal
   * open transition, the first probe failure typically re-opens immediately
   * under the default behaviour as well; this option makes the intent explicit
   * and guarantees the behaviour regardless of how the breaker was opened.
   *
   * Set this to `true` when a single failed probe is conclusive enough to
   * declare the endpoint still unhealthy (e.g. health-check pings rather than
   * real traffic).
   */
  immediateOpenOnHalfOpenFailure?: boolean;
}

const DEFAULT_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 30_000;

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private lastFailureTime = 0;
  /** Timestamp of the most recent half-open probe attempt (issue #701). */
  private lastProbeTime = 0;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly halfOpenProbeIntervalMs: number;
  private readonly immediateOpenOnHalfOpenFailure: boolean;
  private manuallyPaused = false;

  constructor(options: CircuitBreakerOptions = {}) {
    this.threshold = options.threshold ?? DEFAULT_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.halfOpenProbeIntervalMs = options.halfOpenProbeIntervalMs ?? this.cooldownMs;
    this.immediateOpenOnHalfOpenFailure = options.immediateOpenOnHalfOpenFailure ?? false;
  }

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.manuallyPaused) {
      throw new Error('RPC endpoint unavailable (circuit breaker manually paused)');
    }
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime >= this.cooldownMs) {
        this.state = 'HALF_OPEN';
        // This call is the probe, so it runs immediately; later calls are
        // gated by the half-open probe interval below.
        this.lastProbeTime = Date.now();
      } else {
        throw new Error('RPC endpoint unavailable (circuit breaker open)');
      }
    } else if (this.state === 'HALF_OPEN') {
      const remaining = this.halfOpenProbeIntervalMs - (Date.now() - this.lastProbeTime);
      if (remaining > 0) {
        throw new Error(
          `RPC endpoint unavailable (circuit breaker half-open, next probe in ${remaining}ms)`,
        );
      }
      this.lastProbeTime = Date.now();
    }

    try {
      const result = await fn();
      // Reset failure count on success in any state
      if (this.state === 'HALF_OPEN' || this.state === 'CLOSED') {
        this.reset();
      }
      return result;
    } catch (err) {
      this.lastFailureTime = Date.now();
      if (this.state === 'HALF_OPEN' && this.immediateOpenOnHalfOpenFailure) {
        // A single failed probe is treated as conclusive: re-open immediately
        // without waiting to accumulate threshold-many failures (issue #701).
        this.failureCount = this.threshold;
        this.state = 'OPEN';
      } else {
        this.failureCount++;
        if (this.failureCount >= this.threshold) {
          this.state = 'OPEN';
        }
      }
      throw err;
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  /**
   * Manually opens the circuit (e.g. for maintenance). All calls are rejected
   * until {@link resume} is called; the cooldown does not auto-close it (issue #625).
   */
  pause(): void {
    this.manuallyPaused = true;
    this.state = 'OPEN';
    this.lastFailureTime = Date.now();
  }

  /** Closes a manually paused circuit and resets failure counters (issue #625). */
  resume(): void {
    this.manuallyPaused = false;
    this.reset();
  }

  /** Whether the circuit was opened via {@link pause}. */
  isPaused(): boolean {
    return this.manuallyPaused;
  }

  reset(): void {
    this.state = 'CLOSED';
    this.failureCount = 0;
  }
}
