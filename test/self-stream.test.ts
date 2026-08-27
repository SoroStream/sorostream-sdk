import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SoroStreamClient } from '../src/SoroStreamClient.js';
import { SelfStreamError } from '../src/errors.js';
import type { WalletAdapter, CreateStreamParams } from '../src/types.js';

const VALID_CONTRACT = 'CAVTXNC2WCHINDNP4VBLSOQA2667VE3RPQZNGD5TFI4U2QSHTVAC667T';
const VALID_ACCOUNT_1 = 'GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF';
const VALID_ACCOUNT_2 = 'GCCRSPHI3IOK5RBVPQXP3M6SHF25GYYHJZPK2VQCAWU25RGOEBP7XS4S';
const VALID_TOKEN = 'CAVTXNC2WCHINDNP4VBLSOQA2667VE3RPQZNGD5TFI4U2QSHTVAC667T';

function makeMockAdapter(publicKey: string): WalletAdapter {
  return {
    getPublicKey: vi.fn().mockResolvedValue(publicKey),
    signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
    isConnected: vi.fn().mockResolvedValue(true),
  };
}

describe('Self-stream prevention (issue #232)', () => {
  let adapter: WalletAdapter;

  beforeEach(() => {
    adapter = makeMockAdapter(VALID_ACCOUNT_1);
  });

  it('throws SelfStreamError when recipient equals sender', async () => {
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: adapter,
      skipPeerCheck: true,
    });

    const params: CreateStreamParams = {
      recipient: VALID_ACCOUNT_1, // same as sender
      token: VALID_TOKEN,
      amount: 100n,
      ratePerSecond: 1n,
      durationSeconds: 60,
    };

    await expect(client.createStream(params)).rejects.toThrow(SelfStreamError);
  });

  it('allows different recipient and sender', async () => {
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: adapter,
      skipPeerCheck: true,
    });

    const params: CreateStreamParams = {
      recipient: VALID_ACCOUNT_2, // different from sender
      token: VALID_TOKEN,
      amount: 100n,
      ratePerSecond: 1n,
      durationSeconds: 60,
    };

    // Should not throw SelfStreamError (may throw other errors due to RPC mocking)
    try {
      await client.createStream(params);
    } catch (error) {
      expect(error).not.toBeInstanceOf(SelfStreamError);
    }
  });

  it('SelfStreamError has correct name and message', () => {
    const error = new SelfStreamError();
    expect(error.name).toBe('SelfStreamError');
    expect(error.message).toContain(
      'Cannot create a stream where the recipient is the same as the sender',
    );
  });

  it('SelfStreamError extends SoroStreamError', async () => {
    const { SoroStreamError } = await import('../src/errors.js');
    const error = new SelfStreamError();
    expect(error).toBeInstanceOf(SoroStreamError);
  });
});
