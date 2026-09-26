/**
 * Tests for Issue #549: `pauseStream` / `resumeStream` on SoroStreamClient.
 *
 * Verifies:
 * - Both methods encode and submit the pause/resume instruction.
 * - They return a TransactionResult (`{ txHash }`) consistent with other write methods.
 * - Authorization failures (e.g. wallet rejects/disconnected) surface to the caller.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { SoroStreamClient } from '../src/SoroStreamClient.js';
import type { WalletAdapter } from '../src/types.js';

const TEST_PK = Keypair.random().publicKey();
const CONTRACT_ID = 'CAVTXNC2WCHINDNP4VBLSOQA2667VE3RPQZNGD5TFI4U2QSHTVAC667T';

describe('Issue #549: pauseStream / resumeStream', () => {
  let client: SoroStreamClient;
  let mockAdapter: WalletAdapter;

  beforeEach(() => {
    mockAdapter = {
      getPublicKey: vi.fn().mockResolvedValue(TEST_PK),
      signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
      isConnected: vi.fn().mockResolvedValue(true),
    };

    client = new SoroStreamClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      walletAdapter: mockAdapter,
    });
  });

  describe('happy path', () => {
    it('pauseStream encodes the pause instruction and submits it', async () => {
      const submit = vi
        .spyOn(client, 'buildAndSubmit' as never)
        .mockResolvedValue({ txHash: 'txhash_pause', ledger: 0 } as never);
      const pauseSpy = vi.spyOn(client['encoder'], 'pauseStream');

      const result = await client.pauseStream({ streamId: '42' });

      expect(result.txHash).toBe('txhash_pause');
      expect(pauseSpy).toHaveBeenCalledWith('42', TEST_PK);
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it('resumeStream encodes the resume instruction and submits it', async () => {
      const submit = vi
        .spyOn(client, 'buildAndSubmit' as never)
        .mockResolvedValue({ txHash: 'txhash_resume', ledger: 0 } as never);
      const resumeSpy = vi.spyOn(client['encoder'], 'resumeStream');

      const result = await client.resumeStream({ streamId: '42' });

      expect(result.txHash).toBe('txhash_resume');
      expect(resumeSpy).toHaveBeenCalledWith('42', TEST_PK);
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it('returns a TransactionResult consistent with other write methods', async () => {
      vi.spyOn(client, 'buildAndSubmit' as never).mockResolvedValue({
        txHash: 'txhash_pause',
        ledger: 0,
      } as never);

      const pause = await client.pauseStream({ streamId: '42' });
      const resume = await client.resumeStream({ streamId: '42' });

      expect(pause).toEqual({ txHash: 'txhash_pause' });
      expect(resume).toEqual({ txHash: 'txhash_pause' });
    });
  });

  describe('authorization-failure error cases', () => {
    it('pauseStream surfaces a wallet authorization rejection', async () => {
      (mockAdapter.getPublicKey as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('User denied authorization'),
      );

      await expect(client.pauseStream({ streamId: '42' })).rejects.toThrow(
        'User denied authorization',
      );
    });

    it('resumeStream surfaces a wallet authorization rejection', async () => {
      (mockAdapter.getPublicKey as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('User denied authorization'),
      );

      await expect(client.resumeStream({ streamId: '42' })).rejects.toThrow(
        'User denied authorization',
      );
    });

    it('pauseStream surfaces a signature rejection without swallowing it', async () => {
      vi.spyOn(client, 'buildAndSubmit' as never).mockRejectedValue(
        new Error('signing request rejected by wallet'),
      );

      await expect(client.pauseStream({ streamId: '42' })).rejects.toThrow(
        'signing request rejected by wallet',
      );
    });
  });
});
