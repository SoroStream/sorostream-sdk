import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AlbedoWalletAdapter,
  createAlbedoWalletAdapter,
  createAlbedoAdapter,
} from '../src/wallet.js';

describe('Issue #430: Albedo wallet adapter', () => {
  const originalWindow = (globalThis as any).window;

  afterEach(() => {
    (globalThis as any).window = originalWindow;
    vi.restoreAllMocks();
  });

  it('instantiates via constructor and helper functions', () => {
    const adapter1 = new AlbedoWalletAdapter();
    const adapter2 = createAlbedoWalletAdapter();
    const adapter3 = createAlbedoAdapter();

    expect(adapter1).toBeInstanceOf(AlbedoWalletAdapter);
    expect(adapter2).toBeInstanceOf(AlbedoWalletAdapter);
    expect(adapter3).toBeInstanceOf(AlbedoWalletAdapter);
  });

  it('returns pre-configured publicKey if supplied in config', async () => {
    const adapter = createAlbedoWalletAdapter({ publicKey: 'GALBEDO123456789' });
    expect(await adapter.getPublicKey()).toBe('GALBEDO123456789');
    expect(await adapter.isConnected()).toBe(true);
  });

  it('checks connection via custom provider or window.albedo', async () => {
    const mockProvider = {
      isConnected: vi.fn().mockResolvedValue(true),
      publicKey: vi.fn().mockResolvedValue({ pubkey: 'GALBEDO987' }),
    };

    const adapter = createAlbedoWalletAdapter({ provider: mockProvider });
    expect(await adapter.isConnected()).toBe(true);
    expect(await adapter.getPublicKey()).toBe('GALBEDO987');
  });

  it('checks isConnected false when no provider or window.albedo is available', async () => {
    (globalThis as any).window = undefined;
    const adapter = createAlbedoWalletAdapter();
    expect(await adapter.isConnected()).toBe(false);
  });

  it('fetches public key from window.albedo if no provider in config', async () => {
    (globalThis as any).window = {
      albedo: {
        publicKey: vi.fn().mockResolvedValue({ pubkey: 'GALBEDOWINDOW123' }),
      },
    };

    const adapter = createAlbedoWalletAdapter();
    expect(await adapter.isConnected()).toBe(true);
    expect(await adapter.getPublicKey()).toBe('GALBEDOWINDOW123');
  });

  it('handles string response and alternative field names from publicKey/getAccount', async () => {
    const mockProvider1 = {
      publicKey: vi.fn().mockResolvedValue('GALBEDO_STR'),
    };
    const adapter1 = createAlbedoWalletAdapter({ provider: mockProvider1 });
    expect(await adapter1.getPublicKey()).toBe('GALBEDO_STR');

    const mockProvider2 = {
      getPublicKey: vi.fn().mockResolvedValue({ publicKey: 'GALBEDO_PK' }),
    };
    const adapter2 = createAlbedoWalletAdapter({ provider: mockProvider2 });
    expect(await adapter2.getPublicKey()).toBe('GALBEDO_PK');

    const mockProvider3 = {
      getAccount: vi.fn().mockResolvedValue({ address: 'GALBEDO_ADDR' }),
    };
    const adapter3 = createAlbedoWalletAdapter({ provider: mockProvider3 });
    expect(await adapter3.getPublicKey()).toBe('GALBEDO_ADDR');
  });

  it('throws error when provider is missing on getPublicKey', async () => {
    (globalThis as any).window = undefined;
    const adapter = createAlbedoWalletAdapter();
    await expect(adapter.getPublicKey()).rejects.toThrow('Albedo wallet provider is not available');
  });

  it('throws error when provider returns empty public key', async () => {
    const mockProvider = {
      publicKey: vi.fn().mockResolvedValue({}),
    };
    const adapter = createAlbedoWalletAdapter({ provider: mockProvider });
    await expect(adapter.getPublicKey()).rejects.toThrow(
      'Albedo wallet provider did not return a valid public key',
    );
  });

  it('signs transaction using provider tx method (Albedo intent format)', async () => {
    const mockProvider = {
      tx: vi.fn().mockResolvedValue({ signed_envelope_xdr: 'AAAA_SIGNED_XDR_ALBEDO' }),
    };

    const adapter = createAlbedoWalletAdapter({ provider: mockProvider });
    const signed = await adapter.signTransaction('AAAA_UNSIGNED_XDR', 'testnet');

    expect(signed).toBe('AAAA_SIGNED_XDR_ALBEDO');
    expect(mockProvider.tx).toHaveBeenCalledWith(
      expect.objectContaining({
        xdr: 'AAAA_UNSIGNED_XDR',
        network: 'testnet',
      }),
    );
  });

  it('signs transaction mapping mainnet to public network in tx intent', async () => {
    const mockProvider = {
      tx: vi.fn().mockResolvedValue({ signed_envelope_xdr: 'AAAA_MAINNET_SIGNED_XDR' }),
    };

    const adapter = createAlbedoWalletAdapter({ provider: mockProvider });
    const signed = await adapter.signTransaction('AAAA_UNSIGNED_XDR', 'mainnet');

    expect(signed).toBe('AAAA_MAINNET_SIGNED_XDR');
    expect(mockProvider.tx).toHaveBeenCalledWith(
      expect.objectContaining({
        xdr: 'AAAA_UNSIGNED_XDR',
        network: 'public',
      }),
    );
  });

  it('supports fallback signing methods like signTransaction and sign', async () => {
    const mockProvider1 = {
      signTransaction: vi.fn().mockResolvedValue({ signedTxXdr: 'AAAA_FALLBACK_1' }),
    };
    const adapter1 = createAlbedoWalletAdapter({ provider: mockProvider1 });
    expect(await adapter1.signTransaction('AAAA_UNSIGNED', 'testnet')).toBe('AAAA_FALLBACK_1');

    const mockProvider2 = {
      sign: vi.fn().mockResolvedValue('AAAA_FALLBACK_2_STRING'),
    };
    const adapter2 = createAlbedoWalletAdapter({ provider: mockProvider2 });
    expect(await adapter2.signTransaction('AAAA_UNSIGNED', 'testnet')).toBe(
      'AAAA_FALLBACK_2_STRING',
    );
  });

  it('throws error when provider is missing on signTransaction', async () => {
    (globalThis as any).window = undefined;
    const adapter = createAlbedoWalletAdapter();
    await expect(adapter.signTransaction('AAAA_XDR', 'testnet')).rejects.toThrow(
      'Albedo wallet provider is not available',
    );
  });

  it('throws error when provider fails to return signed XDR', async () => {
    const mockProvider = {
      tx: vi.fn().mockResolvedValue({}),
    };
    const adapter = createAlbedoWalletAdapter({ provider: mockProvider });
    await expect(adapter.signTransaction('AAAA_XDR', 'testnet')).rejects.toThrow(
      'Albedo wallet failed to sign transaction',
    );
  });

  it('supports network and connection change listeners', () => {
    const adapter = createAlbedoWalletAdapter();
    const networkCallback = vi.fn();
    const connCallback = vi.fn();

    const unsubNetwork = adapter.onNetworkChange?.(networkCallback);
    const unsubConn = adapter.onConnectionChange?.(connCallback);

    expect(typeof unsubNetwork).toBe('function');
    expect(typeof unsubConn).toBe('function');

    unsubNetwork?.();
    unsubConn?.();
  });
});
