// See ERRORS.md for cause, typical trigger, and recovery guidance for each
// error class below, and which SoroStreamClient methods throw them.

export class SoroStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SoroStreamError';
  }
}

export class InsufficientAmountError extends SoroStreamError {
  constructor(message?: string) {
    super(message ?? 'Amount must be > 0');
    this.name = 'InsufficientAmountError';
  }
}

export class StreamNotFoundError extends SoroStreamError {
  constructor(streamId: string) {
    super(`Stream not found: ${streamId}`);
    this.name = 'StreamNotFoundError';
  }
}

export class StreamNotActiveError extends SoroStreamError {
  constructor(streamId: string) {
    super(`Stream is not active: ${streamId}`);
    this.name = 'StreamNotActiveError';
  }
}

export class TransactionFailedError extends SoroStreamError {
  constructor(details: string) {
    super(`Transaction failed: ${details}`);
    this.name = 'TransactionFailedError';
  }
}

export class InvalidAddressError extends SoroStreamError {
  constructor(address: string) {
    super(`Invalid Stellar address: ${address}`);
    this.name = 'InvalidAddressError';
  }
}

export class AccountNotFoundError extends SoroStreamError {
  constructor(address: string) {
    super(`Account not found on-chain: ${address}`);
    this.name = 'AccountNotFoundError';
  }
}

export class InsufficientBalanceError extends SoroStreamError {
  constructor(message?: string) {
    super(message ?? 'Insufficient token balance or missing trustline');
    this.name = 'InsufficientBalanceError';
  }
}

export class ZeroDurationError extends SoroStreamError {
  constructor(message?: string) {
    super(message ?? 'Stream duration must be greater than zero');
    this.name = 'ZeroDurationError';
  }
}

/** Describes a single failed slot within a bulk create operation. */
export interface BulkCreateFailedSlot {
  /** Zero-based index of the row in the original `rows` array. */
  index: number;
  /** The row that failed. */
  row: import('./types.js').BulkStreamRow;
  /** The underlying error that caused the failure. */
  error: unknown;
}

/**
 * Thrown by `bulkCreateStreams` when one or more stream slots fail contract
 * validation or transaction submission.
 *
 * `successfulBatches` contains every batch that committed successfully;
 * `failedSlots` describes each row that could not be created.
 */
export class BulkCreatePartialError extends SoroStreamError {
  readonly successfulBatches: import('./types.js').BulkCreateBatchResult[];
  readonly failedSlots: BulkCreateFailedSlot[];

  constructor(
    successfulBatches: import('./types.js').BulkCreateBatchResult[],
    failedSlots: BulkCreateFailedSlot[],
  ) {
    const created = successfulBatches.reduce((n, b) => n + b.streamIds.length, 0);
    super(
      `Bulk create partially failed: ${created} stream(s) created, ${failedSlots.length} slot(s) failed`,
    );
    this.name = 'BulkCreatePartialError';
    this.successfulBatches = successfulBatches;
    this.failedSlots = failedSlots;
  }
}

export class InsufficientAllowanceError extends SoroStreamError {
  /** Token contract address that was checked. */
  readonly token: string;
  /** Allowance required to create the stream (in stroops). */
  readonly required: bigint;
  /** Current allowance granted to the contract (in stroops). */
  readonly current: bigint;

  constructor(token: string, required: bigint, current: bigint) {
    super(
      `Insufficient allowance for token ${token}: required ${required}, current ${current} (shortfall ${required - current})`,
    );
    this.name = 'InsufficientAllowanceError';
    this.token = token;
    this.required = required;
    this.current = current;
  }
}

export class DuplicateStreamError extends SoroStreamError {
  constructor(message = 'Duplicate stream detected') {
    super(message);
    this.name = 'DuplicateStreamError';
  }
}

export class SoroStreamMemoError extends SoroStreamError {
  constructor(message: string) {
    super(message);
    this.name = 'SoroStreamMemoError';
  }
}

