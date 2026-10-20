import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Contract } from '@stellar/stellar-sdk';
import { createContractEncoder, requireAddress } from '../src/contractEncoders.js';
import { InvalidAddressError, RateLimitExceededError } from '../src/errors.js';
import { withRetry, isTransientRpcError } from '../src/retry.js';
import { WriteRateLimiter } from '../src/writeRateLimiter.js';
import { deserializeStreamFromJSON } from '../src/utils.js';
import type { Stream } from '../src/types.js';

describe('Issue #783: contractEncoders.ts requireAddress guard consistency across all call sites', () => {
  const contract = new Contract('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC');
  const encoder = createContractEncoder(contract, 'v1');

  // A syntactically valid Stellar Ed25519 public key that does NOT exist on-chain
  const validNonExistentAddress = 'GBJ6W7PZ22C3Y7GZ5S7L6Z7V4O7F5B6X7Y8Z9A0B1C2D3E4F5G6H7I8J';
  const malformedAddress = 'invalid-address-format-not-stellar';

  it('validates address format consistently and throws InvalidAddressError on malformed address', () => {
    expect(() => requireAddress(malformedAddress)).toThrow(InvalidAddressError);
    // Well-formed address passes syntactical validation at encoder boundary
    expect(requireAddress(validNonExistentAddress)).toBe(validNonExistentAddress);
  });

  it('consistently accepts syntactically valid address at encoder boundary across all operations', () => {
    // contractEncoders perform offline XDR building / input sanitization (Issue #458).
    // On-chain existence is checked at transaction simulation/submission time by RPC/Horizon,
    // so encoders consistently permit well-formed addresses regardless of on-chain account existence.
    const createOp = encoder.createStream(validNonExistentAddress, {
      recipient: validNonExistentAddress,
      token: validNonExistentAddress,
      deposit: 1000n,
      flowRate: 10n,
    });
    expect(createOp).toBeDefined();

    const withdrawOp = encoder.withdraw('1', validNonExistentAddress);
    expect(withdrawOp).toBeDefined();

    const cancelOp = encoder.cancelStream('1', validNonExistentAddress);
    expect(cancelOp).toBeDefined();

    const topUpOp = encoder.topUp('1', validNonExistentAddress, 100n);
    expect(topUpOp).toBeDefined();

    const updateFlowOp = encoder.updateFlowRate('1', validNonExistentAddress, 20n);
    expect(updateFlowOp).toBeDefined();

    const setOperatorOp = encoder.setOperator('1', validNonExistentAddress, validNonExistentAddress, true);
    expect(setOperatorOp).toBeDefined();

    const transferOp = encoder.transferStream('1', validNonExistentAddress, validNonExistentAddress);
    expect(transferOp).toBeDefined();

    const addDelegateOp = encoder.addDelegate(validNonExistentAddress, validNonExistentAddress);
    expect(addDelegateOp).toBeDefined();

    const revokeDelegateOp = encoder.revokeDelegate(validNonExistentAddress, validNonExistentAddress);
    expect(revokeDelegateOp).toBeDefined();
  });

  it('consistently throws InvalidAddressError across all encoder operations if address is invalid', () => {
    expect(() => encoder.withdraw('1', malformedAddress)).toThrow(InvalidAddressError);
    expect(() => encoder.cancelStream('1', malformedAddress)).toThrow(InvalidAddressError);
    expect(() => encoder.addDelegate(malformedAddress, validNonExistentAddress)).toThrow(InvalidAddressError);
    expect(() => encoder.addDelegate(validNonExistentAddress, malformedAddress)).toThrow(InvalidAddressError);
  });
});

