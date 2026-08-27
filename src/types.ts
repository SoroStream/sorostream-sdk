import type { FetchAdapter, WebSocketFactory } from './adapters.js';
import type { CircuitBreakerOptions } from './circuitBreaker.js';
import type { RetryOptions } from './retry.js';
import type { StreamRetryPolicy } from './events.js';

/** Status of a payment stream. */
export type StreamStatus = 'Active' | 'Cancelled' | 'Completed' | 'Paused';

// ── Event types (#1) ─────────────────────────────────────────────────────────

export type StreamEventType =
  | 'StreamCreated'
  | 'StreamWithdrawn'
  | 'StreamCancelled'
  | 'StreamCompleted'
  | 'StreamToppedUp'
  | 'StreamPaused'
  | 'StreamResumed'
  | 'StreamTransferred';

export interface StreamEvent<TData = Record<string, unknown>> {
  type: StreamEventType;
  streamId: string;
  txHash: string;
  ledger: number;
  timestamp: number;
  data: TData;
}

/** Typed event handler utility type. */
export type EventHandler<TData = Record<string, unknown>> = (event: StreamEvent<TData>) => void;

export interface StreamSubscription {
  unsubscribe(): void;
}

export interface StreamEventFilter {
  streamId?: string;
  sender?: string;
  recipient?: string;
}

// ── Pagination types (#3) ────────────────────────────────────────────────────

export interface PaginationParams {
  limit?: number;
  cursor?: string;
}

export interface PaginatedStreams {
  streams: Stream[];
  cursor: string | null;
  hasMore: boolean;
}

// ── Batch read types (#427) ──────────────────────────────────────────────────

/** Options for {@link SoroStreamClient.getStreams}. */
export interface GetStreamsOptions {
  /**
   * Maximum number of stream IDs sent per RPC call (default: `50`).
   *
   * Requests larger than this are split into several parallel calls so a
   * dashboard asking for 500 streams never builds a transaction that exceeds
   * the RPC's simulation limits.
   */
  chunkSize?: number;
  /**
   * When `false`, the per-stream TTL cache is ignored and every requested ID
   * is fetched from the network (default: `true`).
   */
  useCache?: boolean;
  /**
   * When `true`, a missing stream raises `StreamNotFoundError` instead of
   * being reported through {@link BatchStreamsResult.missing} (default: `false`).
   */
  strict?: boolean;
  /**
   * When `true` (default), a contract that does not implement the batch
   * `get_streams` entry point transparently falls back to parallel
   * single-stream reads, so the method works against older deployments.
   */
  fallbackToIndividual?: boolean;
}

/** Detailed result of a batch stream read. See {@link SoroStreamClient.getStreamsBatch}. */
export interface BatchStreamsResult {
  /** Resolved streams, in the same order as the requested IDs. */
  streams: Stream[];
  /** Requested IDs that have no on-chain record. */
  missing: string[];
  /** IDs served from the per-stream TTL cache without touching the network. */
  cached: string[];
  /** Number of RPC simulations issued to satisfy the request. */
  rpcCalls: number;
}

// ── Reactive (RxJS-compatible) observable types (#423) ───────────────────────

/** Options for {@link SoroStreamClient.observeStream}. */
export interface ObserveStreamOptions {
  /**
   * Polling interval in milliseconds used to refresh the stream (default:
   * `5000`). All subscribers of the same stream share a single poll loop.
   */
  intervalMs?: number;
  /**
   * When `true` (default), consecutive identical stream states are collapsed
   * so subscribers only see real changes.
   */
  emitOnlyChanges?: boolean;
  /**
   * When `true` (default), the observable completes once the stream reaches a
   * terminal state (`Completed` or `Cancelled`) — there is nothing left to
   * observe, so downstream `takeUntil`/`finalize` logic can clean up.
   */
  completeWhenSettled?: boolean;
  /**
   * When `true`, contract events for this stream also trigger a refresh so
   * changes surface without waiting for the next poll tick (default: `false`,
   * because it starts the shared event poller).
   */
  refreshOnEvents?: boolean;
}

// ── Multisig types (#16) ─────────────────────────────────────────────────────

export interface MultisigSigner {
  signTransaction(xdr: string, network: Network): Promise<string>;
}

// ── Webhook types (#22) ──────────────────────────────────────────────────────

export interface WebhookConfig {
  url: string;
  headers?: Record<string, string>;
  retries?: number;
  retryDelayMs?: number;
  /** Overrides the global `fetch` used to deliver the webhook (issue #199). */
  fetch?: FetchAdapter;
}

/** A single payment stream as returned by the contract. */
export interface Stream {
  /** Unique stream identifier. */
  id: string;
  /** Address of the stream creator / payer. */
  sender: string;
  /** Address of the stream beneficiary. */
  recipient: string;
  /** SAC token contract address (e.g. USDC). */
  token: string;
  /** Total token deposit locked in stroops. */
  deposit: bigint;
  /** Tokens released per second in stroops. */
  flowRate: bigint;
  /** Unix timestamp (seconds) when the stream started. */
  startTime: number;
  /** Unix timestamp (seconds) when the stream ends. */
  endTime: number;
  /** Unix timestamp (seconds) of the last withdrawal. */
  lastWithdrawTime: number;
  /** Current stream status. */
  status: StreamStatus;
  /** Whether the stream auto-renews on completion. */
  autoRenew: boolean;
  /** Unix timestamp (seconds) when the stream was paused (undefined if not paused). */
  pausedAt?: number;
  /** Unix timestamp (seconds) before which no withdrawals are permitted. */
  lockUntil?: number;
  /**
   * Optional namespace for multi-tenant scoping (issue #274).
   * Stored in the stream's metadata field. Filtering by namespace is
   * off-chain only — the contract does not enforce isolation.
   */
  namespace?: string;
  /** Optional helper method for JSON serialization of BigInt fields. */
  toJSON?(): Record<string, unknown>;
}

