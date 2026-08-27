/// <reference lib="es2021.weakref" />
import {
  Contract,
  Networks,
  TransactionBuilder,
  BASE_FEE,
  rpc,
  nativeToScVal,
  scValToNative,
  xdr,
  Transaction,
  FeeBumpTransaction,
  Memo,
} from '@stellar/stellar-sdk';
import { BatchBuilder } from './batchBuilder.js';
import { EventPoller, unrefTimer } from './events.js';
import { InMemoryEventBus, type IEventBus } from './eventBus.js';
import { CrossTabSync, CrossTabEventBus } from './crossTabSync.js';
import {
  OfflineWriteQueue,
  DEFAULT_QUEUE_OPTIONS,
  type OfflineQueueOptions,
} from './offlineQueue.js';
import { Cache } from './cache.js';
import {
  isValidStellarAddress,
  isFederationAddress,
  resolveFederationAddress,
  validateStringLength,
  detectNetworkFromRpcUrl,
  assertSecureRpcUrl,
  filterStreams,
} from './utils.js';
import { ConnectionPool } from './connectionPool.js';
import type { ConnectionPoolOptions, PoolEvent } from './connectionPool.js';
import { getDefaultStorageAdapter, getDefaultFetchAdapter } from './adapters.js';
import type { StorageAdapter, SoroStreamAdapters, FetchAdapter } from './adapters.js';
import { SoroStreamVersionError } from './errors.js';
import type { TransactionHistoryOptions, TransactionHistoryPage } from './horizon.js';
import { getTransactionHistory, getAddressActivity } from './horizon.js';
import { createDefaultRpcTransport } from './transport.js';
import type { RpcTransportAdapter } from './transport.js';
import { createRpcCompatTransport } from './rpc-compat.js';
import type { RpcVersionDetectedPayload } from './rpc-compat.js';
import { waitForLedger } from './readConsistency.js';
import { assertEnvelopeUnmutated } from './xdrValidation.js';
import { PriorityRequestQueue } from './request-queue.js';
import { LocalStorageStreamCache } from './streamStateCache.js';

export type { SoroStreamConfigUpdate, ConfigUpdatedEvent } from './types.js';
import { StreamMonitor } from './stream-monitor.js';
import type { StreamMonitorConfig } from './stream-monitor.js';

// Default read-cache TTL for stream lookups. Matches the EventPoller's 5s
// poll interval so that without an explicit `setNetwork` call, a stream read
// is at most one poll cycle stale on its own network. `setNetwork` flushes
// the cache immediately regardless of this TTL.
const STREAM_CACHE_TTL_MS = 5_000;

/** Minimum allowed stream duration in seconds. */
export const MIN_STREAM_DURATION_SECONDS = 1;

/**
 * SDK-compatible contract version range (issue #209).
 * The SDK will work with contracts >= MIN_COMPATIBLE_VERSION and <= MAX_COMPATIBLE_VERSION.
 */
const MIN_COMPATIBLE_CONTRACT_VERSION = '1.0.0';
const MAX_COMPATIBLE_CONTRACT_VERSION = '1.99.99';

/**
 * Parses a semantic version string into major, minor, patch numbers.
 */
function parseVersion(version: string): { major: number; minor: number; patch: number } {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw new Error(`Invalid version format: ${version}`);
  return {
    major: parseInt(match[1]!, 10),
    minor: parseInt(match[2]!, 10),
    patch: parseInt(match[3]!, 10),
  };
}

/**
 * Compares two semantic versions. Returns -1 if a < b, 0 if a === b, 1 if a > b.
 */
function compareVersions(a: string, b: string): number {
  const vA = parseVersion(a);
  const vB = parseVersion(b);

  if (vA.major !== vB.major) return vA.major < vB.major ? -1 : 1;
  if (vA.minor !== vB.minor) return vA.minor < vB.minor ? -1 : 1;
  if (vA.patch !== vB.patch) return vA.patch < vB.patch ? -1 : 1;
  return 0;
}

import { createContractEncoder } from './contractEncoders.js';
import type { ContractCallEncoder } from './contractEncoders.js';
import { CircuitBreaker } from './circuitBreaker.js';
import type { CircuitBreakerOptions } from './circuitBreaker.js';
import { WriteRateLimiter } from './writeRateLimiter.js';
import type { WriteRateLimitOptions } from './writeRateLimiter.js';
import {
  TransactionFailedError,
  StreamNotFoundError,
  SoroStreamError,
  InsufficientAmountError,
  InvalidAddressError,
  AccountNotFoundError,
  ZeroDurationError,
  BulkCreatePartialError,
  InsufficientAllowanceError,
  DuplicateStreamError,
  FederationResolutionError,
  NonceNotSupportedError,
  SelfStreamError,
  RecipientValidationError,
  StartTimeInPastError,
} from './errors.js';
import type { BulkCreateFailedSlot } from './errors.js';
import type {
  BatchCancelResult,
  BatchWithdrawResult,
  BatchWithdrawPartialResult,
  BulkCreateOptions,
  BulkCreateResult,
  CancelStreamParams,
  CloneStreamOverrides,
  CreateStreamParams,
  FeeEstimate,
  Network,
  PaginatedStreams,
  PaginationParams,
  PriceFeedAdapter,
  RecipientChangedEvent,
  OnRecipientChangedOptions,
  SplitStreamParams,
  SplitStreamResult,
  Stream,
  StreamBalance,
  StreamEvent,
  StreamEventFilter,
  StreamEventType,
  StreamSnapshot,
  StreamSubscription,
  TopUpParams,
  TransferStreamParams,
  PauseStreamParams,
  ResumeStreamParams,
  UpdateFlowRateParams,
  SetOperatorParams,
  OperatorTopUpParams,
  AddDelegateParams,
  RevokeDelegateParams,
  WalletAdapter,
  WithdrawParams,
  WriteOptions,
  StreamFilterCriteria,
  CreateStreamsParams,
  ContractVersion,
  FeeBumpOptions,
  SoroStreamPlugin,
  MiddlewareContext,
  StreamActivityEntry,
  GetActivityLogOptions,
  TokenMetadata,
  MemoHash,
  HealthCheckResult,
  ExportStreamHistoryOptions,
  OperationExplanation,
  BalanceDelta,
  PortfolioStats,
  FeeBumpMonitoringOptions,
  IPluginRegistry,
  WalletAdapterChangedPayload,
  SoroStreamConfigUpdate,
  ConfigUpdatedEvent,
  RecipientTrustScore,
  RecipientTrustScoreProvider,
  OnStreamUpdateOptions,
} from './types.js';
import { withRetry, type RetryOptions } from './retry.js';
import type { EventPollerOptions, StreamRetryPolicy } from './events.js';
import { calculateVestingSchedule, streamToJSON, formatUSDC } from './utils.js';
import { checkPeerDependencies } from './peerDependencies.js';
import { PluginRegistry } from './pluginRegistry.js';
import { getPortfolioStats } from './portfolioAnalytics.js';
import { scheduleFeeBumpMonitor } from './feeBump.js';

const RPC_URLS: Record<Network, string> = {
  mainnet: 'https://soroban.stellar.org',
  testnet: 'https://soroban-testnet.stellar.org',
  futurenet: 'https://rpc-futurenet.stellar.org',
};

const NETWORK_PASSPHRASES: Record<Network, string> = {
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
};

/** Options for constructing a SoroStreamClient. */
export interface SoroStreamClientOptions {
  /**
   * The Stellar network to connect to. Optional when `rpcUrl` is provided
   * and its host can be auto-detected (issue #202): URLs containing
   * `"testnet"` resolve to `"testnet"`; `"mainnet"` or `"horizon.stellar.org"`
   * resolve to `"mainnet"`. When both are provided, `network` always wins —
   * a mismatch against the auto-detected value logs a `console.warn` in
   * non-production builds. Required (and not auto-detectable) for futurenet.
   */
  network?: Network;
  /** The deployed StreamContract address. */
  contractId: string;
  /** Wallet adapter for signing transactions. Optional for read-only operations. */
  walletAdapter?: WalletAdapter;
  /** Optional custom RPC URL (overrides default). */
  rpcUrl?: string;
  /**
   * Optional custom transport for all Soroban RPC calls. Defaults to a
   * thin wrapper around `@stellar/stellar-sdk`'s `rpc.Server` pointed at
   * `rpcUrl` (or the network default). See CUSTOM_TRANSPORT.md.
   */
  transport?: RpcTransportAdapter;
  /** Optional circuit-breaker configuration for RPC calls. */
  circuitBreaker?: CircuitBreakerOptions;
  /**
   * Opt-in client-side rate limit on write operations (`createStream`,
   * `withdraw`, `cancelStream`, etc.), throttling how many can be submitted
   * per second from this client instance to guard against accidental RPC
   * flooding (issue #464). Disabled by default.
   */
  writeRateLimit?: WriteRateLimitOptions;
  /** Maximum time in ms to wait for a transaction to confirm (default: 120000). */
  txTimeoutMs?: number;
  /** Retry policy for read methods (getStream, getClaimable, etc.). */
  readRetry?: RetryOptions;
  /** Retry policy for transaction submission RPC calls (getAccount, prepareTransaction, sendTransaction). */
  submitRetry?: RetryOptions;
  /** Optional price-feed adapter for token-to-fiat display conversion. */
  priceFeed?: PriceFeedAdapter;
  /** Contract version to use for call encoding (default: "v1"). */
  contractVersion?: ContractVersion;
  /** Default fee-bump options applied to all transactions (can be overridden per-call). */
  feeBump?: FeeBumpOptions;
  /**
   * Custom cliff-duration validator (issue #74).
   * Called before every `createStream` / `bulkCreateStreams` call.
   * Throw an error to block transaction submission.
   * Default behaviour enforces `cliffSeconds >= 0`.
   */
  validateCliff?: (cliffSeconds: number) => void | Promise<void>;
  /**
   * Middleware plugins to register on the client (issue #50).
   * Plugins are invoked in registration order for `before` hooks and in
   * reverse order for `after` and `onError` hooks.
   */
  plugins?: SoroStreamPlugin[];
  /**
   * Maximum number of pooled HTTP connections reused across RPC calls (default: 5).
   * Issue #149.
   */
  maxConnections?: number;
  /**
   * Time in ms before an idle pooled connection is closed (default: 30000).
   * Issue #149.
   */
  idleTimeoutMs?: number;
  /**
   * Opt-in connection pool size for high-throughput stream scenarios.
   * When set, subscriptions are distributed across `poolSize` connections.
   * Issue #179.
   */
  poolSize?: number;
  /**
   * Maximum concurrent subscriptions per pooled connection (default: 10).
   * Emits a `pool:full` event when a slot exceeds this limit.
   * Issue #179.
   */
  maxSubscriptionsPerConnection?: number;
  /**
   * Retry policy for automatic event-stream reconnection on unexpected failures.
   * Set `maxAttempts: 0` to disable retries (preserves existing behaviour).
   * Issue #186.
   */
  retryPolicy?: StreamRetryPolicy;
  /**
   * Opt-in event batching configuration for high-frequency streams.
   * When set, events are buffered and delivered in batches via `subscribeBatchEvents`.
   * Issue #187.
   */
  batchingOptions?: import('./types.js').BatchingOptions;
  /**
   * Opt-in check for duplicate stream creation.
   */
  checkDuplicate?: boolean;
  /**
   * Optional hook for recipient trust score / KYC integration (issue #405).
   *
   * When provided, this function is called with the resolved recipient address
   * before the `createStream` transaction is submitted. It must return a
   * {@link RecipientTrustScore}; throwing any error blocks stream creation.
   *
   * @example
   * ```ts
   * onRecipientTrustScore: async (recipient) => {
   *   const res = await myKycProvider.check(recipient);
   *   if (res.blocked) throw new Error(`Recipient ${recipient} is blocked by KYC provider`);
   *   return { score: res.score, label: res.tier };
   * },
   * ```
   */
  onRecipientTrustScore?: RecipientTrustScoreProvider;
  /**
   * When true, write a JSON entry to the `sorostream_audit_log` storage key
   * (via `adapters.storage`, `localStorage` by default) for each SDK write
   * operation: timestamp, operation name, parameters (redacted of keys),
   * result (success/error), and duration.
   * Issue #227.
   */
  auditLog?: boolean;
  /**
   * Optional caller-supplied logger for audit events (issue #389).
   *
   * When provided, every SDK write operation calls `auditLogger.info(entry)`
   * in addition to (or instead of) the built-in storage-based audit log.
   * Any object with an `info` method is accepted (`console`, `pino`, `winston`,
   * custom loggers, etc.).
   *
   * @example
   * ```ts
   * const client = new SoroStreamClient({
   *   // ...
   *   auditLogger: console,  // or pino(), or winston.createLogger(...)
   * });
   * ```
   */
  auditLogger?: import('./types.js').AuditLogger;
  /** Auto fee bump configuration (issue #337). */
  feeBumpMonitoring?: FeeBumpMonitoringOptions;
  /** Skip peer dependency check at construction (issue #213). */
  skipPeerCheck?: boolean;
  /** Custom event bus for SDK lifecycle events (issue #212). */
  eventBus?: IEventBus;
  /**
   * When `true`, opens a `BroadcastChannel` named after the network + contract
   * and synchronises event-bus events across tabs of the same origin: every
   * event emitted by this client is forwarded to other tabs, and events from
   * other tabs are re-emitted locally. The message listener is registered
   * exactly once and removed (channel closed) when the client is destroyed, so
   * re-initialisation cycles never accumulate stale listeners. No-op when
   * `BroadcastChannel` is unavailable (e.g. React Native).
   */
  crossTabSync?: boolean;
  /** Callback invoked when the wallet adapter reports a network change (issue #215). */
  onNetworkChange?: (network: Network) => void;
  /** Skip contract version compatibility check at construction (issue #209). */
  skipVersionCheck?: boolean;
  /** TTL for token metadata cache entries in milliseconds. Defaults to 10 minutes. Issue #203. */
  tokenMetadataTtlMs?: number;
  /**
   * Overrides for the browser globals.
   * Issue #199.
   */
  /**
   * Overrides for the browser globals (`localStorage`, `WebSocket`, `fetch`)
   * the SDK uses by default. Required in environments — like React Native —
   * that don't provide them as globals. See `@sorostream/sdk-react-native`.
   * Issue #199.
   */
  adapters?: SoroStreamAdapters;
  /**
   * Maximum time in milliseconds to wait for the RPC to report the
   * write-confirmed ledger before a subsequent read (read-your-own-writes
   * consistency). Defaults to 10 000 ms (10 seconds).
   *
   * When set to `0`, the RYOW wait is skipped and reads proceed immediately
   * (pre-existing behaviour).
   *
   * Issue #271.
   */
  ryowTimeoutMs?: number;
  /** Enable offline write queue for resilience during connectivity gaps (issue #260). */
  offlineQueue?: boolean;
  /** Maximum entries in the offline write queue (default: from DEFAULT_QUEUE_OPTIONS). */
  maxQueueSize?: number;
  /** RPC protocol version to use. Defaults to "auto" (issue #272). */
  rpcVersion?: 'v1' | 'v2' | 'auto';
  /** Set to `false` to disable telemetry emission (issue #270). Default: true. */
  telemetry?: boolean;
  /**
   * Set to `false` to disable in-flight request deduplication (issue #426).
   *
   * With deduplication enabled (the default), concurrent read calls that
   * address the same data — e.g. five dashboard widgets calling
   * `getStream("42")` in the same tick — share a single RPC request instead of
   * issuing one each. Disable only when you need every call to hit the network
   * independently (for example when measuring raw RPC throughput).
   */
  dedupeRequests?: boolean;
  /**
   * Default maximum number of stream IDs per RPC call in
   * {@link SoroStreamClient.getStreams} (issue #427). Defaults to `50` and can
   * be overridden per call.
   */
  batchReadSize?: number;
}

function nativeToStream(raw: Record<string, unknown>): Stream {
  return {
    id: String(raw['id']),
    sender: String(raw['sender']),
    recipient: String(raw['recipient']),
    token: String(raw['token']),
    deposit: BigInt(raw['deposit'] as number),
    flowRate: BigInt(raw['flow_rate'] as number),
    startTime: Number(raw['start_time']),
    endTime: Number(raw['end_time']),
    lastWithdrawTime: Number(raw['last_withdraw_time']),
    status: raw['status'] as Stream['status'],
    autoRenew: Boolean(raw['auto_renew']),
    ...(raw['paused_at'] != null ? { pausedAt: Number(raw['paused_at']) } : {}),
    ...(raw['lock_until'] != null ? { lockUntil: Number(raw['lock_until']) } : {}),
    toJSON() {
      return streamToJSON(this) as Record<string, unknown>;
    },
  };
}

function scValToStream(val: xdr.ScVal): Stream {
  const raw = scValToNative(val) as Record<string, unknown>;
  return {
    id: String(raw['id']),
    sender: String(raw['sender']),
    recipient: String(raw['recipient']),
    token: String(raw['token']),
    deposit: BigInt(raw['deposit'] as number),
    flowRate: BigInt(raw['flow_rate'] as number),
    startTime: Number(raw['start_time']),
    endTime: Number(raw['end_time']),
    lastWithdrawTime: Number(raw['last_withdraw_time']),
    status: raw['status'] as Stream['status'],
    autoRenew: Boolean(raw['auto_renew']),
    ...(raw['paused_at'] != null ? { pausedAt: Number(raw['paused_at']) } : {}),
    ...(raw['lock_until'] != null ? { lockUntil: Number(raw['lock_until']) } : {}),
    toJSON() {
      return streamToJSON(this) as Record<string, unknown>;
    },
  };
}

export type SimulateOnlyResult = {
  simulated: true;
  result: rpc.Api.SimulateTransactionResponse;
};

/**
 * Main client for interacting with the SoroStream contract.
 *
 * See `ERRORS.md` for the cause, typical trigger, and recommended recovery
 * action for every error class referenced in this client's `@throws` tags.
 *
 * @example
 * ```ts
 * const client = new SoroStreamClient({ network: "testnet", contractId: "...", walletAdapter });
 * const { streamId } = await client.createStream({ recipient, token, amount, durationSeconds, autoRenew });
 * ```
 *
 * @example
 * ```ts
 * // Read-only usage without wallet adapter (issue #223: lazy-loading)
 * const client = new SoroStreamClient({ network: "testnet", contractId: "..." });
 * const stream = await client.getStream("stream-id"); // Works without wallet adapter
 *
 * // Later, when you need to perform a write operation:
 * import { createFreighterAdapter } from "@sorostream/sdk/wallets";
 * client.setWalletAdapter(await createFreighterAdapter());
 * await client.withdraw({ streamId: "stream-id" });
 * ```
 */
interface ClientOwnedTimers {
  eventPoller: EventPoller | null;
  pool: ConnectionPool | null;
  offlineQueue?: OfflineWriteQueue;
  feeBumpCancels: Map<string, (() => void) | number | ReturnType<typeof setTimeout>>;
  extraStops: Set<() => void>;
  unsubWalletNetwork: (() => void) | null;
  unsubWalletConnection: (() => void) | null;
  crossTabSync: CrossTabSync | null;
}

function runClientCleanup(res: ClientOwnedTimers): void {
  res.eventPoller?.destroy();
  res.eventPoller = null;
  res.pool?.destroy();
  res.pool = null;
  res.offlineQueue?.stopHealthCheck();
  for (const cancel of res.feeBumpCancels.values()) {
    if (typeof cancel === 'function') cancel();
    else clearTimeout(cancel);
  }
  res.feeBumpCancels.clear();
  for (const stop of res.extraStops) stop();
  res.extraStops.clear();
  res.unsubWalletNetwork?.();
  res.unsubWalletNetwork = null;
  res.unsubWalletConnection?.();
  res.unsubWalletConnection = null;
  res.crossTabSync?.destroy();
  res.crossTabSync = null;
}

const clientFinalizers: FinalizationRegistry<ClientOwnedTimers> | null =
  typeof FinalizationRegistry !== 'undefined'
    ? new FinalizationRegistry((res) => runClientCleanup(res))
    : null;

export class SoroStreamClient<TEventData = Record<string, unknown>> {
  private server: RpcTransportAdapter;
  /** The user-supplied transport, if any — kept across `setNetwork` calls instead of being rebuilt. */
  private readonly customTransport: RpcTransportAdapter | null;
  private readonly breaker: CircuitBreaker | null;
  private contract: Contract;
  private network: Network;
  private walletAdapter: WalletAdapter | undefined;
  private txTimeoutMs: number;
  private readonly readRetry: RetryOptions;
  private readonly submitRetry: RetryOptions;
  private readonly encoder: ContractCallEncoder;
  private readonly defaultFeeBump: FeeBumpOptions | null = null;
  private readonly priceFeed: PriceFeedAdapter | null = null;
  private eventPoller: EventPoller | null = null;
  // Issue #412: resources stopped by destroy() / GC so polling cannot pin the event loop
  private destroyed = false;
  /** Per-stream read cache, keyed by `${network}:${streamId}`. */
  private readonly streamCache = new Cache<string, Stream>(STREAM_CACHE_TTL_MS);
  /**
   * Per-sender streams cache, keyed by `${network}:${sender}`.
   * Invalidated on every `setNetwork` call to prevent stale cross-network data.
   * Issue #230.
   */
  private readonly senderCache = new Cache<string, Stream[]>(STREAM_CACHE_TTL_MS);
  /**
   * Per-recipient streams cache, keyed by `${network}:${recipient}`.
   * Invalidated on every `setNetwork` call to prevent stale cross-network data.
   * Issue #230.
   */
  private readonly recipientCache = new Cache<string, Stream[]>(STREAM_CACHE_TTL_MS);
  /** Federation address resolution cache (5 min TTL). */
  private readonly federationCache = new Cache<string, string>(300_000);
  private readonly validateCliff: (cliffSeconds: number) => void | Promise<void>;
  private readonly plugins: SoroStreamPlugin[] = [];
  // Issue #337: Auto fee bump monitoring
  private readonly feeBumpMonitoring: FeeBumpMonitoringOptions;
  private readonly feeBumpTimers = new Map<
    string,
    (() => void) | number | ReturnType<typeof setTimeout>
  >();
  private readonly feeBumpedTxs = new Set<string>();
  private readonly ownedTimers: ClientOwnedTimers = {
    eventPoller: null,
    pool: null,
    feeBumpCancels: this.feeBumpTimers,
    extraStops: new Set(),
    unsubWalletNetwork: null,
    unsubWalletConnection: null,
    crossTabSync: null,
  };
  // Issue #338: Plugin registry
  private readonly _pluginRegistry: PluginRegistry;
  private readonly checkDuplicate: boolean;
  // Issue #405: optional recipient trust score / KYC integration hook
  private readonly onRecipientTrustScore: RecipientTrustScoreProvider | undefined;
  // Issue #149: connection pool stats (legacy, used when poolSize is not set)
  private readonly connectionPool: {
    maxConnections: number;
    idleTimeoutMs: number;
    active: number;
    reused: number;
    idle: number;
  };
  // Issue #179: opt-in high-throughput connection pool
  private pool: ConnectionPool | null = null;
  private readonly poolReleases = new Map<string, () => void>();
  // Issue #186: event-stream retry policy and reconnect callbacks
  private readonly retryPolicy: StreamRetryPolicy | undefined;
  private readonly reconnectingCbs = new Set<(attempt: number, delayMs: number) => void>();
  private readonly reconnectedCbs = new Set<() => void>();
  private readonly disconnectedCbs = new Set<(error: unknown) => void>();
  // Issue #187: event batching options
  private readonly batchingOptions: import('./types.js').BatchingOptions | undefined;
  // Issue #228: network version counter — incremented on each setNetwork call
  private networkVersion = 0;
  // Issue #273: in-flight request tracking for hot-reload
  private inFlightCount = 0;
  private inFlightResolvers: Array<() => void> = [];
  // Issue #215: wallet-initiated network switch subscribers
  private readonly networkChangedCbs = new Set<(network: Network) => void>();
  // Issue #261: wallet adapter hot-swap subscribers
  private readonly walletAdapterChangedCbs = new Set<
    (payload: WalletAdapterChangedPayload) => void
  >();
  // Issue #227: audit log toggle
  private readonly auditLogEnabled: boolean;
  // Issue #389: caller-supplied audit logger
  private readonly auditLogger: import('./types.js').AuditLogger | undefined;
  // Issue #391: timestamp of the most recent successful RPC call (ms)
  private lastRpcTimestampMs: number | null = null;
  // Issue #270: telemetry opt-out flag
  private readonly telemetryEnabled: boolean;
  // Issue #199: injectable storage/fetch adapters (replace direct browser global use)
  private readonly storageAdapter: StorageAdapter | null;
  private readonly fetchAdapter: FetchAdapter;
  // Issue #470: opt-in localStorage-backed cache for last-known stream state
  private readonly persistentStreamCache: LocalStorageStreamCache | null;
  // Issue #260: offline write queue (undefined when not enabled)
  private offlineQueue?: OfflineWriteQueue;
  // Issue #265: priority request queue (undefined when not configured)
  private requestQueue?: PriorityRequestQueue;
  // Issue #464: client-side write rate limiter (undefined when not configured)
  private readonly writeRateLimiter?: WriteRateLimiter;
  /**
   * Cached result of the contract's nonce-parameter capability check.
   * `null` means the check has not been performed yet.
   * Issue #231.
   */
  private _nonceSupported: boolean | null = null;
  /**
   * Cached ledger timestamp (Unix seconds) with 5-second TTL.
   * Used as the canonical "now" reference for time-based validation
   * instead of the local system clock (Date.now()).
   */
  private _ledgerTimestampCache: { value: number; expiresAt: number } | null = null;

