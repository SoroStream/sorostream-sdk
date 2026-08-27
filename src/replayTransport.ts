/**
 * Replay transport for deterministic testing (Issue #395).
 *
 * The replay transport has two operating modes:
 *
 * **Record mode** (`ReplayTransport.record(baseTransport, path)`)
 *   All RPC calls are forwarded to `baseTransport`. Each request/response pair
 *   is appended to the in-memory fixture log. Call `transport.save()` to write
 *   the log to a JSON file on disk.
 *
 * **Replay mode** (`ReplayTransport.replay(fixture)`)
 *   No live network calls are made. Requests are matched against the stored
 *   fixture entries in insertion order (per method). Throws
 *   `ReplayFixtureError` when a request arrives for which there is no
 *   remaining fixture entry.
 *
 * Both modes return an object that satisfies `RpcTransportAdapter`, so they
 * can be passed directly to `SoroStreamClient` via the `transport` option.
 *
 * @example Record a fixture during development:
 * ```ts
 * const transport = ReplayTransport.record(
 *   createDefaultRpcTransport("https://soroban-testnet.stellar.org"),
 *   "./fixtures/my-test.json"
 * );
 * const client = new SoroStreamClient({ network: "testnet", contractId, walletAdapter, transport });
 * // … run your scenario …
 * await transport.save(); // writes the fixture file
 * ```
 *
 * @example Replay in tests:
 * ```ts
 * const transport = ReplayTransport.replay("./fixtures/my-test.json");
 * const client = new SoroStreamClient({ network: "testnet", contractId, walletAdapter, transport });
 * // The test runs fully offline and deterministically.
 * ```
 */

import type { RpcTransportAdapter } from './transport.js';
import type { Account, Transaction, FeeBumpTransaction } from '@stellar/stellar-sdk';
import { rpc } from '@stellar/stellar-sdk';
import type { RpcTransportGetEventsRequest } from './transport.js';

/** A single recorded RPC interaction. */
export interface FixtureEntry {
  /** The transport method name, e.g. `"getAccount"`. */
  method: string;
  /** JSON-serializable representation of the call arguments. */
  request: unknown;
  /** JSON-serializable representation of the successful response. */
  response: unknown;
}

/** The structure of a fixture file written / read by {@link ReplayTransport}. */
export interface FixtureFile {
  /** Human-readable label for the fixture (optional). */
  label?: string;
  /** ISO-8601 timestamp when the fixture was recorded. */
  recordedAt: string;
  /** Ordered list of recorded interactions. */
  entries: FixtureEntry[];
}

/**
 * Thrown in replay mode when a method is called but no fixture entry remains.
 */
export class ReplayFixtureError extends Error {
  constructor(method: string, consumed: number) {
    super(
      `ReplayTransport: no fixture entry for "${method}" (${consumed} total entries consumed so far)`,
    );
    this.name = 'ReplayFixtureError';
  }
}

/**
 * Thrown when a fixture file cannot be parsed.
 */
export class ReplayFixtureParseError extends Error {
  constructor(message: string) {
    super(`ReplayTransport: failed to parse fixture — ${message}`);
    this.name = 'ReplayFixtureParseError';
  }
}

/**
 * Serialises a value to a plain JSON-compatible structure.
 * BigInt values are converted to `{ __bigint: "123" }` so they survive
 * JSON round-trips.
 */
function serialise(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? { __bigint: String(v) } : v)),
  );
}

/**
 * Deserialises a value previously processed by `serialise`, restoring BigInts.
 */
function deserialise<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value), (_k, v) => {
    if (v !== null && typeof v === 'object' && '__bigint' in v) return BigInt(v.__bigint as string);
    return v;
  }) as T;
}

/**
 * Simple per-method FIFO queue used to serve replay entries in order.
 */
class ReplayQueue {
  private readonly queues = new Map<string, unknown[]>();
  private consumed = 0;

  load(entries: FixtureEntry[]): void {
    for (const entry of entries) {
      if (!this.queues.has(entry.method)) {
        this.queues.set(entry.method, []);
      }
      this.queues.get(entry.method)!.push(entry.response);
    }
  }

