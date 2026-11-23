import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker } from '../src/circuitBreaker.js';

describe('CircuitBreaker (#540)', () => {
  let circuitBreaker: CircuitBreaker;

  beforeEach(() => {
    // Use a short cooldown for testing
    circuitBreaker = new CircuitBreaker({
      threshold: 2,
      cooldownMs: 10, // 10ms cooldown for fast tests
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('starts in CLOSED state', () => {
    expect(circuitBreaker.getState()).toBe('CLOSED');
  });

  it('transitions from CLOSED to OPEN after threshold failures', async () => {
    const failingFn = () => Promise.reject(new Error('failure'));

    // First failure - should still be CLOSED
    await expect(circuitBreaker.call(failingFn)).rejects.toThrow('failure');
    expect(circuitBreaker.getState()).toBe('CLOSED');
    expect(circuitBreaker['failureCount']).toBe(1);

    // Second failure - should transition to OPEN
    await expect(circuitBreaker.call(failingFn)).rejects.toThrow('failure');
    expect(circuitBreaker.getState()).toBe('OPEN');
    expect(circuitBreaker['failureCount']).toBe(2);
  });

  it('throws error when circuit is OPEN and cooldown not elapsed', async () => {
    const failingFn = () => Promise.reject(new Error('failure'));

    // Cause the circuit to open
    await expect(circuitBreaker.call(failingFn)).rejects.toThrow('failure');
    await expect(circuitBreaker.call(failingFn)).rejects.toThrow('failure');
    expect(circuitBreaker.getState()).toBe('OPEN');

    // Try to call while OPEN and cooldown not elapsed
    await expect(circuitBreaker.call(() => Promise.resolve('success'))).rejects.toThrow(
      'RPC endpoint unavailable (circuit breaker open)',
    );
    expect(circuitBreaker.getState()).toBe('OPEN'); // Should still be OPEN
  });

  it('transitions from OPEN to HALF_OPEN after cooldown elapses', async () => {
    const failingFn = () => Promise.reject(new Error('failure'));

    // Cause the circuit to open
    await expect(circuitBreaker.call(failingFn)).rejects.toThrow('failure');
    await expect(circuitBreaker.call(failingFn)).rejects.toThrow('failure');
    expect(circuitBreaker.getState()).toBe('OPEN');

    // Wait for cooldown to elapse
    await new Promise((resolve) => setTimeout(resolve, 15));

    // Next call should transition to HALF_OPEN and then to CLOSED on success
    await expect(circuitBreaker.call(() => Promise.resolve('success'))).resolves.toBe('success');
    expect(circuitBreaker.getState()).toBe('CLOSED'); // Should be CLOSED after successful half-open call
  });

  it('transitions from HALF_OPEN to CLOSED on successful call', async () => {
    const failingFn = () => Promise.reject(new Error('failure'));
    const succeedingFn = () => Promise.resolve('success');

    // Cause the circuit to open
    await expect(circuitBreaker.call(failingFn)).rejects.toThrow('failure');
    await expect(circuitBreaker.call(failingFn)).rejects.toThrow('failure');
    expect(circuitBreaker.getState()).toBe('OPEN');

    // Wait for cooldown to elapse
    await new Promise((resolve) => setTimeout(resolve, 15));

    // Call in HALF_OPEN state that succeeds should close the circuit
    await expect(circuitBreaker.call(succeedingFn)).resolves.toBe('success');
    expect(circuitBreaker.getState()).toBe('CLOSED');
  });

  it('transitions from HALF_OPEN to OPEN on failed call and resets cooldown timer', async () => {
    const failingFn = () => Promise.reject(new Error('failure'));
    const succeedingFn = () => Promise.resolve('success');

    // Cause the circuit to open
    await expect(circuitBreaker.call(failingFn)).rejects.toThrow('failure');
    await expect(circuitBreaker.call(failingFn)).rejects.toThrow('failure');
    expect(circuitBreaker.getState()).toBe('OPEN');

    // Wait for cooldown to elapse
    await new Promise((resolve) => setTimeout(resolve, 15));

    // Call in HALF_OPEN state that fails should re-open the circuit
    await expect(circuitBreaker.call(failingFn)).rejects.toThrow('failure');
    expect(circuitBreaker.getState()).toBe('OPEN');

    // Immediately try again - should still be OPEN (cooldown reset)
    await expect(circuitBreaker.call(succeedingFn)).rejects.toThrow(
      'RPC endpoint unavailable (circuit breaker open)',
    );
    expect(circuitBreaker.getState()).toBe('OPEN');
  });

  it('resets failure count on successful call in CLOSED state', async () => {
    const failingFn = () => Promise.reject(new Error('failure'));
    const succeedingFn = () => Promise.resolve('success');

    // One failure
    await expect(circuitBreaker.call(failingFn)).rejects.toThrow('failure');
    expect(circuitBreaker.getState()).toBe('CLOSED');
    expect(circuitBreaker['failureCount']).toBe(1);

    // Successful call should reset failure count
    await expect(circuitBreaker.call(succeedingFn)).resolves.toBe('success');
    expect(circuitBreaker.getState()).toBe('CLOSED');
    expect(circuitBreaker['failureCount']).toBe(0);

    // Another failure should start counting from 1 again
    await expect(circuitBreaker.call(failingFn)).rejects.toThrow('failure');
    expect(circuitBreaker.getState()).toBe('CLOSED');
    expect(circuitBreaker['failureCount']).toBe(1);
  });
});

// ── immediateOpenOnHalfOpenFailure option ─────────────────────────────────────

describe('CircuitBreaker immediateOpenOnHalfOpenFailure option', () => {
  it('re-opens on the first probe failure when the option is true', async () => {
    // threshold=3 so the default behaviour would keep the breaker HALF_OPEN
    // after just one failed probe.
    const breaker = new CircuitBreaker({
      threshold: 3,
      cooldownMs: 10,
      immediateOpenOnHalfOpenFailure: true,
    });

    const fail = () => Promise.reject(new Error('boom'));

    // Drive the breaker to OPEN (3 failures).
    await expect(breaker.call(fail)).rejects.toThrow('boom');
    await expect(breaker.call(fail)).rejects.toThrow('boom');
    await expect(breaker.call(fail)).rejects.toThrow('boom');
    expect(breaker.getState()).toBe('OPEN');

    // Wait for cooldown.
    await new Promise((r) => setTimeout(r, 15));

    // Single failed probe must immediately re-open.
    await expect(breaker.call(fail)).rejects.toThrow('boom');
    expect(breaker.getState()).toBe('OPEN');
  });

  it('preserves existing threshold-based re-open behaviour when the option is false (default)', async () => {
    // When immediateOpenOnHalfOpenFailure is false (default), the failureCount
    // accumulated while CLOSED carries over into HALF_OPEN. Since the breaker
    // only opens once failureCount >= threshold, the first probe failure
    // increments it past threshold and re-opens — this is the existing
    // behaviour the option makes explicit.
    const breaker = new CircuitBreaker({
      threshold: 3,
      cooldownMs: 10,
      immediateOpenOnHalfOpenFailure: false,
    });

    const fail = () => Promise.reject(new Error('boom'));

    await expect(breaker.call(fail)).rejects.toThrow('boom');
    await expect(breaker.call(fail)).rejects.toThrow('boom');
    await expect(breaker.call(fail)).rejects.toThrow('boom');
    expect(breaker.getState()).toBe('OPEN');
    expect(breaker['failureCount']).toBe(3);

    await new Promise((r) => setTimeout(r, 15));

    // failureCount carries over (3); probe failure → 4 >= 3 → OPEN.
    await expect(breaker.call(fail)).rejects.toThrow('boom');
    expect(breaker.getState()).toBe('OPEN');
  });

  it('closes normally on a successful probe even when the option is true', async () => {
    const breaker = new CircuitBreaker({
      threshold: 2,
      cooldownMs: 10,
      immediateOpenOnHalfOpenFailure: true,
    });

    const fail = () => Promise.reject(new Error('boom'));
    const succeed = () => Promise.resolve('ok');

    await expect(breaker.call(fail)).rejects.toThrow('boom');
    await expect(breaker.call(fail)).rejects.toThrow('boom');
    expect(breaker.getState()).toBe('OPEN');

    await new Promise((r) => setTimeout(r, 15));

    await expect(breaker.call(succeed)).resolves.toBe('ok');
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('resets the cooldown timer on immediate re-open', async () => {
    const breaker = new CircuitBreaker({
      threshold: 2,
      cooldownMs: 10,
      immediateOpenOnHalfOpenFailure: true,
    });

    const fail = () => Promise.reject(new Error('boom'));
    const succeed = () => Promise.resolve('ok');

    await expect(breaker.call(fail)).rejects.toThrow('boom');
    await expect(breaker.call(fail)).rejects.toThrow('boom');
    expect(breaker.getState()).toBe('OPEN');

    await new Promise((r) => setTimeout(r, 15));

    // Probe fails → immediately OPEN.
    await expect(breaker.call(fail)).rejects.toThrow('boom');
    expect(breaker.getState()).toBe('OPEN');

    // Cooldown just reset — a successful fn must still be blocked.
    await expect(breaker.call(succeed)).rejects.toThrow(
      'RPC endpoint unavailable (circuit breaker open)',
    );
    expect(breaker.getState()).toBe('OPEN');
  });
});
