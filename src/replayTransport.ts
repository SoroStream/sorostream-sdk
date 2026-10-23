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
 *   fixture entries by method **and** recorded request parameters: the first
 *   remaining entry recorded with parameters equal to the incoming request
 *   wins; entries recorded without parameters fall back to insertion order
 *   per method (issue #720). Throws `ReplayFixtureError` when a request
 *   arrives for which there is no remaining matching fixture entry.
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
 * `true` when a recorded request carries no parameter information — `null`,
 * `undefined`, an absent field, or an empty object (issue #720). Such entries
 * are treated as parameter-unaware and served by insertion order.
 */
function hasNoParams(request: unknown): boolean {
  return (
    request === undefined ||
    request === null ||
    (typeof request === 'object' &&
      !Array.isArray(request) &&
      Object.keys(request as object).length === 0)
  );
}

/**
 * Canonical match key for a request's parameters (issue #720). The value is
 * normalised through `serialise` first so BigInts compare structurally, then
 * stringified with sorted object keys so property order never splits a match.
 */
function paramsKey(request: unknown): string {
  return stableStringify(serialise(request));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

/**
 * Per-method replay queue that serves stored fixture entries by method **and**
 * recorded request parameters (issue #720), falling back to insertion order
 * for entries recorded without parameters.
 */
class ReplayQueue {
  private readonly queues = new Map<string, FixtureEntry[]>();
  private consumed = 0;

  load(entries: FixtureEntry[]): void {
    for (const entry of entries) {
      if (!this.queues.has(entry.method)) {
        this.queues.set(entry.method, []);
      }
      this.queues.get(entry.method)!.push(entry);
    }
  }

  next<T>(method: string, request: unknown): T {
    const queue = this.queues.get(method);
    if (!queue || queue.length === 0) {
      throw new ReplayFixtureError(method, this.consumed);
    }

    // 1) Parameter-exact match: first remaining entry recorded with
    //    parameters equal to the incoming request (order-independent).
    const incoming = hasNoParams(request) ? undefined : paramsKey(request);
    let idx = -1;
    if (incoming !== undefined) {
      idx = queue.findIndex(
        (entry) => !hasNoParams(entry.request) && paramsKey(entry.request) === incoming,
      );
    }
    // 2) Fallback: first remaining entry recorded without parameters, in
    //    per-method insertion order.
    if (idx === -1) {
      idx = queue.findIndex((entry) => hasNoParams(entry.request));
    }
    if (idx === -1) {
      throw new ReplayFixtureError(method, this.consumed);
    }

    const entry = queue.splice(idx, 1)[0]!;
    this.consumed++;
    return deserialise<T>(entry.response);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Options for creating a recording transport. */
export interface RecordTransportOptions {
  /** Human-readable label written into the fixture file. */
  label?: string;
  /**
   * Transforms each entry before it is serialized by `toJSON()` or `save()`.
   * No redaction is applied by default; callers recording sensitive data
   * should provide a hook to remove it before persisting fixtures.
   */
  redactEntry?: (entry: FixtureEntry) => FixtureEntry;
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

/** Options for {@link ReplayTransport.replay}. */
export interface ReplayOptions {
  /**
   * When `true` (default), replayed responses resolve in the same order the
   * requests were recorded, even when calls are issued concurrently (e.g.
   * through `Promise.all`). Set to `false` for parallel replay, where
   * concurrent calls are served independently and ordering is not guaranteed.
   * Issue #544.
   */
  sequential?: boolean;
  /**
   * Only replay entries whose `method` is in this list (e.g.
   * `['getEvents', 'getTransaction']`). Calls to other methods throw
   * {@link ReplayFixtureError}. Issue #631.
   */
  methods?: string[];
  /**
   * Custom predicate applied to each fixture entry before loading. Entries
   * for which it returns `false` are skipped. Combined with `methods` when
   * both are given. Issue #631.
   */
  filter?: (entry: FixtureEntry, index: number) => boolean;
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
          entries: entries.map((entry) =>
            options.redactEntry ? options.redactEntry(serialise(entry) as FixtureEntry) : entry,
          ),
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
   * @param options - Replay behaviour options (see {@link ReplayOptions}).
   */
  replay(fixture: FixtureFile | string, options: ReplayOptions = {}): ReplayingRpcTransport {
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

    const methods = options.methods ? new Set(options.methods) : null;
    const filter = options.filter;
    const entries = parsed.entries.filter(
      (entry, i) => (!methods || methods.has(entry.method)) && (!filter || filter(entry, i)),
    );

    const queue = new ReplayQueue();
    queue.load(entries);

    const sequential = options.sequential !== false;

    // Serialisation chain: in sequential mode each response is only handed out
    // after the previously issued call's response, so concurrent calls still
    // resolve in recording order (issue #544).
    let serialised: Promise<void> = Promise.resolve();

    function serve<T>(method: string, request: unknown): Promise<T> {
      if (sequential) {
        const next: Promise<T> = serialised.then(() => queue.next<T>(method, request));
        // Keep the chain alive even if the caller rejects its response.
        serialised = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      }
      return Promise.resolve().then(() => queue.next<T>(method, request));
    }

    const transport: ReplayingRpcTransport = {
      serverURL: undefined,

      getFixture: () => parsed,

      getAccount: (address: string) => serve<Account>('getAccount', { address }),

      getHealth: () => serve<rpc.Api.GetHealthResponse>('getHealth', {}),

      getLatestLedger: () => serve<rpc.Api.GetLatestLedgerResponse>('getLatestLedger', {}),

      getTransaction: (hash: string) =>
        serve<rpc.Api.GetTransactionResponse>('getTransaction', { hash }),

      simulateTransaction: (tx: Transaction | FeeBumpTransaction) =>
        serve<rpc.Api.SimulateTransactionResponse>('simulateTransaction', { xdr: tx.toXDR() }),

      prepareTransaction: (tx: Transaction | FeeBumpTransaction) =>
        serve<Transaction | FeeBumpTransaction>('prepareTransaction', { xdr: tx.toXDR() }),

      sendTransaction: (tx: Transaction | FeeBumpTransaction) =>
        serve<rpc.Api.SendTransactionResponse>('sendTransaction', { xdr: tx.toXDR() }),

      getEvents: (req: RpcTransportGetEventsRequest) =>
        serve<rpc.Api.GetEventsResponse>('getEvents', req),
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
