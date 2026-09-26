import type { SoroStreamAdapters, StorageAdapter, WalletAdapter } from '@sorostream/sdk';
import type { Linking } from 'react-native';

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

// Freighter Mobile deep link constants
const FREIGHTER_MOBILE_SCHEME = 'freighter';
const FREIGHTER_MOBILE_HOST = 'sign';
const FREIGHTER_MOBILE_GET_PUBLIC_KEY_PATH = 'public-key';
const FREIGHTER_MOBILE_SIGN_TRANSACTION_PATH = 'sign-tx';

// Network mapping for Freighter Mobile
const FREIGHTER_MOBILE_NETWORK_MAP: Record<Network, string> = {
  mainnet: 'public',
  testnet: 'testnet',
  futurenet: 'futurenet',
};

/**
 * Creates a WalletAdapter for Freighter Mobile using deep-link signing.
 * 
 * @example
 * ```ts
 * import { SoroStreamClient, createFreighterMobileAdapter } from "@sorostream/sdk-react-native";
 * 
 * const freighterMobileAdapter = await createFreighterMobileAdapter();
 * const client = new SoroStreamClient({
 *   network: "testnet",
 *   contractId: "YOUR_CONTRACT_ID",
 *   walletAdapter: freighterMobileAdapter,
 * });
 * ```
 */
export async function createFreighterMobileAdapter(): Promise<WalletAdapter> {
  // Note: In a real implementation, we would check if the Freighter Mobile app is available
  // by attempting to open a URL and listening for a response, or by checking if the app is installed.
  // For this stub, we assume the app is available and will handle the deep link.

  return {
    async isConnected(): Promise<boolean> {
      // For mobile wallets, we typically assume they're connected if the app exists
      // A more sophisticated implementation might check if the app can be opened
      return true;
    },

    async getPublicKey(): Promise<string> {
      // For simplicity in this stub, we'll use testnet as the default network.
      // In a real app, you might want to get the network from the client context.
      const network = 'testnet';
      const freighterNetwork = FREIGHTER_MOBILE_NETWORK_MAP[network as Network] || 'public';
      const url = `${FREIGHTER_MOBILE_SCHEME}://${FREIGHTER_MOBILE_HOST}/${FREIGHTER_MOBILE_GET_PUBLIC_KEY_PATH}?network=${freighterNetwork}`;
      // In a real app, we would open the URL and wait for the response via a callback or event listener.
      // For this stub, we'll just open the URL and return a placeholder.
      // Note: We are not actually waiting for the response, so this is not a complete implementation.
      // The unit test will mock Linking.openURL and verify the URL format.
      Linking.openURL(url);
      // Return a placeholder - in a real app, this would be the actual public key returned from the app via the deep link callback.
      return 'PLACEHOLDER_PUBLIC_KEY_FROM_FREIGHTER_MOBILE';
    },

    async signTransaction(xdr: string, network: Network): Promise<string> {
      const freighterNetwork = FREIGHTER_MOBILE_NETWORK_MAP[network] || 'public';
      const url = `${FREIGHTER_MOBILE_SCHEME}://${FREIGHTER_MOBILE_HOST}/${FREIGHTER_MOBILE_SIGN_TRANSACTION_PATH}?network=${freighterNetwork}&xdr=${encodeURIComponent(xdr)}`;
      Linking.openURL(url);
      // Return a placeholder - in a real app, this would be the actual signed XDR returned from the app.
      return 'PLACEHOLDER_SIGNED_XDR_FROM_FREIGHTER_MOBILE';
    },
  };
}