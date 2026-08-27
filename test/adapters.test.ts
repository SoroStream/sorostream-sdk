/**
 * Tests for issue #199: injectable StorageAdapter / WebSocketFactory /
 * FetchAdapter so the SDK can run in environments (e.g. React Native) that
 * don't provide `localStorage` / `WebSocket` / `fetch` as globals.
 */
import { describe, it, expect, vi } from 'vitest';
import { SoroStreamClient, createClient } from '../src/SoroStreamClient.js';
import { resolveFederationAddress, watchClaimableWs } from '../src/utils.js';
import type { WalletAdapter } from '../src/types.js';
import type { StorageAdapter } from '../src/adapters.js';

const VALID_CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

function makeAdapter(): WalletAdapter {
  return {
    getPublicKey: vi
      .fn()
      .mockResolvedValue('GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF'),
    signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
    isConnected: vi.fn().mockResolvedValue(true),
  };
}

function makeMemoryStorageAdapter(): StorageAdapter {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    removeItem: (key) => void store.delete(key),
  };
}

describe('createClient', () => {
  it('returns a SoroStreamClient instance equivalent to `new SoroStreamClient(...)`', () => {
    const client = createClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: makeAdapter(),
    });
    expect(client).toBeInstanceOf(SoroStreamClient);
  });
});

describe('StorageAdapter — audit log', () => {
  it('uses the injected storage adapter instead of the global localStorage', () => {
    const storage = makeMemoryStorageAdapter();
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: makeAdapter(),
      auditLog: true,
      adapters: { storage },
    });

    // @ts-expect-error — accessing a private method for the purpose of this test
    client['writeAuditEntry']({ operation: 'test', result: 'success', durationMs: 1 });

    const log = client.getAuditLog();
    expect(log).toHaveLength(1);
    expect(log[0]?.operation).toBe('test');

    client.clearAuditLog();
    expect(client.getAuditLog()).toEqual([]);
  });

  it('degrades gracefully with no storage adapter available (e.g. React Native without localStorage)', () => {
    const originalLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;
    // @ts-expect-error — simulate an environment without localStorage
    delete globalThis.localStorage;

    try {
      const client = new SoroStreamClient({
        network: 'testnet',
        contractId: VALID_CONTRACT,
        walletAdapter: makeAdapter(),
        auditLog: true,
      });

      expect(() => client.getAuditLog()).not.toThrow();
      expect(client.getAuditLog()).toEqual([]);
      expect(() => client.clearAuditLog()).not.toThrow();
    } finally {
      (globalThis as { localStorage?: unknown }).localStorage = originalLocalStorage;
    }
  });
});

describe('FetchAdapter — resolveFederationAddress', () => {
  it('uses the injected fetch implementation instead of the global fetch', async () => {
    const mockPublicKey = 'GABC2DEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV';
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => `FEDERATION_SERVER="https://federation.example.com"`,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ account_id: mockPublicKey }),
      });

    const result = await resolveFederationAddress(
      'alice*example.com',
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toBe(mockPublicKey);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('WebSocketFactory — watchClaimableWs', () => {
  it('uses the injected WebSocket factory instead of the global WebSocket', () => {
    let capturedUrl: string | undefined;
    const fakeSocket = {
      onopen: null as (() => void) | null,
      onmessage: null as ((event: { data: string }) => void) | null,
      onerror: null as (() => void) | null,
      onclose: null as (() => void) | null,
      send: vi.fn(),
      close: vi.fn(),
    };
    const webSocketFactory = vi.fn((url: string) => {
      capturedUrl = url;
      return fakeSocket as unknown as WebSocket;
    });

    const onClaimable = vi.fn();
    const stop = watchClaimableWs(
      'wss://example.com/stream',
      '42',
      onClaimable,
      undefined,
      webSocketFactory,
    );

    expect(webSocketFactory).toHaveBeenCalledWith('wss://example.com/stream');
    expect(capturedUrl).toBe('wss://example.com/stream');

    fakeSocket.onmessage?.({
      data: JSON.stringify({ type: 'claimable', streamId: '42', value: '500' }),
    });
    expect(onClaimable).toHaveBeenCalledWith(500n);

    stop();
    expect(fakeSocket.close).toHaveBeenCalled();
  });

  it('throws a clear error when no WebSocket implementation is available and none is injected', () => {
    const originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
    // @ts-expect-error — simulate an environment without WebSocket
    delete globalThis.WebSocket;

    try {
      expect(() => watchClaimableWs('wss://example.com/stream', '42', vi.fn())).toThrow(
        /WebSocket/,
      );
    } finally {
      (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
    }
  });
});
