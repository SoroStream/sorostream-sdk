export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  threshold?: number;
  cooldownMs?: number;
}

const DEFAULT_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 30_000;

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private lastFailureTime = 0;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private manuallyPaused = false;

  constructor(options: CircuitBreakerOptions = {}) {
    this.threshold = options.threshold ?? DEFAULT_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  }

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.manuallyPaused) {
      throw new Error('RPC endpoint unavailable (circuit breaker manually paused)');
    }
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime >= this.cooldownMs) {
        this.state = 'HALF_OPEN';
      } else {
        throw new Error('RPC endpoint unavailable (circuit breaker open)');
      }
    }

    try {
      const result = await fn();
      // Reset failure count on success in any state
      if (this.state === 'HALF_OPEN' || this.state === 'CLOSED') {
        this.reset();
      }
      return result;
    } catch (err) {
      this.failureCount++;
      this.lastFailureTime = Date.now();
      if (this.failureCount >= this.threshold) {
        this.state = 'OPEN';
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
