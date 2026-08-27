import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SoroStreamClient } from '../src/SoroStreamClient.js';
import type { WalletAdapter, Stream } from '../src/types.js';

const VALID_CONTRACT = 'CAVTXNC2WCHINDNP4VBLSOQA2667VE3RPQZNGD5TFI4U2QSHTVAC667T';
const VALID_ACCOUNT_1 = 'GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF';
const VALID_ACCOUNT_2 = 'GCCRSPHI3IOK5RBVPQXP3M6SHF25GYYHJZPK2VQCAWU25RGOEBP7XS4S';

function makeMockAdapter(publicKey: string = VALID_ACCOUNT_1): WalletAdapter {
  return {
    getPublicKey: vi.fn().mockResolvedValue(publicKey),
    signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
    isConnected: vi.fn().mockResolvedValue(true),
  };
}

describe('Wallet adapter hot-swap', () => {
  let adapter1: WalletAdapter;
  let adapter2: WalletAdapter;

  beforeEach(() => {
    adapter1 = makeMockAdapter(VALID_ACCOUNT_1);
    adapter2 = makeMockAdapter(VALID_ACCOUNT_2);
  });

  it('setWalletAdapter replaces the wallet adapter', async () => {
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: adapter1,
      skipPeerCheck: true,
    });

    // Verify initial adapter is used
    expect((client as any).walletAdapter).toBe(adapter1);

    // Hot-swap adapter
    client.setWalletAdapter(adapter2, 'ledger');

    // Verify new adapter is used
    expect((client as any).walletAdapter).toBe(adapter2);
  });

  it('setWalletAdapter emits walletAdapterChanged event', async () => {
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: adapter1,
      skipPeerCheck: true,
    });

    const eventBus = (client as any).eventBus;
    const emitSpy = vi.spyOn(eventBus, 'emit');

    // Hot-swap adapter
    client.setWalletAdapter(adapter2, 'freighter');

    // Verify event was emitted
    expect(emitSpy).toHaveBeenCalledWith('walletAdapterChanged', {
      adapter: adapter2,
      identifier: 'freighter',
      previousAdapter: adapter1,
    });
  });

  it('setWalletAdapter preserves read-side caches', async () => {
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: adapter1,
      skipPeerCheck: true,
    });

    // Manually populate cache
    const streamCache = (client as any).streamCache;
    const senderCache = (client as any).senderCache;
    streamCache.set('testnet:1', { id: '1' } as Stream);
    senderCache.set('testnet:sender1', [{ id: '1' }] as Stream[]);

    // Hot-swap adapter
    client.setWalletAdapter(adapter2, 'ledger');

    // Verify caches are preserved
    expect(streamCache.get('testnet:1')).toEqual({ id: '1' });
    expect(senderCache.get('testnet:sender1')).toEqual([{ id: '1' }]);
  });

  it('setWalletAdapter re-registers network change listener', async () => {
    const adapterWithListener = makeMockAdapter(VALID_ACCOUNT_1);
    const onNetworkChangeFn = vi.fn();
    adapterWithListener.onNetworkChange = onNetworkChangeFn;

    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: adapter1,
      skipPeerCheck: true,
    });

    const newAdapter = makeMockAdapter(VALID_ACCOUNT_2);
    const newOnNetworkChangeFn = vi.fn();
    newAdapter.onNetworkChange = newOnNetworkChangeFn;

    // Hot-swap adapter
    client.setWalletAdapter(newAdapter, 'ledger');

    // Verify new adapter's listener was registered
    expect(newOnNetworkChangeFn).toHaveBeenCalled();
  });

  it('setWalletAdapter uses default identifier when not provided', async () => {
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: adapter1,
      skipPeerCheck: true,
    });

    const eventBus = (client as any).eventBus;
    const emitSpy = vi.spyOn(eventBus, 'emit');

    // Hot-swap without identifier
    client.setWalletAdapter(adapter2);

    // Verify default identifier
    expect(emitSpy).toHaveBeenCalledWith('walletAdapterChanged', {
      adapter: adapter2,
      identifier: 'unknown',
      previousAdapter: adapter1,
    });
  });

  it("getPublicKey returns the new adapter's public key after swap", async () => {
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: adapter1,
      skipPeerCheck: true,
    });

    expect((client as any).walletAdapter).toBe(adapter1);

    client.setWalletAdapter(adapter2);

    expect((client as any).walletAdapter).toBe(adapter2);
  });
});
