import { describe, it, expect, vi } from 'vitest';
import { createKmsWalletAdapter, KmsWalletAdapter } from '../src/wallet.js';
import { Keypair, TransactionBuilder, Networks, Account } from '@stellar/stellar-sdk';

describe('KmsWalletAdapter (issue #306, #309)', () => {
  const dummyPublicKey = Keypair.random().publicKey();

  it('accepts an async signing function and returns public key', async () => {
    const mockSign = vi.fn().mockResolvedValue(new Uint8Array(64));
    const adapter = createKmsWalletAdapter({
      publicKey: dummyPublicKey,
      sign: mockSign,
    });

    expect(await adapter.isConnected()).toBe(true);
    expect(await adapter.getPublicKey()).toBe(dummyPublicKey);
  });

  it('invokes mock signing function exactly once per transaction submission with correct payload', async () => {
    const mockSign = vi.fn().mockResolvedValue(new Uint8Array(64));
    const adapter = new KmsWalletAdapter({
      publicKey: dummyPublicKey,
      sign: mockSign,
    });

    const account = new Account(dummyPublicKey, '100');
    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .setTimeout(30)
      .build();

    const xdrStr = tx.toXDR();
    const signedXdr = await adapter.signTransaction(xdrStr, 'testnet');

    expect(mockSign).toHaveBeenCalledTimes(1);
    expect(mockSign.mock.calls[0][0]).toBeInstanceOf(Uint8Array);
    expect(signedXdr).toBeDefined();
    expect(typeof signedXdr).toBe('string');
  });

  it('rejects transaction submission if signing function rejects its promise', async () => {
    const mockSign = vi.fn().mockRejectedValue(new Error('KMS Access Denied'));
    const adapter = createKmsWalletAdapter({
      publicKey: dummyPublicKey,
      sign: mockSign,
    });

    const account = new Account(dummyPublicKey, '100');
    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .setTimeout(30)
      .build();

    await expect(adapter.signTransaction(tx.toXDR(), 'testnet')).rejects.toThrow(
      'KMS Access Denied',
    );
  });

  it('throws error if constructed with invalid options', () => {
    expect(() =>
      createKmsWalletAdapter({ publicKey: '', sign: async () => new Uint8Array() }),
    ).toThrow('KmsWalletAdapter requires a valid publicKey');
    expect(() => createKmsWalletAdapter({ publicKey: dummyPublicKey, sign: null as any })).toThrow(
      'KmsWalletAdapter requires a sign function',
    );
  });
});
