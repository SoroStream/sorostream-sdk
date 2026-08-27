/**
 * Lightweight entry point for consumers who only need the client, streaming
 * math, and error types — no wallet adapters (Freighter, Ledger, passkey,
 * multisig) or their heavier browser/hardware dependencies.
 *
 * Bundlers that support tree-shaking (Rollup, esbuild, webpack) will exclude
 * `wallet.ts` and its dependencies entirely when only this entry point is
 * imported, since nothing here references it.
 *
 * @example
 * ```ts
 * import { SoroStreamClient } from "@sorostream/sdk/core";
 *
 * const client = new SoroStreamClient({ network: "testnet", contractId: "...", walletAdapter });
 * const claimable = await client.getClaimable(streamId);
 * ```
 */

export { SoroStreamClient } from './SoroStreamClient.js';
export type { SoroStreamClientOptions, SimulateOnlyResult } from './SoroStreamClient.js';

export { MockSoroStreamClient } from './mock.js';

export { WebhookForwarder } from './webhook.js';
export {
  toStroops,
  formatUSDC,
  formatToken,
  toFiatDisplay,
  isValidStellarAddress,
  isFederationAddress,
  resolveFederationAddress,
  calculateFlowRate,
  timeUntilStreamEnd,
  claimableNow,
  calculateVestingSchedule,
  watchClaimable,
  watchClaimableWs,
  watchTotalClaimable,
  aggregateStreamsByToken,
  totalValueStreamed,
  aggregateStreamsByStatus,
  averageStreamDuration,
  streamHealthSummary,
  aggregateStreamsByRecipient,
  parseCsvStreamRows,
  detectStreamDrift,
  watchStreamDrift,
  isStreamExpiring,
  isStreamStalled,
  isStreamUnderfunded,
  isExpired,
  streamToJSON,
  jsonStringifyStream,
  jsonStringify,
  serializeStreamToJSON,
  deserializeStreamFromJSON,
  bigintReplacer,
  bigintReviver,
  validateStringLength,
  STRING_FIELD_LIMITS,
  encodeStreamId,
  decodeStreamId,
} from './utils.js';
export { templates } from './templates.js';
export { CircuitBreaker } from './circuitBreaker.js';
export { withRetry } from './retry.js';
export type { RetryOptions } from './retry.js';
export type { CircuitState, CircuitBreakerOptions } from './circuitBreaker.js';
export { ConnectionPool } from './connectionPool.js';
export type { ConnectionPoolOptions, PoolEvent, PoolEventType } from './connectionPool.js';
export { InMemoryEventBus } from './eventBus.js';
export type { IEventBus, Unsubscribe } from './eventBus.js';
export type { StreamRetryPolicy, EventPollerOptions } from './events.js';
export type { BatchingOptions, BatchMetrics, CompressionOptions } from './types.js';
export { createContractEncoder } from './contractEncoders.js';
export type { ContractCallEncoder } from './contractEncoders.js';
export { createSimplePriceFeed } from './priceFeed.js';
export type { SimplePriceFeedOptions } from './priceFeed.js';
export {
  SoroStreamError,
  InsufficientAmountError,
  StreamNotFoundError,
  StreamNotActiveError,
  TransactionFailedError,
  InvalidAddressError,
  AccountNotFoundError,
  InsufficientBalanceError,
  ZeroDurationError,
  BulkCreatePartialError,
  InsufficientAllowanceError,
  FederationResolutionError,
  SoroStreamValidationError,
  StartTimeInPastError,
  NonceNotSupportedError,
  SoroStreamRetryExhaustedError,
} from './errors.js';
export type { BulkCreateFailedSlot, RetryAttempt } from './errors.js';
export type {
  Stream,
  StreamBalance,
  StreamStatus,
  CreateStreamParams,
  CloneStreamOverrides,
  EventHandler,
  WithdrawParams,
  CancelStreamParams,
  TopUpParams,
  TransferStreamParams,
  PauseStreamParams,
  ResumeStreamParams,
  UpdateFlowRateParams,
  SetOperatorParams,
  OperatorTopUpParams,
  AddDelegateParams,
  RevokeDelegateParams,
  Network,
  WalletAdapter,
  WalletAdapterSignResult,
  FeeEstimate,
  VestingSchedulePoint,
  VestingScheduleResult,
  WatchClaimableOptions,
  WatchTotalClaimableOptions,
  BulkStreamRow,
  BulkCreateOptions,
  BulkCreateBatchResult,
  BulkCreateResult,
  BatchCancelResult,
  BatchWithdrawResult,
  BatchWithdrawPartialResult,
  TokenAggregate,
  MultisigSigner,
  StreamEvent,
  StreamEventType,
  StreamEventFilter,
  StreamSubscription,
  PaginationParams,
  PaginatedStreams,
  WebhookConfig,
  WriteOptions,
  FormatUSDCOptions,
  StreamDrift,
  ReconcileStreamOptions,
  PriceFeedAdapter,
  FeeBumpOptions,
  ContractVersion,
  SplitStreamParams,
  SplitStreamResult,
  StreamTotals,
  StatusBreakdown,
  DurationStats,
  StreamHealthReport,
  RecipientAggregate,
  StreamSnapshot,
  StreamHistoryEntry,
  SnapshotVestingPoint,
  SoroStreamPlugin,
  MiddlewareContext,
  RecipientChangedEvent,
  OnRecipientChangedOptions,
  StreamActivityEntry,
  StreamActivityType,
  GetActivityLogOptions,
  StreamCreatedEventPayload,
  StreamWithdrawnEventPayload,
  StreamCancelledEventPayload,
  RpcErrorEventPayload,
  SoroStreamEventMap,
} from './types.js';