  // Issue #271: read-your-own-writes consistency
  // Maps streamId → confirmed ledger sequence of the last mutation for that stream.
  private readonly _lastWriteLedger = new Map<string, number>();
  // The configured RYOW wait timeout (0 = disabled).
  private readonly ryowTimeoutMs: number;

  /** TTL cache: streamId → resolved claimable amount */
  private readonly claimableCache = new Cache<string, bigint>(STREAM_CACHE_TTL_MS);
  /**
   * Single in-flight deduplication layer shared by every read path
   * (`getStream`, `getStreams`, `getClaimable`, `getStreamsBySender`,
   * `getStreamsByRecipient`, `getTokenMetadata`). Issue #426.
   */
  private readonly requestDedup: RequestDeduplicator;
  /** Default number of stream IDs per batch RPC call (issue #427). */
  private readonly batchReadSize: number;
  /**
   * Shared, reference-counted observables per `${network}:${streamId}:${opts}`
   * so many subscribers never spawn many poll loops (issue #423).
   */
  private readonly streamObservables = new Map<string, SoroStreamObservable<Stream>>();
  /** Shared, reference-counted claimable observables (issue #423). */
  private readonly claimableObservables = new Map<string, SoroStreamObservable<bigint>>();
  /** Event bus used to emit SDK lifecycle events. Issue #212. */
  private eventBus: IEventBus;
  /** Issue: cross-tab event relay (BroadcastChannel). Null when disabled. */
  private crossTabRelay: CrossTabSync | null = null;
  private crossTabEventBus: CrossTabEventBus | null = null;

  /** Namespace registry: streamId → namespace (off-chain index, issue #274). */
  private readonly namespaceRegistry = new Map<string, string>();

  /** TTL cache: token address → resolved SAC metadata. Issue #203. */
  private readonly tokenMetadataCache: Cache<string, TokenMetadata>;

  // Issue #272: detected RPC version (set after first probe or explicit override)
  private detectedRpcVersion: 'v1' | 'v2' | null = null;

  constructor(options: SoroStreamClientOptions) {
    // Issue #202: auto-detect the network from the RPC URL host when
    // `network` is not explicitly provided. An explicit `network` always
    // wins; a mismatch against the detected value is logged as a warning
    // so misconfigured testnet/mainnet setups are caught early.
    // Issue #463: fail fast on a non-TLS RPC URL rather than silently
    // routing transaction data over an unencrypted connection.
    if (options.rpcUrl) {
      assertSecureRpcUrl(options.rpcUrl);
    }
    const detectedNetwork = options.rpcUrl ? detectNetworkFromRpcUrl(options.rpcUrl) : undefined;
    if (options.network !== undefined) {
      this.network = options.network;
      if (
        detectedNetwork !== undefined &&
        detectedNetwork !== options.network &&
        typeof process !== 'undefined' &&
        process.env?.['NODE_ENV'] !== 'production'
      ) {
        console.warn(
          `[SoroStream SDK] rpcUrl "${options.rpcUrl}" looks like the "${detectedNetwork}" ` +
            `network, but network was explicitly set to "${options.network}". ` +
            `Using "${options.network}" — pass a matching rpcUrl or network to silence this warning.`,
        );
      }
    } else if (detectedNetwork !== undefined) {
      this.network = detectedNetwork;
    } else {
      throw new Error(
        'SoroStreamClient: could not determine the network. Pass `network` explicitly, ' +
          'or an `rpcUrl` containing "testnet", "mainnet", or "horizon.stellar.org".',
      );
    }
    // Issue #213: fail fast with a clear error on an incompatible
    // @stellar/stellar-sdk peer version, instead of cryptic errors at call time.
    if (!options.skipPeerCheck) {
      checkPeerDependencies();
    }
    // Issue: cross-tab sync — open a BroadcastChannel for this network +
    // contract scope and relay event-bus events to/from other tabs. The
    // channel is torn down by destroy() / runClientCleanup() so destroying
    // the client releases the listener and never leaks across re-init cycles.
    const innerEventBus = options.eventBus ?? new InMemoryEventBus();
    this.eventBus = innerEventBus;
    if (options.crossTabSync) {
      const relay = new CrossTabSync({
        channelName: `sorostream:${this.network}:${options.contractId}`,
        enabled: true,
        // Re-emit on the inner bus so a remote event is never broadcast back
        // out (would ping-pong between tabs forever).
        onMessage: (event, data) => innerEventBus.emit(event, data),
      });
      this.crossTabRelay = relay;
      this.ownedTimers.crossTabSync = relay;
      if (relay.active) {
        this.crossTabEventBus = new CrossTabEventBus(innerEventBus, relay);
        this.eventBus = this.crossTabEventBus;
      }
    }

    // Issue #260: Initialize offline write queue if enabled
    if (options.offlineQueue) {
      this.offlineQueue = new OfflineWriteQueue(
        {
          enabled: true,
          maxQueueSize: options.maxQueueSize ?? DEFAULT_QUEUE_OPTIONS.maxQueueSize,
          healthCheckIntervalMs: DEFAULT_QUEUE_OPTIONS.healthCheckIntervalMs,
        },
        this.eventBus,
      );
      this.offlineQueue.startHealthCheck();
      this.ownedTimers.offlineQueue = this.offlineQueue;
    }
    this.walletAdapter = options.walletAdapter;
    this.contract = new Contract(options.contractId);
    this.customTransport = options.transport ?? null;
    this.server =
      this.customTransport ??
      createRpcCompatTransport(options.rpcUrl ?? RPC_URLS[this.network], {
        // Issue #272: "auto" is the default so existing integrations pick up
        // RPC v2 support transparently without any config change.
        rpcVersion: options.rpcVersion ?? 'auto',
        onVersionDetected: (payload: RpcVersionDetectedPayload) => {
          this.detectedRpcVersion = payload.version;
          this.eventBus.emit('rpcVersionDetected', payload);
        },
      });
    void this.server.init?.({
      network: this.network,
      rpcUrl: options.rpcUrl ?? RPC_URLS[this.network],
    });
    this.txTimeoutMs = options.txTimeoutMs ?? 120_000;
    this.breaker = options.circuitBreaker ? new CircuitBreaker(options.circuitBreaker) : null;
    // Issue #464: opt-in client-side throttle on write-operation submission rate.
    this.writeRateLimiter = options.writeRateLimit
      ? new WriteRateLimiter(options.writeRateLimit)
      : undefined;
    this.readRetry = options.readRetry ?? {};
    this.submitRetry = options.submitRetry ?? {};
    this.encoder = createContractEncoder(this.contract, options.contractVersion ?? 'v1');
    this.defaultFeeBump = options.feeBump ?? null;
    this.priceFeed = options.priceFeed ?? null;
    // Default TTL of 5 seconds: short enough to stay reasonably fresh,
    // long enough to absorb bursts of concurrent reads for the same stream.
    this.claimableCache = new Cache<string, bigint>(5_000);
    // Issue #426: one deduplication layer for every read path. Enabled by
    // default — pass `{ dedupeRequests: false }` to opt out.
    this.requestDedup = new RequestDeduplicator({
      enabled: options.dedupeRequests !== false,
      onDeduplicated: (key) => {
        this.eventBus.emit('requestDeduplicated', { key, network: this.network });
      },
    });
    // Issue #427: default batch size for getStreams().
    this.batchReadSize = Math.max(1, options.batchReadSize ?? 50);
    this.validateCliff =
      options.validateCliff ??
      ((s) => {
        if (s < 0) throw new Error('cliffSeconds must be >= 0');
      });
    this.plugins = options.plugins ?? [];
    this.feeBumpMonitoring = options.feeBumpMonitoring ?? { enabled: false };
    this._pluginRegistry = new PluginRegistry();
    this.checkDuplicate = options.checkDuplicate ?? false;
    this.onRecipientTrustScore = options.onRecipientTrustScore;
    this.retryPolicy = options.retryPolicy;
    this.batchingOptions = options.batchingOptions;
    this.auditLogEnabled = options.auditLog ?? false;
    this.auditLogger = options.auditLogger;
    this.telemetryEnabled = options.telemetry !== false;
    this.storageAdapter = options.adapters?.storage ?? getDefaultStorageAdapter();
    this.fetchAdapter = options.adapters?.fetch ?? getDefaultFetchAdapter() ?? fetch;
    // Issue #470: opt-in localStorage-backed cache for last-known stream state
    this.persistentStreamCache =
      options.cacheStreamState && this.storageAdapter
        ? new LocalStorageStreamCache(this.storageAdapter)
        : null;
    // Issue #271: RYOW timeout (0 = disabled for zero-overhead backward compat)
    this.ryowTimeoutMs = options.ryowTimeoutMs ?? 10_000;
    // Issue #203: token metadata cache (10-minute default TTL)
    this.tokenMetadataCache = new Cache<string, TokenMetadata>(
      options.tokenMetadataTtlMs ?? 600_000,
    );
    // Issue #149: connection pool stats tracker
    this.connectionPool = {
      maxConnections: options.maxConnections ?? 5,
      idleTimeoutMs: options.idleTimeoutMs ?? 30_000,
      active: 0,
      reused: 0,
      idle: 0,
    };
    // Issue #179: opt-in connection pool for high-throughput scenarios
    if (options.poolSize && options.poolSize > 1) {
      this.pool = new ConnectionPool({
        poolSize: options.poolSize,
        maxSubscriptionsPerConnection: options.maxSubscriptionsPerConnection,
        idleTimeoutMs: options.idleTimeoutMs,
        rpcUrl: options.rpcUrl ?? RPC_URLS[this.network],
        contractId: options.contractId,
      } satisfies ConnectionPoolOptions);
      this.ownedTimers.pool = this.pool;
    }

    // Issue #215: automatic network switch handling.
    if (options.onNetworkChange) {
      this.networkChangedCbs.add(options.onNetworkChange);
    }
    if (this.walletAdapter?.onNetworkChange) {
      this.ownedTimers.unsubWalletNetwork = this.walletAdapter.onNetworkChange((newNetwork) => {
        if (newNetwork === this.network) return;
        this.setNetwork(newNetwork);
        for (const cb of this.networkChangedCbs) cb(newNetwork);
      });
    }
    if (this.walletAdapter?.onConnectionChange) {
      this.ownedTimers.unsubWalletConnection = this.walletAdapter.onConnectionChange(() => {
        // Connection state is tracked inside the adapter; this subscription
        // keeps WatchWalletChanges alive for lock/unlock detection (#410).
      });
    }

    // Issue #412: auto-stop polling if this instance is garbage-collected
    // without an explicit destroy() call.
    clientFinalizers?.register(this, this.ownedTimers);

    // Issue #209: Version negotiation check
    if (!options.skipVersionCheck) {
      void this.checkContractVersion();
    }
  }

  /**
   * Stops all internal polling and timers owned by this client.
   *
   * Call this when the client is no longer needed. If omitted, a
   * `FinalizationRegistry` callback still tears timers down when the instance
   * is garbage-collected, and Node.js interval handles are `unref()`'d so they
   * do not keep the event loop alive (issue #412).
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    clientFinalizers?.unregister(this);
    this.eventPoller = null;
    this.pool = null;
    // Issue #423: drop shared observables so their poll loops are not kept
    // reachable after teardown. `runClientCleanup` stops the timers themselves.
    this.streamObservables.clear();
    this.claimableObservables.clear();
    runClientCleanup(this.ownedTimers);
    // Sever the relay from the event bus so post-destroy emits are no-ops.
    this.crossTabRelay = null;
    if (this.crossTabEventBus) this.crossTabEventBus.relay = null;
  }

  /**
   * Re-opens the cross-tab channel for the current network scope, replacing
   * the relay created for the previous network. No-op when cross-tab sync is
   * disabled. The old channel is closed first so listeners never accumulate.
   */
  private rebuildCrossTabSync(): void {
    if (!this.crossTabRelay) return;
    const innerBus = this.crossTabEventBus ? this.crossTabEventBus.inner : this.eventBus;
    this.crossTabRelay.destroy();
    this.crossTabRelay = null;
    const relay = new CrossTabSync({
      channelName: `sorostream:${this.network}:${this.contract.contractId()}`,
      enabled: true,
      onMessage: (event, data) => innerBus.emit(event, data),
    });
    this.crossTabRelay = relay;
    this.ownedTimers.crossTabSync = relay;
    if (this.crossTabEventBus) {
      this.crossTabEventBus.relay = relay.active ? relay : null;
    } else if (relay.active) {
      this.crossTabEventBus = new CrossTabEventBus(innerBus, relay);
      this.eventBus = this.crossTabEventBus;
    }
  }

  /**
   * Hot-swaps the wallet adapter at runtime (issue #261).
   *
   * Preserves all read-side cache and event subscriptions. Only the signing
   * provider is replaced. Existing pending transactions remain tied to the
   * previous adapter.
   *
   * @param adapter - The new wallet adapter to use for signing.
   * @param identifier - Optional identifier for the new adapter (emitted in the event).
   *
   * @example
   * ```ts
   * // User switches from Freighter to Ledger
   * client.setWalletAdapter(ledgerAdapter, "ledger");
   * ```
   */
  setWalletAdapter(adapter: WalletAdapter, identifier?: string): void {
    const previousAdapter = this.walletAdapter;
    this.walletAdapter = adapter;

    this.ownedTimers.unsubWalletNetwork?.();
    this.ownedTimers.unsubWalletConnection?.();
    this.ownedTimers.unsubWalletNetwork = null;
    this.ownedTimers.unsubWalletConnection = null;

    // Re-register network change listener if supported
    if (adapter.onNetworkChange) {
      this.ownedTimers.unsubWalletNetwork = adapter.onNetworkChange((newNetwork) => {
        if (newNetwork === this.network) return;
        this.setNetwork(newNetwork);
        for (const cb of this.networkChangedCbs) cb(newNetwork);
      });
    }
    if (adapter.onConnectionChange) {
      this.ownedTimers.unsubWalletConnection = adapter.onConnectionChange(() => {
        /* keep Freighter WatchWalletChanges alive for lock/unlock (#410) */
      });
    }

    // Emit walletAdapterChanged event (issue #261)
    this.eventBus.emit('walletAdapterChanged', {
      adapter: adapter,
      identifier: identifier ?? 'unknown',
      previousAdapter,
    });
  }

  /**
   * Checks the deployed contract version and validates compatibility (issue #209).
   * Emits a console warning for forward-compatible newer versions.
   * Throws SoroStreamVersionError for incompatible older versions.
   *
   * @throws {SoroStreamVersionError} When the contract version is below the minimum required
   */
  private async checkContractVersion(): Promise<void> {
    try {
      const op = this.contract.call('get_version');
      const adapter = this.requireWalletAdapter();
      const tx = new TransactionBuilder(
        await this.server.getAccount(await adapter.getPublicKey()),
        { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASES[this.network] },
      )
        .addOperation(op)
        .setTimeout(30)
        .build();

      const simulated = await this.server.simulateTransaction(tx);

      if (rpc.Api.isSimulationSuccess(simulated) && simulated.result) {
        const contractVersion = scValToNative(simulated.result.retval) as string;

        const cmpMin = compareVersions(contractVersion, MIN_COMPATIBLE_CONTRACT_VERSION);
        const cmpMax = compareVersions(contractVersion, MAX_COMPATIBLE_CONTRACT_VERSION);

        // Contract too old - incompatible
        if (cmpMin < 0) {
          throw new SoroStreamVersionError(contractVersion, MIN_COMPATIBLE_CONTRACT_VERSION);
        }

        // Contract newer than SDK - forward compatible but warn
        if (cmpMax > 0) {
          console.warn(
            `[SoroStream] Contract version ${contractVersion} is newer than SDK maximum ${MAX_COMPATIBLE_CONTRACT_VERSION}. ` +
              `Some features may not be available. Consider updating the SDK.`,
          );
        }

        // Version is compatible - silent success
      }
    } catch (error) {
      // If version check fails due to contract not having get_version, silently continue
      // This maintains backward compatibility with contracts that don't expose version
      if (error instanceof SoroStreamVersionError) {
        throw error; // Re-throw version errors
      }
      // Silently ignore other errors (e.g., contract doesn't have get_version method)
    }
  }

  /**
   * Checks SDK-to-contract version compatibility and returns a detailed result (issue #209).
   *
   * This method queries the deployed contract for its version and compares it
   * against the SDK's minimum and maximum compatible contract versions.
   *
   * @returns A `CompatibilityResult` with SDK version, contract version, and compatibility status.
   *
   * @example
   * ```ts
   * const result = await client.checkContractCompatibility();
   * console.log(`Compatible: ${result.isCompatible}`);
   * console.log(`SDK: ${result.sdkVersion}, Contract: ${result.contractVersion}`);
   * ```
   */
  async checkContractCompatibility(): Promise<import('./types.js').CompatibilityResult> {
    const sdkVersion = '0.1.0'; // From package.json
    const minCompatibleVersion = MIN_COMPATIBLE_CONTRACT_VERSION;
    const maxCompatibleVersion = MAX_COMPATIBLE_CONTRACT_VERSION;

    try {
      const op = this.contract.call('get_version');
      const tx = new TransactionBuilder(
        await this.server.getAccount(await this.requireWalletAdapter().getPublicKey()),
        { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASES[this.network] },
      )
        .addOperation(op)
        .setTimeout(30)
        .build();

      const simulated = await this.server.simulateTransaction(tx);

      if (rpc.Api.isSimulationSuccess(simulated) && simulated.result) {
        const contractVersion = scValToNative(simulated.result.retval) as string;

        const cmpMin = compareVersions(contractVersion, minCompatibleVersion);
        const cmpMax = compareVersions(contractVersion, maxCompatibleVersion);

        const isCompatible = cmpMin >= 0 && cmpMax <= 0;

        let message: string;
        if (cmpMin < 0) {
          message = `Contract version ${contractVersion} is below the minimum compatible version (${minCompatibleVersion}). Upgrade the contract.`;
        } else if (cmpMax > 0) {
          message = `Contract version ${contractVersion} is newer than SDK maximum (${maxCompatibleVersion}). Some features may not be available.`;
        } else {
          message = `Contract version ${contractVersion} is within the compatible range.`;
        }

        return {
          sdkVersion,
          contractVersion,
          minCompatibleVersion,
          maxCompatibleVersion,
          isCompatible,
          message,
        };
      }
    } catch {
      // Contract doesn't expose get_version or simulation failed
    }

    return {
      sdkVersion,
      contractVersion: null,
      minCompatibleVersion,
      maxCompatibleVersion,
      isCompatible: true,
      message: 'Contract version could not be determined. Assuming compatible.',
    };
  }

  // ── Issue #227: Audit log ───────────────────────────────────────────────────

  private static readonly AUDIT_LOG_KEY = 'sorostream_audit_log';
  private static readonly AUDIT_LOG_MAX_ENTRIES = 100;

  private writeAuditEntry(entry: {
    operation: string;
    params?: unknown;
    result?: 'success' | 'error';
    error?: string;
    durationMs: number;
    txHash?: string;
  }): void {
    const isEnabled = this.auditLogEnabled || this.auditLogger !== undefined;
    if (!isEnabled) return;

    const timestamp = new Date().toISOString();
    const network = this.network;
    const redacted = entry.params ? this.redactParams(entry.params) : undefined;

    // Build the structured entry once, shared between storage and logger paths.
    const logEntry: import('./types.js').AuditLogEntry = {
      timestamp,
      network,
      operation: entry.operation,
      params: redacted,
      result: entry.result ?? 'success',
      ...(entry.error !== undefined ? { error: entry.error } : {}),
      durationMs: entry.durationMs,
      ...(entry.txHash !== undefined ? { txHash: entry.txHash } : {}),
    };

    // Issue #389: dispatch to caller-supplied logger if provided.
    if (this.auditLogger) {
      try {
        this.auditLogger.info(logEntry);
      } catch {
        // never throw from audit logger
      }
    }

    // Issue #227: write to storage-based log when auditLog option is set.
    if (this.auditLogEnabled && this.storageAdapter) {
      try {
        const raw = this.storageAdapter.getItem(SoroStreamClient.AUDIT_LOG_KEY);
        const log: unknown[] = raw ? JSON.parse(raw) : [];
        log.push(logEntry);
        // Circular buffer: keep last N entries
        while (log.length > SoroStreamClient.AUDIT_LOG_MAX_ENTRIES) {
          log.shift();
        }
        this.storageAdapter.setItem(SoroStreamClient.AUDIT_LOG_KEY, JSON.stringify(log));
      } catch {
        // storage may be unavailable or full — never throw
      }
    }
  }

