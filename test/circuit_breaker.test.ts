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
      'RPC endpoint unavailable (circuit breaker open)'
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
      'RPC endpoint unavailable (circuit breaker open)'
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