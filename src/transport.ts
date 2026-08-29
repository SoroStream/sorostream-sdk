import { rpc, type Account, type Transaction, type FeeBumpTransaction } from '@stellar/stellar-sdk';
import type { Network } from './types.js';
import { withRetry, isTransientRpcError, type RetryOptions } from './retry.js';
import { SdkNetworkError } from './errors.js';
export { isTransientRpcError };

/**
 * Context passed to {@link RpcTransportAdapter.init} when a transport is
 * attached to a {@link SoroStreamClient} — at construction time, and again
 * on every `setNetwork` call.
 */
export interface RpcTransportInitContext {
  /** The network the transport should now be serving requests for. */
  network: Network;
  /** The RPC URL configured for this network (default or explicit `rpcUrl`). */
  rpcUrl: string;
}

/**
 * Request shape accepted by {@link RpcTransportAdapter.getEvents}. Mirrors
 * `@stellar/stellar-sdk`'s `rpc.Server.GetEventsRequest`.
 */
export interface RpcTransportGetEventsRequest {
  filters: rpc.Api.EventFilter[];
  startLedger?: number;
  endLedger?: number;
  cursor?: string;
  limit?: number;
}

/**
 * The extension point for routing every Soroban RPC call `SoroStreamClient`
 * makes through a custom transport — a private RPC node with bespoke auth, a
 * request-signing proxy, an in-memory fake for tests, or a batching/caching
 * layer in front of the public endpoints.
 *
 * A `RpcTransportAdapter` is a **structural subset** of `@stellar/stellar-sdk`'s
 * `rpc.Server` class — a real `rpc.Server` instance already satisfies this
 * interface, which is exactly how {@link createDefaultRpcTransport} implements
 * it. Custom transports only need to implement the methods below; there is no
 * base class to extend.
 *
 * See CUSTOM_TRANSPORT.md for the full guide, lifecycle, and error handling
 * contract.
 */
export interface RpcTransportAdapter {
  /**
   * Optional setup hook. Called once right after construction, and again
   * every time {@link SoroStreamClient.setNetwork} switches networks. Use it
   * to open connections, authenticate, or swap endpoints — never called
   * concurrently with a request method for the same transport instance.
   */
  init?(context: RpcTransportInitContext): Promise<void> | void;

  /** Fetch a minimal set of current info about a Stellar account (sequence number, balances). */
  getAccount(address: string): Promise<Account>;

  /** General node health check. */
  getHealth(): Promise<rpc.Api.GetHealthResponse>;

  /** Fetch the latest ledger meta info from the network. */
  getLatestLedger(): Promise<rpc.Api.GetLatestLedgerResponse>;

  /** Fetch the status and result of a previously submitted transaction. */
  getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse>;

  /** Simulate a transaction to obtain footprint, resource costs, and result/error. */
  simulateTransaction(
    tx: Transaction | FeeBumpTransaction,
  ): Promise<rpc.Api.SimulateTransactionResponse>;

  /** Simulate a transaction and return a copy with footprint/auth/fees assembled, ready to sign. */
  prepareTransaction(
    tx: Transaction | FeeBumpTransaction,
  ): Promise<Transaction | FeeBumpTransaction>;

  /** Submit a signed transaction to the network. */
  sendTransaction(tx: Transaction | FeeBumpTransaction): Promise<rpc.Api.SendTransactionResponse>;

  /** Fetch contract events matching the given filters, used by `subscribeEvents`/`watchClaimable`. */
  getEvents(request: RpcTransportGetEventsRequest): Promise<rpc.Api.GetEventsResponse>;

  /** The RPC endpoint URL, mirroring `rpc.Server.serverURL`. Optional for custom transports. */
  serverURL?: URL;

  /**
   * Optional teardown hook. Called from {@link SoroStreamClient.disconnect}.
   * Use it to close sockets, flush buffers, or release any resources opened
   * in `init`. Never called automatically by the SDK otherwise — it is the
   * consumer's responsibility to call `client.disconnect()` when done with a
   * client backed by a stateful custom transport.
   */
  teardown?(): Promise<void> | void;
}

