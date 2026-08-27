export { SoroStreamClient } from "./SoroStreamClient.js";
export type {
  SoroStreamClientOptions,
  SoroStreamLifecycleHooks,
  SimulateOnlyResult,
} from "./SoroStreamClient.js";

export { MockSoroStreamClient } from "./mock.js";

export {
  createFreighterAdapter,
  connectWallet,
  createMultisigAdapter,
  createClaimDelegateAdapter,
  createPasskeyAdapter,
} from "./wallet.js";
export type { ClaimDelegateConfig } from "./wallet.js";
export { WebhookForwarder } from "./webhook.js";
export {
  toStroops,
  formatUSDC,
  formatToken,
  toFiatDisplay,
  isValidStellarAddress,
  calculateFlowRate,
  timeUntilStreamEnd,
  claimableNow,
  calculateVestingSchedule,
  watchClaimable,
  watchClaimableWs,
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
} from "./utils.js";
export { templates } from "./templates.js";
export { CircuitBreaker } from "./circuitBreaker.js";
export { withRetry } from "./retry.js";
export type { RetryOptions } from "./retry.js";
export type { CircuitState, CircuitBreakerOptions } from "./circuitBreaker.js";
export { createContractEncoder } from "./contractEncoders.js";
export type { ContractCallEncoder } from "./contractEncoders.js";
export { createSimplePriceFeed } from "./priceFeed.js";
export type { SimplePriceFeedOptions } from "./priceFeed.js";
export {
  SoroStreamError,
  InsufficientAmountError,
  StreamNotFoundError,
  StreamNotActiveError,
  TransactionFailedError,
  InvalidAddressError,
  AccountNotFoundError,
  InsufficientBalanceError,
} from "./errors.js";
export type {
  Stream,
  StreamStatus,
  CreateStreamParams,
  WithdrawParams,
  CancelStreamParams,
  TopUpParams,
  TransferStreamParams,
  PauseStreamParams,
  ResumeStreamParams,
  UpdateFlowRateParams,
  SetOperatorParams,
  OperatorTopUpParams,
  Network,
  WalletAdapter,
  FeeEstimate,
  VestingSchedulePoint,
  VestingScheduleResult,
  WatchClaimableOptions,
  BulkStreamRow,
  BulkCreateOptions,
  BulkCreateBatchResult,
  BulkCreateResult,
  BatchCancelResult,
  BatchWithdrawResult,
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
  PasskeyAdapterConfig,
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
} from "./types.js";