  next<T>(method: string): T {
    const queue = this.queues.get(method);
    if (!queue || queue.length === 0) {
      throw new ReplayFixtureError(method, this.consumed);
    }
    this.consumed++;
    return deserialise<T>(queue.shift());
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Options for creating a recording transport. */
export interface RecordTransportOptions {
  /** Human-readable label written into the fixture file. */
  label?: string;
}

/** Extended transport returned by `ReplayTransport.record`. */
export interface RecordingRpcTransport extends RpcTransportAdapter {
  /**
   * Returns all entries recorded so far without writing to disk.
   * Useful in environments (e.g. browser) where `fs` is unavailable.
   */
  getEntries(): FixtureEntry[];

  /**
   * Serialises the recorded interactions to JSON and resolves with the string.
   * Does NOT write to disk — callers are responsible for persistence when
   * the Node `fs` module is unavailable.
   */
  toJSON(): string;

  /**
   * Writes the fixture file to `path` using Node's `fs/promises` module.
   * Throws if called in a non-Node environment.
   */
  save(path?: string): Promise<void>;
}

/** Extended transport returned by `ReplayTransport.replay`. */
export interface ReplayingRpcTransport extends RpcTransportAdapter {
  /** Returns the raw fixture that was loaded. */
  getFixture(): FixtureFile;
}

export const ReplayTransport = {
  /**
   * Creates a **recording** transport that forwards all calls to
   * `baseTransport` and logs each interaction.
   *
   * @param baseTransport - The live transport to delegate real calls to.
   * @param defaultPath   - Default file path for `save()` calls.
   * @param options       - Optional metadata for the fixture.
   */
  record(
    baseTransport: RpcTransportAdapter,
    defaultPath?: string,
    options: RecordTransportOptions = {},
  ): RecordingRpcTransport {
    const entries: FixtureEntry[] = [];

    function rec<T>(method: string, request: unknown, promise: Promise<T>): Promise<T> {
      return promise.then((response) => {
        entries.push({ method, request: serialise(request), response: serialise(response) });
        return response;
      });
    }

    const transport: RecordingRpcTransport = {
      serverURL: baseTransport.serverURL,

      async init(ctx) {
        await baseTransport.init?.(ctx);
      },

      async teardown() {
        await baseTransport.teardown?.();
      },

      getEntries: () => [...entries],

      toJSON() {
        const fixture: FixtureFile = {
          label: options.label,
          recordedAt: new Date().toISOString(),
          entries,
        };
        return JSON.stringify(fixture, null, 2);
      },

      async save(path?: string) {
        const target = path ?? defaultPath;
        if (!target) throw new Error('ReplayTransport.save: no path provided');
        const { writeFile } = await import('fs/promises');
        await writeFile(target, transport.toJSON(), 'utf8');
      },

      getAccount: (address: string) =>
        rec('getAccount', { address }, baseTransport.getAccount(address)),

      getHealth: () => rec('getHealth', {}, baseTransport.getHealth()),

      getLatestLedger: () => rec('getLatestLedger', {}, baseTransport.getLatestLedger()),

      getTransaction: (hash: string) =>
        rec('getTransaction', { hash }, baseTransport.getTransaction(hash)),

      simulateTransaction: (tx: Transaction | FeeBumpTransaction) =>
        rec('simulateTransaction', { xdr: tx.toXDR() }, baseTransport.simulateTransaction(tx)),

      prepareTransaction: (tx: Transaction | FeeBumpTransaction) =>
        rec('prepareTransaction', { xdr: tx.toXDR() }, baseTransport.prepareTransaction(tx)),

      sendTransaction: (tx: Transaction | FeeBumpTransaction) =>
        rec('sendTransaction', { xdr: tx.toXDR() }, baseTransport.sendTransaction(tx)),

      getEvents: (req: RpcTransportGetEventsRequest) =>
        rec('getEvents', req, baseTransport.getEvents(req)),
    };

    return transport;
  },

  /**
   * Creates a **replaying** transport that serves pre-recorded responses
   * from a fixture file without making any network calls.
   *
   * @param fixture - Either a path to a JSON fixture file (Node only) or a
   *                  pre-parsed {@link FixtureFile} object.
   */
  replay(fixture: FixtureFile | string): ReplayingRpcTransport {
    let parsed: FixtureFile;

    if (typeof fixture === 'string') {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('fs') as typeof import('fs');
        const raw = fs.readFileSync(fixture, 'utf8');
        parsed = JSON.parse(raw) as FixtureFile;
      } catch (err) {
        throw new ReplayFixtureParseError(String(err));
      }
    } else {
      parsed = fixture;
    }

    if (!parsed || !Array.isArray(parsed.entries)) {
      throw new ReplayFixtureParseError('missing or invalid "entries" array');
    }

    const queue = new ReplayQueue();
    queue.load(parsed.entries);

    const transport: ReplayingRpcTransport = {
      serverURL: undefined,

      getFixture: () => parsed,

      getAccount: (_address: string) => Promise.resolve().then(() => queue.next<Account>('getAccount')),

      getHealth: () => Promise.resolve().then(() => queue.next<rpc.Api.GetHealthResponse>('getHealth')),

      getLatestLedger: () =>
        Promise.resolve().then(() => queue.next<rpc.Api.GetLatestLedgerResponse>('getLatestLedger')),

      getTransaction: (_hash: string) =>
        Promise.resolve().then(() => queue.next<rpc.Api.GetTransactionResponse>('getTransaction')),

      simulateTransaction: (_tx: Transaction | FeeBumpTransaction) =>
        Promise.resolve().then(() => queue.next<rpc.Api.SimulateTransactionResponse>('simulateTransaction')),

      prepareTransaction: (_tx: Transaction | FeeBumpTransaction) =>
        Promise.resolve().then(() => queue.next<Transaction | FeeBumpTransaction>('prepareTransaction')),

      sendTransaction: (_tx: Transaction | FeeBumpTransaction) =>
        Promise.resolve().then(() => queue.next<rpc.Api.SendTransactionResponse>('sendTransaction')),

      getEvents: (_req: RpcTransportGetEventsRequest) =>
        Promise.resolve().then(() => queue.next<rpc.Api.GetEventsResponse>('getEvents')),
    };

    return transport;
  },

  /**
   * Parses a fixture JSON string into a {@link FixtureFile} object without
   * reading from disk. Useful when the fixture content is already in memory
   * (e.g. bundled as a JSON import).
   */
  parse(json: string): FixtureFile {
    try {
      const parsed = JSON.parse(json) as FixtureFile;
      if (!parsed || !Array.isArray(parsed.entries)) {
        throw new ReplayFixtureParseError('missing or invalid "entries" array');
      }
      return parsed;
    } catch (err) {
      if (err instanceof ReplayFixtureParseError) throw err;
      throw new ReplayFixtureParseError(String(err));
    }
  },
} as const;
