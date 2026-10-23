/**
 * Generic in-flight request deduplication (issue #426).
 *
 * Dashboards routinely mount several components that all need the same stream
 * at the same time. Without deduplication each component issues its own RPC
 * call for the same data, multiplying latency and RPC quota usage for zero
 * benefit. `RequestDeduplicator` collapses concurrent calls that share a key
 * into a single underlying request: the first caller starts the work, every
 * caller that arrives while it is still in flight joins the same promise.
 *
 * Semantics:
 * - The in-flight entry is registered **synchronously**, before the factory's
 *   first `await` yields, so callers created in the same tick always join.
 * - The entry is removed as soon as the request settles — successfully or not.
 *   Failures are therefore never cached and the next caller retries.
 * - Every joined caller observes the *same* resolved value (or rejection),
 *   which keeps concurrent readers consistent with each other.
 * - Callers arriving in a later turn than the entry's creation take their
 *   join decision one microtask later, so entry removal on settle always
 *   completes first and a late joiner can never receive the result of an
 *   already-settled request (issue #714). Same-turn callers still join
 *   synchronously, preserving the original deduplication contract
 *   (issue #426), including for synchronously-resolving factories.
 */

/** Counters describing deduplication effectiveness. */
export interface RequestDedupStats {
  /** Number of requests currently in flight. */
  inFlight: number;
  /** Total number of `dedupe()` calls seen. */
  requests: number;
  /** Number of underlying requests actually started (cache misses). */
  started: number;
  /** Number of calls that joined an already in-flight request. */
  deduplicated: number;
  /** Highest number of simultaneously in-flight requests observed. */
  peakInFlight: number;
}

/** Options for {@link RequestDeduplicator}. */
export interface RequestDeduplicatorOptions {
  /**
   * When `false`, every call runs its own request and no keys are tracked.
   * Statistics are still collected so callers can measure the difference.
   * Default: `true`.
   */
  enabled?: boolean;
  /** Invoked with the key each time a caller joins an in-flight request. */
  onDeduplicated?: (key: string) => void;
  /**
   * Maximum age in ms of an in-flight request that new callers may join
   * (issue #622). Once a pending request is older than this, its result is
   * considered stale and the next caller starts a fresh request instead.
   * Default: `Infinity` (always join).
   */
  maxAgeMs?: number;
  /**
   * Converts a call's key to the internal string key used for deduplication.
   * This lets callers derive stable keys from object or array arguments.
   * Without a function, keys must remain strings.
   */
  keyFn?: (key: unknown) => string;
}

/** Per-call options for {@link RequestDeduplicator.dedupe}. */
export interface DedupeCallOptions {
  /** Overrides {@link RequestDeduplicatorOptions.maxAgeMs} for this call. */
  maxAgeMs?: number;
  /** When `true`, always start a fresh request and replace any in-flight one. */
  fresh?: boolean;
}

/** Bookkeeping for a tracked in-flight request (issue #714). */
interface InFlightEntry {
  /** Shared promise handed to joiners. */
  promise: Promise<unknown>;
  /** `true` only within the synchronous turn the entry was created in. */
  creationTick: boolean;
}

/**
 * Coalesces concurrent async requests that share the same key.
 *
 * @example
 * ```ts
 * const dedup = new RequestDeduplicator();
 * // Both callers share a single fetch:
 * const [a, b] = await Promise.all([
 *   dedup.dedupe("stream:42", () => fetchStream("42")),
 *   dedup.dedupe("stream:42", () => fetchStream("42")),
 * ]);
 * ```
 */
export class RequestDeduplicator {
  private readonly inFlight = new Map<string, InFlightEntry>();
  private readonly startedAt = new Map<string, number>();
  private readonly maxAgeMs: number;
  private readonly enabled: boolean;
  private readonly onDeduplicated: ((key: string) => void) | undefined;
  private readonly keyFn: ((key: unknown) => string) | undefined;
  private requests = 0;
  private started = 0;
  private deduplicated = 0;
  private peakInFlight = 0;

  constructor(options: RequestDeduplicatorOptions = {}) {
    this.enabled = options.enabled !== false;
    this.onDeduplicated = options.onDeduplicated;
    this.maxAgeMs = options.maxAgeMs ?? Infinity;
    this.keyFn = options.keyFn;
  }

