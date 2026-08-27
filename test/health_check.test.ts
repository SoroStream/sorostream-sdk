import { describe, it, expect, vi } from 'vitest';
import { SoroStreamClient } from '../src/SoroStreamClient.js';
import { Keypair } from '@stellar/stellar-sdk';

describe('SoroStreamClient.healthCheck (issue #308)', () => {
  const dummyPublicKey = Keypair.random().publicKey();
  const mockWallet = {
    getPublicKey: async () => dummyPublicKey,
    signTransaction: async (xdr: string) => xdr,
    isConnected: async () => true,
  };

  it('returns rpcReachable: false on connection refused without throwing', async () => {
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
      walletAdapter: mockWallet,
    });

    // Mock server.getHealth to simulate connection refused error
    (client as any).server = {
      getHealth: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8000')),
    };

    const res = await client.healthCheck({ timeoutMs: 1000 });
    expect(res.rpcReachable).toBe(false);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    expect(res.error).toBe('connect ECONNREFUSED 127.0.0.1:8000');
  });

  it('returns rpcReachable: false on RPC timeout without throwing', async () => {
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
      walletAdapter: mockWallet,
    });

    // Mock server.getHealth to simulate a slow response that exceeds timeout
    (client as any).server = {
      getHealth: vi
        .fn()
        .mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 2000))),
    };

    const res = await client.healthCheck({ timeoutMs: 50 });
    expect(res.rpcReachable).toBe(false);
    expect(res.latencyMs).toBeGreaterThanOrEqual(40);
    expect(res.error).toContain('timed out');
  });

  it('returns rpcReachable: true when RPC returns healthy status', async () => {
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
      walletAdapter: mockWallet,
    });

    (client as any).server = {
      getHealth: vi.fn().mockResolvedValue({ status: 'healthy' }),
    };

    const res = await client.healthCheck();
    expect(res.rpcReachable).toBe(true);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
