import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  LobstrWalletAdapter,
  createLobstrWalletAdapter,
  createLobstrAdapter,
} from '../src/wallet.js';

describe('Issue #431: Lobstr wallet adapter', () => {
  const originalWindow = (globalThis as any).window;

  afterEach(() => {
    (globalThis as any).window = originalWindow;
  });

  it('instantiates via constructor and helper functions', () => {
    const adapter1 = new LobstrWalletAdapter();
    const adapter2 = createLobstrWalletAdapter();
    const adapter3 = createLobstrAdapter();

    expect(adapter1).toBeInstanceOf(LobstrWalletAdapter);
    expect(adapter2).toBeInstanceOf(LobstrWalletAdapter);
    expect(adapter3).toBeInstanceOf(LobstrWalletAdapter);
  });

  it('returns pre-configured publicKey if supplied in config', async () => {
    const adapter = createLobstrWalletAdapter({ publicKey: 'GLOBSTR123' });
    expect(await adapter.getPublicKey()).toBe('GLOBSTR123');
  });

  it('checks connection via custom provider or window.lobstr', async () => {
    const mockProvider = {
      isConnected: vi.fn().mockResolvedValue(true),
      getPublicKey: vi.fn().mockResolvedValue('GLOBSTR456'),
    };

    const adapter = createLobstrWalletAdapter({ provider: mockProvider });
    expect(await adapter.isConnected()).toBe(true);
    expect(await adapter.getPublicKey()).toBe('GLOBSTR456');
  });

  it('signs transaction using provider signTransaction method', async () => {
    const mockProvider = {
      getPublicKey: vi.fn().mockResolvedValue('GLOBSTR789'),
      signTransaction: vi.fn().mockResolvedValue('signed_lobstr_xdr'),
    };

    const adapter = createLobstrWalletAdapter({ provider: mockProvider });
    const signed = await adapter.signTransaction('unsigned_xdr', 'testnet');
    expect(signed).toBe('signed_lobstr_xdr');
    expect(mockProvider.signTransaction).toHaveBeenCalledWith('unsigned_xdr', {
      networkPassphrase: 'Test SDF Network ; September 2015',
      network: 'testnet',
    });
  });

  it('throws informative error when provider is missing', async () => {
    const adapter = createLobstrWalletAdapter({});
    expect(await adapter.isConnected()).toBe(false);
    await expect(adapter.getPublicKey()).rejects.toThrow('Lobstr wallet provider is not available');
    await expect(adapter.signTransaction('xdr', 'testnet')).rejects.toThrow(
      'Lobstr wallet provider is not available',
    );
  });

  it('supports event listener registration methods', () => {
    const adapter = createLobstrWalletAdapter({ publicKey: 'GKEY' });
    const listener = vi.fn();

    const unsubConnection = adapter.onConnectionChange!(listener);
    const unsubNetwork = adapter.onNetworkChange!(listener);

    expect(typeof unsubConnection).toBe('function');
    expect(typeof unsubNetwork).toBe('function');

    unsubConnection();
    unsubNetwork();
  });
});