  private redactParams(params: unknown): unknown {
    if (params === null || typeof params !== 'object') return params;
    if (Array.isArray(params)) return params.map((p) => this.redactParams(p));
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
      if (key === 'secret' || key === 'secretKey' || key === 'privateKey' || key === 'seed') {
        redacted[key] = '***REDACTED***';
      } else if (typeof value === 'bigint') {
        redacted[key] = value.toString();
      } else {
        redacted[key] = value;
      }
    }
    return redacted;
  }

  /**
   * Returns the current audit log entries. Only meaningful when
   * `{ auditLog: true }` was passed to the constructor.
   *
   * Issue #227.
   * @returns Array of audit log entries, or empty array if unavailable.
   */
  getAuditLog(): Array<Record<string, unknown>> {
    if (!this.storageAdapter) return [];
    try {
      const raw = this.storageAdapter.getItem(SoroStreamClient.AUDIT_LOG_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  /**
   * Clears all audit log entries from storage.
   *
   * Issue #227.
   */
  clearAuditLog(): void {
    if (!this.storageAdapter) return;
    try {
      this.storageAdapter.removeItem(SoroStreamClient.AUDIT_LOG_KEY);
    } catch {
      // ignore
    }
  }

  /**
   * Returns the network this client is currently connected to.
   * @returns The currently active network.
   */
  getNetwork(): Network {
    return this.network;
  }

  /**
   * Returns whether telemetry instrumentation is enabled on this client.
   *
   * When `false`, no spans will be emitted to an OpenTelemetry provider
   * even if one is registered by the consuming application. The flag is
   * also a forward-compatibility contract: any future optional usage
   * metrics will also be suppressed when this returns `false`.
   *
   * @returns `true` by default; `false` when `{ telemetry: false }` was
   *   passed to the constructor.
   *
   * Issue #270.
   */
  get isTelemetryEnabled(): boolean {
    return this.telemetryEnabled;
  }

  /**
   * Returns a monotonically increasing version number that increments
   * each time {@link setNetwork} is called. Useful for `watchClaimable`
   * to detect network switches mid-session and restart polling.
   *
   * Issue #228.
   * @returns The current network version counter.
   */
  getNetworkVersion(): number {
    return this.networkVersion;
  }

  /**
   * Returns a snapshot of the client's current runtime state for support and
   * debugging purposes.
   *
   * Issue #391.
   *
   * @returns A {@link DiagnosticsResult} containing SDK version, active network,
   *   wallet adapter name, polling interval, and last successful RPC timestamp.
   *
   * @example
   * ```ts
   * const info = client.diagnostics();
   * console.log(info.sdkVersion, info.network, info.lastRpcTimestampMs);
   * ```
   */
  diagnostics(): import('./types.js').DiagnosticsResult {
    const sdkVersion = '0.1.0'; // From package.json

    // Determine wallet adapter display name.
    let walletAdapter: string | null = null;
    if (this.walletAdapter) {
      const w = this.walletAdapter as { name?: string; adapterName?: string };
      walletAdapter = w.name ?? w.adapterName ?? 'custom';
    }

    return {
      sdkVersion,
      network: this.network,
      walletAdapter,
      pollingIntervalMs: 5_000, // EventPoller default (see events.ts)
      lastRpcTimestampMs: this.lastRpcTimestampMs,
    };
  }
  /**
   * Detects whether the deployed contract supports the `nonce` parameter on
   * `create_stream` by calling `get_version` and inspecting the response.
   *
   * The result is cached after the first successful call so subsequent calls
   * are instant. Returns `false` on any RPC/simulation error so callers degrade
   * gracefully when the check cannot be performed.
   *
   * Issue #231.
   */
  async supportsNonce(): Promise<boolean> {
    if (this._nonceSupported !== null) return this._nonceSupported;
    try {
      const result = await this.simulateOp(this.contract.call('get_version'));
      if (rpc.Api.isSimulationError(result)) {
        // Contract too old to have get_version — nonces not supported.
        this._nonceSupported = false;
        return false;
      }
      const retval = (result as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
      if (!retval) {
        this._nonceSupported = false;
        return false;
      }
      const version = scValToNative(retval) as Record<string, unknown> | string | number;
      // A contract that returns a version map with a `nonce_support` flag or
      // a major version >= 2 is considered to support nonces.
      if (typeof version === 'object' && version !== null) {
        const hasNonceFlag = 'nonce_support' in version && Boolean(version['nonce_support']);
        const majorVersion = typeof version['major'] === 'number' ? version['major'] : 0;
        this._nonceSupported = hasNonceFlag || majorVersion >= 2;
      } else {
        // Scalar version number: version >= 2 supports nonces.
        const v = Number(version);
        this._nonceSupported = !isNaN(v) && v >= 2;
      }
    } catch {
      this._nonceSupported = false;
    }
    return this._nonceSupported;
  }

  /**
   * Switches the client to a different Stellar network.
   *
   * Flushes the read cache and the event poller, then re-initialises the
   * RPC server for the new network. This guarantees the next `getStream`
   * call (or any other read) fetches fresh data instead of returning values
   * cached under the previous network.
   *
   * **Note:** Calling `setNetwork` with the same value as the current
   * network (and without overriding the RPC URL) is a no-op — the cache and
   * event poller are preserved. Use `clearStreamCache()` if you only want
   * to invalidate the cache without changing networks.
   *
   * @param network - The network to switch to ("mainnet" | "testnet" | "futurenet").
   * @param options - Optional overrides (e.g. a custom RPC URL for the new network).
   */
  setNetwork(network: Network, options?: { rpcUrl?: string }): void {
    if (options?.rpcUrl) {
      assertSecureRpcUrl(options.rpcUrl);
    }
    if (this.network === network && !options?.rpcUrl) {
      // Nothing to do — avoid destroying subscribers unnecessarily.
      return;
    }

    const previousNetwork = this.network;

    // Issue #228: increment version so active watchClaimable instances
    // detect the switch and restart polling against the new endpoint.
    this.networkVersion++;

    // 1. Drop the read caches so stale stream data from the previous network
    //    is never served from cache after the switch (issue #230 & #342).
    this.streamCache.clear();
    this.senderCache.clear();
    this.recipientCache.clear();
    this.federationCache.clear();
    // Issue #221 & #426: drop in-flight request tracking on a network switch so
    // a pending read against the previous network is never handed to a caller
    // that has already been moved to the new one.
    this.requestDedup.clear();
    this.claimableCache.clear();
    // Issue #423: shared observables are network-scoped (their cache key
    // includes the network), so the map entries for the old network are
    // dropped here. Active subscribers keep their own poll loop until they
    // unsubscribe.
    this.streamObservables.clear();
    this.claimableObservables.clear();
    // Issue #271: clear pending RYOW ledger records — they are network-specific.
    this._lastWriteLedger.clear();

    // 2. Destroy the existing event poller — it's still pointing at the
    //    previous network's RPC and would otherwise emit stale events for
    //    up to one polling cycle after the switch.
    if (this.eventPoller) {
      this.eventPoller.destroy();
      this.eventPoller = null;
      this.ownedTimers.eventPoller = null;
    }

    // 3. Update the network and rebuild the RPC server for the new endpoint.
    //    A custom transport is kept (not replaced) and just re-`init`ed with
    //    the new network/rpcUrl — the adapter author decides how to react.
    this.network = network;
    const rpcUrl = options?.rpcUrl ?? RPC_URLS[network];
    if (this.customTransport) {
      void this.customTransport.init?.({ network, rpcUrl });
    } else {
      this.server = createDefaultRpcTransport(rpcUrl);
      void this.server.init?.({ network, rpcUrl });
    }

    // Reset nonce-support cache so it is re-probed on the new network.
    this._nonceSupported = null;

    // Issue #342: emit cacheInvalidated debug event on network switch
    this.eventBus.emit('cacheInvalidated', {
      reason: 'networkSwitch',
      network: this.network,
      previousNetwork,
    });

    // Re-scope the cross-tab channel to the new network (closes the old one).
    this.rebuildCrossTabSync();
  }

  /**
   * Hot-reloads SDK configuration at runtime without requiring a restart.
   * Issue #273: Allows operators to change RPC endpoint, contract ID, or
   * timeout while the application is running.
   *
   * - Only the specified fields are updated; omitted fields remain unchanged.
   * - In-flight requests complete before URL changes are applied.
   * - Emits a `configUpdated` event for each changed field.
   *
   * @example
   * ```ts
   * // Change RPC endpoint without restart
   * client.updateConfig({ rpcUrl: "https://new-rpc.example.com" });
   *
   * // Update contract ID and timeout
   * client.updateConfig({ contractId: "CNEW...", txTimeoutMs: 60000 });
   * ```
   */
  updateConfig(partialConfig: SoroStreamConfigUpdate): void {
    // Issue #463: validate before applying any other field so an insecure
    // rpcUrl never leaves the config partially updated.
    if (partialConfig.rpcUrl !== undefined) {
      assertSecureRpcUrl(partialConfig.rpcUrl);
    }

    const updates: ConfigUpdatedEvent[] = [];

    // 1. Update txTimeoutMs (safe to apply immediately — no in-flight impact)
    if (partialConfig.txTimeoutMs !== undefined && partialConfig.txTimeoutMs !== this.txTimeoutMs) {
      updates.push({
        field: 'txTimeoutMs',
        oldValue: this.txTimeoutMs,
        newValue: partialConfig.txTimeoutMs,
      });
      this.txTimeoutMs = partialConfig.txTimeoutMs;
    }

    // 2. Update contractId (rebuild the contract encoder)
    if (
      partialConfig.contractId !== undefined &&
      partialConfig.contractId !== this.contract?.contractId?.()
    ) {
      const oldContractId = this.contract?.contractId?.() ?? null;
      updates.push({
        field: 'contractId',
        oldValue: oldContractId,
        newValue: partialConfig.contractId,
      });
      this.contract = new Contract(partialConfig.contractId);
      // Clear caches since the contract changed
      this.streamCache.clear();
      this.senderCache.clear();
      this.recipientCache.clear();
      this.claimableCache.clear();
      // Issue #426: in-flight reads target the previous contract — detach them
      // so new callers start a request against the new contract instead.
      this.requestDedup.clear();
      this.streamObservables.clear();
      this.claimableObservables.clear();
    }

    // 3. Update rpcUrl (requires waiting for in-flight requests)
    if (partialConfig.rpcUrl !== undefined) {
      const oldRpcUrl = this.customTransport ? 'custom' : ((this.server as any)?.rpcUrl ?? null);

      // Detect network from the new RPC URL
      const newNetwork = detectNetworkFromRpcUrl(partialConfig.rpcUrl);

      updates.push({
        field: 'rpcUrl',
        oldValue: oldRpcUrl,
        newValue: partialConfig.rpcUrl,
      });

      // Wait for in-flight requests to complete before switching
      this.waitForInFlight().then(() => {
        // Use setNetwork to handle the actual switch (destroys poller, clears caches, rebuilds server)
        if (newNetwork) this.setNetwork(newNetwork, { rpcUrl: partialConfig.rpcUrl });
      });
    }

    // 4. Emit configUpdated events
    for (const update of updates) {
      this.eventBus.emit('configUpdated', update);
    }
  }

  /**
   * Increments the in-flight request counter. Called by internal methods
   * before making an RPC request. Issue #273.
   */
  private trackInFlightStart(): void {
    this.inFlightCount++;
  }

  /**
   * Decrements the in-flight request counter and resolves any pending
   * waitForInFlight promises if the count reaches zero. Issue #273.
   */
  private trackInFlightEnd(): void {
    this.inFlightCount = Math.max(0, this.inFlightCount - 1);
    if (this.inFlightCount === 0) {
      for (const resolve of this.inFlightResolvers) {
        resolve();
      }
      this.inFlightResolvers = [];
    }
  }

  /**
   * Returns a promise that resolves when all in-flight requests have completed.
   * Used by updateConfig to wait before applying URL changes. Issue #273.
   */
  private waitForInFlight(): Promise<void> {
    if (this.inFlightCount === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.inFlightResolvers.push(resolve);
    });
  }

  /**
   * Enqueue a failed write operation to the offline queue (Issue #260).
   * Only queues if the offline queue is enabled and the error is a network error.
   */
  private tryQueueOffline(
    operation: string,
    error: unknown,
    execute: () => Promise<unknown>,
  ): boolean {
    if (!this.offlineQueue) return false;
    const isNetworkError =
      error instanceof Error &&
      (error.message.includes('network') ||
        error.message.includes('fetch') ||
        error.message.includes('ECONNREFUSED') ||
        error.message.includes('ETIMEDOUT') ||
        error.message.includes('aborted'));
    if (!isNetworkError) return false;
    this.offlineQueue.markOffline();
    return this.offlineQueue.enqueue(operation, execute);
  }

  /**
   * Get the current offline queue size (Issue #260).
   */
  getOfflineQueueSize(): number {
    return this.offlineQueue?.size ?? 0;
  }

  /**
   * Manually trigger draining the offline queue (Issue #260).
   */
  async drainOfflineQueue(): Promise<void> {
    if (this.offlineQueue) {
      await this.offlineQueue.markOnline();
    }
  }

  /**
   * Clears the internal stream read cache. Useful when callers know the
   * on-chain state has changed (e.g. after an out-of-band mutation).
   *
   * @param streamId - Optional specific stream to invalidate. If omitted,
   *   the entire cache is cleared.
   */
  clearStreamCache(streamId?: string): void {
    if (streamId === undefined) {
      this.streamCache.clear();
      this.senderCache.clear();
      this.recipientCache.clear();
      this.eventBus.emit('cacheInvalidated', {
        reason: 'manual',
        network: this.network,
      });
      return;
    }
    // Cache keys are network-prefixed to defend against mid-flight network
    // switches. Remove entries for every known network.
    for (const key of ['mainnet', 'testnet', 'futurenet'] as Network[]) {
      this.streamCache.delete(`${key}:${streamId}`);
      this.persistentStreamCache?.delete(key, streamId);
      const pass = NETWORK_PASSPHRASES[key];
      if (pass) this.streamCache.delete(`${pass}:${streamId}`);
    }
    this.eventBus.emit('cacheInvalidated', {
      reason: 'manual',
      network: this.network,
      streamId,
    });
  }

  // ── Issue #271: Read-your-own-writes (RYOW) helpers ───────────────────────

  /**
   * Records the confirmed ledger sequence for a stream after a successful
   * write mutation. Subsequent {@link getStream} calls for the same stream
   * will wait for the RPC to reach this ledger before returning data,
   * ensuring callers never observe stale pre-write state.
   *
   * @param streamId - The stream that was mutated.
   * @param ledger   - The ledger sequence returned by the confirmed transaction.
   */
  private _recordWriteLedger(streamId: string, ledger: number): void {
    if (ledger <= 0 || this.ryowTimeoutMs === 0) return;
    this._lastWriteLedger.set(streamId, ledger);
  }

  /**
   * If a previous write has been recorded for `streamId`, waits until the
   * Soroban RPC reports a ledger at or above the write's confirmed sequence
   * before the subsequent read proceeds.  Clears the record once the wait
   * succeeds so later reads are not penalised.
   *
   * No-op when:
   * - No write has been recorded for the stream.
   * - `ryowTimeoutMs` is 0 (RYOW disabled).
   */
  private async _waitForStreamLedger(streamId: string): Promise<void> {
    if (this.ryowTimeoutMs === 0) return;
    const target = this._lastWriteLedger.get(streamId);
    if (target === undefined) return;

    await waitForLedger(this.server, target, {
      timeoutMs: this.ryowTimeoutMs,
    });

    // Only clear once we successfully reached the target.
    this._lastWriteLedger.delete(streamId);
  }

  private async withBreaker<T>(fn: () => Promise<T>): Promise<T> {
    return this.breaker ? this.breaker.call(fn) : fn();
  }

  /**
   * Ensures a wallet adapter is present for operations that require signing.
   * Throws an error if no adapter was provided during client construction.
   * Issue #223: lazy-loading wallet adapter code.
   */
  private requireWalletAdapter(): WalletAdapter {
    if (!this.walletAdapter) {
      throw new Error(
        'This operation requires a wallet adapter. ' +
          'Pass a walletAdapter to the SoroStreamClient constructor, ' +
          'or use the lazy-loading pattern by calling setWalletAdapter() before this operation.',
      );
    }
    return this.walletAdapter;
  }

  // ── Issue #50: Middleware / plugin system ─────────────────────────────────

  /**
   * Registers a middleware plugin on the client.
   * @param plugin - The plugin to register.
   * @returns This client instance, for chaining.
   */
  use(plugin: SoroStreamPlugin): this {
    this.plugins.push(plugin);
    return this;
  }

  /** Issue #338: Plugin registry for ordered plugin execution. */
  get pluginRegistry(): IPluginRegistry {
    return this._pluginRegistry;
  }

  private async runWithMiddleware<T>(
    method: string,
    args: unknown[],
    fn: () => Promise<T>,
  ): Promise<T> {
    const ctx: MiddlewareContext = { method, args };
    // Issue #338: Registry plugins run first in topological order,
    // then legacy flat-list plugins.
    const orderedPlugins: SoroStreamPlugin[] = [...this._pluginRegistry.list(), ...this.plugins];
    for (const p of orderedPlugins) {
      await p.before?.(ctx);
    }
    let result: T;
    try {
      result = await fn();
    } catch (err) {
      for (const p of [...orderedPlugins].reverse()) {
        await p.onError?.(ctx, err);
      }
      throw err;
    }
    for (const p of [...orderedPlugins].reverse()) {
      await p.after?.(ctx, result);
    }
    return result;
  }

  /**
   * Builds a Stellar {@link Memo} from a write-option memo value (issue #201).
   *
   * - `string` values are encoded as `MEMO_TEXT`. Stellar limits text memos to
   *   28 bytes once UTF-8 encoded; longer values throw.
   * - {@link MemoHash} values are encoded as `MEMO_HASH` and must be exactly
   *   32 bytes; any other length throws.
   */
  private buildMemo(memo: string | MemoHash): Memo {
    if (typeof memo === 'string') {
      const byteLength = new TextEncoder().encode(memo).byteLength;
      if (byteLength > 28) {
        throw new Error(`Text memo exceeds the 28-byte limit (got ${byteLength} bytes)`);
      }
      return Memo.text(memo);
    }
    if (memo.length !== 32) {
      throw new Error(`Hash memo must be exactly 32 bytes (got ${memo.length})`);
    }
    // Issue #406: Stellar SDK's Memo.hash accepts a 64-char lowercase hex string
    // in all environments (including Cloudflare Workers where Buffer is unavailable).
    const hex = Array.from(memo)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return Memo.hash(hex);
  }

  private async buildAndSubmit(
    operation: xdr.Operation,
    signal?: AbortSignal,
    feeBumpOpts?: FeeBumpOptions,
    operationName?: string,
    memo?: string | MemoHash,
  ): Promise<{ txHash: string; ledger: number }> {
    const opStart = Date.now();
    try {
      await this.writeRateLimiter?.acquire(operationName ?? 'write');
      return await this.enqueueOp('write', () =>
        this.buildAndSubmitInner(operation, opStart, signal, feeBumpOpts, operationName, memo),
      );
    } catch (err) {
      // Issue #212: notify subscribers of the custom event bus on RPC/submission failure.
      this.eventBus.emit('rpc.error', { method: operationName ?? 'unknown', error: err });
      throw err;
    }
  }

  private async buildAndSubmitInner(
    operation: xdr.Operation,
    opStart: number,
    signal?: AbortSignal,
    feeBumpOpts?: FeeBumpOptions,
    operationName?: string,
    memo?: string | MemoHash,
  ): Promise<{ txHash: string; ledger: number }> {
    const adapter = this.requireWalletAdapter();
    const publicKey = await adapter.getPublicKey();

    const account = await withRetry(
      () => this.withBreaker(() => this.server.getAccount(publicKey)),
      { ...this.submitRetry, signal },
    );

    const txBuilder = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASES[this.network],
    }).addOperation(operation);

    if (memo !== undefined) {
      txBuilder.addMemo(this.buildMemo(memo));
    }

    const tx = txBuilder.setTimeout(30).build();

    const preparedTx = await withRetry(
      () => this.withBreaker(() => this.server.prepareTransaction(tx)),
      { ...this.submitRetry, signal },
    );

    const signedXdr = await adapter.signTransaction(preparedTx.toXDR(), this.network);

    // Issue #459: verify the signed envelope still describes the transaction
    // that was submitted for signing before broadcasting it.
    assertEnvelopeUnmutated(preparedTx, signedXdr, NETWORK_PASSPHRASES[this.network]);

    const result = await withRetry(
      () =>
        this.withBreaker(() =>
          this.server.sendTransaction(
            TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASES[this.network]),
          ),
        ),
      { ...this.submitRetry, signal },
    );

    if (result.status === 'ERROR') {
      throw new TransactionFailedError(JSON.stringify(result.errorResult));
    }

    // Issue #337: Schedule auto fee bump if enabled
    if (this.feeBumpMonitoring.enabled) {
      const threshold = this.feeBumpMonitoring.expiryThreshold ?? 0.8;
      const multiplier = this.feeBumpMonitoring.feeMultiplier ?? 2;
      const cancel = scheduleFeeBumpMonitor(
        result.hash,
        30,
        threshold,
        async (hash: string) => {
          try {
            const r = await this.server.getTransaction(hash);
            return r.status === 'SUCCESS' || r.status === 'FAILED';
          } catch {
            return false;
          }
        },
        (hash: string) => {
          if (this.feeBumpedTxs.has(hash)) return;
          this.feeBumpedTxs.add(hash);
          this.eventBus.emit('transaction.feeBumped', {
            originalTxHash: hash,
            originalFee: Number(BASE_FEE),
            bumpedFee: Number(BASE_FEE) * multiplier,
          });
        },
      );
      this.feeBumpTimers.set(result.hash, cancel);
    }

    // Poll for completion with configurable timeout and exponential backoff
    const startTime = Date.now();
    let delay = 500;
    const maxDelay = 10_000;

    let response = await this.server.getTransaction(result.hash);
    while (response.status === 'NOT_FOUND') {
      if (signal?.aborted) {
        throw new DOMException('Transaction polling aborted', 'AbortError');
      }

      const elapsed = Date.now() - startTime;
      if (elapsed >= this.txTimeoutMs) {
        throw new Error(`Transaction confirmation timed out after ${this.txTimeoutMs}ms`);
      }

      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, maxDelay);

      response = await this.server.getTransaction(result.hash);
    }

    if (response.status === 'FAILED') {
      throw new TransactionFailedError(result.hash);
    }

    if (operationName) {
      this.writeAuditEntry({
        operation: operationName,
        result: 'success',
        durationMs: Date.now() - opStart,
        txHash: result.hash,
      });
    }

    // Issue #391: track last successful RPC timestamp
    this.lastRpcTimestampMs = Date.now();

    // Issue #271: capture confirmed ledger for RYOW consistency.
    const confirmedLedger: number = (response as unknown as { ledger?: number }).ledger ?? 0;

    return { txHash: result.hash, ledger: confirmedLedger };
  }

  private resolveFeeBump(override?: FeeBumpOptions): FeeBumpOptions | undefined {
    return override ?? this.defaultFeeBump ?? undefined;
  }

  private async buildAndSubmitBatch(
    operations: xdr.Operation[],
    operationName = 'batch',
  ): Promise<string> {
    await this.writeRateLimiter?.acquire(operationName);
    return this.enqueueOp('write', () => this.buildAndSubmitBatchInner(operations));
  }

  private async buildAndSubmitBatchInner(operations: xdr.Operation[]): Promise<string> {
    const adapter = this.requireWalletAdapter();
    const publicKey = await adapter.getPublicKey();

    const account = await withRetry(() => this.server.getAccount(publicKey), this.submitRetry);

    let builder = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASES[this.network],
    });
    for (const op of operations) {
      builder = builder.addOperation(op);
    }
    const tx = builder.setTimeout(30).build();

    const preparedTx = await withRetry(() => this.server.prepareTransaction(tx), this.submitRetry);

    const signedXdr = await adapter.signTransaction(preparedTx.toXDR(), this.network);

    // Issue #459: verify the signed envelope still describes the transaction
    // that was submitted for signing before broadcasting it.
    assertEnvelopeUnmutated(preparedTx, signedXdr, NETWORK_PASSPHRASES[this.network]);

    const result = await withRetry(
      () =>
        this.server.sendTransaction(
          TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASES[this.network]),
        ),
      this.submitRetry,
    );

    if (result.status === 'ERROR') {
      throw new TransactionFailedError(JSON.stringify(result.errorResult));
    }

    let response = await this.server.getTransaction(result.hash);
    while (response.status === 'NOT_FOUND') {
      await new Promise((r) => setTimeout(r, 1000));
      response = await this.server.getTransaction(result.hash);
    }

    if (response.status === 'FAILED') {
      throw new TransactionFailedError(result.hash);
    }

    return result.hash;
  }

  /**
   * Submits a batch of operations in a single transaction.
   * @param operations - The Soroban operations to include in the transaction.
   * @returns The confirming transaction hash.
   * @throws {TransactionFailedError} If the transaction is rejected by the network.
   */
  async executeBatch(operations: xdr.Operation[]): Promise<string> {
    return this.buildAndSubmitBatch(operations);
  }

  /**
   * Simulates one or more contract operations in a single RPC call.
   *
   * All operations are packed into one transaction and sent through a single
   * `simulateTransaction` round-trip (issue #445). The underlying RPC server
   * may restrict transactions to a single `invokeHostFunction` operation;
   * callers that need per-operation return values should parse the response
   * themselves and fall back to individual calls when the server rejects the
   * batch shape.
   */
  private async simulateOps(
    operations: xdr.Operation[],
  ): Promise<rpc.Api.SimulateTransactionResponse> {
    return this.enqueueOp('read', async () => {
      const adapter = this.requireWalletAdapter();
      const publicKey = await adapter.getPublicKey();
      const account = await this.withBreaker(() => this.server.getAccount(publicKey));
      let builder = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASES[this.network],
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();
      const result = await this.withBreaker(() => this.server.simulateTransaction(tx));
      // Issue #391: update last successful RPC timestamp
      this.lastRpcTimestampMs = Date.now();
      return result;
    });
  }

  private simulateOp(operation: xdr.Operation): Promise<rpc.Api.SimulateTransactionResponse> {
    return this.simulateOps([operation]);
  }

  /**
   * Routes a unit of RPC work through the opt-in priority request queue
   * (issue #265) when one is configured; otherwise runs it immediately.
   *
   * @param lane - `"write"` for transaction submission, `"read"` for
   *               simulate/query calls. Write requests are drained ahead of
   *               read requests when the queue is at capacity.
   */
  private enqueueOp<T>(lane: 'write' | 'read', fn: () => Promise<T>): Promise<T> {
    return this.requestQueue ? this.requestQueue.enqueue(lane, fn) : fn();
  }

  /**
   * Returns the current ledger timestamp (Unix seconds) from the RPC endpoint,
   * cached with a 5-second TTL to avoid an extra RPC call on every request.
   *
   * Falls back to `Math.floor(Date.now() / 1000)` when the RPC is unreachable
   * so that time-based validation does not block stream creation during an
   * outage. The fallback is intentionally silent — the local clock drift is
   * small relative to the multi-second stream durations being validated.
   */
  private async getLedgerTimestamp(): Promise<number> {
    const now = Date.now();
    if (this._ledgerTimestampCache && now < this._ledgerTimestampCache.expiresAt) {
      return this._ledgerTimestampCache.value;
    }
    try {
      const ledger = (await this.withBreaker(() => this.server.getLatestLedger())) as {
        id: string;
        sequence: number;
        protocolVersion: string;
        lastLedgerCloseTime?: number;
      };
      const ts = ledger.lastLedgerCloseTime ?? Math.floor(Date.now() / 1000);
      this._ledgerTimestampCache = { value: ts, expiresAt: now + 5_000 };
      return ts;
    } catch {
      return Math.floor(Date.now() / 1000);
    }
  }

  /**
   * Clears the cached ledger timestamp. Useful when callers know the ledger
   * has advanced (e.g. after a transaction submission) and want the next
   * validation to fetch a fresh timestamp.
   */
  clearLedgerTimestampCache(): void {
    this._ledgerTimestampCache = null;
  }

  // ── Token metadata cache (Issue #203) ────────────────────────────────────

  /**
   * Fetches and caches the SAC token metadata (name, symbol, decimals).
   * Concurrent calls for the same token share a single in-flight request.
   */
  async getTokenMetadata(tokenAddress: string): Promise<TokenMetadata> {
    const cached = this.tokenMetadataCache.get(tokenAddress);
    if (cached) return cached;

    // Issue #426: shared deduplication layer — concurrent callers for the same
    // token wait on one set of RPC calls.
    return this.requestDedup.dedupe(
      dedupKey('getTokenMetadata', this.network, tokenAddress),
      async (): Promise<TokenMetadata> => {
        const tokenContract = new Contract(tokenAddress);
        const [nameRes, symbolRes, decimalsRes] = await Promise.all([
          this.simulateOp(tokenContract.call('name')),
          this.simulateOp(tokenContract.call('symbol')),
          this.simulateOp(tokenContract.call('decimals')),
        ]);
        const name = String(
          scValToNative((nameRes as rpc.Api.SimulateTransactionSuccessResponse).result!.retval!),
        );
        const symbol = String(
          scValToNative((symbolRes as rpc.Api.SimulateTransactionSuccessResponse).result!.retval!),
        );
        const decimals = Number(
          scValToNative(
            (decimalsRes as rpc.Api.SimulateTransactionSuccessResponse).result!.retval!,
          ),
        );
        const metadata: TokenMetadata = { name, symbol, decimals };
        this.tokenMetadataCache.set(tokenAddress, metadata);
        return metadata;
      },
    );
  }

  /** Clears token metadata cache entries. Without an argument, clears all. */
  clearTokenCache(address?: string): void {
    if (address !== undefined) {
      this.tokenMetadataCache.delete(address);
    } else {
      this.tokenMetadataCache.clear();
    }
  }

  // ── Federation address resolution (Issue #216) ────────────────────────────

  /**
   * Resolves a federation address (e.g. `alice*stellar.org`) to a Stellar
   * G-address. Returns `null` if the address cannot be resolved (never throws).
   * Results are cached for the session.
   */
  async resolveFederationAddress(address: string): Promise<string | null> {
    try {
      const cached = this.federationCache.get(address);
      if (cached) return cached;
      const resolved = await resolveFederationAddress(address);
      this.federationCache.set(address, resolved);
      return resolved;
    } catch {
      return null;
    }
  }

  // ── Pre-flight validation (Issue 2) ───────────────────────────────────────

  private async validateStreamParams(params: CreateStreamParams): Promise<void> {
    // Issue #226: validate string field lengths before transaction construction
    validateStringLength('recipient', params.recipient);
    validateStringLength('token', params.token);

    if (!isValidStellarAddress(params.recipient)) {
      throw new InvalidAddressError(params.recipient);
    }
    if (!isValidStellarAddress(params.token)) {
      throw new InvalidAddressError(params.token);
    }

    if (params.durationSeconds < MIN_STREAM_DURATION_SECONDS) {
      throw new ZeroDurationError(
        `Stream duration must be >= ${MIN_STREAM_DURATION_SECONDS}s, got ${params.durationSeconds}s`,
      );
    }

    // Use the ledger timestamp as the canonical "now" reference instead of the
    // local system clock so that a clock-skewed machine does not incorrectly
    // accept or reject stream creation.
    const ledgerNow = await this.getLedgerTimestamp();
    const startTimeParam =
      params.startTime ?? (params as CreateStreamParams & { start_time?: number }).start_time;
    if (startTimeParam !== undefined && startTimeParam < ledgerNow) {
      // Issue #411: the contract rejects a start_time in the past. Surface a
      // client-side warning and throw instead of submitting a doomed tx.
      console.warn(
        `[SoroStream SDK] createStream: start_time (${startTimeParam}) is earlier than ` +
          `the current ledger timestamp (${ledgerNow}). The contract will reject this ` +
          `transaction. Pass a start_time >= ${ledgerNow} or omit it to use ledger time.`,
      );
      throw new StartTimeInPastError(startTimeParam, ledgerNow);
    }
    const startTime = startTimeParam ?? ledgerNow;
    const endTime = startTime + params.durationSeconds;
    if (endTime <= startTime) {
      throw new ZeroDurationError(
        `Computed endTime (${endTime}) must be greater than startTime (${startTime})`,
      );
    }

    if (params.lockUntil !== undefined) {
      if (params.lockUntil < startTime || params.lockUntil > endTime) {
        throw new Error(
          `lockUntil (${params.lockUntil}) must be between startTime (${startTime}) and endTime (${endTime})`,
        );
      }
    }

    try {
      await this.withBreaker(() => this.server.getAccount(params.recipient));
    } catch {
      throw new AccountNotFoundError(params.recipient);
    }

    const sender = await this.requireWalletAdapter().getPublicKey();
    try {
      await this.withBreaker(() => this.server.getAccount(sender));
    } catch {
      throw new AccountNotFoundError(sender);
    }
  }

  /**
   * Checks the sender's token allowance for the contract via the SAC allowance view.
   * Throws {@link InsufficientAllowanceError} if the current allowance is less than required.
   * Silently passes when the allowance RPC call fails (non-SAC token, RPC outage, etc.).
   */
  private async checkAllowance(token: string, required: bigint): Promise<void> {
    try {
      const sender = await this.requireWalletAdapter().getPublicKey();
      const contractAddress = this.contract.contractId();

      const tokenContract = new Contract(token);
      const op = tokenContract.call(
        'allowance',
        nativeToScVal(sender, { type: 'address' }),
        nativeToScVal(contractAddress, { type: 'address' }),
      );

      const result = await this.simulateOp(op);
      if (rpc.Api.isSimulationError(result)) return; // non-SAC token — skip

      const retval = (result as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
      if (!retval) return;

      const current = BigInt(scValToNative(retval) as number);
      if (current < required) {
        throw new InsufficientAllowanceError(token, required, current);
      }
    } catch (err) {
      if (err instanceof InsufficientAllowanceError) throw err;
      // RPC / parse failures — don't block stream creation
    }
  }

  // ── Stream mutations ──────────────────────────────────────────────────────

  /**
   * Creates a new payment stream on the SoroStream contract.
   *
   * Validates the recipient address, token address, and sender account before
   * submitting. Enforces that `amount > 0` and `durationSeconds >= 1`.
   *
   * @param params - Stream creation parameters. See [Stream Parameter Ranges](../docs/parameters.md) for detailed limits and ranges.
   * @param params.recipient - Beneficiary Stellar address.
   * @param params.token - SAC token contract address.
   * @param params.amount - Total amount to stream in stroops (must be > 0). See [Stream Parameter Ranges](../docs/parameters.md#createstreamparams) for min/max limits.
   * @param params.durationSeconds - Stream duration in seconds (must be >= 1). See [Stream Parameter Ranges](../docs/parameters.md#createstreamparams) for min/max limits.
   * @param params.autoRenew - Whether the stream auto-renews on completion.
   * @param params.cliffSeconds - Optional cliff duration in seconds (default 0). See [Stream Parameter Ranges](../docs/parameters.md#createstreamparams) for min/max limits.
   * @param signal - Optional `AbortSignal` to cancel in-flight transaction polling.
   * @param options - Optional write options (e.g. `simulateOnly`, `feeBump`).
   * @returns `{ streamId, txHash }` — the new stream ID and confirming transaction hash.
   * @throws {InsufficientAmountError} If `amount` is 0 or negative.
   * @throws {ZeroDurationError} If `durationSeconds` is less than 1.
   * @throws {InvalidAddressError} If `recipient` or `token` is not a valid Stellar address.
   * @throws {AccountNotFoundError} If `recipient` or the sender account does not exist on-chain.
   * @throws {TransactionFailedError} If the Soroban transaction is rejected by the network.
   * @throws {StreamNotFoundError} If the post-creation fetch cannot locate the new stream.
   *
   * @example
   * ```ts
   * const { streamId, txHash } = await client.createStream({
   *   recipient: "GRECIPIENT...",
   *   token:     "GUSDC...",
   *   amount:    toStroops("100"),      // 100 USDC
   *   durationSeconds: 30 * 24 * 3600, // 30 days
   *   autoRenew: false,
   * });
   * console.log("Stream created:", streamId, txHash);
   * ```
   */
  async createStream(
    params: CreateStreamParams,
    signal?: AbortSignal,
    options?: WriteOptions,
  ): Promise<{ streamId: string; txHash: string }> {
    return this.runWithMiddleware('createStream', [params], async () => {
      if (params.amount <= 0n) throw new InsufficientAmountError();
      await this.validateCliff(params.cliffSeconds ?? 0);

      // Issue #231: Warn (or throw when strict:true) if the caller provides a
      // nonce field but the contract does not support it.
      if (params.nonce !== undefined) {
        const nonceOk = await this.supportsNonce();
        if (!nonceOk) {
          if (options?.strict) {
            throw new NonceNotSupportedError();
          } else {
            console.warn(
              '[SoroStream SDK] createStream: nonce was provided but the deployed ' +
                'contract does not support nonce-based idempotency. ' +
                'Retries will NOT be deduplicated and may create duplicate streams. ' +
                'Upgrade the contract or pass strict: true in WriteOptions to turn ' +
                'this into an error.',
            );
          }
        }
      }

      // Resolve federation address if needed, with caching
      if (isFederationAddress(params.recipient)) {
        const cached = this.federationCache.get(params.recipient);
        if (cached) {
          params = { ...params, recipient: cached };
        } else {
          const resolved = await resolveFederationAddress(params.recipient, this.fetchAdapter);
          this.federationCache.set(params.recipient, resolved);
          params = { ...params, recipient: resolved };
        }
      }

      const sender = await this.requireWalletAdapter().getPublicKey();

      // Issue #232: Prevent self-streaming (recipient === sender).
      // Checked before validateStreamParams so SelfStreamError is never
      // shadowed by an AccountNotFoundError from the on-chain account lookup.
      if (params.recipient === sender) {
        throw new SelfStreamError();
      }

      // Issue #405: optional trust score / KYC integration.
      // Called after the self-stream check but before on-chain validation so
      // the provider sees the resolved (non-federation) recipient address.
      // Any error thrown by the provider propagates unchanged to the caller.
      if (this.onRecipientTrustScore) {
        await this.onRecipientTrustScore(params.recipient);
      }

      if (this.checkDuplicate) {
        const existingResult = await this.getStreamsBySender(sender);
        const existingStreams = Array.isArray(existingResult)
          ? existingResult
          : existingResult.streams;
        const isDup = existingStreams.some(
          (s) =>
            s.recipient === params.recipient && s.token === params.token && s.status === 'Active',
        );
        if (isDup) {
          throw new DuplicateStreamError();
        }
      }

      // Full validation (format checks + on-chain account verification) runs
      // after the self-stream and duplicate checks so those errors always take
      // priority and are never shadowed by AccountNotFoundError.
      await this.validateStreamParams(params);

      if (!params.skipAllowanceCheck) {
        await this.checkAllowance(params.token, params.amount);
      }

      const operation = this.encoder.createStream(sender, params);

      // Issue #268: explain mode — return dry-run description without submitting.
      if (options?.explain) {
        const durationDays = (params.durationSeconds / 86400).toFixed(1);
        const amountUsdc = formatUSDC(params.amount);
        return this.explainOperation(
          operation,
          'createStream',
          () =>
            `Create a stream of ${amountUsdc} USDC over ${durationDays} days ` +
            `from ${sender} to ${params.recipient}`,
          [sender, params.recipient, params.token],
          () => [
            { address: sender, token: params.token, delta: -params.amount },
            { address: params.recipient, token: params.token, delta: params.amount },
          ],
        ) as unknown as { streamId: string; txHash: string };
      }

      const feeBump = this.resolveFeeBump(options?.feeBump);
      const { txHash, ledger } = await this.buildAndSubmit(
        operation,
        signal,
        feeBump,
        'createStream',
        options?.memo,
      );

      const result = await this.getStreamsBySender(sender);
      const streams = Array.isArray(result) ? result : result.streams;
      const latest = streams[streams.length - 1];
      if (!latest) throw new StreamNotFoundError('(unknown — post-creation fetch returned empty)');

      // Issue #274: store namespace in the off-chain registry
      if (params.namespace) {
        this.namespaceRegistry.set(latest.id, params.namespace);
      }

      // Issue #212: notify subscribers of the custom event bus.
      this.eventBus.emit('stream.created', {
        streamId: latest.id,
        sender,
        recipient: params.recipient,
        token: params.token,
        txHash,
      });

      return { streamId: latest.id, txHash };
    });
  }

  /**
   * Creates multiple payment streams in a single batched transaction.
   *
   * All streams are validated before submission. When `options.simulateOnly`
   * is `true`, the first operation is simulated without broadcasting.
   *
   * @param paramsArray - Array of stream creation parameter objects.
   * @param paramsArray[].recipient - Beneficiary Stellar address.
   * @param paramsArray[].token - SAC token contract address.
   * @param paramsArray[].amount - Total amount to stream in stroops (must be > 0).
   * @param paramsArray[].durationSeconds - Stream duration in seconds (must be > 0).
   * @param paramsArray[].autoRenew - Whether the stream auto-renews on completion.
   * @param options - Optional write options (e.g. `simulateOnly`).
   * @returns `{ streamIds, txHash }`, or a `SimulateOnlyResult` when `options.simulateOnly` is set.
   * @throws {Error} If `paramsArray` is empty or any entry has `amount <= 0` or `durationSeconds <= 0`.
   * @throws {StartTimeInPastError} If any entry's `startTime` is earlier than the current ledger timestamp.
   * @throws {TransactionFailedError} If the batch transaction is rejected.
   */
  async createStreams(
    paramsArray: CreateStreamsParams[],
    options?: WriteOptions,
  ): Promise<{ streamIds: string[]; txHash: string } | SimulateOnlyResult> {
    if (paramsArray.length === 0) throw new Error('At least one stream is required');

    // Issue #457: validate start_time against the current ledger before
    // submitting, mirroring the single-stream check in validateStreamParams.
    // Without this, a past start_time passes client-side and is only caught
    // by the contract, which rejects it with an opaque error.
    const ledgerNow = await this.getLedgerTimestamp();
    for (const params of paramsArray) {
      if (params.amount <= 0n) throw new Error('Amount must be > 0');
      if (params.durationSeconds <= 0) throw new Error('Duration must be > 0');

      const startTimeParam =
        params.startTime ?? (params as CreateStreamParams & { start_time?: number }).start_time;
      if (startTimeParam !== undefined && startTimeParam < ledgerNow) {
        throw new StartTimeInPastError(startTimeParam, ledgerNow);
      }
    }

    const sender = await this.requireWalletAdapter().getPublicKey();

    const operations = paramsArray.map((params) => this.encoder.createStream(sender, params));

    if (options?.simulateOnly) {
      const result = await this.simulateOp(operations[0]!);
      return { simulated: true, result };
    }

    const txHash = await this.buildAndSubmitBatch(operations, 'createStreams');
    const after = await this.getStreamsBySender(sender);
    const afterStreams = Array.isArray(after) ? after : after.streams;
    const streamIds = afterStreams.slice(-paramsArray.length).map((s) => s.id);

    return { streamIds, txHash };
  }

  /**
   * Withdraws all currently claimable tokens from a stream.
   *
   * The connected wallet must be the stream recipient.
   *
   * @param params - Withdraw parameters.
   * @param params.streamId - ID of the stream to withdraw from.
   * @param signal - Optional `AbortSignal` to cancel in-flight transaction polling.
   * @param options - Optional write options (e.g. `feeBump`).
   * @returns `{ txHash, amount }` — confirming transaction hash and withdrawn amount in stroops.
   * @throws {TransactionFailedError} If the transaction is rejected by the network.
   *
   * @example
   * ```ts
   * const { txHash, amount } = await client.withdraw({ streamId: "42" });
   * console.log(`Withdrew ${formatUSDC(BigInt(amount))} USDC — tx: ${txHash}`);
   * ```
   */
  async withdraw(
    params: WithdrawParams,
    signal?: AbortSignal,
    options?: WriteOptions,
  ): Promise<{ txHash: string; amount: string }> {
    const recipient = await this.requireWalletAdapter().getPublicKey();
    const claimable = await this.getClaimable(params.streamId);

    const operation = this.encoder.withdraw(params.streamId, recipient);

    // Issue #268: explain mode — return dry-run description without submitting.
    if (options?.explain) {
      const amountUsdc = formatUSDC(claimable);
      // Fetch stream to get token address for balance delta.
      const stream = await this.getStream(params.streamId).catch(() => null);
      const tokenAddress = stream?.token ?? '(unknown token)';
      return this.explainOperation(
        operation,
        'withdraw',
        () => `Withdraw ${amountUsdc} USDC from stream ${params.streamId}`,
        [recipient, tokenAddress],
        () =>
          claimable > 0n ? [{ address: recipient, token: tokenAddress, delta: claimable }] : [],
      ) as unknown as { txHash: string; amount: string };
    }

    const feeBump = this.resolveFeeBump(options?.feeBump);
    const { txHash } = await this.buildAndSubmit(
      operation,
      signal,
      feeBump,
      'withdraw',
      options?.memo,
    );

    // Issue #212: notify subscribers of the custom event bus.
    this.eventBus.emit('stream.withdrawn', {
      streamId: params.streamId,
      amount: claimable.toString(),
      txHash,
    });

    return { txHash, amount: claimable.toString() };
  }

  /**
   * Withdraws from multiple streams, collecting partial results instead of
   * throwing on first failure.
   *
   * Each withdrawal is submitted individually. When a stream succeeds its ID
   * is recorded in `successes`; when it fails the ID and error are recorded in
   * `failures`. The method **never throws** — callers should inspect the
   * returned object to detect failures and safely retry only the failed IDs.
   *
   * @param streamIds - Stream IDs to withdraw from.
   * @param batchSize - Maximum operations per transaction (default 8). Chunks
   *   are still attempted together, but a chunk failure is recorded per-stream.
   * @returns `{ successes, failures }` — IDs that were successfully withdrawn
   *   and the IDs+errors that were not.
   *
   * **Migration note (issue #229):** Previously this method returned
   * `BatchWithdrawResult[]` and threw on the first failure. It now returns
   * `BatchWithdrawPartialResult` and never throws. Update call sites that rely
   * on a thrown error to instead check `result.failures`.
   *
   * @example
   * ```ts
   * const { successes, failures } = await client.batchWithdraw(["1", "2", "3"]);
   * if (failures.length) {
   *   console.warn("Some withdrawals failed:", failures);
   * }
   * console.log("Withdrawn:", successes);
   * ```
   */
  async batchWithdraw(streamIds: string[], batchSize = 8): Promise<BatchWithdrawPartialResult> {
    const successes: string[] = [];
    const failures: { id: string; error: Error }[] = [];
    const recipient = await this.requireWalletAdapter().getPublicKey();

    for (let i = 0; i < streamIds.length; i += batchSize) {
      const chunk = streamIds.slice(i, i + batchSize);

      // Fetch claimable amounts first — individual failures here are recorded
      // but do not prevent us from attempting the remaining streams.
      const amounts: Map<string, string> = new Map();
      for (const id of chunk) {
        try {
          const claimable = await this.getClaimable(id);
          amounts.set(id, claimable.toString());
        } catch {
          amounts.set(id, '0');
        }
      }

      try {
        const operations = chunk.map((id) => this.encoder.withdraw(id, recipient));
        await this.executeBatch(operations);
        for (const id of chunk) {
          successes.push(id);
        }
      } catch (err) {
        // Batch failed — record every stream in the chunk as failed.
        for (const id of chunk) {
          failures.push({ id, error: err instanceof Error ? err : new Error(String(err)) });
        }
      }
    }

    return { successes, failures };
  }

  /**
   * Cancels an active stream and refunds the unstreamed deposit to the sender.
   *
   * Only the original sender can cancel a stream. Any claimable tokens
   * already accrued remain available for the recipient to withdraw.
   *
   * @param params - Cancel parameters.
   * @param params.streamId - ID of the stream to cancel.
   * @param signal - Optional `AbortSignal` to cancel in-flight transaction polling.
   * @param options - Optional write options (e.g. `feeBump`).
   * @returns `{ txHash }` — confirming transaction hash.
   * @throws {TransactionFailedError} If the transaction is rejected (e.g. stream already cancelled).
   *
   * @example
   * ```ts
   * const { txHash } = await client.cancelStream({ streamId: "42" });
   * ```
   */
  async cancelStream(
    params: CancelStreamParams,
    signal?: AbortSignal,
    options?: WriteOptions,
  ): Promise<{ txHash: string }> {
    const sender = await this.requireWalletAdapter().getPublicKey();
    const operation = this.encoder.cancelStream(params.streamId, sender);

    // Issue #268: explain mode — return dry-run description without submitting.
    if (options?.explain) {
      const stream = await this.getStream(params.streamId).catch(() => null);
      const tokenAddress = stream?.token ?? '(unknown token)';
      // Estimate refund as the portion of deposit not yet streamed.
      const now = Math.floor(Date.now() / 1000);
      const elapsed = stream ? Math.max(0, now - stream.startTime) : 0;
      const streamed = stream ? stream.flowRate * BigInt(elapsed) : 0n;
      const refund = stream ? (stream.deposit > streamed ? stream.deposit - streamed : 0n) : 0n;
      const refundUsdc = formatUSDC(refund);
      return this.explainOperation(
        operation,
        'cancelStream',
        () =>
          `Cancel stream ${params.streamId} — refund estimated ${refundUsdc} USDC to sender ${sender}`,
        [sender, tokenAddress],
        () => (refund > 0n ? [{ address: sender, token: tokenAddress, delta: refund }] : []),
      ) as unknown as { txHash: string };
    }

    const feeBump = this.resolveFeeBump(options?.feeBump);
    const { txHash } = await this.buildAndSubmit(
      operation,
      signal,
      feeBump,
      'cancelStream',
      options?.memo,
    );

    // Issue #212: notify subscribers of the custom event bus.
    this.eventBus.emit('stream.cancelled', { streamId: params.streamId, txHash });

    return { txHash };
  }

  /**
   * Tops up an existing stream with additional tokens, extending its duration.
   *
   * The additional deposit is added to the remaining balance, and the stream's
   * `endTime` is extended proportionally based on the current flow rate.
   *
   * @param params - Top-up parameters.
   * @param params.streamId - ID of the stream to top up.
   * @param params.amount - Additional amount to deposit in stroops (must be > 0).
   * @param signal - Optional `AbortSignal` to cancel in-flight transaction polling.
   * @param options - Optional write options (e.g. `feeBump`).
   * @returns `{ txHash, newEndTime }` — confirming transaction hash and updated end time.
   * @throws {InsufficientAmountError} If `amount` is 0 or negative.
   * @throws {TransactionFailedError} If the transaction is rejected.
   *
   * @example
   * ```ts
   * const { txHash, newEndTime } = await client.topUp({
   *   streamId: "42",
   *   amount: toStroops("50"),
   * });
   * console.log("Stream extended until:", newEndTime.toISOString());
   * ```
   * After the transaction confirms, the local stream cache is updated optimistically
   * so that the next `getStream` call reflects the new balance without waiting for
   * the next RPC poll.
   * @param params - Top-up parameters.
   * @param signal - Optional abort signal.
   * @param options - Optional write options.
   * @returns The transaction hash and new end time, or simulation result.
   */
  async topUp(
    params: TopUpParams,
    signal?: AbortSignal,
    options?: WriteOptions,
  ): Promise<{ txHash: string; newEndTime: Date }> {
    if (params.amount <= 0n) throw new InsufficientAmountError();
    const sender = await this.requireWalletAdapter().getPublicKey();
    const operation = this.encoder.topUp(params.streamId, sender, params.amount);

    // Issue #268: explain mode — return dry-run description without submitting.
    if (options?.explain) {
      const stream = await this.getStream(params.streamId).catch(() => null);
      const tokenAddress = stream?.token ?? '(unknown token)';
      const amountUsdc = formatUSDC(params.amount);
      // Estimate extended duration from current flow rate
      const additionalSeconds =
        stream && stream.flowRate > 0n ? Number(params.amount / stream.flowRate) : 0;
      const additionalDays = (additionalSeconds / 86400).toFixed(1);
      return this.explainOperation(
        operation,
        'topUp',
        () =>
          `Top up stream ${params.streamId} with ${amountUsdc} USDC, extending duration by ~${additionalDays} days`,
        [sender, tokenAddress],
        () => [{ address: sender, token: tokenAddress, delta: -params.amount }],
      ) as unknown as { txHash: string; newEndTime: Date };
    }

    const feeBump = this.resolveFeeBump(options?.feeBump);
    const { txHash, ledger } = await this.buildAndSubmit(
      operation,
      signal,
      feeBump,
      'topUp',
      options?.memo,
    );

    // Issue #271: record the confirmed ledger for RYOW consistency.
    this._recordWriteLedger(params.streamId, ledger);

    // Fetch fresh on-chain state and cache it so immediate getStream() calls
    // reflect the topped-up balance without stale data.
    this.clearStreamCache(params.streamId);
    const stream = await this.getStream(params.streamId);
    return { txHash, newEndTime: new Date(stream.endTime * 1000) };
  }

  /**
   * Cancels multiple streams in batched transactions.
   *
   * @param streamIds - Stream IDs to cancel.
   * @param batchSize - Maximum operations per transaction (default 8).
   * @returns Array of `BatchCancelResult`, one entry per submitted transaction.
   * @throws {TransactionFailedError} If any batch transaction is rejected.
   */
  async batchCancel(streamIds: string[], batchSize = 8): Promise<BatchCancelResult[]> {
    const results: BatchCancelResult[] = [];
    const sender = await this.requireWalletAdapter().getPublicKey();

    for (let i = 0; i < streamIds.length; i += batchSize) {
      const chunk = streamIds.slice(i, i + batchSize);
      const operations = chunk.map((id) => this.encoder.cancelStream(id, sender));
      const txHash = await this.executeBatch(operations);
      results.push({ txHash, streamIds: chunk });
    }

    return results;
  }

  /**
   * Updates the per-second flow rate on an active stream without cancelling it.
   *
   * @param params - Flow rate update parameters.
   * @param params.streamId - ID of the stream to update.
   * @param params.newFlowRate - New flow rate in stroops per second (must be > 0).
   * @param signal - Optional `AbortSignal` to cancel in-flight transaction polling.
   * @param options - Optional write options.
   * @returns `{ txHash }` — confirming transaction hash.
   * @throws {InsufficientAmountError} If `newFlowRate` is 0 or negative.
   * @throws {TransactionFailedError} If the transaction is rejected.
   */
  async updateFlowRate(
    params: UpdateFlowRateParams,
    signal?: AbortSignal,
    options?: WriteOptions,
  ): Promise<{ txHash: string }> {
    if (params.newFlowRate <= 0n) throw new InsufficientAmountError();
    const sender = await this.requireWalletAdapter().getPublicKey();
    const operation = this.encoder.updateFlowRate(params.streamId, sender, params.newFlowRate);
    const feeBump = this.resolveFeeBump(options?.feeBump);
    const { txHash } = await this.buildAndSubmit(
      operation,
      signal,
      feeBump,
      'updateFlowRate',
      options?.memo,
    );
    return { txHash };
  }

  /**
   * Authorises or revokes an operator address for a stream.
   *
   * An authorised operator can call `operatorCancelStream` and `operatorTopUp`
   * on behalf of the stream sender.
   *
   * @param params - Operator configuration parameters.
   * @param params.streamId - ID of the stream.
   * @param params.operator - Stellar address to grant or revoke operator rights.
   * @param params.approved - `true` to grant, `false` to revoke.
   * @param signal - Optional `AbortSignal`.
   * @param options - Optional write options.
   * @returns `{ txHash }` — confirming transaction hash.
   * @throws {TransactionFailedError} If the transaction is rejected.
   */
  async setOperator(
    params: SetOperatorParams,
    signal?: AbortSignal,
    options?: WriteOptions,
  ): Promise<{ txHash: string }> {
    const sender = await this.requireWalletAdapter().getPublicKey();
    const operation = this.encoder.setOperator(
      params.streamId,
      sender,
      params.operator,
      params.approved,
    );
    const feeBump = this.resolveFeeBump(options?.feeBump);
    const { txHash } = await this.buildAndSubmit(
      operation,
      signal,
      feeBump,
      'setOperator',
      options?.memo,
    );
    return { txHash };
  }

  /**
   * Cancels a stream as an authorised operator, on behalf of the sender.
   *
   * @param params - Operator cancel parameters.
   * @param params.streamId - ID of the stream to cancel.
   * @param signal - Optional `AbortSignal` to cancel in-flight transaction polling.
   * @param options - Optional write options.
   * @returns `{ txHash }` — confirming transaction hash.
   * @throws {TransactionFailedError} If the transaction is rejected (e.g. caller is not an authorised operator).
   */
  async operatorCancelStream(
    params: { streamId: string },
    signal?: AbortSignal,
    options?: WriteOptions,
  ): Promise<{ txHash: string }> {
    const operator = await this.requireWalletAdapter().getPublicKey();
    const operation = this.encoder.operatorCancelStream(params.streamId, operator);
    const feeBump = this.resolveFeeBump(options?.feeBump);
    const { txHash } = await this.buildAndSubmit(
      operation,
      signal,
      feeBump,
      'operatorCancelStream',
      options?.memo,
    );
    return { txHash };
  }

  /**
   * Tops up a stream as an authorised operator, on behalf of the sender.
   *
   * @param params - Operator top-up parameters.
   * @param params.streamId - ID of the stream to top up.
   * @param params.amount - Additional amount to deposit in stroops (must be > 0).
   * @param signal - Optional `AbortSignal` to cancel in-flight transaction polling.
   * @param options - Optional write options.
   * @returns `{ txHash }` — confirming transaction hash.
   * @throws {InsufficientAmountError} If `amount` is 0 or negative.
   * @throws {TransactionFailedError} If the transaction is rejected (e.g. caller is not an authorised operator).
   */
  async operatorTopUp(
    params: OperatorTopUpParams,
    signal?: AbortSignal,
    options?: WriteOptions,
  ): Promise<{ txHash: string }> {
    if (params.amount <= 0n) throw new InsufficientAmountError();
    const operator = await this.requireWalletAdapter().getPublicKey();
    const operation = this.encoder.operatorTopUp(params.streamId, operator, params.amount);
    const feeBump = this.resolveFeeBump(options?.feeBump);
    const { txHash } = await this.buildAndSubmit(
      operation,
      signal,
      feeBump,
      'operatorTopUp',
      options?.memo,
    );
    return { txHash };
  }

  /**
   * Splits an active stream into two streams with a user-defined ratio,
   * cancelling the original stream.
   *
   * The remaining balance of the original stream is divided according to the
   * ratio (ratioNumerator / ratioDenominator) and two new streams are created
   * with proportional flow rates. The original stream is cancelled.
   *
   * @param params - Split stream parameters.
   * @param params.streamId - ID of the stream to split.
   * @param params.recipientA - Beneficiary address for the first resulting stream.
   * @param params.recipientB - Beneficiary address for the second resulting stream.
   * @param params.ratioNumerator - Numerator of the split ratio (must be > 0 and < `ratioDenominator`).
   * @param params.ratioDenominator - Denominator of the split ratio (must be > 0).
   * @param signal - Optional `AbortSignal` to cancel in-flight transaction polling.
   * @param options - Optional write options.
   * @returns `{ txHash, streamIdA, streamIdB }` — confirming transaction hash and the two new stream IDs.
   * @throws {Error} If the ratio is not positive or `ratioNumerator >= ratioDenominator`.
   * @throws {InvalidAddressError} If `recipientA` or `recipientB` is not a valid Stellar address.
   * @throws {TransactionFailedError} If the transaction is rejected.
   */
  async splitStream(
    params: SplitStreamParams,
    signal?: AbortSignal,
    options?: WriteOptions,
  ): Promise<SplitStreamResult> {
    if (params.ratioNumerator <= 0 || params.ratioDenominator <= 0) {
      throw new Error('Ratio must be positive');
    }
    if (params.ratioNumerator >= params.ratioDenominator) {
      throw new Error('Ratio numerator must be less than denominator');
    }

    const sender = await this.requireWalletAdapter().getPublicKey();

    if (!isValidStellarAddress(params.recipientA)) {
      throw new InvalidAddressError(params.recipientA);
    }
    if (!isValidStellarAddress(params.recipientB)) {
      throw new InvalidAddressError(params.recipientB);
    }

    const operation = this.encoder.splitStream(sender, params);
    const feeBump = this.resolveFeeBump(options?.feeBump);
    const { txHash } = await this.buildAndSubmit(
      operation,
      signal,
      feeBump,
      'splitStream',
      options?.memo,
    );

    const result = await this.getStreamsBySender(sender);
    const streams = Array.isArray(result) ? result : result.streams;
    const latest = streams.slice(-2);
    const streamIdA = latest[0]?.id ?? '';
    const streamIdB = latest[1]?.id ?? '';

    return { txHash, streamIdA, streamIdB };
  }

  /**
   * Transfers ownership of a stream to a new recipient address mid-flight.
   * Only the sender can transfer ownership.
   *
   * @param params - Transfer parameters.
   * @param params.streamId - ID of the stream to transfer.
   * @param params.newRecipient - Stellar address of the new beneficiary.
   * @param signal - Optional `AbortSignal` to cancel in-flight transaction polling.
   * @param options - Optional write options.
   * @returns `{ txHash }` — confirming transaction hash.
   * @throws {InvalidAddressError} If `newRecipient` is not a valid Stellar address.
   * @throws {TransactionFailedError} If the transaction is rejected.
   */
  async transferStream(
    params: TransferStreamParams,
    signal?: AbortSignal,
    options?: WriteOptions,
  ): Promise<{ txHash: string }> {
    if (!isValidStellarAddress(params.newRecipient)) {
      throw new InvalidAddressError(params.newRecipient);
    }
    const sender = await this.requireWalletAdapter().getPublicKey();
    const operation = this.encoder.transferStream(params.streamId, sender, params.newRecipient);
    const feeBump = this.resolveFeeBump(options?.feeBump);
    const { txHash } = await this.buildAndSubmit(
      operation,
      signal,
      feeBump,
      'transferStream',
      options?.memo,
    );
    return { txHash };
  }

  /**
   * Pauses an active stream. While paused, no new claimable tokens accumulate.
   *
   * @param params - Pause parameters.
   * @param params.streamId - ID of the stream to pause.
   * @param signal - Optional `AbortSignal` to cancel in-flight transaction polling.
   * @param options - Optional write options.
   * @returns `{ txHash }` — confirming transaction hash.
   * @throws {TransactionFailedError} If the transaction is rejected (e.g. stream already paused).
   */
  async pause(
    params: PauseStreamParams,
    signal?: AbortSignal,
    options?: WriteOptions,
  ): Promise<{ txHash: string }> {
    const sender = await this.requireWalletAdapter().getPublicKey();
    const operation = this.encoder.pauseStream(params.streamId, sender);
    const feeBump = this.resolveFeeBump(options?.feeBump);
    const { txHash } = await this.buildAndSubmit(
      operation,
      signal,
      feeBump,
      'pause',
      options?.memo,
    );
    return { txHash };
  }

  /**
   * Resumes a previously paused stream. Claimable tokens will again accumulate.
   *
   * @param params - Resume parameters.
   * @param params.streamId - ID of the stream to resume.
   * @param signal - Optional `AbortSignal` to cancel in-flight transaction polling.
   * @param options - Optional write options.
   * @returns `{ txHash }` — confirming transaction hash.
   * @throws {TransactionFailedError} If the transaction is rejected (e.g. stream is not paused).
   */
  async resume(
    params: ResumeStreamParams,
    signal?: AbortSignal,
    options?: WriteOptions,
  ): Promise<{ txHash: string }> {
    const sender = await this.requireWalletAdapter().getPublicKey();
    const operation = this.encoder.resumeStream(params.streamId, sender);
    const feeBump = this.resolveFeeBump(options?.feeBump);
    const { txHash } = await this.buildAndSubmit(
      operation,
      signal,
      feeBump,
      'resume',
      options?.memo,
    );
    return { txHash };
  }

  // ── Fee estimation ────────────────────────────────────────────────────────

  private async estimateOperationFee(operation: xdr.Operation): Promise<FeeEstimate> {
    const adapter = this.requireWalletAdapter();
    const publicKey = await adapter.getPublicKey();
    const account = await this.withBreaker(() => this.server.getAccount(publicKey));

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASES[this.network],
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const preparedTx = await this.withBreaker(() => this.server.prepareTransaction(tx));

    const minResourceFee =
      (preparedTx as unknown as { minResourceFee?: number }).minResourceFee ?? 0;

    return {
      totalFee: Number(preparedTx.fee) + minResourceFee,
      minResourceFee,
    };
  }

  // ── Issue #268: Explain mode ──────────────────────────────────────────────

  /**
   * Runs an operation in explain/dry-run mode: simulates the transaction and
   * returns a human-readable {@link OperationExplanation} without submitting.
   *
   * @param operation     - The Soroban operation XDR to simulate.
   * @param operationName - Human-readable operation name (e.g. `"createStream"`).
   * @param buildSummary  - Callback that returns the plain-English summary string.
   * @param affectedAddresses - Stellar addresses directly involved in the operation.
   * @param buildDeltas   - Callback that derives expected balance changes from the sim result.
   */
  private async explainOperation(
    operation: xdr.Operation,
    operationName: string,
    buildSummary: () => string,
    affectedAddresses: string[],
    buildDeltas: () => BalanceDelta[],
  ): Promise<OperationExplanation> {
    const publicKey = await this.requireWalletAdapter().getPublicKey();
    const account = await this.withBreaker(() => this.server.getAccount(publicKey));

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASES[this.network],
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simResult = await this.withBreaker(() => this.server.simulateTransaction(tx));

    if (rpc.Api.isSimulationError(simResult)) {
      throw new TransactionFailedError(
        `Explain simulation failed: ${JSON.stringify((simResult as rpc.Api.SimulateTransactionErrorResponse).error)}`,
      );
    }

    const successResult = simResult as rpc.Api.SimulateTransactionSuccessResponse;
    const minResourceFee = Number(successResult.minResourceFee ?? 0);
    const estimatedFee = Number(BASE_FEE) + minResourceFee;

    return {
      operation: operationName,
      summary: buildSummary(),
      affectedAddresses: [...new Set(affectedAddresses.filter(Boolean))],
      balanceDeltas: buildDeltas(),
      estimatedFee,
      minResourceFee,
      simulationResult: simResult,
    };
  }

  /**
   * Estimates the network fee for a {@link createStream} call without submitting it.
   * @param params - Same shape as {@link createStream}'s `params`.
   * @returns `{ totalFee, minResourceFee }` in stroops.
   * @throws {Error} If `amount` is 0 or negative, or `durationSeconds` is 0 or negative.
   */
  async estimateCreateStreamFee(params: CreateStreamParams): Promise<FeeEstimate> {
    if (params.amount <= 0n) throw new Error('Amount must be > 0');
    if (params.durationSeconds <= 0) throw new Error('Duration must be > 0');

    const sender = await this.requireWalletAdapter().getPublicKey();
    const operation = this.encoder.createStream(sender, params);
    return this.estimateOperationFee(operation);
  }

  /**
   * Estimates the network fee for a {@link withdraw} call without submitting it.
   * @param params - Withdraw parameters.
   * @param params.streamId - ID of the stream to withdraw from.
   * @returns `{ totalFee, minResourceFee }` in stroops.
   */
  async estimateWithdrawFee(params: WithdrawParams): Promise<FeeEstimate> {
    const recipient = await this.requireWalletAdapter().getPublicKey();
    const operation = this.encoder.withdraw(params.streamId, recipient);
    return this.estimateOperationFee(operation);
  }

  /**
   * Estimates the network fee for a {@link cancelStream} call without submitting it.
   * @param params - Cancel parameters.
   * @param params.streamId - ID of the stream to cancel.
   * @returns `{ totalFee, minResourceFee }` in stroops.
   */
  async estimateCancelStreamFee(params: CancelStreamParams): Promise<FeeEstimate> {
    const sender = await this.requireWalletAdapter().getPublicKey();
    const operation = this.encoder.cancelStream(params.streamId, sender);
    return this.estimateOperationFee(operation);
  }

  /**
   * Estimates the network fee for a {@link topUp} call without submitting it.
   * @param params - Top-up parameters.
   * @param params.streamId - ID of the stream to top up.
   * @param params.amount - Additional amount to deposit in stroops (must be > 0).
   * @returns `{ totalFee, minResourceFee }` in stroops.
   * @throws {Error} If `amount` is 0 or negative.
   */
  async estimateTopUpFee(params: TopUpParams): Promise<FeeEstimate> {
    if (params.amount <= 0n) throw new Error('Amount must be > 0');
    const sender = await this.requireWalletAdapter().getPublicKey();
    const operation = this.encoder.topUp(params.streamId, sender, params.amount);
    return this.estimateOperationFee(operation);
  }

  /**
   * Estimates the network fee for an {@link updateFlowRate} call without submitting it.
   * @param params - Flow rate update parameters.
   * @returns `{ totalFee, minResourceFee }` in stroops.
   * @throws {Error} If `newFlowRate` is 0 or negative.
   */
  async estimateUpdateFlowRateFee(params: UpdateFlowRateParams): Promise<FeeEstimate> {
    if (params.newFlowRate <= 0n) throw new Error('newFlowRate must be > 0');
    const sender = await this.requireWalletAdapter().getPublicKey();
    const operation = this.encoder.updateFlowRate(params.streamId, sender, params.newFlowRate);
    return this.estimateOperationFee(operation);
  }

  /**
   * Estimates the network fee for a {@link setOperator} call without submitting it.
   * @param params - Operator configuration parameters.
   * @returns `{ totalFee, minResourceFee }` in stroops.
   */
  async estimateSetOperatorFee(params: SetOperatorParams): Promise<FeeEstimate> {
    const sender = await this.requireWalletAdapter().getPublicKey();
    const operation = this.encoder.setOperator(
      params.streamId,
      sender,
      params.operator,
      params.approved,
    );
    return this.estimateOperationFee(operation);
  }

  /**
   * Estimates the network fee for an {@link operatorCancelStream} call without submitting it.
   * @param params - Operator cancel parameters.
   * @returns `{ totalFee, minResourceFee }` in stroops.
   */
  async estimateOperatorCancelStreamFee(params: { streamId: string }): Promise<FeeEstimate> {
    const operator = await this.requireWalletAdapter().getPublicKey();
    const operation = this.encoder.operatorCancelStream(params.streamId, operator);
    return this.estimateOperationFee(operation);
  }

  /**
   * Estimates the network fee for an {@link operatorTopUp} call without submitting it.
   * @param params - Operator top-up parameters.
   * @returns `{ totalFee, minResourceFee }` in stroops.
   * @throws {Error} If `amount` is 0 or negative.
   */
  async estimateOperatorTopUpFee(params: OperatorTopUpParams): Promise<FeeEstimate> {
    if (params.amount <= 0n) throw new Error('Amount must be > 0');
    const operator = await this.requireWalletAdapter().getPublicKey();
    const operation = this.encoder.operatorTopUp(params.streamId, operator, params.amount);
    return this.estimateOperationFee(operation);
  }

  /**
   * Estimates the network fee for a {@link splitStream} call without submitting it.
   * @param params - Split stream parameters.
   * @returns `{ totalFee, minResourceFee }` in stroops.
   */
  async estimateSplitStreamFee(params: SplitStreamParams): Promise<FeeEstimate> {
    const sender = await this.requireWalletAdapter().getPublicKey();
    const operation = this.encoder.splitStream(sender, params);
    return this.estimateOperationFee(operation);
  }

  /**
   * Estimates the network fee for a {@link transferStream} call without submitting it.
   * @param params - Transfer parameters.
   * @returns `{ totalFee, minResourceFee }` in stroops.
   */
  async estimateTransferStreamFee(params: TransferStreamParams): Promise<FeeEstimate> {
    const sender = await this.requireWalletAdapter().getPublicKey();
    const operation = this.encoder.transferStream(params.streamId, sender, params.newRecipient);
    return this.estimateOperationFee(operation);
  }

  /**
   * Estimates the network fee for a {@link pause} call without submitting it.
   * @param params - Pause parameters.
   * @returns `{ totalFee, minResourceFee }` in stroops.
   */
  async estimatePauseFee(params: PauseStreamParams): Promise<FeeEstimate> {
    const sender = await this.requireWalletAdapter().getPublicKey();
    const operation = this.encoder.pauseStream(params.streamId, sender);
    return this.estimateOperationFee(operation);
  }

  /**
   * Estimates the network fee for a {@link resume} call without submitting it.
   * @param params - Resume parameters.
   * @returns `{ totalFee, minResourceFee }` in stroops.
   */
  async estimateResumeFee(params: ResumeStreamParams): Promise<FeeEstimate> {
    const sender = await this.requireWalletAdapter().getPublicKey();
    const operation = this.encoder.resumeStream(params.streamId, sender);
    return this.estimateOperationFee(operation);
  }

  // ── Event subscription ───────────────────────────────────────────────────────

  private getEventPoller(): EventPoller {
    if (!this.eventPoller) {
      const opts: EventPollerOptions = {
        retryPolicy: this.retryPolicy,
        onReconnecting: (attempt, delayMs) => {
          for (const cb of this.reconnectingCbs) cb(attempt, delayMs);
        },
        onReconnected: () => {
          for (const cb of this.reconnectedCbs) cb();
        },
        onDisconnected: (err) => {
          for (const cb of this.disconnectedCbs) cb(err);
        },
        batchingOptions: this.batchingOptions,
      };
      this.eventPoller = new EventPoller(this.server, this.contract.contractId(), opts);
      this.ownedTimers.eventPoller = this.eventPoller;
    }
    return this.eventPoller;
  }

  /**
   * Subscribes to real-time stream lifecycle events matching the given filter.
   * The callback is invoked each time a matching event is detected.
   *
   * @param filter - Criteria to match events against (`streamId`, `sender`, `recipient`); omitted fields match anything.
   * @param callback - Invoked with each matching event.
   * @returns A `StreamSubscription` — call `.unsubscribe()` to stop listening.
   *
   * @example
   * ```ts
   * const sub = client.subscribeEvents({ streamId: "42" }, (event) => {
   *   console.log(event.type, event.streamId);
   * });
   * // later: sub.unsubscribe();
   * ```
   */
  subscribeEvents(
    filter: StreamEventFilter,
    callback: (event: StreamEvent<TEventData>) => void,
  ): StreamSubscription {
    const key = `${filter.streamId ?? '*'}:${filter.sender ?? '*'}:${filter.recipient ?? '*'}:${Date.now()}`;
    const matchFn = (event: StreamEvent): boolean => {
      if (filter.streamId && event.streamId !== filter.streamId) return false;
      if (filter.sender && event.data.sender !== filter.sender) return false;
      if (filter.recipient && event.data.recipient !== filter.recipient) return false;
      return true;
    };

    if (this.pool) {
      const { poller, release } = this.pool.acquirePoller();
      this.poolReleases.set(key, release);
      const sub = poller.subscribe(key, {
        filter: matchFn,
        callback: (event) => callback(event as StreamEvent<TEventData>),
      });
      return {
        unsubscribe: () => {
          sub.unsubscribe();
          const rel = this.poolReleases.get(key);
          rel?.();
          this.poolReleases.delete(key);
        },
      };
    }

    const poller = this.getEventPoller();
    return poller.subscribe(key, {
      filter: matchFn,
      callback: (event) => callback(event as StreamEvent<TEventData>),
    });
  }

  /**
   * Subscribe to a specific stream lifecycle event type.
   *
   * @param eventType - The lifecycle event type to listen for.
   * @param callback - Invoked with the matching event.
   * @returns A `StreamSubscription` — call `.unsubscribe()` to stop listening.
   *
   * @example
   * ```ts
   * const sub = client.on("StreamCreated", (event) => {
   *   console.log("Stream created:", event.streamId);
   * });
   * // later: sub.unsubscribe();
   * ```
   */
  on(
    eventType: StreamEventType,
    callback: (event: StreamEvent<TEventData>) => void,
  ): StreamSubscription {
    return this.subscribeEvents({}, (event) => {
      if (event.type === eventType) {
        callback(event);
      }
    });
  }

  /**
   * Shorthand for subscribing to stream-created events.
   *
   * @param callback - Invoked with each matching event.
   * @returns A `StreamSubscription` — call `.unsubscribe()` to stop listening.
   */
  onStreamCreated(callback: (event: StreamEvent<TEventData>) => void): StreamSubscription {
    return this.on('StreamCreated', callback);
  }

  /**
   * Shorthand for subscribing to stream-withdrawn events.
   *
   * @param callback - Invoked with each matching event.
   * @returns A `StreamSubscription` — call `.unsubscribe()` to stop listening.
   */
  onStreamWithdrawn(callback: (event: StreamEvent<TEventData>) => void): StreamSubscription {
    return this.on('StreamWithdrawn', callback);
  }

  /**
   * Shorthand for subscribing to stream-topped-up events.
   *
   * @param callback - Invoked with each matching event.
   * @returns A `StreamSubscription` — call `.unsubscribe()` to stop listening.
   */
  onStreamToppedUp(callback: (event: StreamEvent<TEventData>) => void): StreamSubscription {
    return this.on('StreamToppedUp', callback);
  }

  /**
   * Shorthand for subscribing to stream-cancelled events.
   *
   * @param callback - Invoked with each matching event.
   * @returns A `StreamSubscription` — call `.unsubscribe()` to stop listening.
   */
  onStreamCancelled(callback: (event: StreamEvent<TEventData>) => void): StreamSubscription {
    return this.on('StreamCancelled', callback);
  }

  /**
   * Shorthand for subscribing to stream-transferred events.
   *
   * @param callback - Invoked with each matching event.
   * @returns A `StreamSubscription` — call `.unsubscribe()` to stop listening.
   */
  onStreamTransferred(callback: (event: StreamEvent<TEventData>) => void): StreamSubscription {
    return this.on('StreamTransferred', callback);
  }

  /**
   * Shorthand for subscribing to stream-paused events.
   *
   * @param callback - Invoked with each matching event.
   * @returns A `StreamSubscription` — call `.unsubscribe()` to stop listening.
   */
  onStreamPaused(callback: (event: StreamEvent<TEventData>) => void): StreamSubscription {
    return this.on('StreamPaused', callback);
  }

  /**
   * Shorthand for subscribing to stream-resumed events.
   *
   * @param callback - Invoked with each matching event.
   * @returns A `StreamSubscription` — call `.unsubscribe()` to stop listening.
   */
  onStreamResumed(callback: (event: StreamEvent<TEventData>) => void): StreamSubscription {
    return this.on('StreamResumed', callback);
  }

  /**
   * Subscribes to live state changes for a specific stream by polling.
   *
   * The callback is invoked each time the stream's state changes between
   * poll cycles — including status transitions (Active → Cancelled),
   * balance changes, and any other field mutations.
   *
   * @param streamId - The stream to watch.
   * @param callback - Called with `{ stream, previous, streamId }` on each state change.
   * @param options - Optional polling configuration.
   * @param options.pollIntervalMs - How often to poll (default 5000 ms).
   * @param options.immediate - When true, call the callback immediately with the current state.
   * @returns A `StreamSubscription` — call `.unsubscribe()` to stop polling.
   *
   * @example
   * ```ts
   * const sub = client.onStreamUpdate("42", ({ stream, previous }) => {
   *   if (previous && stream.status !== previous.status) {
   *     console.log(`Stream status changed: ${previous.status} → ${stream.status}`);
   *   }
   * });
   * // Later:
   * sub.unsubscribe();
   * ```
   */
  onStreamUpdate(
    streamId: string,
    callback: (payload: { stream: Stream; previous: Stream | undefined; streamId: string }) => void,
    options?: OnStreamUpdateOptions,
  ): StreamSubscription {
    const pollIntervalMs = options?.pollIntervalMs ?? 5_000;
    let previous: Stream | undefined = undefined;
    let stopped = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      if (stopped) return;
      try {
        const stream = await this.getStream(streamId);
        const hasChanged =
          previous === undefined ||
          stream.status !== previous.status ||
          stream.deposit !== previous.deposit ||
          stream.lastWithdrawTime !== previous.lastWithdrawTime ||
          stream.endTime !== previous.endTime ||
          stream.flowRate !== previous.flowRate ||
          stream.pausedAt !== previous.pausedAt;

        if (hasChanged) {
          callback({ stream, previous, streamId });
          previous = stream;
        }
      } catch {
        // RPC errors are silently swallowed so the poller stays alive.
        // Callers that need error visibility should use getStream directly.
      }
      if (!stopped) {
        timerId = setTimeout(() => void poll(), pollIntervalMs);
        if (timerId && typeof (timerId as unknown as { unref?: () => void }).unref === 'function') {
          (timerId as unknown as { unref: () => void }).unref();
        }
      }
    };

    if (options?.immediate) {
      void poll();
    } else {
      timerId = setTimeout(() => void poll(), pollIntervalMs);
      if (timerId && typeof (timerId as unknown as { unref?: () => void }).unref === 'function') {
        (timerId as unknown as { unref: () => void }).unref();
      }
    }

    return {
      unsubscribe: () => {
        stopped = true;
        if (timerId !== null) {
          clearTimeout(timerId);
          timerId = null;
        }
      },
    };
  }

  // ── Read methods (with retry) ────────────────────────────────────────────────
  // ── Queries ───────────────────────────────────────────────────────────────

  /**
   * Synchronously returns the last-known state for a stream without making
   * an RPC call — first from the short-lived in-memory read cache, falling
   * back to the persistent storage-backed cache (when
   * `{ cacheStreamState: true }` was passed to the constructor), which
   * survives page reloads.
   *
   * Useful for rendering an immediate value right after client construction,
   * before the first `getStream()` call resolves.
   *
   * Issue #470.
   * @param streamId - The stream ID to look up.
   * @returns The last-known `Stream`, or `undefined` if none is cached.
   */
  getCachedStream(streamId: string): Stream | undefined {
    const cacheKey = `${this.network}:${streamId}`;
    return (
      this.streamCache.get(cacheKey) ?? this.persistentStreamCache?.get(this.network, streamId)
    );
  }

  /**
   * Returns the full stream data for a given stream ID.
   * Returns a cached value when one is present (populated by optimistic updates).
   * Automatically retries on transient RPC errors.
   *
   * Concurrent callers for the same stream ID share a single in-flight RPC
   * request (issue #426): if five components ask for stream `42` in the same
   * tick, exactly one simulation is sent and all five receive the same object.
   *
   * @param streamId - The stream ID to look up.
   * @param options - Set `{ refresh: true }` to bypass the TTL cache and force
   *   a network read (the in-flight deduplication still applies).
   * @returns The `Stream` record.
   * @throws {StreamNotFoundError} If no stream exists with the given ID.
   */
  async getStream(streamId: string, options?: { refresh?: boolean }): Promise<Stream> {
    // Capture the current network so a concurrent `setNetwork` call can't
    // poison the cache with data fetched under a different network.
    const networkAtCallTime = this.network;
    const cacheKey = `${networkAtCallTime}:${streamId}`;

    // Issue #271: if a prior write has been recorded for this stream, wait for
    // the confirmed ledger before serving data — this guarantees the read is
    // not stale relative to the mutation (read-your-own-writes consistency).
    await this._waitForStreamLedger(streamId);

    // 1. Fast path: serve from TTL cache.
    if (!options?.refresh) {
      const cached = this.streamCache.get(cacheKey);
      if (cached) return cached;
    }

    // 2. Deduplication (issue #426): the first caller starts the RPC call, every
    //    caller that arrives while it is in flight joins the same promise.
    return this.requestDedup.dedupe(
      dedupKey('getStream', networkAtCallTime, streamId),
      async () => {
        const result = await withRetry(
          () =>
            this.simulateOp(
              this.contract.call('get_stream', nativeToScVal(BigInt(streamId), { type: 'u64' })),
            ),
          this.readRetry,
        );

        if (rpc.Api.isSimulationError(result)) {
          throw new StreamNotFoundError(streamId);
        }

        const returnVal = (result as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
        if (!returnVal) throw new Error('No return value from contract');
        const stream = scValToStream(returnVal);

        // Only cache the result if the network hasn't changed during the RPC.
        // This guard maintains the cache contract keyed by the *current*
        // network: an in-flight read on the old network must never write into
        // the new network's slot, and any entry already present must remain
        // addressable under the network in which it was originally fetched.
        if (networkAtCallTime === this.network) {
          this.streamCache.set(cacheKey, stream);
        }
        return stream;
      },
    );
  }

    try {
      const stream = await this.streamInflight.get(cacheKey)!;

      // Only cache the result if the network hasn't changed during the RPC.
      // This guard maintains the cache contract keyed by the *current*
      // network: an in-flight read on the old network must never write into
      // the new network's slot, and any entry already present must remain
      // addressable under the network in which it was originally fetched.
      if (networkAtCallTime === this.network) {
        this.streamCache.set(cacheKey, stream);
        // Issue #470: also persist to the opt-in localStorage-backed cache
        this.persistentStreamCache?.set(networkAtCallTime, stream);
      }
      if (!requested.includes(id)) requested.push(id);
    }

    if (requested.length === 0) {
      return { streams: [], missing: [], cached: [], rpcCalls: 0 };
    }

    const networkAtCallTime = this.network;
    const useCache = options?.useCache !== false;
    const chunkSize = Math.max(1, options?.chunkSize ?? this.batchReadSize);

    // Issue #271: honour read-your-own-writes for every requested stream.
    await Promise.all(requested.map((id) => this._waitForStreamLedger(id)));

    const resolved = new Map<string, Stream>();
    const cached: string[] = [];
    const toFetch: string[] = [];

    for (const id of requested) {
      const hit = useCache ? this.streamCache.get(`${networkAtCallTime}:${id}`) : undefined;
      if (hit) {
        resolved.set(id, hit);
        cached.push(id);
      } else {
        toFetch.push(id);
      }
    }

    let rpcCalls = 0;

    if (toFetch.length > 0) {
      const chunks: string[][] = [];
      for (let i = 0; i < toFetch.length; i += chunkSize) {
        chunks.push(toFetch.slice(i, i + chunkSize));
      }

      const fetched = await Promise.all(
        chunks.map((chunk) =>
          this.requestDedup.dedupe(
            dedupKey('getStreams', networkAtCallTime, chunk.join(',')),
            async () => {
              rpcCalls++;
              return this._fetchStreamChunk(chunk, networkAtCallTime, options);
            },
          ),
        ),
      );

      for (const chunkStreams of fetched) {
        for (const stream of chunkStreams) {
          resolved.set(stream.id, stream);
        }
      }
    }

    const missing = requested.filter((id) => !resolved.has(id));
    if (missing.length > 0 && options?.strict) {
      throw new StreamNotFoundError(missing[0]!);
    }

    return {
      streams: requested.map((id) => resolved.get(id)).filter((s): s is Stream => s !== undefined),
      missing,
      cached,
      rpcCalls,
    };
  }

  /**
   * Fetches one chunk of stream IDs with a single `get_streams` simulation,
   * falling back to parallel single reads on contracts without that entry
   * point. Issue #427.
   */
  private async _fetchStreamChunk(
    chunk: string[],
    networkAtCallTime: Network,
    options?: GetStreamsOptions,
  ): Promise<Stream[]> {
    const idsScVal = xdr.ScVal.scvVec(
      chunk.map((id) => nativeToScVal(BigInt(id), { type: 'u64' })),
    );

    const result = await withRetry(
      () => this.simulateOp(this.contract.call('get_streams', idsScVal)),
      this.readRetry,
    );

    if (rpc.Api.isSimulationError(result)) {
      // The contract may be an older deployment without `get_streams`. Falling
      // back keeps the batch API usable everywhere instead of hard-failing.
      if (options?.fallbackToIndividual === false) return [];
      return this._fetchStreamsIndividually(chunk, options);
    }

    const returnVal = (result as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (!returnVal) {
      if (options?.fallbackToIndividual === false) return [];
      return this._fetchStreamsIndividually(chunk, options);
    }

    const raw = scValToNative(returnVal) as Array<Record<string, unknown> | null | undefined>;
    if (!Array.isArray(raw)) {
      if (options?.fallbackToIndividual === false) return [];
      return this._fetchStreamsIndividually(chunk, options);
    }

    const streams = raw
      .filter((entry): entry is Record<string, unknown> => entry != null)
      .map(nativeToStream);

    // Warm the per-stream cache so a later getStream() for any of these IDs is
    // served locally — only when the network hasn't switched mid-flight.
    if (networkAtCallTime === this.network) {
      for (const stream of streams) {
        this.streamCache.set(`${networkAtCallTime}:${stream.id}`, stream);
      }
    }

    return streams;
  }

  /**
   * Fallback path for {@link SoroStreamClient.getStreams}: reads each ID
   * individually (in parallel, still deduplicated) and drops the ones that do
   * not exist. Issue #427.
   */
  private async _fetchStreamsIndividually(
    chunk: string[],
    options?: GetStreamsOptions,
  ): Promise<Stream[]> {
    const settled = await Promise.all(
      chunk.map((id) =>
        this.getStream(id, { refresh: options?.useCache === false }).catch((error: unknown) => {
          if (error instanceof StreamNotFoundError) return null;
          throw error;
        }),
      ),
    );
    return settled.filter((s): s is Stream => s !== null);
  }

  /**
   * Returns the currently claimable amount in stroops for a stream.
   *
   * Concurrent callers for the same stream ID share a single in-flight RPC
   * request — they all receive the same resolved value rather than racing to
   * produce independent results. After resolution the value is cached for 5 s,
   * so subsequent callers within that window skip the RPC call entirely.
   *
   * Distinguishes "stream not found" (returns `0n`) from transient RPC errors
   * (retried automatically, then thrown). A contract-level simulation error
   * indicates the stream does not exist; network failures are retried.
   *
   * @param streamId - The stream ID to check.
   * @returns The claimable amount in stroops, or `0n` if the stream does not exist.
   */
  async getClaimable(streamId: string): Promise<bigint> {
    // 1. Fast path: serve from TTL cache.
    const cached = this.claimableCache.get(streamId);
    if (cached !== undefined) return cached;

    // 2. Deduplication (issue #426): concurrent callers join the in-flight call
    //    instead of each starting their own.
    return this.requestDedup.dedupe(
      dedupKey('getClaimable', this.network, streamId),
      async (): Promise<bigint> => {
        const result = await withRetry(
          () =>
            this.simulateOp(
              this.contract.call('get_claimable', nativeToScVal(BigInt(streamId), { type: 'u64' })),
            ),
          this.readRetry,
        );

        let value = 0n;
        if (!rpc.Api.isSimulationError(result)) {
          const returnVal = (result as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
          if (returnVal) {
            const raw = BigInt(scValToNative(returnVal) as number);
            if (raw < 0n) {
              console.warn(`getClaimable returned negative value ${raw} — clamping to 0`);
            } else {
              value = raw;
            }
          }
        }

        // On success: populate the TTL cache so the next burst of callers
        // doesn't need to wait for a new RPC round-trip.
        this.claimableCache.set(streamId, value);
        return value;
      },
    );
  }

  /**
   * Returns the current accrued claimable balances for a list of stream IDs
   * using a single batched RPC call (issue #445).
   *
   * Intended for dashboards that need live balances for many streams at once
   * without issuing one `simulateTransaction` per stream. The remaining (not
   * cached, not in-flight) IDs are packed into one transaction — one
   * `get_claimable` operation per ID — and simulated in a single round-trip.
   *
   * Results are served from the same TTL cache and in-flight request pool as
   * {@link getClaimable}, so a stream fetched here warms the cache for
   * subsequent single-ID reads and vice versa. Duplicate IDs in the input are
   * de-duplicated while preserving first-seen order.
   *
   * If the RPC server rejects or cannot answer the batched simulation (e.g.
   * it only accepts a single `invokeHostFunction` operation per transaction,
   * or the response shape does not contain one return value per ID), the
   * method gracefully falls back to resolving each ID individually via
   * {@link getClaimable}, which maps missing streams to `0n` and retries
   * transient failures on its own. Missing streams therefore always resolve
   * to `0n` regardless of the code path taken.
   *
   * @param streamIds - The stream IDs to look up.
   * @returns One `StreamBalance` entry per unique input ID, in first-seen
   *   order, with `balance` in stroops (`0n` when the stream does not exist).
   * @example
   * ```ts
   * const balances = await client.getMultipleStreamBalances(["1", "2", "3"]);
   * for (const { streamId, balance } of balances) {
   *   console.log(streamId, balance);
   * }
   * ```
   */
  async getMultipleStreamBalances(streamIds: string[]): Promise<StreamBalance[]> {
    if (streamIds.length === 0) return [];

    // De-duplicate while preserving first-seen order.
    const uniqueIds = [...new Set(streamIds)];

    const balances = new Map<string, bigint>();
    const missing: string[] = [];

    // Fast path: serve from the TTL cache and join in-flight requests, the
    // same sources getClaimable uses, so repeated dashboard polls stay cheap.
    for (const id of uniqueIds) {
      const cached = this.claimableCache.get(id);
      if (cached !== undefined) {
        balances.set(id, cached);
        continue;
      }
      const inFlight = this.claimableInflight.get(id);
      if (inFlight) {
        try {
          balances.set(id, await inFlight);
          continue;
        } catch {
          // Fall through: the in-flight request failed, fetch it with the
          // batch below (or individually) instead of surfacing the error.
        }
      }
      missing.push(id);
    }

    if (missing.length > 0) {
      const batched = await this.simulateClaimableBatch(missing).catch(() => null);
      if (batched) {
        for (const [id, value] of batched) {
          balances.set(id, value);
        }
      } else {
        // The server rejected or could not answer the batched simulation —
        // resolve each ID individually so the caller still gets correct data.
        await Promise.all(
          missing.map(async (id) => {
            const value = await this.getClaimable(id);
            balances.set(id, value);
          }),
        );
      }
    }

    return uniqueIds.map((id) => ({ streamId: id, balance: balances.get(id) ?? 0n }));
  }

  /**
   * Fetches claimable balances for many stream IDs in a single batched
   * `simulateTransaction` call (one `get_claimable` operation per ID).
   *
   * Returns `null` when the simulation errored or the response does not
   * contain exactly one return value per requested ID (e.g. the RPC server
   * only supports a single `invokeHostFunction` operation per transaction).
   * Successful values are written into the claimable TTL cache so subsequent
   * `getClaimable` / `getMultipleStreamBalances` calls are served without
   * another round-trip.
   */
  private async simulateClaimableBatch(ids: string[]): Promise<Map<string, bigint> | null> {
    const operations = ids.map((id) =>
      this.contract.call('get_claimable', nativeToScVal(BigInt(id), { type: 'u64' })),
    );

    const result = await withRetry(() => this.simulateOps(operations), this.readRetry);

    if (rpc.Api.isSimulationError(result)) return null;

    const retvals: xdr.ScVal[] = [];
    // Mock/raw RPC responses expose one entry per operation under `results`;
    // the stellar-sdk parsed shape only exposes the first operation as `result`.
    const raw = (result as unknown as { results?: Array<{ xdr?: string }> }).results;
    if (raw && raw.length > 0) {
      for (const row of raw) {
        if (!row.xdr) return null;
        retvals.push(xdr.ScVal.fromXDR(row.xdr, 'base64'));
      }
    } else if (result.result?.retval) {
      retvals.push(result.result.retval);
    } else {
      return null;
    }

    if (retvals.length !== ids.length) return null;

    const out = new Map<string, bigint>();
    ids.forEach((id, index) => {
      let value = 0n;
      try {
        value = BigInt(scValToNative(retvals[index]!) as number);
      } catch {
        value = 0n;
      }
      if (value < 0n) value = 0n;
      out.set(id, value);
      // Warm the shared TTL cache so single-ID getClaimable reads that
      // follow this batch don't need a new round-trip.
      this.claimableCache.set(id, value);
    });

    return out;
  }

  /**
   * Returns all streams created by a sender address.
   * When `pagination` is omitted, returns the full result set (backward-compatible).
   * Results are cached per-network to prevent stale cross-network data on network
   * switches. The cache is invalidated by {@link setNetwork}. (Issue #230.)
   * Automatically retries on transient RPC errors.
   *
   * Concurrent identical queries share a single in-flight RPC call (issue #426).
   *
   * @param sender - The sender address to query.
   * @param pagination - Optional limit/cursor for paginated results.
   * @param filter - Optional client-side filter criteria (e.g. `{ status: "Active", token, startTimeFrom }`).
   * @returns A `Stream[]` when `pagination` is omitted, otherwise a `PaginatedStreams` page.
   */
  async getStreamsBySender(
    sender: string,
    pagination?: PaginationParams,
    filter?: StreamFilterCriteria,
  ): Promise<Stream[] | PaginatedStreams> {
    // Network-keyed cache for non-paginated calls (issue #230 & #342).
    // When a filter is provided, bypass the cache so filtered results don't
    // poison the unfiltered cache entry for subsequent calls.
    const networkAtCallTime = this.network;
    const cacheKey = `${networkAtCallTime}:${sender}`;
    const hasFilter = filter !== undefined && Object.keys(filter).length > 0;
    if (!pagination && !hasFilter) {
      const cached = this.senderCache.get(cacheKey);
      if (cached) return cached;
    }

    return this.requestDedup.dedupe(
      dedupKey('getStreamsBySender', networkAtCallTime, sender, pagination),
      async (): Promise<Stream[] | PaginatedStreams> => {
        const args: xdr.ScVal[] = [nativeToScVal(sender, { type: 'address' })];

        if (pagination) {
          args.push(nativeToScVal(pagination.limit ?? 20, { type: 'u32' }));
          args.push(
            pagination.cursor != null
              ? nativeToScVal(BigInt(pagination.cursor), { type: 'u64' })
              : xdr.ScVal.scvVoid(),
          );
        }

        const result = await withRetry(
          () => this.simulateOp(this.contract.call('get_streams_by_sender', ...args)),
          this.readRetry,
        );

        if (rpc.Api.isSimulationError(result)) {
          return pagination ? { streams: [], cursor: null, hasMore: false } : [];
        }

        const returnVal = (result as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
        if (!returnVal) {
          return pagination ? { streams: [], cursor: null, hasMore: false } : [];
        }

        const raw = scValToNative(returnVal) as Record<string, unknown>[];
        const streams = raw.map(nativeToStream);

        // Only cache non-paginated results, and only when the network hasn't
        // switched mid-flight (mirrors the guard in getStream).
        if (!pagination && networkAtCallTime === this.network) {
          this.senderCache.set(cacheKey, streams);
        }

        if (!pagination) return streams;

        const limit = pagination.limit ?? 20;
        const last = streams[streams.length - 1];
        return {
          streams,
          cursor: last ? last.id : null,
          hasMore: streams.length >= limit,
        };
      },
    );
  }

  /**
   * Returns all streams targeting a recipient address.
   * When `pagination` is omitted, returns the full result set (backward-compatible).
   * Results are cached per-network to prevent stale cross-network data on network
   * switches. The cache is invalidated by {@link setNetwork}. (Issue #230.)
   * Automatically retries on transient RPC errors.
   *
   * Issue #408: Added optional `filter` parameter. When `filter.activeOnly` is `true`
   * (or `filter.status` is `'Active'`), the returned list is filtered client-side
   * after the RPC fetch. Completed streams that happen to exist in the same ledger as
   * the query are excluded, fixing the false-positive inclusion of completed streams.
   *
   * Concurrent identical queries share a single in-flight RPC call (issue #426);
   * the client-side filter is still applied per caller.
   *
   * @param recipient - The recipient address to query.
   * @param pagination - Optional limit/cursor for paginated results.
   * @param filter - Optional client-side filter criteria (e.g. `{ activeOnly: true }`).
   * @returns A `Stream[]` when `pagination` is omitted, otherwise a `PaginatedStreams` page.
   */
  async getStreamsByRecipient(
    recipient: string,
    pagination?: PaginationParams,
    filter?: StreamFilterCriteria,
  ): Promise<Stream[] | PaginatedStreams> {
    // Network-keyed cache for non-paginated calls (issue #230 & #342).
    // When a filter is provided, bypass the cache so filtered results don't
    // poison the unfiltered cache entry for subsequent calls.
    const networkAtCallTime = this.network;
    const cacheKey = `${networkAtCallTime}:${recipient}`;
    const hasFilter = filter && Object.keys(filter).length > 0;
    if (!pagination && !hasFilter) {
      const cached = this.recipientCache.get(cacheKey);
      if (cached) return cached;
    }

    const args: xdr.ScVal[] = [nativeToScVal(recipient, { type: 'address' })];

    if (pagination) {
      args.push(nativeToScVal(pagination.limit ?? 20, { type: 'u32' }));
      args.push(
        pagination.cursor != null
          ? nativeToScVal(BigInt(pagination.cursor), { type: 'u64' })
          : xdr.ScVal.scvVoid(),
      );
    }

    // Issue #426: concurrent identical queries share one in-flight RPC call.
    const result = await this.requestDedup.dedupe(
      dedupKey('getStreamsByRecipient:rpc', networkAtCallTime, recipient, pagination),
      () =>
        withRetry(
          () => this.simulateOp(this.contract.call('get_streams_by_recipient', ...args)),
          this.readRetry,
        ),
    );

    if (rpc.Api.isSimulationError(result)) {
      return pagination ? { streams: [], cursor: null, hasMore: false } : [];
    }

    const returnVal = (result as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (!returnVal) {
      return pagination ? { streams: [], cursor: null, hasMore: false } : [];
    }

    const raw = scValToNative(returnVal) as Record<string, unknown>[];
    let streams = raw.map(nativeToStream);

    // Issue #408: apply client-side filter (e.g. activeOnly) AFTER the RPC fetch.
    // This ensures completed/cancelled streams from the same ledger are excluded
    // when the caller requests only active streams.
    if (hasFilter) {
      streams = filterStreams(streams, filter!);
    }

    // Only cache non-paginated, unfiltered results, and only when the network
    // hasn't switched mid-flight (mirrors the guard in getStream and getStreamsBySender).
    if (!pagination && !hasFilter && networkAtCallTime === this.network) {
      this.recipientCache.set(cacheKey, streams);
    }

    if (!pagination) return streams;

    const limit = pagination.limit ?? 20;
    const last = streams[streams.length - 1];
    return {
      streams,
      cursor: last ? last.id : null,
      hasMore: streams.length >= limit,
    };
  }

  /**
   * Returns all streams matching a given namespace (issue #274).
   *
   * **Important:** Namespace filtering is **off-chain only**. The contract
   * does not enforce namespace isolation — this method queries the local
   * namespace registry that is populated when streams are created with a
   * `namespace` parameter. Streams created without a namespace are excluded.
   *
   * @param namespace - The namespace string to filter by.
   * @param filter - Optional combined filter criteria (status, token, date range, …)
   *   applied after streams are fetched.
   * @returns An array of streams that have been tagged with the given namespace.
   *
   * @example
   * ```ts
   * // Create a stream with a namespace
   * await client.createStream({
   *   recipient: "GADDR...",
   *   token: "USDC...",
   *   amount: 100000000n,
   *   durationSeconds: 3600,
   *   autoRenew: false,
   *   namespace: "tenant-abc",
   * });
   *
   * // Query streams by namespace
   * const streams = await client.getStreamsByNamespace("tenant-abc");
   *
   * // Dashboard: only active USDC streams started this month
   * const monthAgo = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
   * const recent = await client.getStreamsByNamespace("tenant-abc", {
   *   status: "Active",
   *   token: usdcAddress,
   *   startTimeFrom: monthAgo,
   * });
   * ```
   */
  async getStreamsByNamespace(namespace: string, filter?: StreamFilterCriteria): Promise<Stream[]> {
    const streamIds = Array.from(this.namespaceRegistry.entries())
      .filter(([, ns]) => ns === namespace)
      .map(([id]) => id);

    if (streamIds.length === 0) return [];

    const streams: Stream[] = [];
    for (const id of streamIds) {
      try {
        const stream = await this.getStream(id);
        streams.push(stream);
      } catch {
        // Stream may have been cancelled or is no longer accessible;
        // remove it from the registry
        this.namespaceRegistry.delete(id);
      }
    }

    if (filter !== undefined && Object.keys(filter).length > 0) {
      return filterStreams(streams, filter);
    }
    return streams;
  }

  // ── Issue #426: request deduplication introspection ───────────────────────

  /**
   * Returns counters describing how effective in-flight request deduplication
   * has been on this client (issue #426).
   *
   * `deduplicated` is the number of read calls that were served by joining an
   * already in-flight request — i.e. the number of RPC calls saved.
   *
   * @example
   * ```ts
   * await Promise.all([client.getStream("1"), client.getStream("1")]);
   * client.getRequestStats(); // { requests: 2, started: 1, deduplicated: 1, ... }
   * ```
   */
  getRequestStats(): RequestDedupStats {
    return this.requestDedup.stats();
  }

  /** Resets the counters returned by {@link SoroStreamClient.getRequestStats}. */
  resetRequestStats(): void {
    this.requestDedup.resetStats();
  }

  /**
   * Detaches all tracked in-flight reads so the next caller starts a fresh
   * request (issue #426). Existing callers still receive their result; the
   * pending request simply stops being reusable.
   */
  clearInFlightRequests(): void {
    this.requestDedup.clear();
  }

  // ── Issue #423: reactive (RxJS-compatible) observables ────────────────────

  /**
   * Returns an RxJS-compatible observable of a stream's state (issue #423).
   *
   * The observable emits the current {@link Stream} immediately on subscribe and
   * then again whenever the on-chain state changes. It implements the
   * Observable interop protocol (`Symbol.observable`), so RxJS consumes it
   * directly through `from()` and it composes with the full operator set —
   * without RxJS being a dependency of this SDK.
   *
   * All subscribers of the same stream (and same options) share **one** poll
   * loop and the latest value is replayed to late subscribers, so mounting ten
   * components costs one polling loop, not ten. The loop is torn down as soon
   * as the last subscriber unsubscribes, and also by
   * {@link SoroStreamClient.destroy}.
   *
   * @param streamId - The stream to observe.
   * @param options - Polling interval and emission behaviour.
   * @returns A shared, reference-counted observable of stream states.
   *
   * @example
   * ```ts
   * // Plain usage — no RxJS required
   * const sub = client.observeStream("42").subscribe((stream) => {
   *   console.log(stream.status);
   * });
   * sub.unsubscribe();
   * ```
   *
   * @example
   * ```ts
   * // Compose with RxJS
   * import { from } from "rxjs";
   * import { map, distinctUntilChanged } from "rxjs/operators";
   *
   * from(client.observeStream("42"))
   *   .pipe(map((s) => s.status), distinctUntilChanged())
   *   .subscribe(console.log);
   * ```
   */
  observeStream(streamId: string, options?: ObserveStreamOptions): SoroStreamObservable<Stream> {
    const intervalMs = Math.max(250, options?.intervalMs ?? 5_000);
    const emitOnlyChanges = options?.emitOnlyChanges !== false;
    const completeWhenSettled = options?.completeWhenSettled !== false;
    const refreshOnEvents = options?.refreshOnEvents === true;

    const key = dedupKey(
      'observeStream',
      this.network,
      streamId,
      intervalMs,
      emitOnlyChanges,
      completeWhenSettled,
      refreshOnEvents,
    );
    const existing = this.streamObservables.get(key);
    if (existing) return existing;

    const observable = shareLatest<Stream>(
      (sink) => {
        let timer: ReturnType<typeof setInterval> | null = null;
        let eventSub: StreamSubscription | null = null;
        let stopped = false;
        let inFlight = false;
        let lastSerialized: string | null = null;

        const stop = (): void => {
          if (stopped) return;
          stopped = true;
          if (timer !== null) {
            clearInterval(timer);
            timer = null;
          }
          eventSub?.unsubscribe();
          eventSub = null;
          this.ownedTimers.extraStops.delete(stop);
        };

        const tick = async (refresh: boolean): Promise<void> => {
          // Skip overlapping ticks: a slow RPC must not queue up requests.
          if (stopped || inFlight) return;
          inFlight = true;
          try {
            const stream = await this.getStream(streamId, { refresh });
            if (stopped) return;
            const serialized = JSON.stringify(streamToJSON(stream));
            if (!emitOnlyChanges || serialized !== lastSerialized) {
              lastSerialized = serialized;
              sink.next(stream);
            }
            if (
              completeWhenSettled &&
              (stream.status === 'Completed' || stream.status === 'Cancelled')
            ) {
              stop();
              sink.complete();
            }
          } catch (error) {
            stop();
            sink.error(error);
          } finally {
            inFlight = false;
          }
        };

        // Emit the current state as soon as possible (cache-first), then keep
        // it fresh with forced reads so the TTL cache can't mask a change.
        void tick(false);
        timer = setInterval(() => void tick(true), intervalMs);
        unrefTimer(timer);
        // Issue #412: destroy()/GC must be able to stop this loop.
        this.ownedTimers.extraStops.add(stop);

        if (refreshOnEvents) {
          eventSub = this.subscribeEvents({ streamId }, () => void tick(true));
        }

        return stop;
      },
      {
        onDisconnect: () => {
          this.streamObservables.delete(key);
        },
      },
    );

    this.streamObservables.set(key, observable);
    return observable;
  }

  /**
   * Returns an RxJS-compatible observable of a stream's claimable balance in
   * stroops (issue #423).
   *
   * Like {@link SoroStreamClient.observeStream}, subscribers share one poll
   * loop and the most recent value is replayed to late subscribers.
   *
   * @param streamId - The stream to observe.
   * @param options - Polling interval and emission behaviour.
   * @returns A shared, reference-counted observable of claimable amounts.
   *
   * @example
   * ```ts
   * client.observeClaimable("42").subscribe((stroops) => {
   *   console.log(formatUSDC(stroops));
   * });
   * ```
   */
  observeClaimable(
    streamId: string,
    options?: { intervalMs?: number; emitOnlyChanges?: boolean },
  ): SoroStreamObservable<bigint> {
    const intervalMs = Math.max(250, options?.intervalMs ?? 5_000);
    const emitOnlyChanges = options?.emitOnlyChanges !== false;
    const key = dedupKey('observeClaimable', this.network, streamId, intervalMs, emitOnlyChanges);
    const existing = this.claimableObservables.get(key);
    if (existing) return existing;

    const observable = shareLatest<bigint>(
      (sink) => {
        let timer: ReturnType<typeof setInterval> | null = null;
        let stopped = false;
        let inFlight = false;
        let last: bigint | null = null;

        const stop = (): void => {
          if (stopped) return;
          stopped = true;
          if (timer !== null) {
            clearInterval(timer);
            timer = null;
          }
          this.ownedTimers.extraStops.delete(stop);
        };

        const tick = async (refresh: boolean): Promise<void> => {
          if (stopped || inFlight) return;
          inFlight = true;
          try {
            // Force a network read on subsequent ticks so the 5 s claimable
            // cache cannot stall the observable.
            if (refresh) this.claimableCache.delete(streamId);
            const claimable = await this.getClaimable(streamId);
            if (stopped) return;
            if (!emitOnlyChanges || last !== claimable) {
              last = claimable;
              sink.next(claimable);
            }
          } catch (error) {
            stop();
            sink.error(error);
          } finally {
            inFlight = false;
          }
        };

        void tick(false);
        timer = setInterval(() => void tick(true), intervalMs);
        unrefTimer(timer);
        this.ownedTimers.extraStops.add(stop);

        return stop;
      },
      {
        onDisconnect: () => {
          this.claimableObservables.delete(key);
        },
      },
    );

    this.claimableObservables.set(key, observable);
    return observable;
  }

  // ── Issue #73: Stream snapshot export / import ───────────────────────────

  /**
   * Exports a complete stream snapshot including current claimable amount and
   * a projected vesting curve. The result is fully JSON-serialisable.
   *
   * @param streamId - The stream to snapshot.
   * @param cliffSeconds - Optional cliff duration in seconds for the vesting projection (default 0).
   * @returns A JSON-serialisable `StreamSnapshot`.
   * @throws {StreamNotFoundError} If no stream exists with the given ID.
   */
  async exportStream(streamId: string, cliffSeconds = 0): Promise<StreamSnapshot> {
    const stream = await this.getStream(streamId);
    const claimable = await this.getClaimable(streamId);

    const now = Math.floor(Date.now() / 1000);
    const vesting = calculateVestingSchedule(stream, cliffSeconds, now);

    return {
      version: 1,
      exportedAt: Date.now(),
      stream: {
        ...stream,
        deposit: stream.deposit.toString(),
        flowRate: stream.flowRate.toString(),
      },
      claimableAtExport: claimable.toString(),
      vestingProjection: vesting.milestones.map((m) => ({
        time: m.time,
        vested: m.vested.toString(),
      })),
      history: [],
    };
  }

  /**
   * Reconstructs a read-only stream view from a previously exported snapshot.
   * Useful for offline analysis without a live RPC connection.
   *
   * @param snapshot - A `StreamSnapshot` produced by `exportStream`.
   * @returns The deserialized `Stream` object with bigint fields restored.
   */
  importStream(snapshot: StreamSnapshot): import('./types.js').Stream {
    return {
      ...snapshot.stream,
      deposit: BigInt(snapshot.stream.deposit),
      flowRate: BigInt(snapshot.stream.flowRate),
    };
  }

  /**
   * Creates a new stream with the same parameters as an existing one.
   * The new stream gets a fresh `startTime = now`. Any field can be
   * overridden before submission via `overrides`.
   *
   * @param streamId - ID of the source stream to clone.
   * @param overrides - Optional field overrides applied before submission.
   * @param signal - Optional `AbortSignal` to cancel in-flight transaction polling.
   * @param options - Optional write options.
   * @returns `{ streamId, txHash }` for the newly created stream.
   * @throws {StreamNotFoundError} If the source stream does not exist.
   */
  async cloneStream(
    streamId: string,
    overrides?: CloneStreamOverrides,
    signal?: AbortSignal,
    options?: WriteOptions,
  ): Promise<{ streamId: string; txHash: string }> {
    const source = await this.getStream(streamId);
    const durationSeconds = source.endTime - source.startTime;

    const params: CreateStreamParams = {
      recipient: source.recipient,
      token: source.token,
      amount: source.deposit,
      durationSeconds,
      autoRenew: source.autoRenew,
      ...overrides,
    };

    return this.createStream(params, signal, options);
  }

  // ── Bulk operations ───────────────────────────────────────────────────────

  /**
   * Creates multiple payment streams across one or more batched transactions.
   *
   * Rows are chunked by `options.batchSize`. A chunk where every row shares
   * the default token is submitted as a single multi-operation transaction;
   * a chunk with per-row token overrides falls back to one transaction per
   * row. If any row or chunk fails, the successfully created streams are
   * **not** rolled back — the method throws {@link BulkCreatePartialError}
   * describing exactly which rows succeeded and which failed, instead of
   * silently dropping the failed slots.
   *
   * @param rows - Rows describing the streams to create.
   * @param rows[].recipient - Beneficiary Stellar address for this row.
   * @param rows[].amount - Total amount to stream in stroops (must be > 0).
   * @param rows[].durationSeconds - Stream duration in seconds (must be > 0).
   * @param rows[].token - Optional per-row token override (defaults to `options.token`).
   * @param rows[].cliffSeconds - Optional per-row cliff duration in seconds (default 0).
   * @param options - Bulk creation options.
   * @param options.token - Default SAC token contract address for rows that omit `token`.
   * @param options.autoRenew - Whether created streams auto-renew (default false).
   * @param options.batchSize - Maximum operations per transaction (default 8).
   * @returns `{ batches }` — one entry per submitted transaction, each with its `txHash` and the resulting `streamIds`.
   * @throws {BulkCreatePartialError} If one or more rows fail; carries `successfulBatches` and `failedSlots`.
   * @throws {TransactionFailedError} If a submitted transaction is rejected (wrapped into `failedSlots` rather than thrown directly).
   *
   * @example
   * ```ts
   * try {
   *   const { batches } = await client.bulkCreateStreams(rows, { token: usdc });
   * } catch (err) {
   *   if (err instanceof BulkCreatePartialError) {
   *     console.error(`${err.failedSlots.length} stream(s) failed:`, err.failedSlots);
   *   }
   * }
   * ```
   */
  async bulkCreateStreams(
    rows: import('./types.js').BulkStreamRow[],
    options: BulkCreateOptions,
  ): Promise<BulkCreateResult> {
    return this.runWithMiddleware('bulkCreateStreams', [rows, options], async () => {
      const sender = await this.requireWalletAdapter().getPublicKey();
      const defaultToken = options.token;
      const autoRenew = options.autoRenew ?? false;
      const batchSize = options.batchSize ?? 8;

      // Validate cliff for all rows before submitting anything
      for (const row of rows) {
        await this.validateCliff(row.cliffSeconds ?? 0);
      }

      const results: BulkCreateResult['batches'] = [];
      const failedSlots: BulkCreateFailedSlot[] = [];

      for (let i = 0; i < rows.length; i += batchSize) {
        const chunk = rows.slice(i, i + batchSize);
        const chunkHasMixedTokens = chunk.some((r) => r.token != null && r.token !== defaultToken);

        if (chunkHasMixedTokens) {
          for (let j = 0; j < chunk.length; j++) {
            const row = chunk[j]!;
            try {
              const rowToken = row.token ?? defaultToken;
              const operation = this.encoder.createStream(sender, {
                recipient: row.recipient,
                token: rowToken,
                amount: row.amount,
                durationSeconds: row.durationSeconds,
                autoRenew,
              });
              const { txHash } = await this.buildAndSubmit(
                operation,
                undefined,
                undefined,
                'bulkCreateStreams',
              );

              const result = await this.getStreamsBySender(sender);
              const streams = Array.isArray(result) ? result : result.streams;
              const newStreams = streams.slice(-1);
              const streamIds = newStreams.map((s) => s.id);

              results.push({ txHash, streamIds, rows: [row] });
            } catch (error) {
              failedSlots.push({ index: i + j, row, error });
            }
          }
        } else {
          try {
            const operations = chunk.map((row) => {
              const rowToken = row.token ?? defaultToken;
              return this.encoder.createStream(sender, {
                recipient: row.recipient,
                token: rowToken,
                amount: row.amount,
                durationSeconds: row.durationSeconds,
                autoRenew,
              });
            });

            const txHash = await this.executeBatch(operations);

            const result = await this.getStreamsBySender(sender);
            const streams = Array.isArray(result) ? result : result.streams;
            const newStreams = streams.slice(-chunk.length);
            const streamIds = newStreams.map((s) => s.id);

            results.push({ txHash, streamIds, rows: chunk });
          } catch (error) {
            chunk.forEach((row, j) => {
              failedSlots.push({ index: i + j, row, error });
            });
          }
        }
      }

      if (failedSlots.length > 0) {
        throw new BulkCreatePartialError(results, failedSlots);
      }

      return { batches: results };
    });
  }

  // ── Utility ───────────────────────────────────────────────────────────────

  /**
   * Tears down the active RPC transport by calling its optional
   * `teardown()` hook. Only meaningful for a custom `transport` that holds
   * open resources (sockets, timers, …) — the default transport has nothing
   * to release. Safe to call even if no custom transport was configured.
   * See CUSTOM_TRANSPORT.md.
   */
  async disconnect(): Promise<void> {
    await this.server.teardown?.();
  }

  /**
   * Creates a background monitor that polls the given streams on a fixed
   * interval and emits threshold-based events — `streamExpiringSoon`,
   * `streamExpired`, `streamLowBalance`, and `streamStatusChanged` (issue #266).
   *
   * Centralizes what would otherwise be a hand-rolled polling loop per
   * consumer. Call `monitor.stop()` to clear all timers when done.
   *
   * @param streamIds - The stream IDs to poll.
   * @param config - Poll interval and alert thresholds.
   * @returns A {@link StreamMonitor} instance. Subscribe via `monitor.on(...)`.
   *
   * @example
   * ```ts
   * const monitor = client.createStreamMonitor(["1", "2"], {
   *   pollIntervalMs: 15_000,
   *   expiryWarningMs: 60 * 60 * 1000,
   *   lowBalanceThreshold: 1_000_000n,
   * });
   * monitor.on("streamExpiringSoon", ({ streamId, secondsLeft }) => { ... });
   * // later: monitor.stop();
   * ```
   */
  createStreamMonitor(streamIds: string[], config: StreamMonitorConfig = {}): StreamMonitor {
    return new StreamMonitor(
      streamIds,
      {
        getStream: (streamId) => this.getStream(streamId),
        getClaimable: (streamId) => this.getClaimable(streamId),
      },
      config,
    );
  }

  /**
   * Returns the circuit breaker guarding RPC calls, if one was configured.
   * @returns The active `CircuitBreaker`, or `null` if none was configured.
   */
  getCircuitBreaker(): CircuitBreaker | null {
    return this.breaker;
  }

  /**
   * Returns the price-feed adapter used for token-to-fiat conversions, if one was configured.
   * @returns The active `PriceFeedAdapter`, or `null` if none was configured.
   */
  getPriceFeed(): PriceFeedAdapter | null {
    return this.priceFeed;
  }

  // ── Issue #148: Recipient change notification ─────────────────────────────

  /**
   * Polls a stream and invokes `callback` whenever the recipient address
   * changes. Returns an unsubscribe function that stops the polling.
   *
   * @param streamId - The stream to watch.
   * @param callback - Called with change details when a recipient transfer is detected.
   * @param options - Optional polling interval (default 5 s).
   */
  onRecipientChanged(
    streamId: string,
    callback: (event: RecipientChangedEvent) => void,
    options?: OnRecipientChangedOptions,
  ): () => void {
    const intervalMs = options?.intervalMs ?? 5_000;
    let stopped = false;
    let lastRecipient: string | null = null;

    const poll = async () => {
      if (stopped) return;
      try {
        const stream = await this.getStream(streamId);
        if (lastRecipient !== null && stream.recipient !== lastRecipient) {
          callback({
            streamId,
            oldRecipient: lastRecipient,
            newRecipient: stream.recipient,
            timestamp: Math.floor(Date.now() / 1000),
          });
        }
        lastRecipient = stream.recipient;
      } catch {
        // swallow transient errors — keep polling
      }
    };

    // Seed lastRecipient on first tick
    void poll();
    let timer: ReturnType<typeof setInterval> | null = null;
    timer = setInterval(poll, intervalMs);
    if (timer) (timer as { unref?: () => void }).unref?.();

    const stop = () => {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      this.ownedTimers.extraStops.delete(stop);
    };
    this.ownedTimers.extraStops.add(stop);
    return stop;
  }

  // ── Issue #149: Connection pooling ────────────────────────────────────────

  /**
   * Returns current connection pool statistics.
   * When a pool is configured via `poolSize`, returns live slot counts.
   */
  getConnectionStats(): {
    maxConnections: number;
    active: number;
    idle: number;
    reused: number;
  } {
    if (this.pool) {
      const stats = this.pool.getStats();
      return {
        maxConnections: stats.total,
        active: stats.active,
        idle: stats.idle,
        reused: 0,
      };
    }
    return {
      maxConnections: this.connectionPool.maxConnections,
      active: this.connectionPool.active,
      idle: this.connectionPool.idle,
      reused: this.connectionPool.reused,
    };
  }

  /**
   * Registers a listener for pool-level events (pool:full, pool:reconnect, pool:drain).
   * Only fires when `poolSize` is configured. Returns an unsubscribe function.
   * Issue #179.
   */
  onPoolEvent(listener: (event: PoolEvent) => void): () => void {
    if (!this.pool) return () => {};
    return this.pool.on(listener);
  }

  /**
   * Registers a callback that fires before each reconnect attempt, with the attempt
   * number and computed backoff delay. Returns an unsubscribe function.
   * Issue #186.
   */
  onReconnecting(cb: (attempt: number, delayMs: number) => void): () => void {
    this.reconnectingCbs.add(cb);
    return () => this.reconnectingCbs.delete(cb);
  }

  /**
   * Registers a callback that fires once the event poller successfully reconnects
   * after one or more failures. Returns an unsubscribe function.
   * Issue #186.
   */
  onReconnected(cb: () => void): () => void {
    this.reconnectedCbs.add(cb);
    return () => this.reconnectedCbs.delete(cb);
  }

  /**
   * Registers a callback that fires when the event poller exhausts all retry
   * attempts. Polling stops at this point. Returns an unsubscribe function.
   * Issue #186.
   */
  onDisconnected(cb: (error: unknown) => void): () => void {
    this.disconnectedCbs.add(cb);
    return () => this.disconnectedCbs.delete(cb);
  }

  /**
   * Registers a callback that fires when the connected wallet switches
   * networks mid-session and the client automatically re-points itself at
   * the new network. Only fires for wallet adapters that implement
   * `onNetworkChange` (e.g. {@link createFreighterAdapter}). Returns an
   * unsubscribe function.
   * Issue #215.
   */
  onNetworkChanged(cb: (network: Network) => void): () => void {
    this.networkChangedCbs.add(cb);
    return () => this.networkChangedCbs.delete(cb);
  }

  /**
   * Subscribes to wallet adapter hot-swap notifications.
   *
   * The callback fires immediately after {@link setWalletAdapter} completes
   * and receives a {@link WalletAdapterChangedPayload} containing the previous
   * and new adapter public keys.
   *
   * Returns an unsubscribe function — call it to stop receiving notifications.
   *
   * @param cb - Invoked with the swap payload each time the adapter changes.
   * @returns An unsubscribe function.
   *
   * @example
   * ```ts
   * const unsub = client.onWalletAdapterChanged(({ previousPublicKey, newPublicKey }) => {
   *   console.log(\`Wallet changed: \${previousPublicKey} → \${newPublicKey}\`);
   *   updateUiWalletIndicator(newPublicKey);
   * });
   *
   * // Later, when you no longer need notifications:
   * unsub();
   * ```
   *
   * Issue #261.
   */
  onWalletAdapterChanged(cb: (payload: WalletAdapterChangedPayload) => void): () => void {
    this.walletAdapterChangedCbs.add(cb);
    return () => this.walletAdapterChangedCbs.delete(cb);
  }

  // ── Issue #187: Event batching ────────────────────────────────────────────

  /**
   * Subscribes to batched stream events. The callback receives an array of matching
   * events flushed when `batchingOptions.maxBatchSize` is reached or
   * `batchingOptions.maxBatchDelayMs` elapses — whichever comes first.
   *
   * @param filter - Same filter criteria as `subscribeEvents`.
   * @param callback - Called with a non-empty array of matching events per flush.
   * @returns A `StreamSubscription` — call `.unsubscribe()` to stop listening.
   *
   * @example
   * ```ts
   * const sub = client.subscribeBatchEvents({ streamId: "42" }, (events) => {
   *   console.log(`Received batch of ${events.length} events`);
   * });
   * ```
   */
  subscribeBatchEvents(
    filter: StreamEventFilter,
    callback: (events: StreamEvent[]) => void,
  ): StreamSubscription {
    const poller = this.getEventPoller();
    const key = `batch:${filter.streamId ?? '*'}:${filter.sender ?? '*'}:${filter.recipient ?? '*'}:${Date.now()}`;
    return poller.subscribeBatch(key, {
      filter: (event) => {
        if (filter.streamId && event.streamId !== filter.streamId) return false;
        if (filter.sender && event.data.sender !== filter.sender) return false;
        if (filter.recipient && event.data.recipient !== filter.recipient) return false;
        return true;
      },
      callback,
    });
  }

  /**
   * Live SDK metrics. Currently exposes batch-delivery statistics.
   * Issue #187.
   */
  get metrics(): { batch: import('./types.js').BatchMetrics } {
    return { batch: this.getEventPoller().getBatchMetrics() };
  }
  // ── Issue #167: Stream expiration hooks ──────────────────────────────────

  private readonly _expiryHandlers = new Map<string, Set<(stream: Stream) => void>>();
  private readonly _expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Registers a callback that fires once when a stream reaches its `end_time`.
   * Multiple handlers per stream are supported. The handler receives the stream
   * snapshot fetched at expiry time.
   *
   * @param streamId - The stream to watch for expiry.
   * @param callback - Invoked with the final stream snapshot at expiry.
   * @returns An unsubscribe function. Call it to cancel the hook before it fires.
   *
   * @example
   * ```ts
   * const unsubscribe = client.onExpiry("42", (stream) => {
   *   console.log("Stream expired:", stream.id);
   * });
   * // later: unsubscribe();
   * ```
   */
  onExpiry(streamId: string, callback: (stream: Stream) => void): () => void {
    if (!this._expiryHandlers.has(streamId)) {
      this._expiryHandlers.set(streamId, new Set());
    }
    const handlers = this._expiryHandlers.get(streamId)!;
    handlers.add(callback);

    if (!this._expiryTimers.has(streamId)) {
      void this._scheduleExpiry(streamId);
    }

    return () => {
      handlers.delete(callback);
      if (handlers.size === 0) {
        this._cancelExpiryTimer(streamId);
        this._expiryHandlers.delete(streamId);
      }
    };
  }

  private async _scheduleExpiry(streamId: string): Promise<void> {
    try {
      const stream = await this.getStream(streamId);
      const delayMs = Math.max(0, stream.endTime * 1000 - Date.now());

      const handle = setTimeout(async () => {
        this._expiryTimers.delete(streamId);
        try {
          const finalStream = await this.getStream(streamId);
          const handlers = this._expiryHandlers.get(streamId);
          if (handlers) {
            for (const cb of [...handlers]) cb(finalStream);
          }
        } catch {
          /* stream may no longer exist */
        }
      }, delayMs);

      this._expiryTimers.set(streamId, handle);
    } catch {
      /* stream not found — skip */
    }
  }

  private _cancelExpiryTimer(streamId: string): void {
    const handle = this._expiryTimers.get(streamId);
    if (handle !== undefined) {
      clearTimeout(handle);
      this._expiryTimers.delete(streamId);
    }
  }
  // ── Issue #166: Stream activity log ──────────────────────────────────────

  /**
   * Returns a time-ordered list of on-chain events for a stream.
   *
   * Supported event types: StreamCreated, StreamWithdrawn, StreamCancelled.
   * Results are sorted oldest-first and filtered by optional timestamp range.
   *
   * @param streamId - The stream to query.
   * @param options - Optional timestamp filters (`from`/`to` in ms) and pagination.
   * @returns `StreamActivityEntry[]` sorted oldest-first. Empty array when no events exist.
   *
   * @example
   * ```ts
   * const log = await client.getActivityLog("42");
   * const withdrawals = log.filter((e) => e.type === "StreamWithdrawn");
   * ```
   */
  async getActivityLog(
    streamId: string,
    options?: GetActivityLogOptions,
  ): Promise<StreamActivityEntry[]> {
    const { StreamIndexer } = await import('./indexer.js');
    const indexer = new StreamIndexer(this.server, this.contract.contractId());

    const { events } = await indexer.getStreamHistory(streamId, {
      limit: options?.limit ?? 100,
      cursor: options?.cursor,
    });

    return events
      .map((e): StreamActivityEntry => {
        let amount = 0n;
        if (e.type === 'StreamWithdrawn') {
          amount = e.data.amount;
        } else if (e.type === 'StreamCreated') {
          amount = e.data.deposit;
        }
        return {
          type: e.type as StreamActivityEntry['type'],
          timestamp: new Date(e.ledgerClosedAt).getTime(),
          amount,
          txHash: e.txHash,
          ledger: e.ledger,
        };
      })
      .filter((entry) => {
        if (options?.from != null && entry.timestamp < options.from) return false;
        if (options?.to != null && entry.timestamp > options.to) return false;
        return true;
      })
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Returns paginated on-chain events for a given stream.
   *
   * Each page contains up to `limit` events (default 100) in ledger order,
   * plus a `cursor` value you can pass to the next call to retrieve the
   * following page.
   *
   * @param streamId - The stream to query.
   * @param cursor - Opaque pagination cursor from the previous page (omit for first page).
   * @param limit - Maximum number of events per page (default 100).
   * @returns `{ events, cursor, latestLedger }` — typed stream events and pagination state.
   *
   * @example
   * ```ts
   * const page1 = await client.getStreamHistory("42");
   * const page2 = await client.getStreamHistory("42", page1.cursor, 50);
   * ```
   */
  async getStreamHistory(
    streamId: string,
    cursor?: string,
    limit?: number,
  ): Promise<import('./indexer.js').PaginatedEvents> {
    const { StreamIndexer } = await import('./indexer.js');
    const indexer = new StreamIndexer(this.server, this.contract.contractId());
    return indexer.getStreamHistory(streamId, { cursor, limit });
  }

  /**
   * Retrieves paginated transaction history for a specific stream from Horizon API (issue #200).
   *
   * @param streamId - The stream ID to query
   * @param options - Pagination and filtering options
   * @returns Paginated transaction history with cursor support
   *
   * @example
   * ```ts
   * const history = await client.getTransactionHistory("123", { limit: 20 });
   * if (history.hasMore) {
   *   const nextPage = await client.getTransactionHistory("123", {
   *     cursor: history.nextCursor
   *   });
   * }
   * ```
   */
  async getTransactionHistory(
    streamId: string,
    options?: TransactionHistoryOptions,
  ): Promise<TransactionHistoryPage> {
    return getTransactionHistory(streamId, this.network, {
      ...options,
      contractId: this.contract.contractId(),
    });
  }

  /**
   * Retrieves all stream-related transactions for a given address from Horizon API (issue #200).
   *
   * @param address - The Stellar address to query
   * @param options - Pagination and filtering options
   * @returns Paginated activity log with cursor support
   *
   * @example
   * ```ts
   * const activity = await client.getAddressActivity("GUSER...");
   * for (const tx of activity.transactions) {
   *   console.log(`${tx.operationType} at ${tx.createdAt}`);
   * }
   * ```
   */
  async getAddressActivity(
    address: string,
    options?: TransactionHistoryOptions,
  ): Promise<TransactionHistoryPage> {
    return getAddressActivity(address, this.network, {
      ...options,
      contractId: this.contract.contractId(),
    });
  }

  /**
   * Health check method for RPC server connectivity monitoring (issue #308 / #305).
   *
   * @param options - Timeout configuration (default: 5000ms)
   * @returns HealthCheckResult with rpcReachable, latencyMs, and optional error message
   */
  async healthCheck(options?: { timeoutMs?: number }): Promise<HealthCheckResult> {
    const start = Date.now();
    const timeoutMs = options?.timeoutMs ?? 5000;
    try {
      const getHealthPromise = this.server.getHealth();
      let timer: any;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('RPC health check timed out')), timeoutMs);
      });

      const res = await Promise.race([getHealthPromise, timeoutPromise]).finally(() => {
        if (timer) clearTimeout(timer);
      });

      const latencyMs = Date.now() - start;
      if (res && (res as any).status === 'healthy') {
        return { rpcReachable: true, latencyMs };
      } else {
        return { rpcReachable: false, latencyMs, error: (res as any)?.status || 'unhealthy' };
      }
    } catch (err: any) {
      const latencyMs = Date.now() - start;
      return {
        rpcReachable: false,
        latencyMs,
        error: err?.message || String(err),
      };
    }
  }

  /**
   * Exports historical stream activity in JSON or NDJSON format (issue #307).
   * Supports streaming NDJSON line-by-line to a writable stream without buffering full history in memory.
   *
   * @param addressOrId - Stellar address or stream ID to fetch history for
   * @param options - Export options (format, writable stream, limit, startLedger)
   */
  // ── Issue #330: Streaming balance aggregator ─────────────────────────────

  /**
   * Watches the total claimable amount across all streams for a given recipient
   * address. Polls on a configurable interval and emits the new total whenever
   * any stream's claimable amount changes.
   *
   * @param address - The recipient Stellar address to aggregate claimable for.
   * @param options - Optional configuration.
   * @param options.intervalMs - Polling interval in ms (default: 5000).
   * @returns An object with `unsubscribe()` to stop polling and `on(cb)` to
   *   register a callback that receives the total claimable bigint.
   *
   * @example
   * ```ts
   * const watcher = client.watchTotalClaimable("GADDR...");
   * watcher.on((total) => console.log("Total claimable:", total));
   * // later:
   * watcher.unsubscribe();
   * ```
   */
  watchTotalClaimable(
    address: string,
    options?: { intervalMs?: number },
  ): { unsubscribe: () => void; on: (cb: (total: bigint) => void) => void } {
    const intervalMs = options?.intervalMs ?? 5_000;
    const callbacks = new Set<(total: bigint) => void>();
    let lastTotal: bigint | undefined = undefined;
    let handle: ReturnType<typeof setInterval> | null = null;
    let active = true;

    const poll = async () => {
      if (!active) return;
      try {
        const result = await this.getStreamsByRecipient(address);
        const streams = Array.isArray(result) ? result : result.streams;

        if (streams.length === 0) {
          const newTotal = 0n;
          if (lastTotal !== newTotal) {
            lastTotal = newTotal;
            for (const cb of callbacks) cb(newTotal);
          }
          return;
        }

        const amounts = await Promise.all(
          streams.map((s) => this.getClaimable(s.id).catch(() => 0n)),
        );
        const newTotal = amounts.reduce((sum, a) => sum + a, 0n);
        if (lastTotal !== newTotal) {
          lastTotal = newTotal;
          for (const cb of callbacks) cb(newTotal);
        }
      } catch {
        // Transient RPC errors — silent, next poll will retry
      }
    };

    // Kick off immediately then schedule repeating polls
    void poll();
    handle = setInterval(() => {
      void poll();
    }, intervalMs);
    (handle as { unref?: () => void }).unref?.();

    const unsubscribe = () => {
      active = false;
      if (handle !== null) {
        clearInterval(handle);
        handle = null;
      }
      callbacks.clear();
      this.ownedTimers.extraStops.delete(unsubscribe);
    };
    this.ownedTimers.extraStops.add(unsubscribe);

    return {
      unsubscribe,
      on: (cb: (total: bigint) => void) => {
        callbacks.add(cb);
        // Emit the last known total immediately if available
        if (lastTotal !== undefined) cb(lastTotal);
      },
    };
  }

  // ── Issue #333: Fee estimation cache ─────────────────────────────────────

  /** Cache for fee estimation results. Key = operation type string. */
  private feeEstimationCache: Cache<string, FeeEstimate> | null = null;
  private feeEstimationCacheTtlMs: number = 30_000;

  /**
   * Estimates the fee for the given operation type, with caching.
   * The cache key is the operation type name (not specific parameter values).
   * Cache is invalidated after `feeEstimationCacheTtlMs` ms or on network change.
   *
   * @param operationType - A string key identifying the operation type (e.g. "createStream").
   * @param buildOperation - Factory that returns the XDR operation to simulate.
   * @returns `{ totalFee, minResourceFee }` in stroops.
   */
  private async estimateFeeWithCache(
    operationType: string,
    buildOperation: () => Promise<xdr.Operation>,
  ): Promise<FeeEstimate> {
    const ttl = this.feeEstimationCacheTtlMs;
    if (ttl === 0) {
      // Caching disabled — always call through
      return this.estimateOperationFee(await buildOperation());
    }
    if (!this.feeEstimationCache) {
      this.feeEstimationCache = new Cache<string, FeeEstimate>(ttl);
    }
    const cached = this.feeEstimationCache.get(operationType);
    if (cached) return cached;

    const result = await this.estimateOperationFee(await buildOperation());
    this.feeEstimationCache.set(operationType, result, ttl);
    return result;
  }

  // ── Issue #335: Batch builder factory ─────────────────────────────────────

  /**
   * Returns a new {@link BatchBuilder} for constructing and submitting
   * multi-stream atomic operations in a single transaction.
   *
   * @example
   * ```ts
   * const { txHash, results } = await client.batch()
   *   .createStream({ recipient, token, amount, durationSeconds, autoRenew: false })
   *   .withdraw("stream-1")
   *   .cancelStream("stream-2")
   *   .submit();
   * ```
   */
  batch(): BatchBuilder {
    return new BatchBuilder(this as unknown as SoroStreamClient);
  }

  async exportStreamHistory(
    addressOrId: string,
    options?: ExportStreamHistoryOptions,
  ): Promise<StreamActivityEntry[] | void> {
    const format = options?.format ?? 'json';
    const compression = options?.compression;
    const { StreamIndexer } = await import('./indexer.js');
    const indexer = new StreamIndexer(this.server, this.contract.contractId());

    let cursor: string | undefined = undefined;
    const records: StreamActivityEntry[] = [];

    // Build a compressor (gzip / deflate) or null for passthrough (issue #400).
    // zlib is a Node.js built-in; we import dynamically so the SDK can still be
    // bundled for browser environments where zlib is unavailable (it falls back
    // gracefully to no compression in that case).
    let compressor: { write(data: string): void; end(): Promise<void> } | null = null;

    if (
      format === 'ndjson' &&
      options?.writable &&
      compression &&
      compression !== 'none'
    ) {
      try {
        const zlib = await import('zlib');
        const dest = options.writable;

        const zlibStream =
          compression === 'gzip'
            ? zlib.createGzip()
            : zlib.createDeflate();

        // Pipe compressed bytes into the destination writable.
        zlibStream.on('data', (chunk: Buffer) => {
          if (typeof dest.write === 'function') {
            dest.write(chunk);
          } else if (typeof dest.getWriter === 'function') {
            const writer = dest.getWriter();
            writer.write(chunk);
            if (typeof writer.releaseLock === 'function') writer.releaseLock();
          }
        });

        compressor = {
          write(data: string) {
            zlibStream.write(data);
          },
          end(): Promise<void> {
            return new Promise<void>((resolve, reject) => {
              zlibStream.on('finish', () => {
                if (typeof dest.end === 'function') dest.end();
                resolve();
              });
              zlibStream.on('error', reject);
              zlibStream.end();
            });
          },
        };
      } catch {
        // zlib unavailable (browser env) — fall back to no compression.
        compressor = null;
      }
    }

    const serializeLine = (entry: StreamActivityEntry): string =>
      JSON.stringify(entry, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n';

    const writeRecord = (entry: StreamActivityEntry) => {
      if (format === 'ndjson' && options?.writable) {
        if (compressor) {
          // Compression is active — feed the line to the zlib stream.
          compressor.write(serializeLine(entry));
        } else {
          // No compression — write directly to the destination writable.
          const line = serializeLine(entry);
          if (typeof options.writable.write === 'function') {
            options.writable.write(line);
          } else if (typeof options.writable.getWriter === 'function') {
            const writer = options.writable.getWriter();
            const encoder = new TextEncoder();
            writer.write(encoder.encode(line));
            if (typeof writer.releaseLock === 'function') {
              writer.releaseLock();
            }
          }
        }
      } else {
        records.push(entry);
      }
    };

    let hasMore = true;
    while (hasMore) {
      const page = await indexer.getStreamHistory(addressOrId, {
        limit: options?.limit ?? 100,
        startLedger: options?.startLedger,
        cursor,
      });

      for (const e of page.events) {
        let amount = 0n;
        if (e.type === 'StreamWithdrawn') {
          amount = e.data.amount;
        } else if (e.type === 'StreamCreated') {
          amount = e.data.deposit;
        }
        const entry: StreamActivityEntry = {
          type: e.type as StreamActivityEntry['type'],
          timestamp: new Date(e.ledgerClosedAt).getTime(),
          amount,
          txHash: e.txHash,
          ledger: e.ledger,
        };
        writeRecord(entry);
      }

      if (page.cursor && page.cursor !== cursor && page.events.length > 0) {
        cursor = page.cursor;
      } else {
        hasMore = false;
      }
    }

    // Flush and close the compressor if one was created.
    if (compressor) {
      await compressor.end();
      return;
    }

    if (format === 'json') {
      return records;
    }
  }

  /**
   * Adds a delegate to the caller's account on the contract.
   *
   * @param delegate - The address to authorize as a delegate.
   * @param options - Optional write parameters (memo, feeBump, signal).
   * @returns Object containing the confirming transaction hash.
   */
  async addDelegate(delegate: string, options?: WriteOptions): Promise<{ txHash: string }> {
    return this.runWithMiddleware('addDelegate', [delegate], async () => {
      validateStringLength('delegate', delegate);
      if (!isValidStellarAddress(delegate)) {
        throw new InvalidAddressError(delegate);
      }
      const sender = await this.requireWalletAdapter().getPublicKey();
      const operation = this.encoder.addDelegate(sender, delegate);
      const feeBump = this.resolveFeeBump(options?.feeBump);
      const { txHash } = await this.buildAndSubmit(
        operation,
        options?.signal,
        feeBump,
        'addDelegate',
        options?.memo,
      );
      return { txHash };
    });
  }

  /**
   * Queries delegates authorized for a delegator address.
   *
   * @param delegator - The delegator address to query. Defaults to the connected wallet public key.
   * @returns Array of authorized delegate addresses.
   */
  async getDelegates(delegator?: string): Promise<string[]> {
    return this.runWithMiddleware('getDelegates', [delegator], async () => {
      const target =
        delegator ?? (this.walletAdapter ? await this.walletAdapter.getPublicKey() : undefined);
      if (!target) {
        throw new Error('Delegator address required when no wallet adapter is present');
      }
      validateStringLength('delegator', target);
      if (!isValidStellarAddress(target)) {
        throw new InvalidAddressError(target);
      }
      const operation = this.contract.call(
        'get_delegates',
        nativeToScVal(target, { type: 'address' }),
      );
      const result = await this.simulateOp(operation);
      if (rpc.Api.isSimulationSuccess(result) && result.result) {
        const delegates = scValToNative(result.result.retval) as string[];
        return Array.isArray(delegates) ? delegates : [];
      }
      return [];
    });
  }

  /**
   * Revokes a delegate from the caller's account on the contract.
   *
   * @param delegate - The address to revoke delegation from.
   * @param options - Optional write parameters (memo, feeBump, signal).
   * @returns Object containing the confirming transaction hash.
   */
  async revokeDelegate(delegate: string, options?: WriteOptions): Promise<{ txHash: string }> {
    return this.runWithMiddleware('revokeDelegate', [delegate], async () => {
      validateStringLength('delegate', delegate);
      if (!isValidStellarAddress(delegate)) {
        throw new InvalidAddressError(delegate);
      }
      const sender = await this.requireWalletAdapter().getPublicKey();
      const operation = this.encoder.revokeDelegate(sender, delegate);
      const feeBump = this.resolveFeeBump(options?.feeBump);
      const { txHash } = await this.buildAndSubmit(
        operation,
        options?.signal,
        feeBump,
        'revokeDelegate',
        options?.memo,
      );
      return { txHash };
    });
  }

  // ── Issue #329: Stream-scoped delegation API ─────────────────────────────

  /**
   * Grants a delegate address permission to call `withdraw` on a specific
   * stream on behalf of the stream sender.
   *
   * Unlike {@link addDelegate} (account-level delegation), this method is
   * scoped to a single stream identified by `streamId`.
   *
   * Issue #329.
   *
   * @param streamId - The ID of the stream to grant delegation on.
   * @param delegate - The address to authorize as a delegate for this stream.
   * @param options - Optional write parameters (memo, feeBump, signal).
   * @returns Object containing the confirming transaction hash.
   * @throws {StreamNotFoundError} If the stream does not exist.
   * @throws {InvalidAddressError} If `delegate` is not a valid Stellar address.
   */
  async grantDelegate(
    streamId: string,
    delegate: string,
    options?: WriteOptions,
  ): Promise<{ txHash: string }> {
    return this.runWithMiddleware('grantDelegate', [streamId, delegate], async () => {
      validateStringLength('streamId', streamId);
      validateStringLength('delegate', delegate);
      if (!isValidStellarAddress(delegate)) {
        throw new InvalidAddressError(delegate);
      }
      const sender = await this.requireWalletAdapter().getPublicKey();
      const operation = this.contract.call(
        'grant_stream_delegate',
        nativeToScVal(sender, { type: 'address' }),
        nativeToScVal(streamId, { type: 'string' }),
        nativeToScVal(delegate, { type: 'address' }),
      );
      const feeBump = this.resolveFeeBump(options?.feeBump);
      const { txHash } = await this.buildAndSubmit(
        operation,
        options?.signal,
        feeBump,
        'grantDelegate',
        options?.memo,
      );
      return { txHash };
    });
  }

  /**
   * Revokes a previously granted stream-level delegation.
   *
   * Removes the `delegate` address from the list of addresses authorised to
   * call `withdraw` on `streamId` on behalf of the stream sender.
   *
   * Issue #329.
   *
   * @param streamId - The ID of the stream to revoke delegation from.
   * @param delegate - The address to remove from the stream's delegate list.
   * @param options - Optional write parameters (memo, feeBump, signal).
   * @returns Object containing the confirming transaction hash.
   * @throws {StreamNotFoundError} If the stream does not exist.
   * @throws {InvalidAddressError} If `delegate` is not a valid Stellar address.
   */
  async revokeDelegateFromStream(
    streamId: string,
    delegate: string,
    options?: WriteOptions,
  ): Promise<{ txHash: string }> {
    return this.runWithMiddleware('revokeDelegateFromStream', [streamId, delegate], async () => {
      validateStringLength('streamId', streamId);
      validateStringLength('delegate', delegate);
      if (!isValidStellarAddress(delegate)) {
        throw new InvalidAddressError(delegate);
      }
      const sender = await this.requireWalletAdapter().getPublicKey();
      const operation = this.contract.call(
        'revoke_stream_delegate',
        nativeToScVal(sender, { type: 'address' }),
        nativeToScVal(streamId, { type: 'string' }),
        nativeToScVal(delegate, { type: 'address' }),
      );
      const feeBump = this.resolveFeeBump(options?.feeBump);
      const { txHash } = await this.buildAndSubmit(
        operation,
        options?.signal,
        feeBump,
        'revokeDelegateFromStream',
        options?.memo,
      );
      return { txHash };
    });
  }

  /**
   * Returns all delegates currently authorised for a specific stream.
   *
   * Issue #329.
   *
   * @param streamId - The stream ID to query delegates for.
   * @returns Array of authorized delegate addresses, or an empty array.
   */
  async getStreamDelegates(streamId: string): Promise<string[]> {
    return this.runWithMiddleware('getStreamDelegates', [streamId], async () => {
      validateStringLength('streamId', streamId);
      const operation = this.contract.call(
        'get_stream_delegates',
        nativeToScVal(streamId, { type: 'string' }),
      );
      const result = await this.simulateOp(operation);
      if (rpc.Api.isSimulationSuccess(result) && result.result) {
        const delegates = scValToNative(result.result.retval) as string[];
        return Array.isArray(delegates) ? delegates : [];
      }
      return [];
    });
  }
}

/**
 * Factory function for constructing a {@link SoroStreamClient}. Equivalent to
 * `new SoroStreamClient(options)` — provided so environments without a
 * default `localStorage`/`WebSocket`/`fetch` (e.g. React Native) can supply
 * overrides via `adapters` without reaching for the class constructor.
 *
 * Issue #199.
 *
 * @example
 * ```ts
 * import { createClient } from "@sorostream/sdk";
 * import { reactNativeAdapters } from "@sorostream/sdk-react-native";
 *
 * const client = createClient({
 *   network: "testnet",
 *   contractId: "...",
 *   walletAdapter,
 *   adapters: reactNativeAdapters,
 * });
 * ```
 */
export function createClient<TEventData = Record<string, unknown>>(
  options: SoroStreamClientOptions,
): SoroStreamClient<TEventData> {
  return new SoroStreamClient<TEventData>(options);
}

// Re-export for convenience
export type { StreamFilterCriteria, CreateStreamsParams };
// Fix #156: Use ledger time instead of Date.now() for stream startTime

// Fix #157: batchWithdraw skipped streams with zero claimable
// Now returns skipped: true with reason for zero-balance streams

// Fix #157: batchWithdraw now returns skipped entry for zero claimable streams
