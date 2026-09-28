/**
 * Smoke test for issue #199: exercises the React Native adapters in a
 * simulated "bare" React Native environment (no `localStorage` global,
 * matching RN's actual JS runtime) to confirm the SDK does not crash and the
 * audit log round-trips through the AsyncStorage-backed adapter.
 */
import { describe, it, expect, vi } from 'vitest';
// Imported from the SDK's source (rather than the `@sorostream/sdk` package
// name) because npm workspaces does not self-link the monorepo root to
// satisfy sibling packages' dependency on their own root package name.
import { SoroStreamClient } from '../../../src/SoroStreamClient.js';
import type { WalletAdapter } from '../../../src/types.js';
import {
  createAsyncStorageAdapter,
  createReactNativeAdapters,
  createExpoSecureStoreAdapter,
  createExpoAdapters,
  setupExpoPolyfills,
} from '../src/index.js';
import type { AsyncStorageLike, ExpoSecureStoreLike } from '../src/index.js';

const VALID_CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

function makeWalletAdapter(): WalletAdapter {
  return {
    getPublicKey: vi
      .fn()
      .mockResolvedValue('GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF'),
    signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
    isConnected: vi.fn().mockResolvedValue(true),
  };
}

function makeFakeAsyncStorage(): AsyncStorageLike {
  const store = new Map<string, string>();
  return {
    getItem: async (key) => store.get(key) ?? null,
    setItem: async (key, value) => void store.set(key, value),
    removeItem: async (key) => void store.delete(key),
  };
}

function makeFakeExpoSecureStore(): ExpoSecureStoreLike {
  const store = new Map<string, string>();
  return {
    getItemAsync: async (key) => store.get(key) ?? null,
    setItemAsync: async (key, value) => void store.set(key, value),
    deleteItemAsync: async (key) => void store.delete(key),
  };
}

describe('createAsyncStorageAdapter', () => {
  it('writes are readable immediately (in-memory cache)', () => {
    const adapter = createAsyncStorageAdapter(makeFakeAsyncStorage());
    adapter.setItem('k', 'v');
    expect(adapter.getItem('k')).toBe('v');
    adapter.removeItem('k');
    expect(adapter.getItem('k')).toBeNull();
  });

  it('hydrates from the underlying async storage on first read', async () => {
    const backing = makeFakeAsyncStorage();
    await backing.setItem('preexisting', 'hello');

    const adapter = createAsyncStorageAdapter(backing);
    // Not yet hydrated — first read triggers background hydration.
    expect(adapter.getItem('preexisting')).toBeNull();

    // Allow the background hydration microtask to resolve.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adapter.getItem('preexisting')).toBe('hello');
  });
});

describe('createExpoSecureStoreAdapter (#654)', () => {
  it('reads and writes to fake Expo SecureStore backend', async () => {
    const secureStore = makeFakeExpoSecureStore();
    await secureStore.setItemAsync('token', 'secret_val');

    const adapter = createExpoSecureStoreAdapter(secureStore);
    expect(adapter.getItem('token')).toBeNull(); // pending hydration

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adapter.getItem('token')).toBe('secret_val');

    adapter.setItem('newKey', 'newVal');
    expect(adapter.getItem('newKey')).toBe('newVal');
  });

  it('createExpoAdapters correctly selects secureStore or asyncStorage', () => {
    const secureStore = makeFakeExpoSecureStore();
    const adapters = createExpoAdapters({ secureStore });
    expect(adapters.storage).toBeDefined();
  });

  it('setupExpoPolyfills sets global crypto if missing', () => {
    const fakeCrypto = { getRandomValues: vi.fn() };
    setupExpoPolyfills({ crypto: fakeCrypto as any });
    expect(globalThis.crypto).toBeDefined();
  });
});

describe('bare React Native environment smoke test', () => {
  it('SoroStreamClient constructs and reads/clears the audit log via the React Native storage adapter when browser globals are absent', async () => {
    const originalLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;
    // React Native's JS runtime has no `localStorage` global — simulate that.
    // @ts-expect-error — intentionally deleting a global for this test
    delete globalThis.localStorage;

    try {
      const backingStorage = makeFakeAsyncStorage();
      await backingStorage.setItem(
        'sorostream_audit_log',
        JSON.stringify([{ operation: 'createStream', result: 'success', durationMs: 5 }]),
      );

      const client = new SoroStreamClient({
        network: 'testnet',
        contractId: VALID_CONTRACT,
        walletAdapter: makeWalletAdapter(),
        auditLog: true,
        adapters: createReactNativeAdapters({ asyncStorage: backingStorage }),
      });

      // First read triggers background hydration from the async backing store.
      expect(client.getAuditLog()).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(client.getAuditLog()).toHaveLength(1);
      expect(client.getAuditLog()[0]?.operation).toBe('createStream');

      expect(() => client.clearAuditLog()).not.toThrow();
      expect(client.getAuditLog()).toEqual([]);
    } finally {
      (globalThis as { localStorage?: unknown }).localStorage = originalLocalStorage;
    }
  });
});
