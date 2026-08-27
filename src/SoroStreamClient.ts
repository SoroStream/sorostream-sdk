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
} from "@stellar/stellar-sdk";
import { EventPoller } from "./events.js";
import { isValidStellarAddress } from "./utils.js";
import { createContractEncoder } from "./contractEncoders.js";
import type { ContractCallEncoder } from "./contractEncoders.js";
import { CircuitBreaker } from "./circuitBreaker.js";
import type { CircuitBreakerOptions } from "./circuitBreaker.js";
import {
  TransactionFailedError,
  StreamNotFoundError,
  InsufficientAmountError,
  InvalidAddressError,
  AccountNotFoundError,
} from "./errors.js";
import type {
  BatchCancelResult,
  BatchWithdrawResult,
  BulkCreateOptions,
  BulkCreateResult,
  CancelStreamParams,
  CreateStreamParams,
  FeeEstimate,
  Network,
  PaginatedStreams,
  PaginationParams,
  PriceFeedAdapter,
  SplitStreamParams,
  SplitStreamResult,
  Stream,
  StreamEvent,
  StreamEventFilter,
  StreamEventType,
  StreamSubscription,
  TopUpParams,
  TransferStreamParams,
  PauseStreamParams,
  ResumeStreamParams,
  UpdateFlowRateParams,
  SetOperatorParams,
  OperatorTopUpParams,
  WalletAdapter,
  WithdrawParams,
  WriteOptions,
  StreamFilterCriteria,
  CreateStreamsParams,
  ContractVersion,
  FeeBumpOptions,
} from "./types.js";
import { withRetry, type RetryOptions } from "./retry.js";

const RPC_URLS: Record<Network, string> = {
  mainnet: "https://soroban.stellar.org",
  testnet: "https://soroban-testnet.stellar.org",
  futurenet: "https://rpc-futurenet.stellar.org",
};

const NETWORK_PASSPHRASES: Record<Network, string> = {
  mainnet: Networks.PUBLIC,
  testnet: Networks.TESTNET,
  futurenet: Networks.FUTURENET,
};

/**
 * Lifecycle hook callbacks fired when the client observes stream state
 * transitions via background event polling.
 *
 * Hooks fire for transitions on any stream emitted by the contract — not only
 * operations initiated by this client instance — so filter on
 * {@link StreamEvent.streamId} / `data.sender` / `data.recipient` if needed.
 */
export interface SoroStreamLifecycleHooks {
  /** Fired when a `StreamCreated` contract event is observed. */
  onStreamCreated?(event: StreamEvent): void;
  /** Fired when a `StreamCompleted` contract event is observed. */
  onStreamCompleted?(event: StreamEvent): void;
  /** Fired when a `StreamCancelled` contract event is observed. */
  onStreamCancelled?(event: StreamEvent): void;
}

/** Options for constructing a SoroStreamClient. */
export interface SoroStreamClientOptions {
  /** The Stellar network to connect to. */
  network: Network;
  /** The deployed StreamContract address. */
  contractId: string;
  /** Wallet adapter for signing transactions. */
  walletAdapter: WalletAdapter;
  /** Optional custom RPC URL (overrides default). */
  rpcUrl?: string;
  /** Optional circuit-breaker configuration for RPC calls. */
  circuitBreaker?: CircuitBreakerOptions;
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
   * Optional lifecycle hooks invoked on stream state transitions observed by
   * this client (`onStreamCreated`, `onStreamCompleted`, `onStreamCancelled`).
   * Note: configuring any hook enables background contract-event polling for
   * the lifetime of the client, same as calling {@link subscribeEvents}.
   */
  lifecycleHooks?: SoroStreamLifecycleHooks;
}

/** Maps a raw Soroban contract value to a Stream object. */
function scValToStream(val: xdr.ScVal): Stream {
  const raw = scValToNative(val) as Record<string, unknown>;
  return {
    id: String(raw["id"]),
    sender: String(raw["sender"]),
    recipient: String(raw["recipient"]),
    token: String(raw["token"]),
    deposit: BigInt(raw["deposit"] as number),
    flowRate: BigInt(raw["flow_rate"] as number),
    startTime: Number(raw["start_time"]),
    endTime: Number(raw["end_time"]),
    lastWithdrawTime: Number(raw["last_withdraw_time"]),
    status: raw["status"] as Stream["status"],
    autoRenew: Boolean(raw["auto_renew"]),
    ...(raw["paused_at"] != null ? { pausedAt: Number(raw["paused_at"]) } : {}),
  };
}

