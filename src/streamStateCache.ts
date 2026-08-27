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
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface StoredStreamEntry {
  stream: SerializedStream;
  cachedAt: number;
}

/** Persists last-known `Stream` state across page loads via a {@link StorageAdapter}. */
export class LocalStorageStreamCache {
  private readonly storage: StorageAdapter;
  private readonly maxAgeMs: number;

  constructor(storage: StorageAdapter, maxAgeMs: number = DEFAULT_MAX_AGE_MS) {
    this.storage = storage;
    this.maxAgeMs = maxAgeMs;
  }

  private key(network: string, streamId: string): string {
    return `${KEY_PREFIX}:${network}:${streamId}`;
  }

  /** Returns the last persisted state for a stream, or `undefined` if absent, stale, or corrupt. */
  get(network: string, streamId: string): Stream | undefined {
    try {
      const raw = this.storage.getItem(this.key(network, streamId));
      if (!raw) return undefined;
      const entry = JSON.parse(raw) as StoredStreamEntry;
      if (typeof entry.cachedAt !== 'number' || Date.now() - entry.cachedAt > this.maxAgeMs) {
        return undefined;
      }
      return deserializeStream(entry.stream);
    } catch {
      return undefined;
    }
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
