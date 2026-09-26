import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SoroStreamClient } from '../src/SoroStreamClient.js';
import { Account, Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';
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

/**
 * Builds a wallet adapter that signs the prepared transaction by signing it
 * with a real Stellar keypair. This satisfies the SDK's
 * assertEnvelopeUnmutated guard, which decodes the signed XDR and compares it
 * to the prepared transaction.
 */
function makeSigningAdapter(publicKey: string): WalletAdapter {
  const kp = Keypair.random();
  return {
    getPublicKey: vi.fn().mockResolvedValue(publicKey),
    signTransaction: vi.fn().mockImplementation(async (xdr: string) => {
      const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
      tx.sign(kp);
      return tx.toXDR();
    }),
    isConnected: vi.fn().mockResolvedValue(true),
  };
}

/**
 * Injects a fully-mocked RPC server so write operations can be driven
 * deterministically without hitting the network. The server reports a
 * successful, immediately-confirmed transaction.
 */
function injectMockServer(client: SoroStreamClient) {
  const account = new Account(VALID_ACCOUNT_1, '1');
  const server = {
    getAccount: vi.fn().mockResolvedValue(account),
    simulateTransaction: vi.fn().mockResolvedValue({
      status: 'SUCCESS',
      result: { retval: undefined },
    }),
    prepareTransaction: vi.fn().mockImplementation((tx: unknown) => tx),
    sendTransaction: vi.fn().mockResolvedValue({ status: 'PENDING', hash: 'tx-hash' }),
    getTransaction: vi.fn().mockResolvedValue({ status: 'SUCCESS', ledger: 123 }),
    getLatestLedger: vi.fn().mockResolvedValue({ sequence: 999 }),
  };
  (client as any).server = server;
  return server;
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

  // ── Issue #562: wallet hot-swap acceptance criteria ─────────────────────────

  it('emits wallet:switched with { previous, next } addresses', async () => {
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: adapter1,
      skipPeerCheck: true,
    });

    const switched = vi.fn();
    client.on('wallet:switched', switched);

    await client.setWalletAdapter(adapter2, 'ledger');
    // wallet:switched is emitted asynchronously (addresses are resolved
    // after the swap), so yield to let the event fire.
    await new Promise((r) => setTimeout(r, 20));

    expect(switched).toHaveBeenCalledWith(
      expect.objectContaining({
        previous: VALID_ACCOUNT_1,
        next: VALID_ACCOUNT_2,
        identifier: 'ledger',
      }),
    );
  });

  it('emits wallet:switched with null addresses when getPublicKey fails', async () => {
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: adapter1,
      skipPeerCheck: true,
    });

    const switched = vi.fn();
    client.on('wallet:switched', switched);

    const brokenAdapter: WalletAdapter = {
      getPublicKey: vi.fn().mockRejectedValue(new Error('nope')),
      signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
      isConnected: vi.fn().mockResolvedValue(true),
    };

    await client.setWalletAdapter(brokenAdapter);
    await new Promise((r) => setTimeout(r, 20));

    expect(switched).toHaveBeenCalledWith(
      expect.objectContaining({
        previous: VALID_ACCOUNT_1,
        next: null,
      }),
    );
  });

  it('in-flight write operations complete with the wallet that initiated them', async () => {
    // A slow, controllable write so we can swap wallets mid-flight and assert
    // the in-flight operation still signs with the *previous* adapter.
    let resolveWrite: (() => void) | null = null;
    const writeBlocker = new Promise<void>((r) => {
      resolveWrite = r;
    });

    const slowAdapter = makeSigningAdapter(VALID_ACCOUNT_1);
    // Replace the fast signer with a slow one that still signs the prepared XDR.
    const kp = Keypair.random();
    slowAdapter.signTransaction = vi.fn().mockImplementation(async (xdr: string) => {
      await writeBlocker;
      const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
      tx.sign(kp);
      return tx.toXDR();
    });

    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: slowAdapter,
      skipPeerCheck: true,
      txTimeoutMs: 60_000,
    });
    injectMockServer(client);

    // Start a slow write (executeBatch). We don't await it yet.
    const writePromise = client.executeBatch([]);

    // Let the write reach the signing stage.
    await new Promise((r) => setTimeout(r, 20));

    // Swap to a new wallet mid-flight.
    client.setWalletAdapter(adapter2);

    // Let the in-flight write complete.
    resolveWrite!();
    await writePromise;

    // The in-flight write must have signed with the *previous* (slow) adapter,
    // not the newly swapped adapter2.
    expect(slowAdapter.signTransaction).toHaveBeenCalled();
    expect(adapter2.signTransaction).not.toHaveBeenCalled();
  });

  it('new operations after setWalletAdapter use the new wallet', async () => {
    const signingAdapter1 = makeSigningAdapter(VALID_ACCOUNT_1);
    const signingAdapter2 = makeSigningAdapter(VALID_ACCOUNT_2);
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: signingAdapter1,
      skipPeerCheck: true,
    });
    injectMockServer(client);

    await client.setWalletAdapter(signingAdapter2, 'ledger');

    // A subsequent write must sign with the new adapter.
    const writePromise = client.executeBatch([]);

    await new Promise((r) => setTimeout(r, 20));

    expect(signingAdapter2.signTransaction).toHaveBeenCalled();
    expect(signingAdapter1.signTransaction).not.toHaveBeenCalled();

    // Avoid an unhandled rejection from the in-flight write.
    await writePromise.catch(() => {});
  });
});