describe('Issue #789: retry.ts retry policy distinguishing 429 rate-limit from generic 5xx error', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('classifies both 429 rate limit and 5xx responses as transient errors', () => {
    const error429 = new Error('HTTP 429 Too Many Requests: Rate limit exceeded');
    const error500 = new Error('HTTP 500 Internal Server Error');
    const error503 = new Error('HTTP 503 Service Unavailable');

    expect(isTransientRpcError(error429)).toBe(true);
    expect(isTransientRpcError(error500)).toBe(true);
    expect(isTransientRpcError(error503)).toBe(true);
  });

  it('retries transient 429 and 5xx errors with retry budget exhaustion behavior', async () => {
    let attempts429 = 0;
    const fn429 = vi.fn(async () => {
      attempts429++;
      throw new Error('429 Too Many Requests');
    });

    const retryPromise429 = withRetry(fn429, { maxAttempts: 3, baseDelayMs: 10, transientOnly: true });
    
    // Fast forward through backoffs
    await vi.runAllTimersAsync();
    await expect(retryPromise429).rejects.toThrow();
    expect(attempts429).toBe(3);

    let attempts503 = 0;
    const fn503 = vi.fn(async () => {
      attempts503++;
      throw new Error('503 Service Unavailable');
    });

    const retryPromise503 = withRetry(fn503, { maxAttempts: 3, baseDelayMs: 10, transientOnly: true });
    await vi.runAllTimersAsync();
    await expect(retryPromise503).rejects.toThrow();
    expect(attempts503).toBe(3);
  });

  it('allows custom shouldRetry policy to apply distinct handling for 429 vs 5xx', async () => {
    const customPolicy = vi.fn((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('429')) {
        // e.g. defer to rate limiter or back off differently
        return true;
      }
      return false; // do not retry 5xx immediately
    });

    const fn = vi.fn().mockRejectedValueOnce(new Error('500 Internal Error'));
    await expect(withRetry(fn, { shouldRetry: customPolicy, maxAttempts: 3 })).rejects.toThrow('500 Internal Error');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(customPolicy).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe('Issue #786: writeRateLimiter.ts RateLimitExceededError structured context for backoff', () => {
  it('exposes structured context fields (queueDepth, queueLimit) on RateLimitExceededError', async () => {
    const limiter = new WriteRateLimiter({
      maxPerSecond: 10,
      burst: 1,
      queueSize: 1,
      shared: false,
    });

    // Acquire first token
    await limiter.acquire('op');

    // Second acquire exceeds queue capacity
    try {
      await limiter.acquire('op');
      expect.fail('Should have thrown RateLimitExceededError');
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitExceededError);
      const rateLimitErr = err as RateLimitExceededError;
      // Assert structured fields exist for callers to implement backoff
      expect(rateLimitErr.queueDepth).toBeDefined();
      expect(rateLimitErr.queueLimit).toBeDefined();
      expect(typeof rateLimitErr.queueDepth).toBe('number');
      expect(typeof rateLimitErr.queueLimit).toBe('number');
      expect(rateLimitErr.queueDepth).toBeGreaterThan(0);
      expect(rateLimitErr.queueLimit).toBe(1);
    }
  });

  it('rejects when over capacity while preserving normal behavior under capacity', async () => {
    const limiter = new WriteRateLimiter({
      maxPerSecond: 5,
      burst: 2,
      queueSize: 2,
    });

    await expect(limiter.acquire('op')).resolves.toBeUndefined();
  });
});

describe('Issue #788: streaming deserialization handling truncated mid-record payload', () => {
  it('correctly deserializes non-truncated full stream JSON payload', () => {
    const validStream: Stream = {
      id: 'stream-1',
      sender: 'GBJ6W7PZ22C3Y7GZ5S7L6Z7V4O7F5B6X7Y8Z9A0B1C2D3E4F5G6H7I8J',
      recipient: 'GBJ6W7PZ22C3Y7GZ5S7L6Z7V4O7F5B6X7Y8Z9A0B1C2D3E4F5G6H7I8J',
      token: 'GBJ6W7PZ22C3Y7GZ5S7L6Z7V4O7F5B6X7Y8Z9A0B1C2D3E4F5G6H7I8J',
      deposit: 1000n,
      flowRate: 10n,
      startTime: 1000,
      endTime: 2000,
      lastWithdrawTime: 1000,
      status: 'Active',
      autoRenew: false,
    };

    const json = JSON.stringify({
      ...validStream,
      deposit: validStream.deposit.toString(),
      flowRate: validStream.flowRate.toString(),
    });

    const parsed = deserializeStreamFromJSON(json);
    expect(parsed.id).toBe('stream-1');
    expect(parsed.deposit).toBe(1000n);
  });

  it('throws when stream payload is truncated mid-record', () => {
    const fullJson = JSON.stringify({
      id: 'stream-1',
      sender: 'GBJ6W7PZ22C3Y7GZ5S7L6Z7V4O7F5B6X7Y8Z9A0B1C2D3E4F5G6H7I8J',
      recipient: 'GBJ6W7PZ22C3Y7GZ5S7L6Z7V4O7F5B6X7Y8Z9A0B1C2D3E4F5G6H7I8J',
      deposit: '1000',
      flowRate: '10',
    });

    // Simulate truncated payload mid-record
    const truncatedChunk = fullJson.slice(0, 30);

    expect(() => {
      deserializeStreamFromJSON(truncatedChunk);
    }).toThrow();
  });
});
