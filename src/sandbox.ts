import type {
  CreateStreamParams,
  Stream,
  StreamBalance,
  WithdrawParams,
  CancelStreamParams,
  StreamEventType,
  StreamEvent,
} from './types.js';

/**
 * Error thrown when a sandbox method is called with no registered scenario
 * and `defaultBehavior` is `"error"`.
 *
 * Issue #332.
 */
export class SandboxUnexpectedCallError extends Error {
  constructor(method: string) {
    super(
      `SoroStreamSandbox: unexpected call to "${method}" — no scenario registered and defaultBehavior is "error". ` +
        `Register a scenario via the ScenarioMap constructor argument.`,
    );
    this.name = 'SandboxUnexpectedCallError';
  }
}

/**
 * Map of operation names to scenario handlers used by {@link SoroStreamSandbox}.
 * Each handler mirrors the real client method's signature.
 *
 * Issue #332.
 */
export type ScenarioMap = {
  createStream?: (params: CreateStreamParams) => Promise<{ streamId: string; txHash: string }>;
  getStream?: (streamId: string) => Promise<Stream>;
  withdraw?: (params: WithdrawParams) => Promise<{ txHash: string; amount: string }>;
  cancelStream?: (params: CancelStreamParams) => Promise<{ txHash: string }>;
  getClaimable?: (streamId: string) => Promise<bigint>;
  getMultipleStreamBalances?: (streamIds: string[]) => Promise<StreamBalance[]>;
  estimateFee?: (params: unknown) => Promise<bigint>;
  getStreamsBySender?: (sender: string) => Promise<Stream[]>;
  getStreamsByRecipient?: (recipient: string) => Promise<Stream[]>;
  topUp?: (params: {
    streamId: string;
    amount: bigint;
  }) => Promise<{ txHash: string; newEndTime: Date }>;
  batchWithdraw?: (
    streamIds: string[],
  ) => Promise<{ successes: string[]; failures: { id: string; error: Error }[] }>;
  batchCancel?: (streamIds: string[]) => Promise<{ txHash: string; streamIds: string[] }[]>;
};

/**
 * Configuration options for {@link SoroStreamSandbox}.
 *
 * Issue #332.
 */
export type SandboxOptions = {
  /**
   * What to do when a method is called with no registered scenario.
   * - `"error"` (default): throws {@link SandboxUnexpectedCallError}.
   * - `"empty"`: returns a sensible empty/null value.
   */
  defaultBehavior?: 'error' | 'empty';
  /**
   * When `true`, event handlers registered via `on()` / `off()` are invoked
   * with synthetic events when write operations succeed (matching the real
   * client's event emission behaviour).
   */
  emitEvents?: boolean;
};

/**
 * A drop-in replacement for {@link SoroStreamClient} for use in unit tests.
 *
 * Instead of making real Soroban RPC calls, `SoroStreamSandbox` dispatches
 * every method call through the provided {@link ScenarioMap}. This lets you
 * unit-test application logic without a live network or contract.
 *
 * Unexpected calls either throw {@link SandboxUnexpectedCallError} or return
 * empty values, depending on the `defaultBehavior` option.
 *
 * Issue #332.
 *
 * @example
 * ```ts
 * const sandbox = new SoroStreamSandbox(
 *   {
 *     createStream: async (params) => ({ streamId: "mock-42", txHash: "0xabc" }),
 *     getClaimable: async (id) => 5_000_000n,
 *   },
 *   { defaultBehavior: "empty", emitEvents: true }
 * );
 *
 * const { streamId } = await sandbox.createStream({
 *   recipient: "GADDR...", token: "USDC...",
 *   amount: 100_000_000n, durationSeconds: 3600, autoRenew: false,
 * });
 * ```
 */
export class SoroStreamSandbox {
  private readonly scenarios: ScenarioMap;
  private readonly defaultBehavior: 'error' | 'empty';
  private readonly emitEvents: boolean;

  private readonly eventHandlers = new Map<string, Set<Function>>();

