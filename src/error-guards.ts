/**
 * @module error-guards
 *
 * Type-safe narrowing helpers for the SoroStream SDK error hierarchy.
 *
 * Instead of writing:
 * ```ts
 * if (err instanceof SoroStreamRetryExhaustedError || err instanceof FederationResolutionError) { ... }
 * ```
 *
 * You can write:
 * ```ts
 * if (isNetworkError(err)) { ... }  // err is SoroStreamRetryExhaustedError | FederationResolutionError
 * ```
 *
 * Or use the `matchError` helper for exhaustive pattern matching:
 * ```ts
 * matchError(err, {
 *   onNetwork:    (e) => console.error("network:", e.message),
 *   onContract:   (e) => console.error("contract:", e.message),
 *   onValidation: (e) => console.error("validation field:", e instanceof SoroStreamValidationError ? e.field : ""),
 *   onAuth:       (e) => console.error("auth:", e.message),
 *   otherwise:    (e) => console.error("other:", String(e)),
 * });
 * ```
 */

import {
  SoroStreamError,
  SoroStreamRetryExhaustedError,
  FederationResolutionError,
  TransactionFailedError,
  StreamNotFoundError,
  StreamNotActiveError,
  DuplicateStreamError,
  BulkCreatePartialError,
  InsufficientAmountError,
  InsufficientBalanceError,
  InsufficientAllowanceError,
  ZeroDurationError,
  InvalidAddressError,
  AccountNotFoundError,
  SoroStreamValidationError,
  SoroStreamMemoError,
  NonceNotSupportedError,
  SoroStreamDependencyError,
  StartTimeInPastError,
  InvalidStreamIdError,
  TransactionMutatedError,
} from './errors.js';

// ── Error union types ─────────────────────────────────────────────────────────

/**
 * Errors related to network communication and transient RPC failures.
 * Includes retry exhaustion and federation address resolution failures.
 *
 * @example
 * ```ts
 * import { isNetworkError, type NetworkError } from "@sorostream/sdk";
 *
 * function handleError(err: unknown) {
 *   if (isNetworkError(err)) {
 *     // err: SoroStreamRetryExhaustedError | FederationResolutionError
 *     scheduleRetry();
 *   }
 * }
 * ```
 */
export type NetworkError = SoroStreamRetryExhaustedError | FederationResolutionError;

/**
 * Errors produced by on-chain contract interactions.
 * Covers failed transactions, missing/inactive streams, duplicate detection,
 * and partial bulk-create failures.
 *
 * @example
 * ```ts
 * import { isContractError, type ContractError } from "@sorostream/sdk";
 *
 * function handleError(err: unknown) {
 *   if (isContractError(err)) {
 *     // err: TransactionFailedError | StreamNotFoundError | StreamNotActiveError
 *     //    | DuplicateStreamError | BulkCreatePartialError
 *   }
 * }
 * ```
 */
export type ContractError =
  | TransactionFailedError
  | StreamNotFoundError
  | StreamNotActiveError
  | DuplicateStreamError
  | BulkCreatePartialError;

/**
 * Errors from client-side input validation before any RPC call is made.
 * Covers amount, balance, allowance, duration, address, and field-length checks.
 *
 * @example
 * ```ts
 * import { isValidationError, type ValidationError } from "@sorostream/sdk";
 *
 * function handleError(err: unknown) {
 *   if (isValidationError(err)) {
 *     // err: InsufficientAmountError | InsufficientBalanceError
 *     //    | InsufficientAllowanceError | ZeroDurationError
 *     //    | InvalidAddressError | AccountNotFoundError
 *     //    | SoroStreamValidationError | SoroStreamMemoError
 *   }
 * }
 * ```
 */
export type ValidationError =
  | InsufficientAmountError
  | InsufficientBalanceError
  | InsufficientAllowanceError
  | ZeroDurationError
  | InvalidAddressError
  | AccountNotFoundError
  | SoroStreamValidationError
  | SoroStreamMemoError
  | StartTimeInPastError
  | InvalidStreamIdError;

/**
 * Errors related to wallet authentication, signing capability, and
 * SDK/contract compatibility.
 *
 * @example
 * ```ts
 * import { isAuthError, type AuthError } from "@sorostream/sdk";
 *
 * function handleError(err: unknown) {
 *   if (isAuthError(err)) {
 *     // err: NonceNotSupportedError | SoroStreamDependencyError | TransactionMutatedError
 *   }
 * }
 * ```
 */