/**
 * Optional error type for custom `RpcTransportAdapter` implementations to
 * wrap a lower-level transport failure (a rejected fetch, a closed socket,
 * an auth failure, …) before letting it propagate out of an adapter method.
 * Not required — an adapter may throw any `Error` — but using it gives
 * `withRetry`'s failure logs and `SoroStreamRetryExhaustedError.originalError`
 * a consistent shape. See CUSTOM_TRANSPORT.md.
 */
export class SoroStreamTransportError extends SoroStreamError {
  /** The lower-level error that caused this transport failure, if any. */
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'SoroStreamTransportError';
    this.cause = cause;
  }
}

export class FederationResolutionError extends SoroStreamError {
  constructor(address: string, reason?: string) {
    super(`Failed to resolve federation address "${address}"${reason ? `: ${reason}` : ''}`);
    this.name = 'FederationResolutionError';
  }
}

/**
 * Thrown by `createStream` when `startTime` / `start_time` is earlier than the
 * current ledger timestamp (issue #411). The contract would reject the
 * transaction; the SDK fails fast with a client-side message instead.
 */
export class StartTimeInPastError extends SoroStreamError {
  constructor(startTime: number, ledgerTimestamp: number) {
    super(
      `start_time (${startTime}) is earlier than the current ledger timestamp (${ledgerTimestamp}). ` +
        `The contract rejects streams that start in the past.`,
    );
    this.name = 'StartTimeInPastError';
  }
}

export class SoroStreamValidationError extends SoroStreamError {
  /** Name of the field that failed validation. */
  readonly field: string;
  /** Actual length of the value in bytes. */
  readonly actualLength: number;
  /** Maximum allowed length in bytes. */
  readonly maxLength: number;

  constructor(field: string, actualLength: number, maxLength: number) {
    super(`Field "${field}" exceeded maximum length: ${actualLength} bytes (max ${maxLength})`);
    this.name = 'SoroStreamValidationError';
    this.field = field;
    this.actualLength = actualLength;
    this.maxLength = maxLength;
  }
}

/**
 * Thrown by `createStream` when `strict: true` is set in {@link WriteOptions}
 * and the caller provides a `nonce` field but the deployed contract does not
 * support the nonce parameter (issue #231).
 *
 * When `strict` is **not** set (default), a `console.warn` is emitted instead.
 */
export class NonceNotSupportedError extends SoroStreamError {
  constructor() {
    super(
      'The nonce field was provided but the deployed contract does not support ' +
        'nonce-based idempotency. Retries will NOT be deduplicated. ' +
        'Upgrade the contract or remove the nonce field. ' +
        'Pass strict: true in WriteOptions to turn this into an error.',
    );
    this.name = 'NonceNotSupportedError';
  }
}

export interface RetryAttempt {
  attempt: number;
  timestamp: number;
  error: unknown;
}

/**
 * Thrown by {@link withRetry} when all retry attempts are exhausted.
 *
 * Includes the original error from the last attempt, the total number of
 * attempts made, a timestamped log of every attempt, and (when available)
 * the final RPC response body for debugging.
 */
export class SoroStreamRetryExhaustedError extends SoroStreamError {
  readonly originalError: unknown;
  readonly attemptCount: number;
  readonly attempts: RetryAttempt[];
  readonly finalResponseBody: string | null;

  constructor(
    originalError: unknown,
    attemptCount: number,
    attempts: RetryAttempt[],
    finalResponseBody: string | null,
  ) {
    const lastErrMsg =
      originalError instanceof Error ? originalError.message : String(originalError);
    super(`RPC request failed after ${attemptCount} attempt(s): ${lastErrMsg}`);
    this.name = 'SoroStreamRetryExhaustedError';
    this.originalError = originalError;
    this.attemptCount = attemptCount;
    this.attempts = attempts;
    this.finalResponseBody = finalResponseBody;
  }
}