/** Parameters for creating a new stream. */
export interface CreateStreamParams {
  /** Beneficiary address. */
  recipient: string;
  /** SAC token contract address. */
  token: string;
  /** Total amount to stream in stroops. */
  amount: bigint;
  /** Stream duration in seconds. */
  durationSeconds: number;
  /** Whether to auto-renew on completion. */
  autoRenew: boolean;
  /** Opt-in check for duplicate stream creation. */
  checkDuplicate?: boolean;
  /**
   * Cliff duration in seconds (issue #74).
   * When set, the configured `validateCliff` function is called before
   * the transaction is submitted. Defaults to 0 (no cliff).
   */
  cliffSeconds?: number;
  /**
   * Optional idempotency nonce for duplicate-safe retries (issue #231).
   * When provided and the deployed contract supports nonce parameters, the
   * nonce is included in the `create_stream` call to deduplicate concurrent
   * retries. If the contract does **not** support nonces, the SDK emits a
   * `console.warn`. Pass `strict: true` in {@link WriteOptions} to throw an
   * error instead of warning.
   */
  nonce?: string;
  /**
   * Skip the token allowance pre-flight check (issue #165).
   * Set to true when you have already approved the contract or the token
   * does not expose an allowance view (e.g. native XLM).
   */
  skipAllowanceCheck?: boolean;
  /**
   * Unix timestamp (seconds) before which no withdrawals are allowed.
   * Must be between startTime and endTime when provided.
   * Enforced at contract level; the SDK validates this before submission.
   */
  lockUntil?: number;
  /**
   * Optional Unix timestamp (seconds) for when the stream should start.
   * Must not be earlier than the current ledger close time; the contract
   * rejects past start times. The SDK warns and throws before submission
   * when a past `startTime` is provided (issue #411).
   */
  startTime?: number;
  /**
   * Optional namespace for multi-tenant scoping (issue #274).
   * Stored in the stream's metadata field. Filtering by namespace is
   * off-chain only — the contract does not enforce isolation.
   */
  namespace?: string;
}

/** Overrides for cloneStream. Any CreateStreamParams field may be changed before submission. */
export type CloneStreamOverrides = Partial<CreateStreamParams>;

/** Alias for a single stream creation params object. */
export type CreateStreamsParams = CreateStreamParams;

/** Parameters for withdrawing from a stream. */
export interface WithdrawParams {
  /** Stream ID to withdraw from. */
  streamId: string;
}

/** Parameters for cancelling a stream. */
export interface CancelStreamParams {
  /** Stream ID to cancel. */
  streamId: string;
}

/** Parameters for topping up a stream. */
export interface TopUpParams {
  /** Stream ID to top up. */
  streamId: string;
  /** Additional amount to add in stroops. */
  amount: bigint;
}

/** Network configuration. */
export type Network = 'mainnet' | 'testnet' | 'futurenet';

/** Fee estimate returned by prepareTransaction. */
export interface FeeEstimate {
  /** Total fee in stroops (base fee + min resource fee). */
  totalFee: number;
  /** Soroban resource fee in stroops. */
  minResourceFee: number;
}

/** Result of batch cancellation. */
export interface BatchCancelResult {
  txHash: string;
  streamIds: string[];
}

/** Parameters for updating a stream's flow rate. */
export interface UpdateFlowRateParams {
  streamId: string;
  newFlowRate: bigint;
}

/** Parameters for setting an operator on a stream. */
export interface SetOperatorParams {
  streamId: string;
  operator: string;
  approved: boolean;
}

/** Parameters for an operator to top up a stream. */
export interface OperatorTopUpParams {
  streamId: string;
  amount: bigint;
}

/** Parameters for transferring a stream to a new recipient. */
export interface TransferStreamParams {
  streamId: string;
  newRecipient: string;
}

/** Parameters for pausing a stream. */
export interface PauseStreamParams {
  streamId: string;
}

/** Parameters for resuming a paused stream. */
export interface ResumeStreamParams {
  streamId: string;
}

/** A single milestone point in a vesting schedule. */
export interface VestingSchedulePoint {
  /** Unix timestamp of the milestone. */
  time: number;
  /** Amount vested in stroops at this point. */
  vested: bigint;
}

/** Result of a display-only vesting schedule calculation. */
export interface VestingScheduleResult {
  /** Effective claimable amount right now in stroops (0 if still in cliff). */
  effectiveClaimable: bigint;
  /** Total amount that vests over the full duration in stroops. */
  totalAmount: bigint;
  /** Unix timestamp when the cliff period ends. */
  cliffEndTime: number;
  /** Whether we are still in the cliff period. */
  inCliff: boolean;
  /** Schedule milestones for UI display (cliff, 25%, 50%, 75%, 100%). */
  milestones: VestingSchedulePoint[];
}

// ── Issue #148: Recipient change notification ────────────────────────────────

/** Payload delivered to an {@link onRecipientChanged} callback. */
export interface RecipientChangedEvent {
  streamId: string;
  oldRecipient: string;
  newRecipient: string;
  timestamp: number;
}

/** Options for {@link SoroStreamClient.onRecipientChanged}. */
export interface OnRecipientChangedOptions {
  /** Polling interval in ms (default: 5000). */
  intervalMs?: number;
}

// ── Issue #188: WebSocket compression ───────────────────────────────────────

/**
 * Options for permessage-deflate compression on WebSocket connections.
 * Disabled by default to avoid breaking existing deployments.
 */
export interface CompressionOptions {
  /**
   * zlib compression level (1 = fastest, 9 = best compression).
   * Default: 6 (zlib default).
   */
  level?: number;
  /**
   * Minimum payload size in bytes to compress (default: 128).
   * Payloads below this threshold are sent uncompressed to avoid overhead.
   */
  threshold?: number;
}

