/**
 * Multi-network client configuration (Issue #393).
 *
 * `MultiNetworkClient` wraps multiple `SoroStreamClient` instances — one per
 * configured network — and exposes a unified API that fans read operations out
 * to every network and returns combined results.
 *
 * This lets a single instance query streams across mainnet and testnet without
 * managing separate client handles or manually switching the active network.
 *
 * ```
 * ┌─────────────────────────────────┐
 * │      MultiNetworkClient         │
 * │  ┌──────────┐  ┌─────────────┐ │
 * │  │  testnet │  │   mainnet   │ │
 * │  │  client  │  │   client    │ │
 * │  └──────────┘  └─────────────┘ │
 * └─────────────────────────────────┘
 * ```
 *
 * @example
 * ```ts
 * import { MultiNetworkClient } from "@sorostream/sdk";
 *
 * const multi = new MultiNetworkClient([
 *   { network: "testnet",  contractId: "CTEST...",  walletAdapter },
 *   { network: "mainnet",  contractId: "CMAIN...",  walletAdapter },
 * ]);
 *
 * // Query a stream on a specific network
 * const stream = await multi.getStream("testnet", "stream-42");
 *
 * // Fetch all streams for a recipient across every network
 * const allStreams = await multi.getStreamsByRecipientAllNetworks("GRECIPIENT...");
 *
 * // Which networks are configured?
 * console.log(multi.networks); // ["testnet", "mainnet"]
 * ```
 */

import { SoroStreamClient } from './SoroStreamClient.js';
import type { SoroStreamClientOptions } from './SoroStreamClient.js';
import type { Network, Stream, PaginatedStreams } from './types.js';

// Helper to unwrap Stream[] from the paginated-or-array return type.
function toStreamArray(result: Stream[] | PaginatedStreams): Stream[] {
  if (Array.isArray(result)) return result;
  return result.streams;
}

/**
 * Per-network configuration entry. All `SoroStreamClientOptions` fields are
 * accepted; `network` is required so the multi-client can route by network.
 */
export type NetworkConfig = SoroStreamClientOptions & { network: Network };

/**
 * A stream result annotated with the network it was fetched from.
 */
export interface NetworkedStream {
  /** The network this stream was fetched from. */
  network: Network;
  /** The stream data. */
  stream: Stream;
}

/**
 * Result shape for {@link MultiNetworkClient.findStreamAcrossNetworksDetailed}.
 */
export interface MultiNetworkStreamSearch {
  /** Per-network outcome. */
  results: Array<{
    network: Network;
    /** The stream, or `null` if not found on this network. */
    stream: Stream | null;
    /** Non-null when the per-network fetch failed (distinct from "not found"). */
    error: Error | null;
  }>;
  /** Flat list of streams found across all networks (only successes). */
  found: NetworkedStream[];
}

/**
 * Result shape for {@link MultiNetworkClient.getStreamsBySenderAllNetworks} and
 * {@link MultiNetworkClient.getStreamsByRecipientAllNetworks}.
 */
export interface MultiNetworkStreams {
  /** Per-network results. */
  results: Array<{
    network: Network;
    streams: Stream[];
    /** Non-null when the per-network fetch failed. */
    error: Error | null;
  }>;
  /** Flat list of all streams across all networks (only successes). */
  allStreams: Stream[];
}

/**
 * Wraps multiple `SoroStreamClient` instances and fans operations across them.
 *
 * Mutation methods (`createStream`, `withdraw`, etc.) are intentionally **not**
 * exposed here — write operations should always target a specific network via
 * `getClient(network)` to avoid accidental cross-network submissions.
 */
export class MultiNetworkClient {
  private readonly clients: Map<Network, SoroStreamClient>;

