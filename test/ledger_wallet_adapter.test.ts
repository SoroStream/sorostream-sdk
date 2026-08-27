import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LedgerWalletAdapter, createLedgerWalletAdapter, createLedgerAdapter } from '../src/wallet.js';
import { Keypair, TransactionBuilder, Networks, Operation } from '@stellar/stellar-sdk';

describe('Issue #432: Ledger hardware wallet adapter', () => {
  const originalWindow = (globalThis as any).window;
  const originalNavigator = (globalThis as any).navigator;

  afterEach(() => {
    (globalThis as any).window = originalWindow;
    try {
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true,
        writable: true,
      });
    } catch {}
  });

  it('instantiates via constructor and helper functions', () => {
    const adapter1 = new LedgerWalletAdapter();
    const adapter2 = createLedgerWalletAdapter();
    const adapter3 = createLedgerAdapter({});

    expect(adapter1).toBeInstanceOf(LedgerWalletAdapter);
    expect(adapter2).toBeInstanceOf(LedgerWalletAdapter);
    expect(adapter3).toBeInstanceOf(LedgerWalletAdapter);
  });

  it('returns pre-configured publicKey if supplied in config', async () => {
    const adapter = createLedgerWalletAdapter({ publicKey: 'GLEDGER123' });
    expect(await adapter.getPublicKey()).toBe('GLEDGER123');
  });

  it('checks connection status via isConnected()', async () => {
    const mockTransport = {};
    const adapterWithTransport = createLedgerWalletAdapter({ transport: mockTransport });
    expect(await adapterWithTransport.isConnected()).toBe(true);

    const adapterNoTransport = createLedgerWalletAdapter();
    // In Node test environment without window, returns false
    expect(await adapterNoTransport.isConnected()).toBe(false);

    (globalThis as any).window = { navigator: { usb: {} } };
    expect(await adapterNoTransport.isConnected()).toBe(true);
  });

  it('fetches public key from transport using getPublicKey()', async () => {
    const mockTransport = {};
    const adapter = createLedgerWalletAdapter({
      transport: mockTransport,
      bip32Path: "44'/148'/0'",
    });

    const kp = Keypair.random();
    // Inject mock app instance behavior by overriding getPublicKey internally
    (adapter as any).getAppInstance = vi.fn().mockResolvedValue({
      getPublicKey: vi.fn().mockResolvedValue({ publicKey: kp.publicKey() }),
    });

    const pubKey = await adapter.getPublicKey();
    expect(pubKey).toBe(kp.publicKey());
  });

  it('signs transaction envelope using signTransaction()', async () => {
    const kp = Keypair.random();
    const sourceKp = Keypair.random();
    const tx = new TransactionBuilder(
      new (await import('@stellar/stellar-sdk')).Account(sourceKp.publicKey(), '100'),
      { fee: '100', networkPassphrase: Networks.TESTNET },
    )
      .addOperation(Operation.payment({
        destination: kp.publicKey(),
        asset: (await import('@stellar/stellar-sdk')).Asset.native(),
        amount: '10',
      }))
      .setTimeout(30)
      .build();

    const unsignedXdr = tx.toEnvelope().toXDR('base64');
    const mockSig = Buffer.alloc(64, 1);

    const adapter = createLedgerWalletAdapter({
      publicKey: kp.publicKey(),
    });

    (adapter as any).getAppInstance = vi.fn().mockResolvedValue({
      signHash: vi.fn().mockResolvedValue({ signature: mockSig }),
      getPublicKey: vi.fn().mockResolvedValue({ publicKey: kp.publicKey() }),
    });

    const signedXdr = await adapter.signTransaction(unsignedXdr, 'testnet');
    expect(signedXdr).toBeDefined();
    expect(typeof signedXdr).toBe('string');
  });

  it('supports onConnectionChange and onNetworkChange listeners', () => {
    const adapter = createLedgerWalletAdapter({ publicKey: 'GLEDGER' });
    const listener = vi.fn();

    const unsubConnection = adapter.onConnectionChange!(listener);
    const unsubNetwork = adapter.onNetworkChange!(listener);

    expect(typeof unsubConnection).toBe('function');
    expect(typeof unsubNetwork).toBe('function');

    unsubConnection();
    unsubNetwork();
  });
});
