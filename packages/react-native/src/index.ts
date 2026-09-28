import type { SoroStreamAdapters, StorageAdapter } from '@sorostream/sdk';

/**
 * Current version of `@sorostream/sdk-react-native`.
 */
export const VERSION = '0.1.0';

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
 * Structural subset of `expo-secure-store` module functions.
 * Pass your installed `SecureStore` module directly — this package does not
 * depend on `expo-secure-store` itself.
 */
export interface ExpoSecureStoreLike {
  getItemAsync(key: string, options?: Record<string, unknown>): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: Record<string, unknown>): Promise<void>;
  deleteItemAsync(key: string, options?: Record<string, unknown>): Promise<void>;
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
 * Wraps Expo's `expo-secure-store` module as a synchronous {@link StorageAdapter}.
 */
export function createExpoSecureStoreAdapter(secureStore: ExpoSecureStoreLike): StorageAdapter {
  const cache = new Map<string, string>();
  const hydrating = new Set<string>();

  function hydrate(key: string): void {
    if (cache.has(key) || hydrating.has(key)) return;
    hydrating.add(key);
    secureStore
      .getItemAsync(key)
      .then((value) => {
        if (value !== null) cache.set(key, value);
      })
      .catch(() => {})
      .finally(() => hydrating.delete(key));
  }

  return {
    getItem(key) {
      hydrate(key);
      return cache.get(key) ?? null;
    },
    setItem(key, value) {
      cache.set(key, value);
      void secureStore.setItemAsync(key, value).catch(() => {});
    },
    removeItem(key) {
      cache.delete(key);
      void secureStore.deleteItemAsync(key).catch(() => {});
    },
  };
}

/**
 * Builds the `adapters` option for `createClient`/`SoroStreamClient` in a
 * React Native app.
 */
export function createReactNativeAdapters(options?: {
  asyncStorage?: AsyncStorageLike;
}): SoroStreamAdapters {
  return {
    storage: options?.asyncStorage ? createAsyncStorageAdapter(options.asyncStorage) : undefined,
  };
}

/**
 * Builds the `adapters` option for `createClient`/`SoroStreamClient` in an Expo app.
 * Accepts either `secureStore` (`expo-secure-store`) or `asyncStorage` (`@react-native-async-storage/async-storage`).
 *
 * @example
 * ```ts
 * import * as SecureStore from "expo-secure-store";
 * import { createClient } from "@sorostream/sdk";
 * import { createExpoAdapters } from "@sorostream/sdk-react-native";
 *
 * const client = createClient({
 *   network: "testnet",
 *   contractId: "...",
 *   walletAdapter,
 *   adapters: createExpoAdapters({ secureStore: SecureStore }),
 * });
 * ```
 */
export function createExpoAdapters(options?: {
  secureStore?: ExpoSecureStoreLike;
  asyncStorage?: AsyncStorageLike;
}): SoroStreamAdapters {
  if (options?.secureStore) {
    return { storage: createExpoSecureStoreAdapter(options.secureStore) };
  }
  if (options?.asyncStorage) {
    return { storage: createAsyncStorageAdapter(options.asyncStorage) };
  }
  return {};
}

/**
 * Utility helper to set up Expo polyfills (e.g. `globalThis.crypto.getRandomValues`).
 */
export function setupExpoPolyfills(options?: {
  crypto?: { getRandomValues: <T extends ArrayBufferView | null>(array: T) => T };
}): void {
  if (options?.crypto && typeof globalThis.crypto === 'undefined') {
    (globalThis as unknown as { crypto: unknown }).crypto = options.crypto;
  }
}