export type SimulateOnlyResult = {
  simulated: true;
  result: rpc.Api.SimulateTransactionResponse;
};

/**
 * Main client for interacting with the SoroStream contract.
 *
 * @example
 * ```ts
 * const client = new SoroStreamClient({ network: "testnet", contractId: "...", walletAdapter });
 * const { streamId } = await client.createStream({ recipient, token, amount, durationSeconds, autoRenew });
 * ```
 */
export class SoroStreamClient {
  private readonly server: rpc.Server;
  private readonly breaker: CircuitBreaker | null;
  private readonly contract: Contract;
  private readonly network: Network;
  private readonly walletAdapter: WalletAdapter;
  private readonly txTimeoutMs: number;
  private readonly readRetry: RetryOptions;
  private readonly submitRetry: RetryOptions;
  private readonly encoder: ContractCallEncoder;
  private readonly defaultFeeBump: FeeBumpOptions | null = null;
  private readonly priceFeed: PriceFeedAdapter | null = null;
  private eventPoller: EventPoller | null = null;

  constructor(options: SoroStreamClientOptions) {
    this.network = options.network;
    this.walletAdapter = options.walletAdapter;
    this.contract = new Contract(options.contractId);
    this.server = new rpc.Server(
      options.rpcUrl ?? RPC_URLS[options.network],
      { allowHttp: false }
    );
    this.txTimeoutMs = options.txTimeoutMs ?? 120_000;
    this.breaker = options.circuitBreaker
      ? new CircuitBreaker(options.circuitBreaker)
      : null;
    this.readRetry = options.readRetry ?? {};
    this.submitRetry = options.submitRetry ?? {};
    this.encoder = createContractEncoder(this.contract, options.contractVersion ?? "v1");
    this.defaultFeeBump = options.feeBump ?? null;
    this.priceFeed = options.priceFeed ?? null;

    const hooks = options.lifecycleHooks;
    if (hooks) {
      this.registerLifecycleHook("StreamCreated", hooks.onStreamCreated);
      this.registerLifecycleHook("StreamCompleted", hooks.onStreamCompleted);
      this.registerLifecycleHook("StreamCancelled", hooks.onStreamCancelled);
    }
  }

  private async withBreaker<T>(fn: () => Promise<T>): Promise<T> {
    return this.breaker ? this.breaker.call(fn) : fn();
  }

  private async buildAndSubmit(
    operation: xdr.Operation,
    signal?: AbortSignal,
    feeBumpOpts?: FeeBumpOptions
  ): Promise<string> {
    const publicKey = await this.walletAdapter.getPublicKey();

    const account = await withRetry(
      () => this.withBreaker(() => this.server.getAccount(publicKey)),
      { ...this.submitRetry, signal }
    );

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASES[this.network],
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const preparedTx = await withRetry(
      () => this.withBreaker(() => this.server.prepareTransaction(tx)),
      { ...this.submitRetry, signal }
    );

    const signedXdr = await this.walletAdapter.signTransaction(
      preparedTx.toXDR(),
      this.network
    );

    const result = await withRetry(
      () => this.withBreaker(() =>
        this.server.sendTransaction(
          TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASES[this.network])
        )
      ),
      { ...this.submitRetry, signal }
    );

    if (result.status === "ERROR") {
      throw new TransactionFailedError(JSON.stringify(result.errorResult));
    }

    // Poll for completion with configurable timeout and exponential backoff
    const startTime = Date.now();
    let delay = 500;
    const maxDelay = 10_000;

    let response = await this.server.getTransaction(result.hash);
    while (response.status === "NOT_FOUND") {
      if (signal?.aborted) {
        throw new DOMException("Transaction polling aborted", "AbortError");
      }

      const elapsed = Date.now() - startTime;
      if (elapsed >= this.txTimeoutMs) {
        throw new Error(
          `Transaction confirmation timed out after ${this.txTimeoutMs}ms`
        );
      }

      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, maxDelay);

