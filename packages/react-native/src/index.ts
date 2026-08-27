import type { SoroStreamAdapters, StorageAdapter } from '@sorostream/sdk';

/**
 * Structural subset of `@react-native-async-storage/async-storage`'s default
 * export. Pass your installed instance directly — this package does not
 * depend on `@react-native-async-storage/async-storage` itself, so any
 * API-compatible storage works (including test doubles).
 */
export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/**
 * Wraps an async storage backend (e.g. `@react-native-async-storage/async-storage`)
 * as a synchronous {@link StorageAdapter}.
 *
 * The SDK's `StorageAdapter` interface is synchronous (it mirrors the Web
 * Storage API used by `getAuditLog`/`clearAuditLog`), while React Native's
 * `AsyncStorage` is inherently asynchronous. This adapter bridges the two
 * with an in-memory cache: reads are served from the cache and trigger a
 * background hydration from `asyncStorage` on first access; writes update
 * the cache immediately and persist to `asyncStorage` in the background.
 *
 * This makes reads/writes **eventually consistent** rather than strictly
 * synchronous — acceptable for the SDK's audit log, which is a best-effort,
 * non-critical diagnostic feature (already documented to swallow storage
 * errors rather than throw).
 *
 * @example
 * ```ts
 * import AsyncStorage from "@react-native-async-storage/async-storage";
 * import { createAsyncStorageAdapter } from "@sorostream/sdk-react-native";
 *
 * const storage = createAsyncStorageAdapter(AsyncStorage);
 * ```
 */
export function createAsyncStorageAdapter(asyncStorage: AsyncStorageLike): StorageAdapter {
  const cache = new Map<string, string>();
  const hydrating = new Set<string>();

  function hydrate(key: string): void {
    if (cache.has(key) || hydrating.has(key)) return;
    hydrating.add(key);
    asyncStorage
      .getItem(key)
      .then((value) => {
        if (value !== null) cache.set(key, value);
      })
      .catch(() => {
        // best-effort — the SDK's audit log already tolerates storage failures
      })
      .finally(() => hydrating.delete(key));
  }

  return {
    getItem(key) {
      hydrate(key);
      return cache.get(key) ?? null;
    },
    setItem(key, value) {
      cache.set(key, value);
      void asyncStorage.setItem(key, value).catch(() => {});
    },
    removeItem(key) {
      cache.delete(key);
      void asyncStorage.removeItem(key).catch(() => {});
    },
  };
}

/**
 * Builds the `adapters` option for `createClient`/`SoroStreamClient` in a
 * React Native app.
 *
 * React Native provides `fetch` and `WebSocket` as globals already, so only
 * `storage` needs an explicit override — pass your app's `AsyncStorage`
 * instance (or omit it to leave the audit log disabled/no-op).
 *
 * @example
 * ```ts
 * import AsyncStorage from "@react-native-async-storage/async-storage";
 * import { createClient } from "@sorostream/sdk";
 * import { createReactNativeAdapters } from "@sorostream/sdk-react-native";
 *
 * const client = createClient({
 *   network: "testnet",
 *   contractId: "...",
 *   walletAdapter,
 *   auditLog: true,
 *   adapters: createReactNativeAdapters({ asyncStorage: AsyncStorage }),
 * });
 * ```
 */
export function createReactNativeAdapters(options?: {
  asyncStorage?: AsyncStorageLike;
}): SoroStreamAdapters {
  return {
    storage: options?.asyncStorage ? createAsyncStorageAdapter(options.asyncStorage) : undefined,
  };
}
