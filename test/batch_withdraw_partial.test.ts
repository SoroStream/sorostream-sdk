/**
 * Tests for issue #229: batchWithdraw must return partial results when some
 * streams succeed and others fail, instead of throwing on the first error.
 */
import { describe, it, expect, vi } from 'vitest';
import { SoroStreamClient } from '../src/SoroStreamClient.js';
import type { WalletAdapter } from '../src/types.js';

const VALID_CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const RECIPIENT = 'GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF';

function makeAdapter(): WalletAdapter {
  return {
    getPublicKey: vi.fn().mockResolvedValue(RECIPIENT),
    signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
    isConnected: vi.fn().mockResolvedValue(true),
  };
}

describe('#229 batchWithdraw — partial results', () => {
  it('returns successes and failures separately without throwing', async () => {
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: makeAdapter(),
    });

    // Stub executeBatch to fail on the second chunk
    vi.spyOn(client, 'executeBatch')
      .mockResolvedValueOnce('tx1') // first chunk succeeds
      .mockRejectedValueOnce(new Error('chunk2 failed')); // second chunk fails

    vi.spyOn(client, 'getClaimable').mockResolvedValue(100n);

    const result = await client.batchWithdraw(
      ['1', '2', '3', '4', '5'],
      2, // batchSize = 2 → 3 chunks (2+2+1)
    );

    expect(result.successes).toEqual(['1', '2']);
    expect(result.failures).toHaveLength(3);
    expect(result.failures[0]!.id).toBe('3');
    expect(result.failures[0]!.error.message).toContain('chunk2 failed');
  });

  it('never throws — empty successes if all batches fail', async () => {
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: makeAdapter(),
    });

    vi.spyOn(client, 'executeBatch').mockRejectedValue(new Error('all failed'));
    vi.spyOn(client, 'getClaimable').mockResolvedValue(100n);

    const result = await client.batchWithdraw(['1', '2', '3']);

    expect(result.successes).toEqual([]);
    expect(result.failures).toHaveLength(3);
    expect(result.failures.every((f) => f.error.message === 'all failed')).toBe(true);
  });

  it('returns all successes when no failures occur', async () => {
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: makeAdapter(),
    });

    vi.spyOn(client, 'executeBatch').mockResolvedValue('tx_all_ok');
    vi.spyOn(client, 'getClaimable').mockResolvedValue(100n);

    const result = await client.batchWithdraw(['1', '2', '3']);

    expect(result.successes).toEqual(['1', '2', '3']);
    expect(result.failures).toEqual([]);
  });

  it('associates each failure with the correct stream ID', async () => {
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: makeAdapter(),
    });

    // First chunk fails, second chunk succeeds
    vi.spyOn(client, 'executeBatch')
      .mockRejectedValueOnce(new Error('chunk1 failed'))
      .mockResolvedValueOnce('tx2');

    vi.spyOn(client, 'getClaimable').mockResolvedValue(100n);

    const result = await client.batchWithdraw(['10', '20', '30', '40'], 2);

    expect(result.failures.map((f) => f.id)).toEqual(['10', '20']);
    expect(result.successes).toEqual(['30', '40']);
  });

  it('tolerates individual getClaimable failures without blocking submission', async () => {
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: makeAdapter(),
    });

    vi.spyOn(client, 'executeBatch').mockResolvedValue('tx_ok');

    // getClaimable throws on stream "2"
    vi.spyOn(client, 'getClaimable')
      .mockResolvedValueOnce(100n)
      .mockRejectedValueOnce(new Error('claimable fetch failed'))
      .mockResolvedValueOnce(100n);

    const result = await client.batchWithdraw(['1', '2', '3']);

    // Even though getClaimable failed, executeBatch was still called and succeeded
    expect(result.successes).toEqual(['1', '2', '3']);
    expect(result.failures).toEqual([]);
  });

  it('returns BatchWithdrawPartialResult with correct shape', async () => {
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: makeAdapter(),
    });

    vi.spyOn(client, 'executeBatch').mockResolvedValue('tx');
    vi.spyOn(client, 'getClaimable').mockResolvedValue(100n);

    const result = await client.batchWithdraw(['1']);

    expect(result).toHaveProperty('successes');
    expect(result).toHaveProperty('failures');
    expect(Array.isArray(result.successes)).toBe(true);
    expect(Array.isArray(result.failures)).toBe(true);
  });

  it('each failure entry includes stream id and error', async () => {
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: makeAdapter(),
    });

    vi.spyOn(client, 'executeBatch').mockRejectedValue(new Error('rpc error'));
    vi.spyOn(client, 'getClaimable').mockResolvedValue(100n);

    const result = await client.batchWithdraw(['42']);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.id).toBe('42');
    expect(result.failures[0]!.error).toBeInstanceOf(Error);
    expect(result.failures[0]!.error.message).toBe('rpc error');
  });
});