      response = await this.server.getTransaction(result.hash);
    }

    if (response.status === "FAILED") {
      throw new TransactionFailedError(result.hash);
    }

    return result.hash;
  }

  private resolveFeeBump(override?: FeeBumpOptions): FeeBumpOptions | undefined {
    return override ?? this.defaultFeeBump ?? undefined;
  }

  private async buildAndSubmitBatch(operations: xdr.Operation[]): Promise<string> {
    const publicKey = await this.walletAdapter.getPublicKey();

    const account = await withRetry(
      () => this.server.getAccount(publicKey),
      this.submitRetry
    );

    let builder = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASES[this.network],
    });
    for (const op of operations) {
      builder = builder.addOperation(op);
    }
    const tx = builder.setTimeout(30).build();

    const preparedTx = await withRetry(
      () => this.server.prepareTransaction(tx),
      this.submitRetry
    );

    const signedXdr = await this.walletAdapter.signTransaction(
      preparedTx.toXDR(),
      this.network
    );

    const result = await withRetry(
      () => this.server.sendTransaction(
        TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASES[this.network])
      ),
      this.submitRetry
    );

    if (result.status === "ERROR") {
      throw new TransactionFailedError(JSON.stringify(result.errorResult));
    }

    let response = await this.server.getTransaction(result.hash);
    while (response.status === "NOT_FOUND") {
      await new Promise((r) => setTimeout(r, 1000));
      response = await this.server.getTransaction(result.hash);
    }

    if (response.status === "FAILED") {
      throw new TransactionFailedError(result.hash);
    }

    return result.hash;
  }

  /** Public wrapper for submitting a batch of operations in a single transaction. */
  async executeBatch(operations: xdr.Operation[]): Promise<string> {
    return this.buildAndSubmitBatch(operations);
  }

  private async simulateOp(
    operation: xdr.Operation
  ): Promise<rpc.Api.SimulateTransactionResponse> {
    const publicKey = await this.walletAdapter.getPublicKey();
    const account = await this.withBreaker(() =>
      this.server.getAccount(publicKey)
    );
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASES[this.network],
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();
    return this.withBreaker(() => this.server.simulateTransaction(tx));
  }

  // ── Pre-flight validation (Issue 2) ───────────────────────────────────────

  private async validateStreamParams(
    params: CreateStreamParams
  ): Promise<void> {
    if (!isValidStellarAddress(params.recipient)) {
      throw new InvalidAddressError(params.recipient);
    }
    if (!isValidStellarAddress(params.token)) {
      throw new InvalidAddressError(params.token);
    }

    try {
      await this.withBreaker(() =>
        this.server.getAccount(params.recipient)
      );
    } catch {
      throw new AccountNotFoundError(params.recipient);
    }

    const sender = await this.walletAdapter.getPublicKey();
    try {
      await this.withBreaker(() => this.server.getAccount(sender));
    } catch {
      throw new AccountNotFoundError(sender);
    }
  }

  // ── Stream mutations ──────────────────────────────────────────────────────

  /**
   * Creates a new payment stream.
   * @param params - Stream creation parameters.
   * @param signal - Optional AbortSignal to cancel transaction polling.
   * @returns The new stream ID and transaction hash.
   * @param signal - Optional abort signal.
   * @param options - Optional write options.
   * @returns The new stream ID and transaction hash, or simulation result.
   */
  async createStream(
    params: CreateStreamParams,
    signal?: AbortSignal,
    options?: WriteOptions
  ): Promise<{ streamId: string; txHash: string }> {
    if (params.amount <= 0n) throw new InsufficientAmountError();
    if (params.durationSeconds <= 0)
      throw new InsufficientAmountError("Duration must be > 0");

    await this.validateStreamParams(params);

    const sender = await this.walletAdapter.getPublicKey();
    const operation = this.encoder.createStream(sender, params);
    const feeBump = this.resolveFeeBump(options?.feeBump);
    const txHash = await this.buildAndSubmit(operation, signal, feeBump);

    const result = await this.getStreamsBySender(sender);
    const streams = Array.isArray(result) ? result : result.streams;
    const latest = streams[streams.length - 1];
    if (!latest)
      throw new StreamNotFoundError(
        "(unknown — post-creation fetch returned empty)"
      );

    return { streamId: latest.id, txHash };
  }

  /**
   * Creates multiple payment streams in a single transaction.
   * @param paramsArray - Array of stream creation parameters.
   * @param options - Optional write options (e.g. simulateOnly).
   * @returns Array of stream IDs and the transaction hash, or simulation result.
   */
  async createStreams(
    paramsArray: CreateStreamsParams[],
    options?: WriteOptions
  ): Promise<
    { streamIds: string[]; txHash: string } | SimulateOnlyResult
  > {
    if (paramsArray.length === 0) throw new Error("At least one stream is required");
    for (const params of paramsArray) {
      if (params.amount <= 0n) throw new Error("Amount must be > 0");
      if (params.durationSeconds <= 0) throw new Error("Duration must be > 0");
    }

    const sender = await this.walletAdapter.getPublicKey();

    const operations = paramsArray.map((params) =>
      this.encoder.createStream(sender, params)
    );

    if (options?.simulateOnly) {
      const result = await this.simulateOp(operations[0]!);
      return { simulated: true, result };
    }

    const txHash = await this.buildAndSubmitBatch(operations);
    const after = await this.getStreamsBySender(sender);
    const afterStreams = Array.isArray(after) ? after : after.streams;
    const streamIds = afterStreams.slice(-paramsArray.length).map((s) => s.id);

    return { streamIds, txHash };
  }

  /**
   * Withdraws all currently claimable tokens from a stream.
   * @param params - Withdraw parameters.
   * @param signal - Optional AbortSignal to cancel transaction polling.
   * @returns The transaction hash and withdrawn amount.
   * @param signal - Optional abort signal.
   * @param options - Optional write options.
   * @returns The transaction hash and withdrawn amount, or simulation result.
   */
  async withdraw(
    params: WithdrawParams,
    signal?: AbortSignal,
    options?: WriteOptions
  ): Promise<{ txHash: string; amount: string }> {
    const recipient = await this.walletAdapter.getPublicKey();
    const claimable = await this.getClaimable(params.streamId);

    const operation = this.encoder.withdraw(params.streamId, recipient);
    const feeBump = this.resolveFeeBump(options?.feeBump);
    const txHash = await this.buildAndSubmit(operation, signal, feeBump);
    return { txHash, amount: claimable.toString() };
  }

  /**
   * Withdraws from multiple streams in a single transaction.
   * Streams are grouped into batches to stay within Stellar's per-transaction
   * operation limit. Each batch becomes one submitted transaction.
   *
   * @param streamIds - Array of stream IDs to withdraw from.
   * @param batchSize - Max operations per transaction (default 8).
   * @returns Array of batch results, one per transaction.
   */
  async batchWithdraw(
    streamIds: string[],
    batchSize = 8
  ): Promise<BatchWithdrawResult[]> {
    const results: BatchWithdrawResult[] = [];
    const recipient = await this.walletAdapter.getPublicKey();

    for (let i = 0; i < streamIds.length; i += batchSize) {
      const chunk = streamIds.slice(i, i + batchSize);
      const operations = chunk.map((id) =>
        this.encoder.withdraw(id, recipient)
      );

      const amounts: string[] = [];
      for (const id of chunk) {
        const claimable = await this.getClaimable(id);
        amounts.push(claimable.toString());
      }

      const txHash = await this.executeBatch(operations);
      results.push({ txHash, streamIds: chunk, amounts });
    }

    return results;
  }

  /**
   * Cancels an active stream. Refunds unstreamed tokens to sender.
   * @param params - Cancel parameters.
   * @param signal - Optional AbortSignal to cancel transaction polling.
   * @returns The transaction hash.
   * @param signal - Optional abort signal.
   * @param options - Optional write options.
   * @returns The transaction hash, or simulation result.
   */
  async cancelStream(
    params: CancelStreamParams,
    signal?: AbortSignal,
    options?: WriteOptions
  ): Promise<{ txHash: string }> {
    const sender = await this.walletAdapter.getPublicKey();
    const operation = this.encoder.cancelStream(params.streamId, sender);
    const feeBump = this.resolveFeeBump(options?.feeBump);
    const txHash = await this.buildAndSubmit(operation, signal, feeBump);
    return { txHash };
  }

  /**
   * Tops up an existing stream with additional tokens, extending its duration.
   * @param params - Top-up parameters.
   * @param signal - Optional AbortSignal to cancel transaction polling.
   * @returns The transaction hash and new end time.
   * @param signal - Optional abort signal.
   * @param options - Optional write options.
   * @returns The transaction hash and new end time, or simulation result.
   */
  async topUp(
    params: TopUpParams,
    signal?: AbortSignal,
    options?: WriteOptions
  ): Promise<{ txHash: string; newEndTime: Date }> {
    if (params.amount <= 0n) throw new InsufficientAmountError();
    const sender = await this.walletAdapter.getPublicKey();
    const operation = this.encoder.topUp(
      params.streamId,
      sender,
      params.amount
    );
    const feeBump = this.resolveFeeBump(options?.feeBump);
    const txHash = await this.buildAndSubmit(operation, signal, feeBump);
    const stream = await this.getStream(params.streamId);
    return { txHash, newEndTime: new Date(stream.endTime * 1000) };
  }

  /**
   * Cancels multiple streams in batches.
   */
  async batchCancel(
    streamIds: string[],
    batchSize = 8
  ): Promise<BatchCancelResult[]> {
    const results: BatchCancelResult[] = [];
    const sender = await this.walletAdapter.getPublicKey();

    for (let i = 0; i < streamIds.length; i += batchSize) {
      const chunk = streamIds.slice(i, i + batchSize);
      const operations = chunk.map((id) =>
        this.encoder.cancelStream(id, sender)
      );
      const txHash = await this.executeBatch(operations);
      results.push({ txHash, streamIds: chunk });
    }

    return results;
  }

  /**
   * Updates the flow rate on an active stream without cancelling it.
   */
  async updateFlowRate(
    params: UpdateFlowRateParams,
    signal?: AbortSignal,
    options?: WriteOptions
  ): Promise<{ txHash: string }> {
    if (params.newFlowRate <= 0n) throw new InsufficientAmountError();
    const sender = await this.walletAdapter.getPublicKey();
    const operation = this.encoder.updateFlowRate(params.streamId, sender, params.newFlowRate);
    const feeBump = this.resolveFeeBump(options?.feeBump);
    const txHash = await this.buildAndSubmit(operation, signal, feeBump);
    return { txHash };
  }

  /**
   * Authorises or revokes an operator address for a stream.
   */
  async setOperator(
    params: SetOperatorParams,
    signal?: AbortSignal,
    options?: WriteOptions
  ): Promise<{ txHash: string }> {
    const sender = await this.walletAdapter.getPublicKey();
    const operation = this.encoder.setOperator(
      params.streamId,
      sender,
      params.operator,
      params.approved
    );
    const feeBump = this.resolveFeeBump(options?.feeBump);
    const txHash = await this.buildAndSubmit(operation, signal, feeBump);
    return { txHash };
  }

  /**
   * Cancels a stream as an authorised operator.
   */
  async operatorCancelStream(
    params: { streamId: string },
    signal?: AbortSignal,
    options?: WriteOptions
  ): Promise<{ txHash: string }> {
    const operator = await this.walletAdapter.getPublicKey();
    const operation = this.encoder.operatorCancelStream(params.streamId, operator);
    const feeBump = this.resolveFeeBump(options?.feeBump);
    const txHash = await this.buildAndSubmit(operation, signal, feeBump);
    return { txHash };
  }

  /**
   * Tops up a stream as an authorised operator.
   */
  async operatorTopUp(
    params: OperatorTopUpParams,
    signal?: AbortSignal,
    options?: WriteOptions
  ): Promise<{ txHash: string }> {
    if (params.amount <= 0n) throw new InsufficientAmountError();
    const operator = await this.walletAdapter.getPublicKey();
    const operation = this.encoder.operatorTopUp(params.streamId, operator, params.amount);
    const feeBump = this.resolveFeeBump(options?.feeBump);
    const txHash = await this.buildAndSubmit(operation, signal, feeBump);
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
   * @param signal - Optional AbortSignal to cancel transaction polling.
   * @param options - Optional write options.
   * @returns The transaction hash and the two new stream IDs.
   */
  async splitStream(
    params: SplitStreamParams,
    signal?: AbortSignal,
    options?: WriteOptions
  ): Promise<SplitStreamResult> {
    if (params.ratioNumerator <= 0 || params.ratioDenominator <= 0) {
      throw new Error("Ratio must be positive");
    }
    if (params.ratioNumerator >= params.ratioDenominator) {
      throw new Error("Ratio numerator must be less than denominator");
    }

    const sender = await this.walletAdapter.getPublicKey();

    if (!isValidStellarAddress(params.recipientA)) {
      throw new InvalidAddressError(params.recipientA);
    }
    if (!isValidStellarAddress(params.recipientB)) {
      throw new InvalidAddressError(params.recipientB);
    }

    const operation = this.encoder.splitStream(sender, params);
    const feeBump = this.resolveFeeBump(options?.feeBump);
    const txHash = await this.buildAndSubmit(operation, signal, feeBump);

    const result = await this.getStreamsBySender(sender);
    const streams = Array.isArray(result) ? result : result.streams;
    const latest = streams.slice(-2);
    const streamIdA = latest[0]?.id ?? "";
    const streamIdB = latest[1]?.id ?? "";

    return { txHash, streamIdA, streamIdB };
  }

  /**
   * Transfers ownership of a stream to a new recipient address mid-flight.
   * Only the sender can transfer ownership.
   */
  async transferStream(
    params: TransferStreamParams,
    signal?: AbortSignal,
    options?: WriteOptions
  ): Promise<{ txHash: string }> {
    if (!isValidStellarAddress(params.newRecipient)) {
      throw new InvalidAddressError(params.newRecipient);
    }
    const sender = await this.walletAdapter.getPublicKey();
    const operation = this.encoder.transferStream(
      params.streamId,
      sender,
      params.newRecipient
    );
    const feeBump = this.resolveFeeBump(options?.feeBump);
    const txHash = await this.buildAndSubmit(operation, signal, feeBump);
    return { txHash };
  }

  /**
   * Pauses an active stream. While paused, no new claimable tokens accumulate.
   */
  async pause(
    params: PauseStreamParams,
    signal?: AbortSignal,
    options?: WriteOptions
  ): Promise<{ txHash: string }> {
    const sender = await this.walletAdapter.getPublicKey();
    const operation = this.encoder.pauseStream(params.streamId, sender);
    const feeBump = this.resolveFeeBump(options?.feeBump);
    const txHash = await this.buildAndSubmit(operation, signal, feeBump);
    return { txHash };
  }

  /**
   * Resumes a previously paused stream. Claimable tokens will again accumulate.
   */
  async resume(
    params: ResumeStreamParams,
    signal?: AbortSignal,
    options?: WriteOptions
  ): Promise<{ txHash: string }> {
    const sender = await this.walletAdapter.getPublicKey();
    const operation = this.encoder.resumeStream(params.streamId, sender);
    const feeBump = this.resolveFeeBump(options?.feeBump);
    const txHash = await this.buildAndSubmit(operation, signal, feeBump);
    return { txHash };
  }

  // ── Fee estimation ────────────────────────────────────────────────────────

  private async estimateOperationFee(
    operation: xdr.Operation
  ): Promise<FeeEstimate> {
    const publicKey = await this.walletAdapter.getPublicKey();
    const account = await this.withBreaker(() =>
      this.server.getAccount(publicKey)
    );

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASES[this.network],
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const preparedTx = await this.withBreaker(() =>
      this.server.prepareTransaction(tx)
    );

    const minResourceFee =
      (
        preparedTx as unknown as { minResourceFee?: number }
      ).minResourceFee ?? 0;

    return {
      totalFee: Number(preparedTx.fee) + minResourceFee,
      minResourceFee,
    };
  }

  async estimateCreateStreamFee(
    params: CreateStreamParams
  ): Promise<FeeEstimate> {
    if (params.amount <= 0n) throw new Error("Amount must be > 0");
    if (params.durationSeconds <= 0) throw new Error("Duration must be > 0");

    const sender = await this.walletAdapter.getPublicKey();
    const operation = this.encoder.createStream(sender, params);
    return this.estimateOperationFee(operation);
  }

  async estimateWithdrawFee(params: WithdrawParams): Promise<FeeEstimate> {
    const recipient = await this.walletAdapter.getPublicKey();
    const operation = this.encoder.withdraw(params.streamId, recipient);
    return this.estimateOperationFee(operation);
  }

  async estimateCancelStreamFee(
    params: CancelStreamParams
  ): Promise<FeeEstimate> {
    const sender = await this.walletAdapter.getPublicKey();
    const operation = this.encoder.cancelStream(params.streamId, sender);
    return this.estimateOperationFee(operation);
  }

  async estimateTopUpFee(params: TopUpParams): Promise<FeeEstimate> {
    if (params.amount <= 0n) throw new Error("Amount must be > 0");
    const sender = await this.walletAdapter.getPublicKey();
    const operation = this.encoder.topUp(
      params.streamId,
      sender,
      params.amount
    );
    return this.estimateOperationFee(operation);
  }

  // ── Event subscription ───────────────────────────────────────────────────────

  private getEventPoller(): EventPoller {
    if (!this.eventPoller) {
      this.eventPoller = new EventPoller(
        this.server,
        this.contract.contractId()
      );
    }
    return this.eventPoller;
  }

  private registerLifecycleHook(
    eventType: StreamEventType,
    callback?: (event: StreamEvent) => void
  ): void {
    if (!callback) return;
    this.getEventPoller().subscribe(`hooks:${eventType}`, {
      filter: (event) => event.type === eventType,
      callback,
    });
  }

  /**
   * Subscribes to real-time stream lifecycle events matching the given filter.
   * The callback is invoked each time a matching event is detected.
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
    callback: (event: StreamEvent) => void
  ): StreamSubscription {
    const poller = this.getEventPoller();
    const key = `${filter.streamId ?? "*"}:${filter.sender ?? "*"}:${filter.recipient ?? "*"}:${Date.now()}`;

    return poller.subscribe(key, {
      filter: (event) => {
        if (filter.streamId && event.streamId !== filter.streamId) return false;
        if (filter.sender && event.data.sender !== filter.sender) return false;
        if (filter.recipient && event.data.recipient !== filter.recipient)
          return false;
        return true;
      },
      callback,
    });
  }

  /**
   * Subscribe to a specific stream lifecycle event type.
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
    callback: (event: StreamEvent) => void
  ): StreamSubscription {
    return this.subscribeEvents({}, (event) => {
      if (event.type === eventType) {
        callback(event);
      }
    });
  }

  /**
   * Shorthand for subscribing to stream-created events.
   */
  onStreamCreated(callback: (event: StreamEvent) => void): StreamSubscription {
    return this.on("StreamCreated", callback);
  }

  /**
   * Shorthand for subscribing to stream-withdrawn events.
   */
  onStreamWithdrawn(callback: (event: StreamEvent) => void): StreamSubscription {
    return this.on("StreamWithdrawn", callback);
  }

  /**
   * Shorthand for subscribing to stream-topped-up events.
   */
  onStreamToppedUp(callback: (event: StreamEvent) => void): StreamSubscription {
    return this.on("StreamToppedUp", callback);
  }

  /**
   * Shorthand for subscribing to stream-cancelled events.
   */
  onStreamCancelled(callback: (event: StreamEvent) => void): StreamSubscription {
    return this.on("StreamCancelled", callback);
  }

  /**
   * Shorthand for subscribing to stream-transferred events.
   */
  onStreamTransferred(callback: (event: StreamEvent) => void): StreamSubscription {
    return this.on("StreamTransferred", callback);
  }

  /**
   * Shorthand for subscribing to stream-paused events.
   */
  onStreamPaused(callback: (event: StreamEvent) => void): StreamSubscription {
    return this.on("StreamPaused", callback);
  }

  /**
   * Shorthand for subscribing to stream-resumed events.
   */
  onStreamResumed(callback: (event: StreamEvent) => void): StreamSubscription {
    return this.on("StreamResumed", callback);
  }

  // ── Read methods (with retry) ────────────────────────────────────────────────
  // ── Queries ───────────────────────────────────────────────────────────────

  /**
   * Returns the full stream data for a given stream ID.
   * Automatically retries on transient RPC errors.
   * @param streamId - The stream ID to look up.
   */
  async getStream(streamId: string): Promise<Stream> {
    const result = await withRetry(
      () =>
        this.simulateOp(
          this.contract.call(
            "get_stream",
            nativeToScVal(BigInt(streamId), { type: "u64" })
          )
          .build()
      )
    );

    if (rpc.Api.isSimulationError(result)) {
      throw new StreamNotFoundError(streamId);
    }

    const returnVal = (
      result as rpc.Api.SimulateTransactionSuccessResponse
    ).result?.retval;
    if (!returnVal) throw new Error("No return value from contract");
    return scValToStream(returnVal);
  }

  /**
   * Returns the currently claimable amount in stroops for a stream.
   *
   * Distinguishes "stream not found" (returns `0n`) from transient RPC errors
   * (retried automatically, then thrown). A contract-level simulation error
   * indicates the stream does not exist; network failures are retried.
   *
   * @param streamId - The stream ID to check.
   */
  async getClaimable(streamId: string): Promise<bigint> {
    const result = await withRetry(
      () =>
        this.simulateOp(
          this.contract.call(
            "get_claimable",
            nativeToScVal(BigInt(streamId), { type: "u64" })
          )
        ),
      this.readRetry
    );

    if (rpc.Api.isSimulationError(result)) return 0n;

    const returnVal = (result as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (!returnVal) return 0n;
    return BigInt(scValToNative(returnVal) as number);
  }

  /**
   * Returns all streams created by a sender address.
   * When `pagination` is omitted, returns the full result set (backward-compatible).
   * Automatically retries on transient RPC errors.
   *
   * @param sender - The sender address to query.
   * @param pagination - Optional limit/cursor for paginated results.
   */
  async getStreamsBySender(
    sender: string,
    pagination?: PaginationParams
  ): Promise<Stream[] | PaginatedStreams> {
    const args: xdr.ScVal[] = [nativeToScVal(sender, { type: "address" })];

    if (pagination) {
      args.push(nativeToScVal(pagination.limit ?? 20, { type: "u32" }));
      args.push(
        pagination.cursor != null
          ? nativeToScVal(BigInt(pagination.cursor), { type: "u64" })
          : xdr.ScVal.scvVoid()
      );
    }

    const result = await withRetry(
      () => this.simulateOp(this.contract.call("get_streams_by_sender", ...args)),
      this.readRetry
    );

    if (rpc.Api.isSimulationError(result)) {
      return pagination
        ? { streams: [], cursor: null, hasMore: false }
        : [];
    }

    const returnVal = (
      result as rpc.Api.SimulateTransactionSuccessResponse
    ).result?.retval;
    if (!returnVal) {
      return pagination
        ? { streams: [], cursor: null, hasMore: false }
        : [];
    }

    const raw = scValToNative(returnVal) as xdr.ScVal[];
    const streams = raw.map(scValToStream);

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
   * Returns all streams targeting a recipient address.
   * When `pagination` is omitted, returns the full result set (backward-compatible).
   * Automatically retries on transient RPC errors.
   *
   * @param recipient - The recipient address to query.
   * @param pagination - Optional limit/cursor for paginated results.
   */
  async getStreamsByRecipient(
    recipient: string,
    pagination?: PaginationParams
  ): Promise<Stream[] | PaginatedStreams> {
    const args: xdr.ScVal[] = [
      nativeToScVal(recipient, { type: "address" }),
    ];

    if (pagination) {
      args.push(nativeToScVal(pagination.limit ?? 20, { type: "u32" }));
      args.push(
        pagination.cursor != null
          ? nativeToScVal(BigInt(pagination.cursor), { type: "u64" })
          : xdr.ScVal.scvVoid()
      );
    }

    const result = await withRetry(
      () => this.simulateOp(this.contract.call("get_streams_by_recipient", ...args)),
      this.readRetry
    );

    if (rpc.Api.isSimulationError(result)) {
      return pagination
        ? { streams: [], cursor: null, hasMore: false }
        : [];
    }

    const returnVal = (
      result as rpc.Api.SimulateTransactionSuccessResponse
    ).result?.retval;
    if (!returnVal) {
      return pagination
        ? { streams: [], cursor: null, hasMore: false }
        : [];
    }

    const raw = scValToNative(returnVal) as xdr.ScVal[];
    const streams = raw.map(scValToStream);

    if (!pagination) return streams;

    const limit = pagination.limit ?? 20;
    const last = streams[streams.length - 1];
    return {
      streams,
      cursor: last ? last.id : null,
      hasMore: streams.length >= limit,
    };
  }

  // ── Bulk operations ───────────────────────────────────────────────────────

  async bulkCreateStreams(
    rows: import("./types.js").BulkStreamRow[],
    options: BulkCreateOptions
  ): Promise<BulkCreateResult> {
    const sender = await this.walletAdapter.getPublicKey();
    const defaultToken = options.token;
    const autoRenew = options.autoRenew ?? false;
    const batchSize = options.batchSize ?? 8;

    const results: BulkCreateResult["batches"] = [];

    for (let i = 0; i < rows.length; i += batchSize) {
      const chunk = rows.slice(i, i + batchSize);
      const chunkHasMixedTokens = chunk.some(
        (r) => r.token != null && r.token !== defaultToken
      );

      if (chunkHasMixedTokens) {
        // When rows have different tokens, submit each as a separate transaction
        for (const row of chunk) {
          const rowToken = row.token ?? defaultToken;
          const operation = this.encoder.createStream(sender, {
            recipient: row.recipient,
            token: rowToken,
            amount: row.amount,
            durationSeconds: row.durationSeconds,
            autoRenew,
          });
          const txHash = await this.buildAndSubmit(operation);

          const result = await this.getStreamsBySender(sender);
          const streams = Array.isArray(result) ? result : result.streams;
          const newStreams = streams.slice(-1);
          const streamIds = newStreams.map((s) => s.id);

          results.push({ txHash, streamIds, rows: [row] });
        }
      } else {
        // All rows in this chunk use the same token — batch into one transaction
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
      }
    }

    return { batches: results };
  }

  // ── Utility ───────────────────────────────────────────────────────────────

  getCircuitBreaker(): CircuitBreaker | null {
    return this.breaker;
  }

  getPriceFeed(): PriceFeedAdapter | null {
    return this.priceFeed;
  }
}

// Re-export for convenience
export type { StreamFilterCriteria, CreateStreamsParams };
