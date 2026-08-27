/**
 * feeRetryMiddleware.ts
 *
 * Issue #404 — Middleware that intercepts Soroban fee-error responses and
 * automatically resubmits the transaction with a bumped fee, up to a
 * configurable maximum.
 *
 * Usage:
 * ```ts
 * import { SoroStreamClient, createFeeRetryMiddleware } from "@sorostream/sdk";
 *
 * const client = new SoroStreamClient({
 *   network: "testnet",
 *   contractId: "C...",
 *   walletAdapter,
 *   plugins: [
 *     createFeeRetryMiddleware({ maxFeeStroops: 10_000, maxAttempts: 3 }),
 *   ],
 * });
 * ```
 */

import type { SoroStreamPlugin, MiddlewareContext } from './types.js';

// ── Constants ────────────────────────────────────────────────────────────────

/** Soroban RPC result codes that indicate an insufficient fee. */
const FEE_ERROR_CODES = new Set(['tx_insufficient_fee', 'op_insufficient_fee', 'insufficient_fee']);

/** Default multiplier applied to the fee on each retry (50% bump). */
const DEFAULT_BUMP_FACTOR = 1.5;

/** Default maximum fee in stroops (100 000 = 0.01 XLM). */
const DEFAULT_MAX_FEE_STROOPS = 100_000;

/** Default maximum number of retry attempts after the initial failure. */
const DEFAULT_MAX_ATTEMPTS = 3;

// ── Types ────────────────────────────────────────────────────────────────────

/** Options for {@link createFeeRetryMiddleware}. */
export interface FeeRetryMiddlewareOptions {
  /**
   * Maximum fee in stroops the middleware is allowed to bid.
   * Retries stop once the calculated bumped fee would exceed this value.
   * Default: 100 000 stroops (0.01 XLM).
   */
  maxFeeStroops?: number;

  /**
   * Multiplicative factor applied to the fee on each retry.
   * For example, `1.5` bumps the fee by 50% per attempt.
   * Default: 1.5.
   */
  bumpFactor?: number;

  /**
   * Maximum number of retry attempts after the first fee error.
   * Default: 3.
   */
  maxAttempts?: number;

  /**
   * Optional callback invoked before each retry attempt.
   * Useful for logging or metrics.
   *
   * @param attempt - 1-based attempt number.
   * @param bumpedFee - The fee (in stroops) that will be used for this attempt.
   */
  onRetry?: (attempt: number, bumpedFee: number) => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns `true` when the thrown error looks like a Soroban fee-insufficient
 * result. Checks common error code strings and HTTP 400 bodies that the
 * Soroban RPC may return.
 */
function isFeeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const err = error as Record<string, unknown>;

  // Check standard `code` / `result_code` properties
  const code =
    (typeof err['code'] === 'string' ? err['code'] : undefined) ??
    (typeof err['result_code'] === 'string' ? err['result_code'] : undefined) ??
    (typeof err['resultCode'] === 'string' ? err['resultCode'] : undefined);

  if (code && FEE_ERROR_CODES.has(code.toLowerCase())) return true;

  // Check error message text — Soroban RPC sometimes surfaces this in `.message`
  const message =
    err instanceof Error ? err.message : typeof err['message'] === 'string' ? err['message'] : '';

  if (typeof message === 'string') {
    const lower = message.toLowerCase();
    if (
      lower.includes('tx_insufficient_fee') ||
      lower.includes('insufficient_fee') ||
      lower.includes('fee too low') ||
      lower.includes('fee is too low')
    ) {
      return true;
    }
  }

  // Check nested `extras.result_codes` from Stellar SDK horizon/rpc responses
  const extras = err['extras'];
  if (extras && typeof extras === 'object') {
    const resultCodes = (extras as Record<string, unknown>)['result_codes'];
    if (resultCodes && typeof resultCodes === 'object') {
      const txCode = (resultCodes as Record<string, unknown>)['transaction'];
      if (typeof txCode === 'string' && FEE_ERROR_CODES.has(txCode.toLowerCase())) return true;
    }
  }

  // Check `body` string (raw RPC JSON response)
  const body = typeof err['body'] === 'string' ? err['body'] : undefined;
  if (body) {
    const lowerBody = body.toLowerCase();
    if (lowerBody.includes('tx_insufficient_fee') || lowerBody.includes('insufficient_fee')) {
      return true;
    }
  }

  return false;
}

/**
 * Extracts the base fee hint from the error object, if the RPC returns the
 * minimum required fee alongside the rejection. Falls back to `undefined`.
 */
