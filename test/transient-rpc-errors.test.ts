import { describe, it, expect, vi } from 'vitest';
import { isTransientRpcError, withRetry } from '../src/retry.js';

describe('isTransientRpcError (#363)', () => {
  it('returns true for timeout errors', () => {
    expect(isTransientRpcError(new Error('Request timed out'))).toBe(true);
    expect(isTransientRpcError(new Error('ETIMEDOUT'))).toBe(true);
    expect(isTransientRpcError(new Error('Connection timeout'))).toBe(true);
  });

  it('returns true for network errors', () => {
    expect(isTransientRpcError(new Error('fetch failed'))).toBe(true);
    expect(isTransientRpcError(new Error('ECONNRESET'))).toBe(true);
    expect(isTransientRpcError(new Error('network error'))).toBe(true);
  });

  it('returns true for HTTP 429', () => {
    const err = Object.assign(new Error('Rate limited'), { status: 429 });
    expect(isTransientRpcError(err)).toBe(true);
  });

  it('returns true for HTTP 503', () => {
    const err = Object.assign(new Error('Service unavailable'), { status: 503 });
    expect(isTransientRpcError(err)).toBe(true);
  });

  it('returns true for Soroban RPC -32005 (rate limited)', () => {
    const err = Object.assign(new Error('RPC rate limited'), { code: -32005 });
    expect(isTransientRpcError(err)).toBe(true);
  });

  it('returns true for Soroban RPC -32603 (internal error)', () => {
    const err = Object.assign(new Error('Internal error'), { code: -32603 });
    expect(isTransientRpcError(err)).toBe(true);
  });

  it('returns false for contract/validation errors', () => {
    expect(isTransientRpcError(new Error('Contract error: invalid params'))).toBe(false);
    expect(isTransientRpcError(new Error('Transaction failed'))).toBe(false);
    expect(isTransientRpcError(new Error('Insufficient funds'))).toBe(false);
  });

  it('returns false for AbortError', () => {
    const abort = new DOMException('Aborted', 'AbortError');
    expect(isTransientRpcError(abort)).toBe(false);
  });

  it('returns false for null/undefined', () => {
    expect(isTransientRpcError(null)).toBe(false);
    expect(isTransientRpcError(undefined)).toBe(false);
  });
});

describe('withRetry transientOnly option (#363)', () => {
  it('does not retry non-transient errors when transientOnly: true', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Contract error: bad params'));
    await expect(
      withRetry(fn, { maxAttempts: 3, transientOnly: true })
    ).rejects.toThrow('Contract error: bad params');
    // Should only be called once — non-transient, no retries
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries transient errors when transientOnly: true', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('Service unavailable'), { status: 503 }))
      .mockResolvedValue('success');
    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 0, transientOnly: true });
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries all errors by default (backwards compatible)', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('Any error'))
      .mockResolvedValue('ok');
    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 0 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('uses custom shouldRetry predicate', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('special error'));
    const shouldRetry = vi.fn().mockReturnValue(false);
    await expect(
      withRetry(fn, { maxAttempts: 3, shouldRetry })
    ).rejects.toThrow('special error');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(shouldRetry).toHaveBeenCalledTimes(1);
  });
});