/** Reconnect policy options for WebSocket subscriptions. */
export interface WebSocketReconnectOptions {
  /** Max reconnect attempts before stopping (default: 5). Set to 0 to disable. */
  maxAttempts?: number;
  /** Base delay in ms for exponential backoff (default: 1000). */
  baseDelayMs?: number;
  /** Maximum delay cap in ms for exponential backoff (default: 30000). */
  maxDelayMs?: number;
}

/** Parameters for adding a delegate. */
export interface AddDelegateParams {
  delegate: string;
}

/** Parameters for revoking a delegate. */
export interface RevokeDelegateParams {
  delegate: string;
}

/**
 * Summary object passed to the {@link WatchClaimableOptions.onStreamCompleted} callback
 * when a watched stream reaches its end time.
 *
 * Issue #385.
 */
export interface StreamCompletedSummary {
  /** The stream ID that completed. */
  streamId: string;
  /** Total tokens streamed from startTime to endTime (deposit in stroops). */
  totalStreamed: bigint;
  /** Unix timestamp (seconds) when the stream ended. */
  endTime: number;
}

/** Options for {@link watchClaimable}. */
export interface WatchClaimableOptions {
  /** Interval in ms between interpolation ticks (default: 200). */
  tickMs?: number;
  /** Interval in ms between on-chain reconciliations (default: 5000). */
  reconcileMs?: number;
  /**
   * WebSocket URL for real-time claimable updates.
   * When provided, the watcher will subscribe via WS and fall back to
   * polling-based interpolation if the WS connection fails.
   */
  wsUrl?: string;
  /**
   * The stream ID to subscribe to for WS updates.
   * Required when `wsUrl` is set.
   */
  wsStreamId?: string;
  /**
   * Opt-in permessage-deflate compression for the WebSocket connection.
   * Disabled by default. Requires server-side support; falls back gracefully.
   * Issue #188.
   */
  compression?: boolean | CompressionOptions;
  /** Reconnect policy configuration for WebSocket connection. */
  wsReconnectOptions?: WebSocketReconnectOptions;
  /**
   * Returns a monotonically increasing version number that increments
   * each time the client switches networks. When the version changes
   * mid-session, the watcher cancels its current polling interval and
   * restarts against the new RPC endpoint.
   */
  getNetworkVersion?: () => number;
  /**
   * Called when a network switch is detected during reconciliation.
   * The watcher cancels its current polling and restarts with a fresh
   * base value. The callback receives an `outdatedData` signal so
   * subscribers know values are being refreshed.
   */
  onNetworkChanged?: () => void;
  /**
   * Overrides the global `WebSocket` constructor used for the `wsUrl`
   * subscription. Required in environments without a native `WebSocket`
   * global (issue #199).
   */
  webSocketFactory?: WebSocketFactory;
  /**
   * Called once when the watched stream reaches its `endTime`.
   * Receives the stream ID and a {@link StreamCompletedSummary} with the
   * total tokens streamed and the stream's end timestamp.
   *
   * Issue #385.
   *
   * @example
   * ```ts
   * watchClaimable(stream, reconcile, onTick, {
   *   onStreamCompleted: (streamId, summary) => {
   *     console.log(`Stream ${streamId} finished. Total streamed: ${summary.totalStreamed}`);
   *   },
   * });
   * ```
   */
  onStreamCompleted?: (streamId: string, summary: StreamCompletedSummary) => void;
}

/** Options for {@link watchTotalClaimable}. */
export interface WatchTotalClaimableOptions extends WatchClaimableOptions {}

/**
 * Wallet adapter interface. Implement this to support custom signing backends.
 *
 * @example
 * ```ts
 * const serverKeypairAdapter: WalletAdapter = {
 *   async getPublicKey() { return Keypair.fromSecret(process.env.SECRET!).publicKey(); },
 *   async signTransaction(xdr, network) {
 *     const kp = Keypair.fromSecret(process.env.SECRET!);
 *     const tx = TransactionBuilder.fromXDR(xdr, Networks[network.toUpperCase()]);
 *     tx.sign(kp);
 *     return tx.toEnvelope().toXDR("base64");
 *   },
 *   async isConnected() { return true; },
 * };
 * ```
 */
export interface WalletAdapter {
  getPublicKey(): Promise<string>;
  signTransaction(xdr: string, network: Network): Promise<string>;
  isConnected(): Promise<boolean>;
  /**
   * Optional: subscribe to wallet-initiated network changes (issue #215).
   * Called with the new network whenever the connected wallet switches
   * networks mid-session (e.g. the user changes networks in the Freighter
   * extension). Returns an unsubscribe function.
   *
   * Adapters that cannot detect wallet-side network changes (server-side
   * keypair adapters, multisig adapters, etc.) simply omit this method.
   */
  onNetworkChange?(callback: (network: Network) => void): () => void;
  /**
   * Optional: subscribe to wallet lock/unlock (connection) changes (issue #410).
   * Called with `false` when the wallet is locked or disconnected, and `true`
   * when it becomes available again (e.g. Freighter unlocked mid-session).
   * Returns an unsubscribe function.
   */
  onConnectionChange?(callback: (connected: boolean) => void): () => void;
  /**
   * Optional: releases any retained key material (issue #460). Adapters that
   * hold raw secret key buffers (e.g. `createKeypairAdapter`) zero them out
   * here; adapters with nothing sensitive to hold in memory simply omit this
   * method. Once called, the adapter should no longer be used.
   */
  destroy?(): void;
}

/** Result shape returned when a wallet adapter signs a transaction (issue #344). */
export interface WalletAdapterSignResult {
  /** The signed transaction envelope XDR encoded in base64. */
  signedXdr: string;
  /** Optional transaction hash if calculated by the adapter. */
  txHash?: string;
}

/** A single row for bulk stream creation. */
export interface BulkStreamRow {
  recipient: string;
  amount: bigint;
  durationSeconds: number;
  /** Optional per-row token override. Falls back to BulkCreateOptions.token when omitted. */
  token?: string;
  /** Optional cliff duration in seconds for this row (issue #74). Defaults to 0. */
  cliffSeconds?: number;
}

