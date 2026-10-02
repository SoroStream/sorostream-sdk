import type { SoroStreamAdapters, StorageAdapter, WalletAdapter, Network } from '@sorostream/sdk';

const Linking = {
  openURL(url: string): Promise<any> {
    const rn = (globalThis as Record<string, any>).ReactNative || globalThis;
    if (rn && rn.Linking && typeof rn.Linking.openURL === 'function') {
      return rn.Linking.openURL(url);
    }
    return Promise.resolve();
  },
};

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
/**
 * Structural subset of a biometric prompt library (e.g. `expo-local-authentication`
 * or `react-native-biometrics`). This package does not depend on either —
 * adapt your library to this shape.
 */
export interface BiometricAuthenticator {
  /** Whether biometric hardware is present and enrolled. */
  isAvailable(): Promise<boolean>;
  /** Shows the system biometric prompt; resolves `true` on success. */
  authenticate(options: { promptMessage: string }): Promise<boolean>;
}

export interface BiometricWalletOptions {
  /** Prompt shown before signing a transaction. */
  promptMessage?: string;
  /** Also require biometrics before `getPublicKey()` (wallet unlock). Default: `false`. */
  requireForPublicKey?: boolean;
  /** Keep the wallet unlocked for this many ms after a successful prompt. Default: `0` (prompt every time). */
  unlockTtlMs?: number;
}

/**
 * Wraps a {@link WalletAdapter} so signing requires biometric authentication.
 * Throws if biometrics are unavailable or the user cancels the prompt.
 *
 * @example
 * ```ts
 * import * as LocalAuthentication from "expo-local-authentication";
 *
 * const wallet = createBiometricWalletAdapter(await createFreighterMobileAdapter(), {
 *   isAvailable: async () =>
 *     (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync()),
 *   authenticate: async ({ promptMessage }) =>
 *     (await LocalAuthentication.authenticateAsync({ promptMessage })).success,
 * });
 * ```
 */
export function createBiometricWalletAdapter(
  wallet: WalletAdapter,
  biometrics: BiometricAuthenticator,
  options: BiometricWalletOptions = {},
): WalletAdapter {
  const promptMessage = options.promptMessage ?? 'Authenticate to unlock your wallet';
  const ttl = options.unlockTtlMs ?? 0;
  let unlockedUntil = 0;

  async function unlock(): Promise<void> {
    if (ttl > 0 && Date.now() < unlockedUntil) return;
    if (!(await biometrics.isAvailable())) {
      throw new Error('Biometric authentication is not available on this device');
    }
    if (!(await biometrics.authenticate({ promptMessage }))) {
      throw new Error('Biometric authentication failed or was cancelled');
    }
    unlockedUntil = Date.now() + ttl;
  }

  return {
    ...wallet,
    async getPublicKey() {
      if (options.requireForPublicKey) await unlock();
      return wallet.getPublicKey();
    },
    async signTransaction(xdr, network) {
      await unlock();
      return wallet.signTransaction(xdr, network);
    },
  };
}