export type AuthError = NonceNotSupportedError | SoroStreamDependencyError | TransactionMutatedError;

// ── Type guard functions ──────────────────────────────────────────────────────

/**
 * Returns `true` when `err` is a {@link SoroStreamError}.
 *
 * Use this as an initial gate before the more specific guards below.
 *
 * @param err - Any value caught from a `catch` block.
 * @returns `true` if `err` is an instance of `SoroStreamError`.
 *
 * @example
 * ```ts
 * try {
 *   await client.createStream(...);
 * } catch (err) {
 *   if (isSoroStreamError(err)) {
 *     console.error(err.message); // err is SoroStreamError
 *   }
 * }
 * ```
 */
export function isSoroStreamError(err: unknown): err is SoroStreamError {
  return err instanceof SoroStreamError;
}

/**
 * Narrows `err` to a {@link NetworkError} —
 * either {@link SoroStreamRetryExhaustedError} or {@link FederationResolutionError}.
 *
 * Network errors are generally transient and suitable for retry or graceful
 * degradation.
 *
 * @param err - Any value caught from a `catch` block.
 * @returns `true` if `err` is a `SoroStreamRetryExhaustedError` or `FederationResolutionError`.
 *
 * @example
 * ```ts
 * if (isNetworkError(err)) {
 *   // err: SoroStreamRetryExhaustedError | FederationResolutionError
 *   if (err instanceof SoroStreamRetryExhaustedError) {
 *     console.log(`Failed after ${err.attemptCount} attempts`);
 *   }
 * }
 * ```
 */
export function isNetworkError(err: unknown): err is NetworkError {
  return err instanceof SoroStreamRetryExhaustedError || err instanceof FederationResolutionError;
}

/**
 * Narrows `err` to a {@link ContractError} — a failure originating from the
 * on-chain SoroStream contract or transaction submission.
 *
 * @param err - Any value caught from a `catch` block.
 * @returns `true` if `err` is one of the contract-level error classes.
 *
 * @example
 * ```ts
 * if (isContractError(err)) {
 *   // err: TransactionFailedError | StreamNotFoundError | StreamNotActiveError
 *   //    | DuplicateStreamError | BulkCreatePartialError
 *   if (err instanceof StreamNotFoundError) {
 *     router.push("/streams"); // stream was deleted
 *   }
 * }
 * ```
 */
export function isContractError(err: unknown): err is ContractError {
  return (
    err instanceof TransactionFailedError ||
    err instanceof StreamNotFoundError ||
    err instanceof StreamNotActiveError ||
    err instanceof DuplicateStreamError ||
    err instanceof BulkCreatePartialError
  );
}

/**
 * Narrows `err` to a {@link ValidationError} — a client-side input problem
 * caught before any RPC call.
 *
 * These errors indicate a programming mistake or invalid user input and
 * should generally not be retried without fixing the inputs.
 *
 * @param err - Any value caught from a `catch` block.
 * @returns `true` if `err` is one of the validation-level error classes.
 *
 * @example
 * ```ts
 * if (isValidationError(err)) {
 *   if (err instanceof SoroStreamValidationError) {
 *     showFieldError(err.field, `Too long (max ${err.maxLength} bytes)`);
 *   } else if (err instanceof InsufficientAllowanceError) {
 *     promptApproval(err.token, err.required);
 *   }
 * }
 * ```
 */
export function isValidationError(err: unknown): err is ValidationError {
  return (
    err instanceof InsufficientAmountError ||
    err instanceof InsufficientBalanceError ||
    err instanceof InsufficientAllowanceError ||
    err instanceof ZeroDurationError ||
    err instanceof InvalidAddressError ||
    err instanceof AccountNotFoundError ||
    err instanceof SoroStreamValidationError ||
    err instanceof SoroStreamMemoError ||
    err instanceof StartTimeInPastError ||
    err instanceof InvalidStreamIdError
  );
}

/**
 * Narrows `err` to an {@link AuthError} — a wallet capability or SDK
 * compatibility problem.
 *
 * @param err - Any value caught from a `catch` block.
 * @returns `true` if `err` is a `NonceNotSupportedError` or `SoroStreamDependencyError`.
 *
 * @example
 * ```ts
 * if (isAuthError(err)) {
 *   // err: NonceNotSupportedError | SoroStreamDependencyError
 *   if (err instanceof SoroStreamDependencyError) {
 *     console.error(`Upgrade ${err.packageName} to ${err.requiredRange}`);
 *   }
 * }
 * ```
 */
