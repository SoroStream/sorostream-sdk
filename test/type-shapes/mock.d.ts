/**
 * In-memory mock of the SoroStream contract for consumer unit tests.
 *
 * Drop-in replacement for {@link SoroStreamClient} that requires no network
 * access. Mirrors the real contract's flow-rate math and status transitions.
 *
 * @example
 * ```ts
 * import { MockSoroStreamClient } from "@sorostream/sdk/mock";
 *
 * const mock = new MockSoroStreamClient();
 * const { streamId } = await mock.createStream({
 *   recipient: "GRECIPIENT...",
 *   token: "GUSDC...",
 *   amount: 1_000_000_000n,
 *   durationSeconds: 3600,
 *   autoRenew: false,
 * });
 * const claimable = await mock.getClaimable(streamId);
 * ```
 */
import type { BatchCancelResult, CancelStreamParams, CloneStreamOverrides, CreateStreamParams, PaginatedStreams, PaginationParams, SetOperatorParams, SplitStreamParams, SplitStreamResult, Stream, StreamEvent, StreamEventFilter, StreamFilterCriteria, StreamSnapshot, StreamSubscription, SoroStreamPlugin, TopUpParams, TransferStreamParams, PauseStreamParams, ResumeStreamParams, UpdateFlowRateParams, OperatorTopUpParams, WithdrawParams, WriteOptions } from './types.js';
export declare class MockSoroStreamClient {
    private streams;
    private listeners;
    private senderKey;
    constructor(senderKey?: string);
    /** Override the mock's current "sender" address (simulates wallet.getPublicKey). */
    setSender(address: string): void;
    /** Directly inject a pre-built stream — useful for testing edge cases. */
    seedStream(stream: Stream): void;
    /** Simulate `seconds` of time passing on a stream by shifting its timestamps backward. */
    advanceTime(streamId: string, seconds: number): void;
    private emit;
    createStream(params: CreateStreamParams, _signal?: AbortSignal, options?: WriteOptions): Promise<{
        streamId: string;
        txHash: string;
    }>;
    withdraw(params: WithdrawParams, _signal?: AbortSignal, options?: WriteOptions): Promise<{
        txHash: string;
        amount: string;
    }>;
    cancelStream(params: CancelStreamParams, _signal?: AbortSignal, options?: WriteOptions): Promise<{
        txHash: string;
    }>;
    topUp(params: TopUpParams, _signal?: AbortSignal, options?: WriteOptions): Promise<{
        txHash: string;
        newEndTime: Date;
    }>;
    batchCancel(streamIds: string[], _batchSize?: number): Promise<BatchCancelResult[]>;
    updateFlowRate(params: UpdateFlowRateParams): Promise<{
        txHash: string;
    }>;
    private operators;
    private delegates;
    addDelegate(delegate: string): Promise<{
        txHash: string;
    }>;
    getDelegates(delegator?: string): Promise<string[]>;
    revokeDelegate(delegate: string): Promise<{
        txHash: string;
    }>;
    setOperator(params: SetOperatorParams): Promise<{
        txHash: string;
    }>;
    operatorCancelStream(params: {
        streamId: string;
    }): Promise<{
        txHash: string;
    }>;
    operatorTopUp(params: OperatorTopUpParams): Promise<{
        txHash: string;
    }>;
    splitStream(params: SplitStreamParams): Promise<SplitStreamResult>;
    transferStream(params: TransferStreamParams): Promise<{
        txHash: string;
    }>;
    pause(params: PauseStreamParams): Promise<{
        txHash: string;
    }>;
    resume(params: ResumeStreamParams): Promise<{
        txHash: string;
    }>;
    getStream(streamId: string): Promise<Stream>;
    getClaimable(streamId: string): Promise<bigint>;
    getStreamsBySender(sender: string, pagination?: PaginationParams): Promise<Stream[] | PaginatedStreams>;
    getStreamsByRecipient(recipient: string, pagination?: PaginationParams, filter?: StreamFilterCriteria): Promise<Stream[] | PaginatedStreams>;
    private _paginate;
    cloneStream(streamId: string, overrides?: CloneStreamOverrides): Promise<{
        streamId: string;
        txHash: string;
    }>;
    subscribeEvents(filter: StreamEventFilter, callback: (event: StreamEvent) => void): StreamSubscription;
    exportStream(streamId: string, cliffSeconds?: number): Promise<StreamSnapshot>;
    importStream(snapshot: StreamSnapshot): Stream;
    use(_plugin: SoroStreamPlugin): this;
    onRecipientChanged(streamId: string, callback: (event: {
        streamId: string;
        oldRecipient: string;
        newRecipient: string;
        timestamp: number;
    }) => void, options?: {
        intervalMs?: number;
    }): () => void;
    getConnectionStats(): {
        maxConnections: number;
        active: number;
        idle: number;
        reused: number;
    };
}
export type SandboxUnexpectedCallPolicy = 'error' | 'allow' | 'warn';
export interface SandboxCallLog {
    method: string;
    args: unknown[];
    timestamp: number;
}
/**
 * Offline, in-memory testing environment and mock client (issue #348).
 * Serves as a drop-in replacement for {@link SoroStreamClient} in unit tests
 * without hitting Soroban RPC endpoints.
 */
export declare class SoroStreamSandbox extends MockSoroStreamClient {
    private callLog;
    private scenarios;
    private unexpectedCallPolicy;
    constructor(senderKey?: string);
    /** Configures the unexpected call handling policy. */
    setUnexpectedCallPolicy(policy: SandboxUnexpectedCallPolicy): void;
    /** Configures a custom mock handler or scenario for an SDK operation. */
    configureScenario(method: string, handler: (...args: any[]) => any): void;
    /** Clears all registered custom scenarios. */
    clearScenarios(): void;
    /** Returns all recorded calls made to this sandbox instance. */
    getCalls(method?: string): SandboxCallLog[];
    /** Clears the recorded call log history. */
    clearCallHistory(): void;
    /** Asserts that a method was called at least `times` count (default 1). */
    assertCalled(method: string, times?: number): void;
    /** Asserts that a method was called with arguments matching the predicate. */
    assertCalledWith(method: string, matcher: (args: unknown[]) => boolean): void;
    private recordAndExecute;
    private isDefaultOperation;
    createStream(params: CreateStreamParams, signal?: AbortSignal, options?: WriteOptions): Promise<any>;
    withdraw(params: WithdrawParams, signal?: AbortSignal, options?: WriteOptions): Promise<any>;
    cancelStream(params: CancelStreamParams, signal?: AbortSignal, options?: WriteOptions): Promise<any>;
    topUp(params: TopUpParams, signal?: AbortSignal, options?: WriteOptions): Promise<any>;
    getStream(streamId: string): Promise<Stream>;
    getClaimable(streamId: string): Promise<bigint>;
    getStreamsBySender(sender: string, pagination?: PaginationParams): Promise<Stream[] | PaginatedStreams>;
    getStreamsByRecipient(recipient: string, pagination?: PaginationParams, filter?: StreamFilterCriteria): Promise<Stream[] | PaginatedStreams>;
}