/** Options for bulkCreateStreams. */
export interface BulkCreateOptions {
  /** SAC token contract address. Applied as default when a row omits `token`. */
  token: string;
  /** Whether auto-renew is enabled (default false). */
  autoRenew?: boolean;
  /** Max operations per transaction (default 8). */
  batchSize?: number;
}

/** Result of one batch within a bulk create. */
export interface BulkCreateBatchResult {
  txHash: string;
  streamIds: string[];
  rows: BulkStreamRow[];
}

/** Full result of bulkCreateStreams. */
export interface BulkCreateResult {
  batches: BulkCreateBatchResult[];
}

/** Result of one transaction within a batchWithdraw call. */
export interface BatchWithdrawResult {
  txHash: string;
  streamIds: string[];
  amounts: string[];
}

/**
 * Result of a batchWithdraw call that collects partial results (issue #229).
 * Streams that succeeded are in `successes`, failures are in `failures`.
 */
export interface BatchWithdrawPartialResult {
  /** Stream IDs successfully withdrawn. */
  successes: string[];
  /** Stream IDs that failed, with the thrown error per stream. */
  failures: { id: string; error: Error }[];
}

/** Per-token aggregate of a set of streams. */
export interface TokenAggregate {
  token: string;
  streamCount: number;
  deposited: bigint;
  claimable: bigint;
  claimedSoFar: bigint;
}

// ── Issue #44: Locale-aware formatUSDC ───────────────────────────────────────

/** Options for locale-aware {@link formatUSDC} formatting. */
export interface FormatUSDCOptions {
  /** BCP 47 locale string (e.g. "en-US", "de-DE"). */
  locale?: string;
  /** Maximum decimal digits to display. */
  maximumFractionDigits?: number;
  /** Minimum decimal digits to display. */
  minimumFractionDigits?: number;
  /** Whether to use grouping separators (e.g. commas in en-US). Default: true. */
  useGrouping?: boolean;
}

// ── Issue #47: Cache reconciliation / drift detection ────────────────────────

/** A single field that differs between cached and on-chain stream state. */
export interface StreamDrift {
  field: keyof Stream;
  cached: unknown;
  onChain: unknown;
}

/** Options for {@link watchStreamDrift}. */
export interface ReconcileStreamOptions {
  /** Interval in ms between on-chain reconciliation checks (default: 30000). */
  intervalMs?: number;
}

// ── Issue #46: WebAuthn passkey adapter ─────────────────────────────────────

/** Configuration for a WebAuthn/passkey-based Soroban smart wallet adapter. */
export interface PasskeyAdapterConfig {
  /** Deployed smart wallet contract address (becomes the wallet's public key). */
  contractId: string;
  /** WebAuthn relying party ID (e.g. "example.com"). */
  rpId: string;
  /**
   * The credential ID of the registered passkey (ArrayBuffer from credential.rawId).
   * Required — without it the browser may select the wrong passkey silently.
   */
  credentialId: ArrayBuffer;
}

// ── Price feed adapter (#Issue 1) ────────────────────────────────────────────

/**
 * Pluggable adapter for converting token amounts to fiat display values.
 * Implement this to back formatToken/toFiatDisplay with a price oracle or API.
 */
export interface PriceFeedAdapter {
  /**
   * Returns the price of one unit of the given token in the display currency.
   * @param tokenAddress - The token contract address (e.g. SAC address).
   * @param displayCurrency - Target currency code (default: "usd").
   * @returns Price per token unit in the display currency.
   */
  getPrice(tokenAddress: string, displayCurrency?: string): Promise<number>;
}

// ── Split stream types ───────────────────────────────────────────────────────

/** Parameters for splitting an active stream into two streams. */
export interface SplitStreamParams {
  /** Stream ID to split. */
  streamId: string;
  /** Numerator of the split ratio (e.g. 70 for a 70/30 split). */
  ratioNumerator: number;
  /** Denominator of the split ratio (e.g. 100 for 70/100 = 70%). */
  ratioDenominator: number;
  /** First destination address for the split stream. */
  recipientA: string;
  /** Second destination address for the split stream. */
  recipientB: string;
}

/** Result of splitting a stream. */
export interface SplitStreamResult {
  /** Transaction hash of the split operation. */
  txHash: string;
  /** Stream ID for the first split stream. */
  streamIdA: string;
  /** Stream ID for the second split stream. */
  streamIdB: string;
}

// ── Fee bump types (#Issue 3) ────────────────────────────────────────────────

/**
 * Options for wrapping a transaction in a Stellar fee-bump.
 * Allows an app operator to cover network fees on behalf of end users.
 */
export interface FeeBumpOptions {
  /** The Stellar address of the account paying network fees. */
  sponsorAddress: string;
  /** Wallet adapter for signing the fee-bump envelope. */
  sponsorAdapter: WalletAdapter;
  /** Maximum fee in stroops the sponsor is willing to pay. */
  maxFee?: number;
}

// ── Issue #201: Memo parsing ─────────────────────────────────────────────────

/**
 * The subset of a Horizon transaction record's fields needed to decode its
 * memo. Accepts a full Horizon transaction response as well as this minimal
 * shape.
 */
export interface HorizonTransactionRecord {
  /** The memo encoding used, or `"none"` when no memo was set. */
  memo_type?: 'none' | 'text' | 'id' | 'hash' | 'return';
  /**
   * The raw memo value as returned by Horizon: plain text for `"text"`/`"id"`,
   * base64 for `"hash"`/`"return"`. Absent when `memo_type` is `"none"`.
   */
  memo?: string;
}

/** The result of decoding a Horizon transaction record's memo. */
export interface ParsedMemo {
  /** The memo's encoding, or `"none"` when the transaction had no memo. */
  type: 'none' | 'text' | 'id' | 'hash' | 'return';
  /**
   * The decoded value: the plain string for `"text"`/`"id"`, a 32-byte
   * `Buffer` for `"hash"`/`"return"`, or `null` when `type` is `"none"`.
   */
  value: string | MemoHash | null;
}