export function isAuthError(err: unknown): err is AuthError {
  return (
    err instanceof NonceNotSupportedError ||
    err instanceof SoroStreamDependencyError ||
    err instanceof TransactionMutatedError
  );
}

// ── matchError helper ─────────────────────────────────────────────────────────

/**
 * Handlers passed to {@link matchError}. Every key is optional except
 * `otherwise`, which catches anything that didn't match the specific handlers.
 *
 * TypeScript infers the return type of `matchError` from the handler return
 * types — no `as` casts needed.
 */
export interface ErrorMatchHandlers<
  TNetwork = void,
  TContract = void,
  TValidation = void,
  TAuth = void,
  TOtherwise = void,
> {
  /**
   * Called when `err` is a {@link NetworkError}.
   * @param err - `SoroStreamRetryExhaustedError | FederationResolutionError`
   */
  onNetwork?: (err: NetworkError) => TNetwork;
  /**
   * Called when `err` is a {@link ContractError}.
   * @param err - `TransactionFailedError | StreamNotFoundError | StreamNotActiveError
   *            | DuplicateStreamError | BulkCreatePartialError`
   */
  onContract?: (err: ContractError) => TContract;
  /**
   * Called when `err` is a {@link ValidationError}.
   * @param err - `InsufficientAmountError | InsufficientBalanceError | InsufficientAllowanceError
   *            | ZeroDurationError | InvalidAddressError | AccountNotFoundError
   *            | SoroStreamValidationError | SoroStreamMemoError`
   */
  onValidation?: (err: ValidationError) => TValidation;
  /**
   * Called when `err` is an {@link AuthError}.
   * @param err - `NonceNotSupportedError | SoroStreamDependencyError`
   */
  onAuth?: (err: AuthError) => TAuth;
  /**
   * Fallback handler called when `err` did not match any of the handlers above.
   * When omitted the function returns `undefined` for unmatched errors.
   */
  otherwise?: (err: unknown) => TOtherwise;
}

/**
 * Pattern-matching helper for the SoroStream error hierarchy.
 *
 * Dispatches `err` to the first matching handler and returns its result.
 * Returns `undefined` when no handler matches and `otherwise` is omitted.
 *
 * All handlers are optional — only provide the ones you need. TypeScript
 * narrows `err` to the correct subtype inside each handler with no `as`
 * casts required.
 *
 * @param err - Any value caught from a `catch` block.
 * @param handlers - An object with optional per-category callbacks.
 * @returns The return value of the matched handler, or `undefined`.
 *
 * @example
 * ```ts
 * const message = matchError(err, {
 *   onNetwork:    (e) => `Network error — please retry: ${e.message}`,
 *   onContract:   (e) => `Contract error: ${e.message}`,
 *   onValidation: (e) => `Bad input: ${e.message}`,
 *   onAuth:       (e) => `Auth problem: ${e.message}`,
 *   otherwise:    (e) => `Unexpected error: ${String(e)}`,
 * });
 * ```
 *
 * @example Early-exit without `otherwise`:
 * ```ts
 * matchError(err, {
 *   onNetwork:    (e) => showRetryBanner(e.message),
 *   onValidation: (e) => {
 *     if (e instanceof SoroStreamValidationError) highlightField(e.field);
 *     if (e instanceof InsufficientAllowanceError) promptApproval(e.token, e.required);
 *   },
 * });
 * ```
 */
export function matchError<
  TNetwork = undefined,
  TContract = undefined,
  TValidation = undefined,
  TAuth = undefined,
  TOtherwise = undefined,
>(
  err: unknown,
  handlers: ErrorMatchHandlers<TNetwork, TContract, TValidation, TAuth, TOtherwise>,
): TNetwork | TContract | TValidation | TAuth | TOtherwise | undefined {
  if (isNetworkError(err) && handlers.onNetwork) {
    return handlers.onNetwork(err) as TNetwork;
  }
  if (isContractError(err) && handlers.onContract) {
    return handlers.onContract(err) as TContract;
  }
  if (isValidationError(err) && handlers.onValidation) {
    return handlers.onValidation(err) as TValidation;
  }
  if (isAuthError(err) && handlers.onAuth) {
    return handlers.onAuth(err) as TAuth;
  }
  if (handlers.otherwise) {
    return handlers.otherwise(err) as TOtherwise;
  }
  return undefined;
}
