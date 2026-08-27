import { describe, it, expect, vi } from 'vitest';
import { createFeeRetryMiddleware, FeeRetryError } from '../src/feeRetryMiddleware.js';
import type { MiddlewareContext } from '../src/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeFeeError(code = 'tx_insufficient_fee'): Error {
  const err = new Error(`Transaction rejected: ${code}`) as Error & Record<string, unknown>;
  (err as Record<string, unknown>)['result_code'] = code;
  return err;
}

function makeCtx(method = 'createStream', args: unknown[] = [{}]): MiddlewareContext {
  return { method, args };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createFeeRetryMiddleware (issue #404)', () => {
  it('returns a SoroStreamPlugin with before and onError hooks', () => {
    const plugin = createFeeRetryMiddleware();
    expect(typeof plugin.before).toBe('function');
    expect(typeof plugin.onError).toBe('function');
  });

  it('re-throws non-fee errors unchanged', async () => {
    const plugin = createFeeRetryMiddleware();
    const ctx = makeCtx();
    plugin.before!(ctx);

    const networkError = new Error('ECONNRESET');
    await expect(plugin.onError!(ctx, networkError)).rejects.toThrow('ECONNRESET');
    // Should NOT be a FeeRetryError
    await expect(plugin.onError!(ctx, networkError)).rejects.not.toBeInstanceOf(FeeRetryError);
  });

  it('throws FeeRetryError for tx_insufficient_fee', async () => {
    const plugin = createFeeRetryMiddleware({ maxFeeStroops: 50_000 });
    const ctx = makeCtx();
    plugin.before!(ctx);

    const feeErr = makeFeeError('tx_insufficient_fee');
    await expect(plugin.onError!(ctx, feeErr)).rejects.toBeInstanceOf(FeeRetryError);
  });

  it('throws FeeRetryError for op_insufficient_fee', async () => {
    const plugin = createFeeRetryMiddleware({ maxFeeStroops: 50_000 });
    const ctx = makeCtx();
    plugin.before!(ctx);

    const feeErr = makeFeeError('op_insufficient_fee');
    await expect(plugin.onError!(ctx, feeErr)).rejects.toBeInstanceOf(FeeRetryError);
  });

  it('detects fee error from message text', async () => {
    const plugin = createFeeRetryMiddleware({ maxFeeStroops: 50_000 });
    const ctx = makeCtx();
    plugin.before!(ctx);

    const err = new Error('Transaction failed: tx_insufficient_fee');
    await expect(plugin.onError!(ctx, err)).rejects.toBeInstanceOf(FeeRetryError);
  });

  it('applies bumpFactor to the fee on each retry', async () => {
    const onRetry = vi.fn();
    const plugin = createFeeRetryMiddleware({
      maxFeeStroops: 50_000,
      bumpFactor: 2,
      maxAttempts: 3,
      onRetry,
    });
    const ctx = makeCtx();
    plugin.before!(ctx);

    const feeErr = Object.assign(new Error('tx_insufficient_fee'), {
      result_code: 'tx_insufficient_fee',
      minFee: 100,
    });

    // First retry — fee should be bumped from 100 to 200
    try {
      await plugin.onError!(ctx, feeErr);
    } catch (e) {
      expect(e).toBeInstanceOf(FeeRetryError);
      expect((e as FeeRetryError).suggestedFeeStroops).toBe(200);
      expect((e as FeeRetryError).attempt).toBe(1);
    }

    // Second retry — fee bumped from 200 to 400
    try {
      await plugin.onError!(ctx, feeErr);
    } catch (e) {
      expect(e).toBeInstanceOf(FeeRetryError);
      expect((e as FeeRetryError).suggestedFeeStroops).toBe(400);
      expect((e as FeeRetryError).attempt).toBe(2);
    }

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, 200);
    expect(onRetry).toHaveBeenNthCalledWith(2, 2, 400);
  });

  it('re-throws original error when maxAttempts is exhausted', async () => {
    const plugin = createFeeRetryMiddleware({
      maxFeeStroops: 50_000,
      bumpFactor: 1.5,
      maxAttempts: 2,
    });
    const ctx = makeCtx();
    plugin.before!(ctx);

    const feeErr = makeFeeError('tx_insufficient_fee');

    // Exhaust attempts
    for (let i = 0; i < 2; i++) {
      try {
        await plugin.onError!(ctx, feeErr);
      } catch {
        // expected FeeRetryError on first attempts
      }
    }

    // Next call should re-throw the original fee error (not FeeRetryError)
    await expect(plugin.onError!(ctx, feeErr)).rejects.toBe(feeErr);
  });

  it('re-throws original error when bumped fee would exceed maxFeeStroops', async () => {
    const plugin = createFeeRetryMiddleware({
      maxFeeStroops: 150,
      bumpFactor: 2,
      maxAttempts: 10,
    });
    const ctx = makeCtx();
    plugin.before!(ctx);

    const feeErr = Object.assign(new Error('tx_insufficient_fee'), {
      result_code: 'tx_insufficient_fee',
      minFee: 100,
    });

    // First retry: 100 * 2 = 200 > 150 — should hit cap and re-throw original
    await expect(plugin.onError!(ctx, feeErr)).rejects.toBe(feeErr);
  });

  it('injects __feeRetryBumpedFee into last options arg', async () => {
    const plugin = createFeeRetryMiddleware({ maxFeeStroops: 50_000 });
    const options = { memo: 'test' };
    const ctx = makeCtx('withdraw', [{ streamId: 'S1' }, options]);
    plugin.before!(ctx);

    const feeErr = makeFeeError('tx_insufficient_fee');
    try {
      await plugin.onError!(ctx, feeErr);
    } catch {
      // expected
    }

    expect((options as Record<string, unknown>)['__feeRetryBumpedFee']).toBeGreaterThan(0);
  });

  it('FeeRetryError carries cause and suggestedFeeStroops', async () => {
    const plugin = createFeeRetryMiddleware({ maxFeeStroops: 50_000 });
    const ctx = makeCtx();
    plugin.before!(ctx);

    const feeErr = makeFeeError('tx_insufficient_fee');
    let caught: FeeRetryError | null = null;
    try {
      await plugin.onError!(ctx, feeErr);
    } catch (e) {
      caught = e as FeeRetryError;
    }

    expect(caught).not.toBeNull();
    expect(caught!.cause).toBe(feeErr);
    expect(caught!.suggestedFeeStroops).toBeGreaterThan(0);
    expect(caught!.name).toBe('FeeRetryError');
  });

  it('invokes onRetry callback with correct args', async () => {
    const onRetry = vi.fn();
    const plugin = createFeeRetryMiddleware({
      maxFeeStroops: 10_000,
      bumpFactor: 1.5,
      onRetry,
    });
    const ctx = makeCtx();
    plugin.before!(ctx);

    const feeErr = Object.assign(new Error('tx_insufficient_fee'), {
      result_code: 'tx_insufficient_fee',
      minFee: 200,
    });

    try {
      await plugin.onError!(ctx, feeErr);
    } catch {
      // expected
    }

    expect(onRetry).toHaveBeenCalledOnce();
    const [attempt, fee] = onRetry.mock.calls[0];
    expect(attempt).toBe(1);
    expect(fee).toBe(300); // 200 * 1.5
  });
});