// ── Write options ────────────────────────────────────────────────────────────

/**
 * A 32-byte hash memo, as required by Stellar's `MEMO_HASH` type (issue #201).
 * Any value whose length is not exactly 32 bytes is rejected at submission time.
 *
 * Issue #406: Changed from `Buffer` to `Uint8Array` for Cloudflare Workers compatibility.
 * `Buffer` is a Node.js-only subclass of `Uint8Array`; using `Uint8Array` directly works
 * in all environments (Node.js, Bun, Deno, Cloudflare Workers, browsers).
 */
export type MemoHash = Uint8Array;

/** Options for write operations (create, withdraw, cancel, top-up). */
export interface WriteOptions {
  /** If true, simulate only without submitting. */
  simulateOnly?: boolean;
  /** Optional AbortSignal to cancel in-flight transaction polling. */
  signal?: AbortSignal;
  /** Override fee-bump for this specific transaction. */
  feeBump?: FeeBumpOptions;
  /**
   * If true, throw a `NonceNotSupportedError` when a nonce is provided but
   * the deployed contract does not support it (issue #231). When false
   * (default), a `console.warn` is emitted instead.
   */
  strict?: boolean;
  /**
   * Optional transaction memo for off-chain reconciliation (issue #201),
   * e.g. tagging a transaction with an invoice ID or order reference.
   * - `string` — encoded as `MEMO_TEXT`. Must be <= 28 bytes once UTF-8 encoded.
   * - {@link MemoHash} (`Uint8Array`) — encoded as `MEMO_HASH`. Must be exactly 32 bytes.
   */
  memo?: string | MemoHash;
  /**
   * When `true`, run the operation in explain/dry-run mode.
   *
   * The method will simulate the transaction (no on-chain submission) and
   * return an {@link OperationExplanation} object instead of the normal
   * `{ txHash, ... }` result. The explanation includes a human-readable
   * summary, affected addresses, expected balance changes, and the estimated
   * network fee.
   *
   * If simulation fails (e.g. the contract rejects the parameters) the method
   * throws a `TransactionFailedError` with the simulation error details.
   *
   * Issue #268.
   */
  explain?: boolean;
}

// ── Issue #268: SDK explain mode ─────────────────────────────────────────────

/**
 * A single balance change expected from a write operation.
 * Amounts are in stroops; negative values represent outflows.
 */
export interface BalanceDelta {
  /** Stellar address affected. */
  address: string;
  /** Token contract address (SAC). */
  token: string;
  /**
   * Expected change in token balance in stroops.
   * Negative = tokens leaving the account; positive = tokens arriving.
   */
  delta: bigint;
}

/**
 * Human-readable explanation of a pending write operation, returned when
 * `explain: true` is passed to a write method.
 *
 * Analogous to `terraform plan` or SQL `EXPLAIN` — shows what the operation
 * will do without submitting it on-chain.
 *
 * Issue #268.
 */
export interface OperationExplanation {
  /**
   * The SDK method being explained (e.g. `"createStream"`, `"withdraw"`).
   */
  operation: string;
  /**
   * A plain-English sentence describing what the operation will do.
   *
   * @example "Create a stream of 100 USDC over 30 days from GABC... to GXYZ..."
   * @example "Withdraw 12.50 USDC from stream 42"
   * @example "Cancel stream 42 — refund estimated 87.50 USDC to sender GABC..."
   */
  summary: string;
  /**
   * All Stellar addresses that will be directly involved in the operation.
   * Includes the sender/recipient/operator as applicable.
   */
  affectedAddresses: string[];
  /**
   * Expected balance changes per address and token.
   * Empty when the operation has no predictable balance impact (e.g. a
   * parameter-only update that does not move tokens).
   */
  balanceDeltas: BalanceDelta[];
  /**
   * Estimated total network fee in stroops (base fee + Soroban resource fee).
   * Derived from a dry-run `prepareTransaction` call.
   */
  estimatedFee: number;
  /** Minimum Soroban resource fee component in stroops. */
  minResourceFee: number;
  /**
   * Raw Soroban simulation response for callers who want to inspect low-level
   * resource usage (instructions, read/write bytes, etc.).
   */
  simulationResult: unknown;
}

// ── Contract versioning (#Issue 4) ───────────────────────────────────────────

/** Supported contract versions for call encoding. */
export type ContractVersion = 'v1' | 'v2';

// ── Issue #209: Contract compatibility checking ──────────────────────────────

/**
 * Result of checking SDK-to-contract version compatibility.
 */
export interface CompatibilityResult {
  /** The SDK version (from package.json). */
  sdkVersion: string;
  /** The deployed contract version (may be null if contract doesn't expose get_version). */
  contractVersion: string | null;
  /** The minimum compatible contract version. */
  minCompatibleVersion: string;
  /** The maximum compatible contract version. */
  maxCompatibleVersion: string;
  /** Whether the contract version is within the supported range. */
  isCompatible: boolean;
  /** Human-readable compatibility message. */
  message: string;
}

// ── Dashboard / reporting aggregate types ────────────────────────────────────

/** Aggregate totals across a set of streams. */
export interface StreamTotals {
  /** Total number of streams. */
  totalStreams: number;
  /** Sum of all deposits in stroops. */
  totalDeposited: bigint;
  /** Sum of all claimable amounts in stroops (estimated). */
  totalClaimable: bigint;
  /** Sum of all claimed amounts in stroops. */
  totalClaimed: bigint;
  /** Sum of all remaining deposits in stroops. */
  totalRemaining: bigint;
}

/** Per-status breakdown of a set of streams. */
export interface StatusBreakdown {
  /** Streams with status "Active". */
  active: number;
  /** Streams with status "Cancelled". */
  cancelled: number;
  /** Streams with status "Completed". */
  completed: number;
}