/**
 * Wraps an async RPC call so that any `SyntaxError` caused by a non-JSON
 * response body is caught and re-thrown as {@link SdkNetworkError} with the
 * raw body attached. Any other error propagates unchanged. Issue #521.
 */
async function wrapNonJsonError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SyntaxError) {
      // Stellar SDK rethrows JSON parse failures as bare SyntaxErrors.
      // Attach whatever we know (the message contains the raw snippet in
      // some environments) and re-throw as SdkNetworkError.
      const raw = err.message ?? '';
      throw new SdkNetworkError(
        `RPC returned a non-JSON response. This usually means the endpoint is down or a proxy returned an HTML error page. Raw body: ${raw}`,
        raw,
      );
    }
    throw err;
  }
}

/**
 * The transport `SoroStreamClient` uses when no `transport` option is
 * provided — a thin, drop-in wrapper around `@stellar/stellar-sdk`'s
 * `rpc.Server`. Exported so custom transports can compose or delegate to it
 * (e.g. to add logging around the default behaviour instead of
 * reimplementing every method).
 *
 * @example
 * ```ts
 * const base = createDefaultRpcTransport("https://soroban-testnet.stellar.org");
 * const logged: RpcTransportAdapter = {
 *   ...base,
 *   async sendTransaction(tx) {
 *     console.log("submitting", tx.hash().toString("hex"));
 *     return base.sendTransaction(tx);
 *   },
 * };
 * ```
 */
export function createDefaultRpcTransport(
  rpcUrl: string,
  opts?: rpc.Server.Options,
): RpcTransportAdapter {
  const server = new rpc.Server(rpcUrl, { allowHttp: false, ...opts });
  return {
    serverURL: server.serverURL,
    getAccount: (address) => server.getAccount(address),
    getHealth: () => server.getHealth(),
    getLatestLedger: () => server.getLatestLedger(),
    getTransaction: (hash) => server.getTransaction(hash),
    // Issue #521: wrap methods that parse a JSON response body so a non-JSON
    // reply (HTML error page, plain-text gateway message) becomes a
    // descriptive SdkNetworkError instead of a bare SyntaxError.
    simulateTransaction: (tx) => wrapNonJsonError(() => server.simulateTransaction(tx)),
    prepareTransaction: (tx) => wrapNonJsonError(() => server.prepareTransaction(tx)),
    sendTransaction: (tx) => wrapNonJsonError(() => server.sendTransaction(tx)),
    getEvents: (request) => server.getEvents(request),
  };
}

/**
 * Wraps an {@link RpcTransportAdapter} with automatic retry logic using exponential
 * backoff and full jitter for transient RPC errors (issue #425).
 *
 * @param transport - The underlying RpcTransportAdapter to wrap.
 * @param options - Configurable retry options (maxAttempts, baseDelayMs, maxDelayMs, etc.).
 */
export function createRetryingRpcTransport(
  transport: RpcTransportAdapter,
  options?: RetryOptions,
): RpcTransportAdapter {
  const retryOpts: RetryOptions = {
    transientOnly: true,
    ...options,
  };

  return {
    ...transport,
    init: transport.init ? (ctx) => transport.init!(ctx) : undefined,
    teardown: transport.teardown ? () => transport.teardown!() : undefined,
    getAccount: (address) => withRetry(() => transport.getAccount(address), retryOpts),
    getHealth: () => withRetry(() => transport.getHealth(), retryOpts),
    getLatestLedger: () => withRetry(() => transport.getLatestLedger(), retryOpts),
    getTransaction: (hash) => withRetry(() => transport.getTransaction(hash), retryOpts),
    simulateTransaction: (tx) => withRetry(() => transport.simulateTransaction(tx), retryOpts),
    prepareTransaction: (tx) => withRetry(() => transport.prepareTransaction(tx), retryOpts),
    sendTransaction: (tx) => withRetry(() => transport.sendTransaction(tx), retryOpts),
    getEvents: (request) => withRetry(() => transport.getEvents(request), retryOpts),
  };
}
