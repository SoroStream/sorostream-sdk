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
import { createAsyncStorageAdapter, createReactNativeAdapters } from '../src/index.js';
import type { AsyncStorageLike } from '../src/index.js';

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