/** Duration statistics for a set of streams. */
export interface DurationStats {
  /** Average duration in seconds. */
  average: number;
  /** Minimum duration in seconds. */
  min: number;
  /** Maximum duration in seconds. */
  max: number;
  /** Median duration in seconds. */
  median: number;
}

/** Summary of stream health issues. */
export interface StreamHealthReport {
  /** Number of active streams expiring within the threshold. */
  expiring: number;
  /** Number of active streams that have stalled. */
  stalled: number;
  /** Number of active streams that are underfunded. */
  underfunded: number;
  /** Total active streams checked. */
  totalActive: number;
}

/** Per-recipient aggregate of a set of streams. */
export interface RecipientAggregate {
  /** Recipient address. */
  recipient: string;
  /** Number of streams targeting this recipient. */
  streamCount: number;
  /** Total deposited in stroops. */
  deposited: bigint;
  /** Estimated claimable amount in stroops. */
  claimable: bigint;
  /** Total claimed so far in stroops. */
  claimedSoFar: bigint;
}

/**
 * A single stream's current accrued claimable balance returned by
 * `SoroStreamClient.getMultipleStreamBalances`.
 *
 * `balance` is the amount claimable right now in stroops (`0n` when the
 * stream does not exist). The entry type is JSON-serialisable so dashboard
 * layers can render many balances directly.
 */
export interface StreamBalance {
  /** The stream ID the balance belongs to. */
  streamId: string;
  /** Current accrued claimable amount in stroops. */
  balance: bigint;
}

// ── Issue #405: Recipient trust score integration ────────────────────────────

/**
 * Result returned by a recipient trust score provider.
 */
export interface RecipientTrustScore {
  /** Numeric trust score (0–100, where 100 is fully trusted). */
  score: number;
  /**
   * Optional human-readable label for the score (e.g. `"KYC_VERIFIED"`,
   * `"UNVERIFIED"`, `"BLOCKED"`).
   */
  label?: string;
  /** Optional raw provider metadata for logging/auditing. */
  metadata?: Record<string, unknown>;
}

/**
 * Hook called before every `createStream` transaction is submitted.
 *
 * Receives the recipient address and must return a {@link RecipientTrustScore}.
 * Throw any error to block stream creation — the error propagates unchanged to
 * the caller so the app can present a meaningful message.
 *
 * @example
 * ```ts
 * const client = new SoroStreamClient({
 *   // ...
 *   onRecipientTrustScore: async (recipient) => {
 *     const result = await myKycProvider.score(recipient);
 *     if (result.blocked) throw new Error(`Recipient ${recipient} is blocked`);
 *     return { score: result.score, label: result.tier };
 *   },
 * });
 * ```
 */
export type RecipientTrustScoreProvider = (
  recipient: string,
) => RecipientTrustScore | Promise<RecipientTrustScore>;

// ── Issue #364: onStreamUpdate subscription ─────────────────────────────────

/** Options for the {@link SoroStreamClient.onStreamUpdate} subscription. */
export interface OnStreamUpdateOptions {
  /**
   * How often to poll the RPC for state changes, in ms.
   * Defaults to 5000 (5 seconds).
   */
  pollIntervalMs?: number;
  /**
   * When true, fire the callback immediately with the current stream state
   * before waiting for the first poll interval. Defaults to false.
   */
  immediate?: boolean;
}

// ── Stream filtering (issue #204) ───────────────────────────────────────────

/** Criteria for filtering streams. */
export interface StreamFilterCriteria {
  sender?: string;
  recipient?: string;
  token?: string;
  status?: StreamStatus;
  /** When true, only include streams that are `"Active"` and not yet expired. */
  activeOnly?: boolean;
  /**
   * Inclusive lower bound (Unix seconds) on the stream's `startTime`.
   * Combine with `startTimeTo` to select streams that started within a window.
   */
  startTimeFrom?: number;
  /** Inclusive upper bound (Unix seconds) on the stream's `startTime`. */
  startTimeTo?: number;
  /** Inclusive lower bound (Unix seconds) on the stream's `endTime`. */
  endTimeFrom?: number;
  /** Inclusive upper bound (Unix seconds) on the stream's `endTime`. */
  endTimeTo?: number;
}

/** Alias for {@link StreamFilterCriteria}, matching the `filterStreams` API. */
export type StreamFilter = StreamFilterCriteria;

/** Field to sort streams by in {@link sortStreams}. `"amount"` sorts by `deposit`. */
export type StreamSortField = 'startTime' | 'endTime' | 'amount';

/** Sort direction for {@link sortStreams}. */
export type SortOrder = 'asc' | 'desc';

// ── Issue #166: Stream activity log ─────────────────────────────────────────

/** The type of activity recorded in a stream's activity log. */
export type StreamActivityType =
  'StreamCreated' | 'StreamWithdrawn' | 'StreamCancelled' | 'StreamToppedUp';

/** A single entry in a stream's on-chain activity log. */
export interface StreamActivityEntry {
  /** Type of on-chain event. */
  type: StreamActivityType;
  /** Unix timestamp (ms) of the ledger close. */
  timestamp: number;
  /** Token amount involved, in stroops. `0n` for events with no amount. */
  amount: bigint;
  /** Transaction hash that emitted this event. */
  txHash: string;
  /** Raw ledger number. */
  ledger: number;
}

/** Options for {@link SoroStreamClient.getActivityLog}. */
export interface GetActivityLogOptions {
  /** Only return entries at or after this Unix timestamp (ms). */
  from?: number;
  /** Only return entries at or before this Unix timestamp (ms). */
  to?: number;
  /** Max number of entries to return per page (default 100). */
  limit?: number;
  /** Cursor from a previous page for continuation. */
  cursor?: string;
}

// ── Issue #73: Stream snapshot export/import ─────────────────────────────────

/** A history entry recording a past event on a stream. */
export interface StreamHistoryEntry {
  type: string;
  timestamp: number;
  txHash: string;
  data?: Record<string, unknown>;
}