  /**
   * @param configs - One configuration entry per network. Duplicate networks
   *                  are rejected with a `MultiNetworkConfigError`.
   */
  constructor(configs: NetworkConfig[]) {
    if (configs.length === 0) {
      throw new MultiNetworkConfigError('At least one network configuration is required.');
    }

    this.clients = new Map();

    for (const config of configs) {
      if (this.clients.has(config.network)) {
        throw new MultiNetworkConfigError(
          `Duplicate network configuration for "${config.network}". Each network must appear at most once.`,
        );
      }
      this.clients.set(config.network, new SoroStreamClient(config));
    }
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  /**
   * Returns the list of configured network names.
   */
  get networks(): Network[] {
    return [...this.clients.keys()];
  }

  /**
   * Returns the underlying `SoroStreamClient` for `network`.
   *
   * @throws {MultiNetworkNotFoundError} if `network` is not configured.
   */
  getClient(network: Network): SoroStreamClient {
    const client = this.clients.get(network);
    if (!client) {
      throw new MultiNetworkNotFoundError(network, this.networks);
    }
    return client;
  }

  /**
   * Returns `true` when `network` has a registered client.
   */
  hasNetwork(network: Network): boolean {
    return this.clients.has(network);
  }

  /**
   * Adds a network at runtime. The new network is included in all subsequent
   * aggregate queries without recreating the client.
   *
   * @throws {MultiNetworkConfigError} if `config.network` is already configured.
   */
  addNetwork(config: NetworkConfig): void {
    if (this.clients.has(config.network)) {
      throw new MultiNetworkConfigError(
        `Duplicate network configuration for "${config.network}". Each network must appear at most once.`,
      );
    }
    this.clients.set(config.network, new SoroStreamClient(config));
  }

  /**
   * Removes a network at runtime, destroying its underlying client. The
   * network is excluded from all subsequent aggregate queries.
   *
   * @throws {MultiNetworkNotFoundError} if `network` is not configured.
   */
  removeNetwork(network: Network): void {
    const client = this.clients.get(network);
    if (!client) {
      throw new MultiNetworkNotFoundError(network, this.networks);
    }
    client.destroy();
    this.clients.delete(network);
  }

  // ── Read operations ───────────────────────────────────────────────────────

  /**
   * Fetches a single stream from the specified network.
   *
   * @param network  - Target network.
   * @param streamId - Stream identifier.
   */
  async getStream(network: Network, streamId: string): Promise<Stream> {
    return this.getClient(network).getStream(streamId);
  }

  /**
   * Fetches all streams for `recipient` on the specified network.
   */
  async getStreamsByRecipient(network: Network, recipient: string): Promise<Stream[]> {
    return toStreamArray(await this.getClient(network).getStreamsByRecipient(recipient));
  }

  /**
   * Fetches all streams for `sender` on the specified network.
   */
  async getStreamsBySender(network: Network, sender: string): Promise<Stream[]> {
    return toStreamArray(await this.getClient(network).getStreamsBySender(sender));
  }

  /**
   * Returns the claimable amount for `streamId` on the specified network.
   */
  async getClaimable(network: Network, streamId: string): Promise<bigint> {
    return this.getClient(network).getClaimable(streamId);
  }

  /**
   * Fetches streams for `recipient` from **all** configured networks in
   * parallel.  Networks that fail individually are captured in the `error`
   * field of their result entry rather than rejecting the whole call.
   */
  async getStreamsByRecipientAllNetworks(recipient: string): Promise<MultiNetworkStreams> {
    return this._fanOut((client) => client.getStreamsByRecipient(recipient).then(toStreamArray));
  }

  /**
   * Fetches streams for `sender` from **all** configured networks in
   * parallel.  Per-network errors are captured rather than propagated.
   */
  async getStreamsBySenderAllNetworks(sender: string): Promise<MultiNetworkStreams> {
    return this._fanOut((client) => client.getStreamsBySender(sender).then(toStreamArray));
  }

  /**
   * Looks up `streamId` on every configured network and returns all matches
   * (the same ID may exist on multiple networks).
   *
   * **Limitation:** this method cannot distinguish "the stream doesn't exist
   * on this network" from "the RPC call to this network failed" — both cases
   * simply omit that network from the returned array. A network outage during
   * the search looks identical to the stream genuinely not existing there. If
   * you need to tell these apart (e.g. to retry only the networks that
   * actually failed), use {@link findStreamAcrossNetworksDetailed} instead,
   * which reports a per-network `error` field.
   */
  async findStreamAcrossNetworks(streamId: string): Promise<NetworkedStream[]> {
    // Read the live map at call time so runtime add/remove is honored.
    const results = await Promise.allSettled(
      [...this.clients.entries()].map(async ([network, client]) => {
        const stream = await client.getStream(streamId);
        return { network, stream };
      }),
    );

    return results
      .filter((r): r is PromiseFulfilledResult<NetworkedStream> => r.status === 'fulfilled')
      .map((r) => r.value);
  }

  /**
   * Like {@link findStreamAcrossNetworks}, but reports a per-network outcome
   * instead of silently dropping networks where the lookup failed — using the
   * same `error`-field shape as {@link _fanOut} (see {@link MultiNetworkStreams}).
   *
   * Note this does not fully resolve the "not found" vs "RPC error"
   * ambiguity: `SoroStreamClient.getStream` itself rejects for both a
   * genuinely missing stream and a real transport/RPC failure, with no
   * separate "not found" resolution path. What this method adds over
   * {@link findStreamAcrossNetworks} is that the rejection's `Error` is
   * preserved per network (in `results[].error`) instead of being discarded,
   * so callers can inspect the error's message/type themselves to tell the
   * two cases apart where the underlying client surfaces that information.
   */
  async findStreamAcrossNetworksDetailed(streamId: string): Promise<MultiNetworkStreamSearch> {
    const entries = [...this.clients.entries()];

    const settled = await Promise.allSettled(
      entries.map(async ([network, client]) => ({
        network,
        stream: await client.getStream(streamId),
      })),
    );

    const results = settled.map((r, i) => {
      const network = entries[i]![0];
      if (r.status === 'fulfilled') {
        return { network, stream: r.value.stream, error: null };
      }
      return { network, stream: null, error: r.reason as Error };
    });

    const found = results
      .filter((r): r is { network: Network; stream: Stream; error: null } => r.stream !== null)
      .map((r) => ({ network: r.network, stream: r.stream }));

    return { results, found };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Calls `destroy()` on all underlying clients, stopping polling timers.
   * Call this when the `MultiNetworkClient` is no longer needed.
   */
  destroy(): void {
    for (const client of this.clients.values()) {
      client.destroy();
    }
  }

  /**
   * Calls `disconnect()` on all underlying clients, tearing down any custom
   * transport connections.
   */
  async disconnect(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.disconnect()));
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async _fanOut(
    fn: (client: SoroStreamClient) => Promise<Stream[]>,
  ): Promise<MultiNetworkStreams> {
    // Snapshot the live map at call time so runtime add/remove is honored.
    const entries = [...this.clients.entries()];

    const settled = await Promise.allSettled(
      entries.map(async ([network, client]) => ({
        network,
        streams: await fn(client),
      })),
    );

    const results = settled.map((r, i) => {
      const network = entries[i]![0];
      if (r.status === 'fulfilled') {
        return { network, streams: r.value.streams, error: null };
      }
      return { network, streams: [] as Stream[], error: r.reason as Error };
    });

    const allStreams = results.flatMap((r) => r.streams);
    return { results, allStreams };
  }
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Thrown when the `MultiNetworkClient` is constructed with invalid config. */
export class MultiNetworkConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MultiNetworkConfigError';
  }
}

/** Thrown when `getClient` is called with an unconfigured network. */
export class MultiNetworkNotFoundError extends Error {
  constructor(network: Network, available: Network[]) {
    super(
      `MultiNetworkClient: network "${network}" is not configured. ` +
        `Available networks: ${available.join(', ')}.`,
    );
    this.name = 'MultiNetworkNotFoundError';
  }
}
