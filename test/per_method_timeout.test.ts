import { describe, it, expect, vi } from 'vitest';
import { Account, TransactionBuilder, Operation, Asset, nativeToScVal } from '@stellar/stellar-sdk';
import { SoroStreamClient } from '../src/SoroStreamClient.js';
import type { WalletAdapter } from '../src/types.js';

const VALID_CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const VALID_ACCOUNT = 'GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF';

function makeValidTxXdr(): string {
  const dummyAccount = new Account(VALID_ACCOUNT, '1');
  const tx = new TransactionBuilder(dummyAccount, {
    fee: '100',
    networkPassphrase: 'Test SDF Network ; September 2015',
  })
    .addOperation(
      Operation.payment({
        destination: VALID_ACCOUNT,
        asset: Asset.native(),
        amount: '10',
      }),
    )
    .setTimeout(30)
    .build();
  return tx.toXDR();
}

function makeMockAdapter(validXdr: string): WalletAdapter {
  return {
    getPublicKey: vi.fn().mockResolvedValue(VALID_ACCOUNT),
    signTransaction: vi.fn().mockResolvedValue(validXdr),
    isConnected: vi.fn().mockResolvedValue(true),
  };
}

describe('Issue #434: Configurable per-method request timeout', () => {
  it('uses per-method timeoutMs option overriding default txTimeoutMs', async () => {
    const validXdr = makeValidTxXdr();
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: makeMockAdapter(validXdr),
      txTimeoutMs: 60000,
    });

    const mockServer = {
      getAccount: vi.fn().mockResolvedValue(new Account(VALID_ACCOUNT, '1')),
      prepareTransaction: vi.fn().mockImplementation((tx) => Promise.resolve(tx)),
      sendTransaction: vi.fn().mockResolvedValue({ status: 'PENDING', hash: 'tx123' }),
      getTransaction: vi.fn().mockResolvedValue({ status: 'NOT_FOUND' }),
      simulateTransaction: vi.fn().mockResolvedValue({
        result: { retval: nativeToScVal(100n) },
      }),
    };

    (client as any).server = mockServer;
    vi.spyOn(client, 'getClaimable').mockResolvedValue(100n);

    const start = Date.now();
    await expect(
      client.withdraw(
        { streamId: '1' },
        undefined,
        { timeoutMs: 150 },
      ),
    ).rejects.toThrow('Transaction confirmation timed out after 150ms');

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
  });

  it('accepts timeout alias in WriteOptions', async () => {
    const validXdr = makeValidTxXdr();
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: makeMockAdapter(validXdr),
      txTimeoutMs: 60000,
    });

    const mockServer = {
      getAccount: vi.fn().mockResolvedValue(new Account(VALID_ACCOUNT, '1')),
      prepareTransaction: vi.fn().mockImplementation((tx) => Promise.resolve(tx)),
      sendTransaction: vi.fn().mockResolvedValue({ status: 'PENDING', hash: 'tx456' }),
      getTransaction: vi.fn().mockResolvedValue({ status: 'NOT_FOUND' }),
      simulateTransaction: vi.fn().mockResolvedValue({
        result: { retval: nativeToScVal(true) },
      }),
    };

    (client as any).server = mockServer;
    vi.spyOn(client, 'getStream').mockResolvedValue({
      id: '2',
      sender: VALID_ACCOUNT,
      recipient: VALID_ACCOUNT,
      token: VALID_CONTRACT,
      deposit: 1000n,
      flowRate: 10n,
      startTime: 1000,
      endTime: 2000,
      lastWithdrawTime: 1000,
      status: 'Active',
      autoRenew: false,
    });

    await expect(
      client.cancelStream(
        { streamId: '2' },
        undefined,
        { timeout: 100 },
      ),
    ).rejects.toThrow('Transaction confirmation timed out after 100ms');
  });
});