/** A projected vesting milestone used in the snapshot. */
export interface SnapshotVestingPoint {
  time: number;
  vested: string; // serialised as string to survive JSON bigint round-trip
}

/** A serialisable snapshot of a stream at a point in time. */
export interface StreamSnapshot {
  /** Snapshot schema version. */
  version: 1;
  /** Unix timestamp (ms) when the snapshot was taken. */
  exportedAt: number;
  /** The full stream parameter set. */
  stream: Omit<Stream, 'deposit' | 'flowRate'> & {
    deposit: string;
    flowRate: string;
  };
  /** Current claimable amount at snapshot time, serialised as string. */
  claimableAtExport: string;
  /** Projected vesting curve milestones. */
  vestingProjection: SnapshotVestingPoint[];
  /** Recorded event history (may be empty when history is unavailable). */
  history: StreamHistoryEntry[];
}

// ── Issue #50: Middleware / plugin system ────────────────────────────────────

/** Context passed to every middleware hook. */
export interface MiddlewareContext {
  /** Name of the client method being called (e.g. "createStream"). */
  method: string;
  /** Arguments passed to the method. */
  args: unknown[];
}

/** A middleware plugin that can observe or intercept client calls. */
export interface SoroStreamPlugin {
  /**
   * Called before the client method executes.
   * Throw to prevent the call from proceeding.
   */
  before?(ctx: MiddlewareContext): void | Promise<void>;
  /**
   * Called after the client method resolves successfully.
   * `result` is the return value of the method.
   */
  after?(ctx: MiddlewareContext, result: unknown): void | Promise<void>;
  /**
   * Called when the client method throws.
   * Re-throwing replaces the original error; returning swallows it.
   */
  onError?(ctx: MiddlewareContext, error: unknown): void | Promise<void>;
}

// ── Issue #203: Token metadata caching ──────────────────────────────────────

/** SAC token metadata (name, symbol, decimals) as read from the token contract. */
export interface TokenMetadata {
  /** Full token name (e.g. "USD Coin"). */
  name: string;
  /** Token symbol (e.g. "USDC"). */
  symbol: string;
  /** Number of decimal places the token uses. */
  decimals: number;
}

// ── Issue #187: Event batching ───────────────────────────────────────────────

/** Configuration for event batching on high-frequency streams. */
export interface BatchingOptions {
  /** Max events per batch before flushing (default: 50). */
  maxBatchSize?: number;
  /** Max delay in ms before a non-full batch is flushed (default: 10). */
  maxBatchDelayMs?: number;
}

/** Running metrics for the event batch buffer. */
export interface BatchMetrics {
  /** Total number of batches flushed since the poller started. */
  totalBatches: number;
  /** Total number of events delivered across all batches. */
  totalEvents: number;
  /** Average batch size (0 when no batches have been flushed yet). */
  averageBatchSize: number;
  /** Unix timestamp (ms) of the most recent flush, or null if none. */
  lastFlushAt: number | null;
}

// ── Issue #212: Custom event bus integration ─────────────────────────────────

/** Payload emitted on the `"stream.created"` event bus event. */
export interface StreamCreatedEventPayload {
  streamId: string;
  sender: string;
  recipient: string;
  token: string;
  txHash: string;
}

/** Payload emitted on the `"stream.withdrawn"` event bus event. */
export interface StreamWithdrawnEventPayload {
  streamId: string;
  amount: string;
  txHash: string;
}

/** Payload emitted on the `"stream.cancelled"` event bus event. */
export interface StreamCancelledEventPayload {
  streamId: string;
  txHash: string;
}

/** Payload emitted on the `"rpc.error"` event bus event. */
export interface RpcErrorEventPayload {
  /** Name of the client method that failed (e.g. `"createStream"`). */
  method: string;
  /** The underlying error thrown during submission. */
  error: unknown;
}

/**
 * Event payload emitted by {@link SoroStreamClient.setWalletAdapter} after
 * the signing provider has been replaced without re-initialising the client.
 * Issue #261.
 */
export interface WalletAdapterChangedPayload {
  /**
   * Public key held by the adapter that was replaced.
   * \`null\` when the previous adapter's \`getPublicKey()\` could not be resolved.
   */
  previousPublicKey: string | null;
  /**
   * Public key of the newly active adapter.
   * \`null\` when the new adapter's \`getPublicKey()\` could not be resolved.
   */
  newPublicKey: string | null;
  /**
   * Human-readable name for the new adapter, if provided.
   * For display or audit-log purposes only.
   */
  adapterName?: string;
}

/**
 * Maps each SDK lifecycle event name emitted through {@link IEventBus} to its
 * payload shape. Reference-only — {@link IEventBus.emit} itself stays
 * loosely typed so any framework-agnostic bus can implement it.
 */
export interface SoroStreamEventMap {
  'stream.created': StreamCreatedEventPayload;
  'stream.withdrawn': StreamWithdrawnEventPayload;
  'stream.cancelled': StreamCancelledEventPayload;
  'rpc.error': RpcErrorEventPayload;
  walletAdapterChanged: WalletAdapterChangedEventPayload;
  cacheInvalidated: CacheInvalidatedEventPayload;
  requestDeduplicated: RequestDeduplicatedEventPayload;
}

/**
 * Payload emitted when a read call joined an already in-flight request
 * instead of issuing its own (issue #426).
 */
export interface RequestDeduplicatedEventPayload {
  /** Internal deduplication key of the shared request. */
  key: string;
  /** Network the shared request is running against. */
  network: Network;
}

/** Payload emitted when the client read cache is invalidated (issue #342). */
export interface CacheInvalidatedEventPayload {
  reason: 'networkSwitch' | 'manual' | string;
  network: Network;
  previousNetwork?: Network;
  streamId?: string;
}

/** Payload emitted when the wallet adapter is hot-swapped (issue #261). */
export interface WalletAdapterChangedEventPayload {
  /** The new wallet adapter. */
  adapter: WalletAdapter;
  /** Identifier for the new adapter. */
  identifier: string;
  /** The previous wallet adapter. */
  previousAdapter: WalletAdapter;
}