/**
 * Thrown by the constructor when the consumer's installed version of a peer
 * dependency (e.g. `@stellar/stellar-sdk`) is incompatible with the range
 * this SDK was built against. Pass `{ skipPeerCheck: true }` in the client
 * config to skip this check. Issue #213.
 */
export class SoroStreamDependencyError extends SoroStreamError {
  /** Name of the incompatible peer package, e.g. "@stellar/stellar-sdk". */
  readonly packageName: string;
  /** The semver range this SDK requires. */
  readonly requiredRange: string;
  /** The version actually installed in the consumer's environment. */
  readonly installedVersion: string;

  constructor(packageName: string, requiredRange: string, installedVersion: string) {
    super(
      `${packageName}@${installedVersion} is incompatible with this SDK, which requires ${packageName}@${requiredRange}. ` +
        `Upgrade or downgrade ${packageName} to satisfy ${requiredRange}, or pass { skipPeerCheck: true } to opt out of this check.`,
    );
    this.name = 'SoroStreamDependencyError';
    this.packageName = packageName;
    this.requiredRange = requiredRange;
    this.installedVersion = installedVersion;
  }
}

/**
 * Thrown when a stream creation request uses the same address for both sender
 * and recipient. Self-streaming is not supported by the contract.
 */
export class SelfStreamError extends SoroStreamError {
  constructor() {
    super(
      'Cannot create a stream where the recipient is the same as the sender. ' +
        'Use a different recipient address.',
    );
    this.name = 'SelfStreamError';
  }
}

/**
 * Thrown when the SDK detects a contract version that is outside the
 * supported compatibility range. Issue #209.
 */
export class SoroStreamVersionError extends SoroStreamError {
  /** The detected contract version. */
  readonly contractVersion: string;
  /** The minimum compatible version. */
  readonly minCompatibleVersion: string;
  /** Alias for {@link minCompatibleVersion}. */
  readonly minVersion: string;

  constructor(contractVersion: string, minVersion: string) {
    super(
      `Contract version ${contractVersion} is incompatible with SDK. Minimum required: ${minVersion}`,
    );
    this.name = 'SoroStreamVersionError';
    this.contractVersion = contractVersion;
    this.minCompatibleVersion = minVersion;
    this.minVersion = minVersion;
  }
}

/**
 * Thrown by {@link validateRecipient} when the recipient address is invalid
 * or does not exist on-chain (issue #339). The `warnings` array provides
 * human-readable explanations for each detected issue.
 */
export class RecipientValidationError extends SoroStreamError {
  /** Whether the address has a trustline for the token. */
  readonly hasTrustline: boolean;
  /** Whether the account exists on-chain. */
  readonly accountExists: boolean;
  /** Human-readable warnings for each detected issue. */
  readonly warnings: string[];

  constructor(hasTrustline: boolean, accountExists: boolean, warnings: string[]) {
    super(`Recipient validation failed: ${warnings.join('; ')}`);
    this.name = 'RecipientValidationError';
    this.hasTrustline = hasTrustline;
    this.accountExists = accountExists;
    this.warnings = warnings;
  }
}

/**
 * Thrown when a non-TLS (`http://`) RPC endpoint URL is supplied to the SDK
 * (constructor, `setNetwork`, or `updateConfig`) for a non-loopback host
 * (issue #463). Transaction data — including signed envelopes — must never
 * be routed over an unencrypted connection. Loopback hosts (`localhost`,
 * `127.0.0.1`, `::1`) are exempt to keep local Soroban quickstart workflows
 * working.
 */
export class InsecureRpcUrlError extends SoroStreamError {
  /** The rejected RPC URL. */
  readonly rpcUrl: string;

  constructor(rpcUrl: string) {
    super(
      `Insecure RPC URL "${rpcUrl}": non-TLS "http://" endpoints are not allowed. ` +
        'Use an "https://" URL, or a loopback host (localhost/127.0.0.1) for local development.',
    );
    this.name = 'InsecureRpcUrlError';
    this.rpcUrl = rpcUrl;
  }
}
