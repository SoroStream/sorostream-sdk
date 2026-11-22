/**
 * Issue #736: `createFeeRetryMiddleware` retries a fee-insufficient Soroban
 * response up to a configurable `maxAttempts`, bumping the fee each time. This
 * test confirms that once the configured maximum is exhausted against a
 * persistently failing fee call, the rejection that ultimately surfaces to
 * the caller is the original fee error (not a generic wrapper), and that
 * exactly the configured number of retry attempts were made.
 */
import { describe, it, expect, vi } from 'vitest';
import { createFeeRetryMiddleware, FeeRetryError } from '../src/feeRetryMiddleware.js';
import type { MiddlewareContext } from '../src/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * A fee error carrying a Soroban `result_code` (the discriminator
 * `isFeeError` looks for). It carries no `minFee` hint, so the middleware
 * starts bumping from its default base fee.
 */
function makeFeeError(code = 'tx_insufficient_fee'): Error & { result_code: string } {
  const err = new Error(`Transaction rejected: ${code}`) as Error & {
    result_code: string;
  };
  err.result_code = code;
  return err;
}

function makeCtx(method = 'createStream', args: unknown[] = [{}]): MiddlewareContext {
  return { method, args };
}

/**
 * Drives the client-style retry loop the way the SDK's middleware runner would:
 * `onError` either throws `FeeRetryError` (a signal to retry with a bumped fee)
 * or re-throws the error that should surface to the caller. We keep retrying
 * while we see `FeeRetryError` and stop at the first non-retry error.
 *
 * Returns the final surfaced error and how many retry attempts were made.
 */
async function driveRetryLoop(
  plugin: ReturnType<typeof createFeeRetryMiddleware>,
  ctx: MiddlewareContext,
  feeErr: Error,
): Promise<{ finalError: unknown; retryAttempts: number }> {
  let finalError: unknown;
  let retryAttempts = 0;

  // Hard guard so a bug can never hang the test.
  for (let guard = 0; guard < 50; guard++) {
    try {
      await plugin.onError!(ctx, feeErr);
      // onError always throws in these scenarios, but if it ever resolves we
      // treat that as the call having succeeded.
      finalError = undefined;
      break;
    } catch (e) {
      if (e instanceof FeeRetryError) {
        retryAttempts += 1;
        continue; // middleware says: retry with the bumped fee
      }
      finalError = e;
      break; // original error surfaced to the caller
    }
  }

  return { finalError, retryAttempts };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createFeeRetryMiddleware exhaustion (issue #736)', () => {
  it('surfaces the original fee error after exactly maxAttempts retries', async () => {
    const MAX_ATTEMPTS = 2;
    const onRetry = vi.fn();
    const onComplete = vi.fn();

    const plugin = createFeeRetryMiddleware({
      maxFeeStroops: 50_000,
      bumpFactor: 2,
      maxAttempts: MAX_ATTEMPTS,
      onRetry,
      onComplete,
    });
    const ctx = makeCtx();
    plugin.before!(ctx);

    const feeErr = makeFeeError('tx_insufficient_fee');

    const { finalError, retryAttempts } = await driveRetryLoop(plugin, ctx, feeErr);

    // The final rejection is the ORIGINAL fee error — same instance, not a
    // generic wrapper or a FeeRetryError.
    expect(finalError).toBe(feeErr);
    expect(finalError).not.toBeInstanceOf(FeeRetryError);

    // The original fee error TYPE is preserved and exposed (carries its
    // result_code), so a caller matching on the fee error still recognises it.
    expect((finalError as Error & { result_code: string }).result_code).toBe(
      'tx_insufficient_fee',
    );

    // Exactly the configured number of retry attempts were made — no more,
    // no fewer. `onRetry` fires once per actual retry attempt.
    expect(retryAttempts).toBe(MAX_ATTEMPTS);
    expect(onRetry).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, 200);
    expect(onRetry).toHaveBeenNthCalledWith(2, 2, 400);

    // The completion hook reports exhaustion with the attempt count and
    // `succeeded: false`.
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith(MAX_ATTEMPTS, false);
  });

  it('surfaces the original fee error unchanged when maxAttempts is 1', async () => {
    const onRetry = vi.fn();
    const plugin = createFeeRetryMiddleware({
      maxFeeStroops: 50_000,
      bumpFactor: 2,
      maxAttempts: 1,
      onRetry,
    });
    const ctx = makeCtx();
    plugin.before!(ctx);

    const feeErr = makeFeeError('op_insufficient_fee');

    const { finalError, retryAttempts } = await driveRetryLoop(plugin, ctx, feeErr);

    expect(finalError).toBe(feeErr);
    expect(finalError).not.toBeInstanceOf(FeeRetryError);
    expect((finalError as Error & { result_code: string }).result_code).toBe(
      'op_insufficient_fee',
    );
    expect(retryAttempts).toBe(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('does not retry a non-fee error and surfaces it unchanged', async () => {
    const onRetry = vi.fn();
    const plugin = createFeeRetryMiddleware({
      maxFeeStroops: 50_000,
      maxAttempts: 3,
      onRetry,
    });
    const ctx = makeCtx();
    plugin.before!(ctx);

    const networkError = new Error('ECONNRESET');

    const { finalError, retryAttempts } = await driveRetryLoop(plugin, ctx, networkError);

    // Non-fee errors propagate unchanged with zero retry attempts.
    expect(finalError).toBe(networkError);
    expect(finalError).not.toBeInstanceOf(FeeRetryError);
    expect(retryAttempts).toBe(0);
    expect(onRetry).not.toHaveBeenCalled();
  });
});