  /**
   * Runs `factory` unless an identical request (same `key`) is already in
   * flight, in which case the existing promise is returned instead.
   *
   * @param key - Identity of the request. Include every input that changes the
   *   result (network, address, pagination, …) so distinct reads never share.
   * @param factory - Starts the underlying request. Called at most once per
   *   in-flight window.
   * @param options - Staleness controls (issue #622).
   * @returns The shared promise for this key.
   */
  dedupe<T>(key: unknown, factory: () => Promise<T>, options: DedupeCallOptions = {}): Promise<T> {
    this.requests++;
    const normalizedKey = this.normalizeKey(key);

    if (!this.enabled) {
      this.started++;
      return this.invoke(factory);
    }

    const existing = this.inFlight.get(normalizedKey);
    const maxAge = options.maxAgeMs ?? this.maxAgeMs;
    const age = Date.now() - (this.startedAt.get(normalizedKey) ?? Date.now());
    if (existing && !options.fresh && age <= maxAge) {
      if (existing.creationTick) {
        return this.join(normalizedKey, existing) as Promise<T>;
      }
      // Settle cleanup runs as a microtask after this caller's turn, so
      // defer the join decision by one microtask: any pending removal
      // completes first and a late joiner can never observe an entry that
      // has already settled (issue #714). If the entry survived, join it;
      // otherwise start fresh work.
      return Promise.resolve().then(() => {
        const current = this.inFlight.get(normalizedKey);
        if (current) {
          const currentAge = Date.now() - (this.startedAt.get(normalizedKey) ?? Date.now());
          if (currentAge <= maxAge) return this.join(normalizedKey, current) as Promise<T>;
        }
        return this.start(normalizedKey, factory);
      });
    }

    return this.start(normalizedKey, factory);
  }

  /** Registers `factory`'s shared promise under `key` and wires settle cleanup. */
  private start<T>(key: string, factory: () => Promise<T>): Promise<T> {
    this.started++;
    const shared = this.invoke(factory);
    const entry: InFlightEntry = { promise: shared, creationTick: true };
    this.inFlight.set(key, entry);
    this.startedAt.set(key, Date.now());
    // Leave the creation turn, so only same-turn callers join synchronously.
    Promise.resolve().then(() => {
      entry.creationTick = false;
    });
    if (this.inFlight.size > this.peakInFlight) {
      this.peakInFlight = this.inFlight.size;
    }

    // Release the slot on settle. `finally` ensures cleanup runs whether the
    // promise fulfills or rejects, preventing leaks from timeouts or other
    // rejection scenarios. The identity guard keeps a `fresh` replacement's
    // entry from being clobbered by an older request's cleanup.
    shared
      .finally(() => {
        if (this.inFlight.get(key) === entry) {
          this.inFlight.delete(key);
          this.startedAt.delete(key);
        }
      })
      .catch(() => {});

    return shared;
  }

  /** Hands `entry`'s shared promise to a joiner and records the stat. */
  private join(key: string, entry: InFlightEntry): Promise<unknown> {
    this.deduplicated++;
    this.onDeduplicated?.(key);
    return entry.promise;
  }

  /** Returns `true` when a request for `key` is currently in flight. */
  has(key: unknown): boolean {
    return this.inFlight.has(this.normalizeKey(key));
  }

  private normalizeKey(key: unknown): string {
    if (this.keyFn) return this.keyFn(key);
    if (typeof key !== 'string') {
      throw new TypeError('RequestDeduplicator keys must be strings unless keyFn is provided');
    }
    return key;
  }

  /** Number of requests currently in flight. */
  get size(): number {
    return this.inFlight.size;
  }

  /** Keys of the requests currently in flight. */
  keys(): string[] {
    return Array.from(this.inFlight.keys());
  }

  /**
   * Detaches all tracked requests so future callers start fresh work.
   *
   * In-flight promises are *not* cancelled — their existing callers still
   * receive the result — they simply stop being reusable. Used on network
   * switches and config reloads, where the pending result may belong to a
   * different network and must not be handed to a new caller.
   */
  clear(): void {
    this.inFlight.clear();
    this.startedAt.clear();
  }

  /** Returns a snapshot of the deduplication counters. */
  stats(): RequestDedupStats {
    return {
      inFlight: this.inFlight.size,
      requests: this.requests,
      started: this.started,
      deduplicated: this.deduplicated,
      peakInFlight: this.peakInFlight,
    };
  }

  /** Resets the counters returned by {@link RequestDeduplicator.stats}. */
  resetStats(): void {
    this.requests = 0;
    this.started = 0;
    this.deduplicated = 0;
    this.peakInFlight = this.inFlight.size;
  }

  /** Normalises a synchronously-throwing factory into a rejected promise. */
  private invoke<T>(factory: () => Promise<T>): Promise<T> {
    try {
      return Promise.resolve(factory());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

/**
 * Builds a stable deduplication key from arbitrary parts.
 *
 * `undefined`/`null` parts are collapsed to `*` so `key("a", undefined)` and
 * `key("a", null)` address the same slot, and objects are serialised with
 * sorted keys so property order never splits a key.
 */
export function dedupKey(
  ...parts: Array<string | number | boolean | null | undefined | object>
): string {
  return parts
    .map((part) => {
      if (part === undefined || part === null) return '*';
      if (typeof part === 'object') return stableStringify(part);
      return String(part);
    })
    .join('|');
}

function stableStringify(value: unknown): string {
  if (typeof value === 'bigint') return `${value}n`;
  if (value === null || typeof value !== 'object') {
    return String(JSON.stringify(value));
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