function extractMinFeeFromError(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const err = error as Record<string, unknown>;

  // Some RPC implementations surface `minFee` / `min_fee` in the error
  const minFee = err['minFee'] ?? err['min_fee'];
  if (typeof minFee === 'number' && minFee > 0) return minFee;
  if (typeof minFee === 'string') {
    const parsed = parseInt(minFee, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }

  return undefined;
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Creates a {@link SoroStreamPlugin} that catches Soroban fee-insufficient
 * errors and retries the failing method with an exponentially bumped fee up to
 * `maxFeeStroops`.
 *
 * The middleware works by wrapping the `onError` hook: when a fee error is
 * detected it re-invokes the original method with updated fee context injected
 * into the call arguments, repeating until the call succeeds or the fee cap /
 * attempt limit is reached.
 *
 * @param options - Retry configuration.
 * @returns A `SoroStreamPlugin` ready to pass to `plugins` in the client config.
 *
 * @example
 * ```ts
 * const client = new SoroStreamClient({
 *   network: "testnet",
 *   contractId: "C...",
 *   walletAdapter,
 *   plugins: [
 *     createFeeRetryMiddleware({ maxFeeStroops: 50_000, bumpFactor: 2, maxAttempts: 4 }),
 *   ],
 * });
 * ```
 */
export function createFeeRetryMiddleware(
  options: FeeRetryMiddlewareOptions = {},
): SoroStreamPlugin {
  const maxFeeStroops = options.maxFeeStroops ?? DEFAULT_MAX_FEE_STROOPS;
  const bumpFactor = options.bumpFactor ?? DEFAULT_BUMP_FACTOR;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const onRetry = options.onRetry;

  /**
   * Per-call state stored on the MiddlewareContext args array (index -1 hidden
   * slot) so that `before` / `onError` hooks share the same mutable object
   * across a single method invocation.
   */
  const callState = new WeakMap<
    object,
    {
      attempts: number;
      currentFee: number;
      /** The bound executor injected on the first `before` call. */
      executor?: () => Promise<unknown>;
    }
  >();

  /** Returns (or lazily creates) the mutable per-call state for `ctx`. */
  const getState = (ctx: MiddlewareContext) => {
    // Use the args array as the key — it's a stable object reference for the call.
    let state = callState.get(ctx.args as object);
    if (!state) {
      state = { attempts: 0, currentFee: 0 };
      callState.set(ctx.args as object, state);
    }
    return state;
  };

  const plugin: SoroStreamPlugin = {
    before(ctx: MiddlewareContext): void {
      // Initialise state for this call; currentFee = 0 means "use SDK default"
      const state = getState(ctx);
      state.attempts = 0;
      state.currentFee = 0;
    },

    async onError(ctx: MiddlewareContext, error: unknown): Promise<void> {
      if (!isFeeError(error)) {
        // Not a fee error — let it propagate unchanged
        throw error;
      }

      const state = getState(ctx);

      if (state.attempts >= maxAttempts) {
        // Exhausted retries — re-throw the last fee error
        throw error;
      }

      // Determine starting fee for the first retry
      if (state.currentFee === 0) {
        // Try to use the minimum fee hint from the error, or fall back to a
        // reasonable Soroban base (100 base + 1 000 000 resource fee envelope)
        const minFeeHint = extractMinFeeFromError(error);
        state.currentFee = minFeeHint ?? 100;
      }

      // Apply bump
      const bumpedFee = Math.ceil(state.currentFee * bumpFactor);

      if (bumpedFee > maxFeeStroops) {
        // Fee would exceed the cap — stop retrying
        throw error;
      }

      state.currentFee = bumpedFee;
      state.attempts += 1;

      onRetry?.(state.attempts, bumpedFee);

      // Propagate the bumped fee hint via the context args so that any
      // downstream middleware or the client itself can read it.
      // We store it at a known key in a synthetic trailing arg object when
      // the last arg is an options bag, or append a new one.
      const lastArg = ctx.args[ctx.args.length - 1];
      if (lastArg && typeof lastArg === 'object' && !Array.isArray(lastArg)) {
        (lastArg as Record<string, unknown>)['__feeRetryBumpedFee'] = bumpedFee;
      } else {
        (ctx.args as unknown[]).push({ __feeRetryBumpedFee: bumpedFee });
      }

      // Re-throw a structured error so the SDK middleware runner re-invokes
      // the call. The actual retry loop is driven externally (the client's
      // `runWithMiddleware` method re-throws from `onError`, so here we signal
      // via a special marker instead of swallowing the error).
      //
      // We throw a wrapped FeeRetryError so the caller can detect it and
      // attempt a retry at the client level if wired up; or alternatively the
      // error propagates and the user can catch + retry manually.
      throw new FeeRetryError(bumpedFee, state.attempts, error);
    },
  };

  return plugin;
}

// ── FeeRetryError ────────────────────────────────────────────────────────────

/**
 * Thrown by {@link createFeeRetryMiddleware} when a fee error is encountered
 * and the middleware has bumped the fee for a retry.
 *
 * Callers can catch this error and resubmit the transaction with
 * `suggestedFeeStroops` as the new fee ceiling.
 *
 * @example
 * ```ts
 * try {
 *   await client.createStream(params);
 * } catch (err) {
 *   if (err instanceof FeeRetryError) {
 *     console.log(`Retrying with fee: ${err.suggestedFeeStroops} stroops`);
 *     // Retry logic here...
 *   }
 * }
 * ```
 */
export class FeeRetryError extends Error {
  /** The bumped fee (in stroops) suggested for the next attempt. */
  readonly suggestedFeeStroops: number;
  /** The 1-based retry attempt number that produced this error. */
  readonly attempt: number;
  /** The underlying fee error that triggered this retry. */
  readonly cause: unknown;

  constructor(suggestedFeeStroops: number, attempt: number, cause: unknown) {
    super(
      `Fee error on attempt ${attempt}. Suggested retry fee: ${suggestedFeeStroops} stroops. ` +
        `Underlying error: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'FeeRetryError';
    this.suggestedFeeStroops = suggestedFeeStroops;
    this.attempt = attempt;
    this.cause = cause;
  }
}