/** Configuration options for KmsWalletAdapter (issue #306). */
export interface KmsWalletAdapterConfig {
  /** The public key (Stellar address) corresponding to the KMS key. */
  publicKey: string;
  /** Async function that signs raw payload bytes using KMS. */
  sign: (payload: Uint8Array) => Promise<Uint8Array>;
}

/** Result shape returned by SoroStreamClient.healthCheck (issue #308). */
export interface HealthCheckResult {
  /** True if RPC endpoint responded successfully within timeout. */
  rpcReachable: boolean;
  /** Measured round-trip latency in milliseconds. */
  latencyMs: number;
  /** Optional error message if RPC check failed. */
  error?: string;
}

/** Options for exportStreamHistory (issue #307). */
export interface ExportStreamHistoryOptions {
  /** Output format: 'json' (array) or 'ndjson' (line-delimited stream). Defaults to 'json'. */
  format?: 'json' | 'ndjson';
  /** Target writable stream (Node.js WritableStream, browser WritableStream, or object with write()). */
  writable?: any;
  /** Maximum items per page fetch. Defaults to 100. */
  limit?: number;
  /** Starting ledger number to filter events. */
  startLedger?: number;
}

// ── Issue #267: JSON Schema generation ───────────────────────────────────────

/**
 * The JSON-serializable subset of `SoroStreamClientOptions` — the parts of a
 * client config a non-TypeScript caller (a Python or Go script assembling a
 * config payload) can meaningfully specify and validate.
 *
 * Deliberately excludes fields that bind to a runtime object with no JSON
 * representation: `walletAdapter`, `transport`, `priceFeed`, `validateCliff`,
 * `plugins`, `adapters`, and `feeBump` (its `sponsorAdapter` is a signer).
 * This is the type `generateSchemas()` reflects to produce the
 * `SoroStreamClientConfig` JSON Schema exported at `@sorostream/sdk/schemas`.
 */
export interface SoroStreamClientConfig {
  /** The Stellar network to connect to. */
  network?: Network;
  /** The deployed StreamContract address. */
  contractId: string;
  /** Optional custom RPC URL (overrides the default for `network`). */
  rpcUrl?: string;
  /** Optional circuit-breaker configuration for RPC calls. */
  circuitBreaker?: CircuitBreakerOptions;
  /** Maximum time in ms to wait for a transaction to confirm (default: 120000). */
  txTimeoutMs?: number;
  /** Retry policy for read methods (getStream, getClaimable, etc.). */
  readRetry?: Omit<RetryOptions, 'signal'>;
  /** Retry policy for transaction submission RPC calls. */
  submitRetry?: Omit<RetryOptions, 'signal'>;
  /** Contract version to use for call encoding (default: "v1"). */
  contractVersion?: ContractVersion;
  /** Maximum number of pooled HTTP connections reused across RPC calls (default: 5). */
  maxConnections?: number;
  /** Time in ms before an idle pooled connection is closed (default: 30000). */
  idleTimeoutMs?: number;
  /** Opt-in connection pool size for high-throughput stream scenarios. */
  poolSize?: number;
  /** Maximum concurrent subscriptions per pooled connection (default: 10). */
  maxSubscriptionsPerConnection?: number;
  /** Retry policy for automatic event-stream reconnection on unexpected failures. */
  retryPolicy?: StreamRetryPolicy;
  /** Opt-in event batching configuration for high-frequency streams. */
  batchingOptions?: BatchingOptions;
  /** Opt-in check for duplicate stream creation. */
  checkDuplicate?: boolean;
  /** When true, write an audit log entry for each SDK write operation. */
  auditLog?: boolean;
}

/** Portfolio statistics aggregated across all of an address's streams. Issue #336. */
export interface PortfolioStats {
  activeSentCount: number;
  activeReceivedCount: number;
  totalClaimable: bigint;
  totalMonthlyOutflow: bigint;
  totalMonthlyInflow: bigint;
}

/** Auto fee-bump monitoring configuration. Issue #337. */
export interface FeeBumpMonitoringOptions {
  enabled: boolean;
  expiryThreshold?: number;
  feeMultiplier?: number;
}

/** Plugin registry interface for managing ordered plugin execution. Issue #338. */
export interface IPluginRegistry {
  register(
    plugin: SoroStreamPlugin,
    constraints?: { name?: string; before?: string; after?: string },
  ): void;
  list(): SoroStreamPlugin[];
  unregister(plugin: SoroStreamPlugin): boolean;
}

/** Partial configuration update accepted by `updateConfig`. */
export interface SoroStreamConfigUpdate {
  txTimeoutMs?: number;
  contractId?: string;
  rpcUrl?: string;
}

/** Describes a single field change emitted by `configUpdated` events. */
export interface ConfigUpdatedEvent {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

// ── Issue #398: getStreamHealth ──────────────────────────────────────────────

/** Health status string returned by {@link getStreamHealth}. */
export type StreamHealthStatus = 'healthy' | 'warning' | 'critical' | 'completed' | 'cancelled';

/** Result returned by {@link getStreamHealth}. */
export interface StreamHealthResult {
  /**
   * Numeric health score in the range 0–100.
   * 100 = fully healthy; lower values indicate increasing risk.
   */
  score: number;
  /** Human-readable health status. */
  status: StreamHealthStatus;
  /** Remaining balance in stroops (deposit minus streamed so far). */
  remainingBalance: bigint;
  /** Seconds elapsed since stream started. */
  elapsedSeconds: number;
  /** Seconds remaining until stream ends (0 if ended). */
  remainingSeconds: number;
  /** Seconds since the last withdrawal (0 if never withdrawn). */
  secondsSinceLastWithdrawal: number;
  /** Human-readable diagnostics messages (empty when status is healthy). */
  diagnostics: string[];
}