  constructor(scenarios: ScenarioMap = {}, options?: SandboxOptions) {
    this.scenarios = scenarios;
    this.defaultBehavior = options?.defaultBehavior ?? 'error';
    this.emitEvents = options?.emitEvents ?? false;
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  private unexpected(method: string): never {
    throw new SandboxUnexpectedCallError(method);
  }

  private emitEvent(type: StreamEventType, data: Record<string, unknown>): void {
    if (!this.emitEvents) return;
    const handlers = this.eventHandlers.get(type);
    if (!handlers) return;
    const event: StreamEvent = {
      type,
      streamId: (data['streamId'] as string) ?? '',
      txHash: (data['txHash'] as string) ?? '',
      ledger: 0,
      timestamp: Math.floor(Date.now() / 1000),
      data,
    };
    for (const handler of handlers) {
      handler(event);
    }
  }

  // ── Event interface matching real client ───────────────────────────────────

  /**
   * Registers an event handler. Matches the real client's event interface.
   * @param event - Event type to listen for.
   * @param handler - Callback invoked when the event fires.
   */
  on(event: string, handler: Function): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  /**
   * Removes a previously registered event handler.
   * @param event - Event type.
   * @param handler - The same function reference passed to `on()`.
   */
  off(event: string, handler: Function): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  // ── Main SDK operations ────────────────────────────────────────────────────

  /**
   * Creates a stream using the registered `createStream` scenario.
   */
  async createStream(params: CreateStreamParams): Promise<{ streamId: string; txHash: string }> {
    if (this.scenarios.createStream) {
      const result = await this.scenarios.createStream(params);
      this.emitEvent('StreamCreated', { streamId: result.streamId, txHash: result.txHash });
      return result;
    }
    if (this.defaultBehavior === 'empty') {
      return { streamId: '', txHash: '' };
    }
    this.unexpected('createStream');
  }

  /**
   * Retrieves a stream using the registered `getStream` scenario.
   */
  async getStream(streamId: string): Promise<Stream> {
    if (this.scenarios.getStream) {
      return this.scenarios.getStream(streamId);
    }
    if (this.defaultBehavior === 'empty') {
      return null as unknown as Stream;
    }
    this.unexpected('getStream');
  }

  /**
   * Withdraws from a stream using the registered `withdraw` scenario.
   */
  async withdraw(params: WithdrawParams): Promise<{ txHash: string; amount: string }> {
    if (this.scenarios.withdraw) {
      const result = await this.scenarios.withdraw(params);
      this.emitEvent('StreamWithdrawn', {
        streamId: params.streamId,
        txHash: result.txHash,
        amount: result.amount,
      });
      return result;
    }
    if (this.defaultBehavior === 'empty') {
      return { txHash: '', amount: '0' };
    }
    this.unexpected('withdraw');
  }

  /**
   * Cancels a stream using the registered `cancelStream` scenario.
   */
  async cancelStream(params: CancelStreamParams): Promise<{ txHash: string }> {
    if (this.scenarios.cancelStream) {
      const result = await this.scenarios.cancelStream(params);
      this.emitEvent('StreamCancelled', { streamId: params.streamId, txHash: result.txHash });
      return result;
    }
    if (this.defaultBehavior === 'empty') {
      return { txHash: '' };
    }
    this.unexpected('cancelStream');
  }

  /**
   * Returns the claimable amount for a stream using the registered `getClaimable` scenario.
   */
  async getClaimable(streamId: string): Promise<bigint> {
    if (this.scenarios.getClaimable) {
      return this.scenarios.getClaimable(streamId);
    }
    if (this.defaultBehavior === 'empty') {
      return 0n;
    }
    this.unexpected('getClaimable');
  }

  /**
   * Returns claimable balances for multiple streams using the registered
   * `getMultipleStreamBalances` scenario.
   */
  async getMultipleStreamBalances(streamIds: string[]): Promise<StreamBalance[]> {
    if (this.scenarios.getMultipleStreamBalances) {
      return this.scenarios.getMultipleStreamBalances(streamIds);
    }
    if (this.defaultBehavior === 'empty') {
      return [];
    }
    this.unexpected('getMultipleStreamBalances');
  }

  /**
   * Estimates the fee for an operation using the registered `estimateFee` scenario.
   */
  async estimateFee(params: unknown): Promise<bigint> {
    if (this.scenarios.estimateFee) {
      return this.scenarios.estimateFee(params);
    }
    if (this.defaultBehavior === 'empty') {
      return 0n;
    }
    this.unexpected('estimateFee');
  }

  /**
   * Returns streams by sender using the registered `getStreamsBySender` scenario.
   */
  async getStreamsBySender(sender: string): Promise<Stream[]> {
    if (this.scenarios.getStreamsBySender) {
      return this.scenarios.getStreamsBySender(sender);
    }
    if (this.defaultBehavior === 'empty') {
      return [];
    }
    this.unexpected('getStreamsBySender');
  }

  /**
   * Returns streams by recipient using the registered `getStreamsByRecipient` scenario.
   */
  async getStreamsByRecipient(recipient: string): Promise<Stream[]> {
    if (this.scenarios.getStreamsByRecipient) {
      return this.scenarios.getStreamsByRecipient(recipient);
    }
    if (this.defaultBehavior === 'empty') {
      return [];
    }
    this.unexpected('getStreamsByRecipient');
  }

  /**
   * Tops up a stream using the registered `topUp` scenario.
   */
  async topUp(params: {
    streamId: string;
    amount: bigint;
  }): Promise<{ txHash: string; newEndTime: Date }> {
    if (this.scenarios.topUp) {
      return this.scenarios.topUp(params);
    }
    if (this.defaultBehavior === 'empty') {
      return { txHash: '', newEndTime: new Date() };
    }
    this.unexpected('topUp');
  }

  /**
   * Batch-withdraws from multiple streams using the registered `batchWithdraw` scenario.
   */
  async batchWithdraw(
    streamIds: string[],
  ): Promise<{ successes: string[]; failures: { id: string; error: Error }[] }> {
    if (this.scenarios.batchWithdraw) {
      return this.scenarios.batchWithdraw(streamIds);
    }
    if (this.defaultBehavior === 'empty') {
      return { successes: [], failures: [] };
    }
    this.unexpected('batchWithdraw');
  }

  /**
   * Batch-cancels multiple streams using the registered `batchCancel` scenario.
   */
  async batchCancel(streamIds: string[]): Promise<{ txHash: string; streamIds: string[] }[]> {
    if (this.scenarios.batchCancel) {
      return this.scenarios.batchCancel(streamIds);
    }
    if (this.defaultBehavior === 'empty') {
      return [];
    }
    this.unexpected('batchCancel');
  }
}
