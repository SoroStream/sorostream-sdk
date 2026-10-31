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
 * A scenario value can be either:
 * - A single handler function (existing behaviour), or
 * - An array of handler functions consumed one per call (sequence mode).
 *   Once the array is exhausted, the sandbox falls back to `defaultBehavior`.
 *
 * Issue #332, extended by #696.
 */
export type ScenarioHandler<T extends (...args: never[]) => Promise<unknown>> = T | T[];

export type ScenarioMap = {
  createStream?: ScenarioHandler<
    (params: CreateStreamParams) => Promise<{ streamId: string; txHash: string }>
  >;
  getStream?: ScenarioHandler<(streamId: string) => Promise<Stream>>;
  withdraw?: ScenarioHandler<
    (params: WithdrawParams) => Promise<{ txHash: string; amount: string }>
  >;
  cancelStream?: ScenarioHandler<(params: CancelStreamParams) => Promise<{ txHash: string }>>;
  getClaimable?: ScenarioHandler<(streamId: string) => Promise<bigint>>;
  getMultipleStreamBalances?: ScenarioHandler<(streamIds: string[]) => Promise<StreamBalance[]>>;
  estimateFee?: ScenarioHandler<(params: unknown) => Promise<bigint>>;
  getStreamsBySender?: ScenarioHandler<(sender: string) => Promise<Stream[]>>;
  getStreamsByRecipient?: ScenarioHandler<(recipient: string) => Promise<Stream[]>>;
  topUp?: ScenarioHandler<
    (params: { streamId: string; amount: bigint }) => Promise<{ txHash: string; newEndTime: Date }>
  >;
  batchWithdraw?: ScenarioHandler<
    (
      streamIds: string[],
    ) => Promise<{ successes: string[]; failures: { id: string; error: Error }[] }>
  >;
  batchCancel?: ScenarioHandler<
    (streamIds: string[]) => Promise<{ txHash: string; streamIds: string[] }[]>
  >;
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

  /**
   * Per-method call counters used to advance through sequence scenarios
   * (arrays of handlers). Keyed by scenario name.
   */
  private readonly sequenceIndex = new Map<string, number>();

  constructor(scenarios: ScenarioMap = {}, options?: SandboxOptions) {
    this.scenarios = scenarios;
    this.defaultBehavior = options?.defaultBehavior ?? 'error';
    this.emitEvents = options?.emitEvents ?? false;
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  private unexpected(method: string): never {
    throw new SandboxUnexpectedCallError(method);
  }

  /**
   * Resolves the next callable handler for `key`.
   *
   * - If the scenario is a single function, it is returned on every call.
   * - If it is an array, each call consumes the next entry. Once exhausted,
   *   `undefined` is returned so the caller can fall through to `defaultBehavior`.
   */
  private nextHandler<T extends (...args: never[]) => Promise<unknown>>(
    key: keyof ScenarioMap,
  ): T | undefined {
    const scenario = this.scenarios[key] as ScenarioHandler<T> | undefined;
    if (!scenario) return undefined;
    if (!Array.isArray(scenario)) return scenario as T;
    const idx = this.sequenceIndex.get(key as string) ?? 0;
    const handler = scenario[idx] as T | undefined;
    this.sequenceIndex.set(key as string, idx + 1);
    return handler;
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

  async createStream(params: CreateStreamParams): Promise<{ streamId: string; txHash: string }> {
    const handler =
      this.nextHandler<(p: CreateStreamParams) => Promise<{ streamId: string; txHash: string }>>(
        'createStream',
      );
    if (handler) {
      const result = await handler(params);
      this.emitEvent('StreamCreated', { streamId: result.streamId, txHash: result.txHash });
      return result;
    }
    if (this.defaultBehavior === 'empty') {
      return { streamId: '', txHash: '' };
    }
    this.unexpected('createStream');
  }

  async getStream(streamId: string): Promise<Stream> {
    const handler = this.nextHandler<(id: string) => Promise<Stream>>('getStream');
    if (handler) return handler(streamId);
    if (this.defaultBehavior === 'empty') return null as unknown as Stream;
    this.unexpected('getStream');
  }

  async withdraw(params: WithdrawParams): Promise<{ txHash: string; amount: string }> {
    const handler =
      this.nextHandler<(p: WithdrawParams) => Promise<{ txHash: string; amount: string }>>(
        'withdraw',
      );
    if (handler) {
      const result = await handler(params);
      this.emitEvent('StreamWithdrawn', {
        streamId: params.streamId,
        txHash: result.txHash,
        amount: result.amount,
      });
      return result;
    }
    if (this.defaultBehavior === 'empty') return { txHash: '', amount: '0' };
    this.unexpected('withdraw');
  }

  async cancelStream(params: CancelStreamParams): Promise<{ txHash: string }> {
    const handler =
      this.nextHandler<(p: CancelStreamParams) => Promise<{ txHash: string }>>('cancelStream');
    if (handler) {
      const result = await handler(params);
      this.emitEvent('StreamCancelled', { streamId: params.streamId, txHash: result.txHash });
      return result;
    }
    if (this.defaultBehavior === 'empty') return { txHash: '' };
    this.unexpected('cancelStream');
  }

  async getClaimable(streamId: string): Promise<bigint> {
    const handler = this.nextHandler<(id: string) => Promise<bigint>>('getClaimable');
    if (handler) return handler(streamId);
    if (this.defaultBehavior === 'empty') return 0n;
    this.unexpected('getClaimable');
  }

  async getMultipleStreamBalances(streamIds: string[]): Promise<StreamBalance[]> {
    const handler = this.nextHandler<(ids: string[]) => Promise<StreamBalance[]>>(
      'getMultipleStreamBalances',
    );
    if (handler) return handler(streamIds);
    if (this.defaultBehavior === 'empty') return [];
    this.unexpected('getMultipleStreamBalances');
  }

  async estimateFee(params: unknown): Promise<bigint> {
    const handler = this.nextHandler<(p: unknown) => Promise<bigint>>('estimateFee');
    if (handler) return handler(params);
    if (this.defaultBehavior === 'empty') return 0n;
    this.unexpected('estimateFee');
  }

  async getStreamsBySender(sender: string): Promise<Stream[]> {
    const handler = this.nextHandler<(s: string) => Promise<Stream[]>>('getStreamsBySender');
    if (handler) return handler(sender);
    if (this.defaultBehavior === 'empty') return [];
    this.unexpected('getStreamsBySender');
  }

  async getStreamsByRecipient(recipient: string): Promise<Stream[]> {
    const handler = this.nextHandler<(r: string) => Promise<Stream[]>>('getStreamsByRecipient');
    if (handler) return handler(recipient);
    if (this.defaultBehavior === 'empty') return [];
    this.unexpected('getStreamsByRecipient');
  }

  async topUp(params: {
    streamId: string;
    amount: bigint;
  }): Promise<{ txHash: string; newEndTime: Date }> {
    const handler =
      this.nextHandler<
        (p: { streamId: string; amount: bigint }) => Promise<{ txHash: string; newEndTime: Date }>
      >('topUp');
    if (handler) return handler(params);
    if (this.defaultBehavior === 'empty') return { txHash: '', newEndTime: new Date() };
    this.unexpected('topUp');
  }

  async batchWithdraw(
    streamIds: string[],
  ): Promise<{ successes: string[]; failures: { id: string; error: Error }[] }> {
    const handler =
      this.nextHandler<
        (
          ids: string[],
        ) => Promise<{ successes: string[]; failures: { id: string; error: Error }[] }>
      >('batchWithdraw');
    if (handler) return handler(streamIds);
    if (this.defaultBehavior === 'empty') return { successes: [], failures: [] };
    this.unexpected('batchWithdraw');
  }

  async batchCancel(streamIds: string[]): Promise<{ txHash: string; streamIds: string[] }[]> {
    const handler =
      this.nextHandler<(ids: string[]) => Promise<{ txHash: string; streamIds: string[] }[]>>(
        'batchCancel',
      );
    if (handler) return handler(streamIds);
    if (this.defaultBehavior === 'empty') return [];
    this.unexpected('batchCancel');
  }
}
