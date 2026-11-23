/**
 * Optional localStorage-backed cache for last-known stream state (issue #470).
 *
 * Complements the in-memory `streamCache` used by `getStream()`: the
 * in-memory cache is cleared on every page reload, while this layer persists
 * the most recently observed `Stream` for each ID via a `StorageAdapter` so
 * it can be served synchronously right after construction — before the
 * first RPC response for that stream arrives.
 */

import type { StorageAdapter } from './adapters.js';
import type { Stream } from './types.js';
import { serializeStream, deserializeStream } from './serialization.js';
import type { SerializedStream } from './serialization.js';

const KEY_PREFIX = 'sorostream_stream_cache';
/** Default maximum age (ms) of a cached stream entry before it is considered stale. */
export const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface StoredStreamEntry {
  stream: SerializedStream;
  cachedAt: number;
}

/** Persists last-known `Stream` state across page loads via a {@link StorageAdapter}. */
export class LocalStorageStreamCache {
  private readonly storage: StorageAdapter;
  private readonly maxAgeMs: number;
  /**
   * Contract ID used to scope storage keys. Two deployments that share the
   * same `network` label but target different contracts can coexist in the
   * same storage without reading or overwriting each other's entries.
   * `undefined` preserves the pre-fix behaviour (no contractId segment) for
   * callers that do not supply one.
   */
  private readonly contractId: string | undefined;

  constructor(
    storage: StorageAdapter,
    maxAgeMs: number = DEFAULT_MAX_AGE_MS,
    contractId?: string,
  ) {
    this.storage = storage;
    this.maxAgeMs = maxAgeMs;
    this.contractId = contractId;
  }

  private key(network: string, streamId: string): string {
    if (this.contractId !== undefined) {
      return `${KEY_PREFIX}:${network}:${this.contractId}:${streamId}`;
    }
    return `${KEY_PREFIX}:${network}:${streamId}`;
  }

  /** Reads the raw stored entry, ignoring the freshness window. `undefined` if absent or corrupt. */
  private read(network: string, streamId: string): StoredStreamEntry | undefined {
    try {
      const raw = this.storage.getItem(this.key(network, streamId));
      if (!raw) return undefined;
      const entry = JSON.parse(raw) as StoredStreamEntry;
      if (typeof entry.cachedAt !== 'number') return undefined;
      return entry;
    } catch {
      return undefined;
    }
  }

  /** Returns the last persisted state for a stream, or `undefined` if absent, stale, or corrupt. */
  get(network: string, streamId: string): Stream | undefined {
    const entry = this.read(network, streamId);
    if (!entry || Date.now() - entry.cachedAt > this.maxAgeMs) return undefined;
    try {
      return deserializeStream(entry.stream);
    } catch {
      return undefined;
    }
  }

  /**
   * Stale-while-revalidate read (issue #713).
   *
   * Returns the cached value immediately — even when it is older than the
   * freshness window used by {@link get} — alongside a refresh promise. The
   * refresh promise runs `refresh()`, writes the resulting stream back into
   * the cache on success (leaving the cache untouched on failure), and
   * resolves with the updated value. Callers that ignore `refresh` while it
   * can reject should attach a no-op catch handler.
   */
  getWithRevalidate(
    network: string,
    streamId: string,
    refresh: () => Promise<Stream>,
  ): { value: Stream | undefined; refresh: Promise<Stream> } {
    const entry = this.read(network, streamId);
    let value: Stream | undefined;
    if (entry) {
      try {
        value = deserializeStream(entry.stream);
      } catch {
        value = undefined;
      }
    }

    let started: Promise<Stream>;
    try {
      started = refresh();
    } catch (error) {
      started = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const revalidated = started.then((stream) => {
      this.set(network, stream);
      return stream;
    });

    return { value, refresh: revalidated };
  }

  /** Persists `stream` as the last-known state for its ID. Never throws. */
  set(network: string, stream: Stream): void {
    try {
      const entry: StoredStreamEntry = { stream: serializeStream(stream), cachedAt: Date.now() };
      this.storage.setItem(this.key(network, stream.id), JSON.stringify(entry));
    } catch {
      // storage may be unavailable, full, or in a restricted context — never throw
    }
  }

  /** Removes the persisted entry for a stream on the given network. */
  delete(network: string, streamId: string): void {
    try {
      this.storage.removeItem(this.key(network, streamId));
    } catch {
      // ignore
    }
  }
}
