/**
 * Tests for issue #202: auto-detect the network from the RPC endpoint URL.
 *
 * - `detectNetworkFromRpcUrl` maps testnet/mainnet/horizon.stellar.org URLs.
 * - `SoroStreamClient` auto-resolves `network` from `rpcUrl` when `network`
 *   is omitted.
 * - An explicit `network` always overrides auto-detection.
 * - `getNetwork()` returns the resolved value.
 * - A console warning fires (non-production) when the explicit override
 *   mismatches the auto-detected network.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SoroStreamClient } from '../src/SoroStreamClient.js';
import { detectNetworkFromRpcUrl } from '../src/utils.js';
import type { WalletAdapter } from '../src/types.js';

const VALID_CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const VALID_ACCOUNT = 'GAXXZ5XSL2VTQPGWB3LPU5273HSJXMK7VHLZTF2XKW65QFZVA3XKULQZ';

function makeAdapter(): WalletAdapter {
  return {
    getPublicKey: vi.fn().mockResolvedValue(VALID_ACCOUNT),
    signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
    isConnected: vi.fn().mockResolvedValue(true),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('#202 detectNetworkFromRpcUrl', () => {
  it('resolves testnet URLs', () => {
    expect(detectNetworkFromRpcUrl('https://soroban-testnet.stellar.org')).toBe('testnet');
  });

  it('resolves mainnet URLs', () => {
    expect(detectNetworkFromRpcUrl('https://soroban-mainnet.stellar.org')).toBe('mainnet');
  });

  it('resolves horizon.stellar.org URLs to mainnet', () => {
    expect(detectNetworkFromRpcUrl('https://horizon.stellar.org')).toBe('mainnet');
  });

  it('is case-insensitive', () => {
    expect(detectNetworkFromRpcUrl('https://SOROBAN-TESTNET.stellar.org')).toBe('testnet');
  });

  it('returns undefined for an unrecognized URL', () => {
    expect(detectNetworkFromRpcUrl('https://my-custom-rpc.example.com')).toBeUndefined();
  });
});

describe('#202 SoroStreamClient network auto-detection', () => {
  it('auto-resolves testnet from a testnet rpcUrl when network is omitted', () => {
    const client = new SoroStreamClient({
      contractId: VALID_CONTRACT,
      walletAdapter: makeAdapter(),
      rpcUrl: 'https://soroban-testnet.stellar.org',
    });
    expect(client.getNetwork()).toBe('testnet');
  });

  it('auto-resolves mainnet from a mainnet rpcUrl when network is omitted', () => {
    const client = new SoroStreamClient({
      contractId: VALID_CONTRACT,
      walletAdapter: makeAdapter(),
      rpcUrl: 'https://horizon.stellar.org',
    });
    expect(client.getNetwork()).toBe('mainnet');
  });

  it('an explicit network overrides auto-detection', () => {
    const client = new SoroStreamClient({
      network: 'mainnet',
      contractId: VALID_CONTRACT,
      walletAdapter: makeAdapter(),
      rpcUrl: 'https://soroban-testnet.stellar.org',
    });
    expect(client.getNetwork()).toBe('mainnet');
  });

  it('getNetwork() returns the resolved network', () => {
    const client = new SoroStreamClient({
      network: 'futurenet',
      contractId: VALID_CONTRACT,
      walletAdapter: makeAdapter(),
    });
    expect(client.getNetwork()).toBe('futurenet');
  });

  it('throws when neither network nor a detectable rpcUrl is provided', () => {
    expect(
      () =>
        new SoroStreamClient({
          contractId: VALID_CONTRACT,
          walletAdapter: makeAdapter(),
          rpcUrl: 'https://custom-rpc.example.com',
        }),
    ).toThrow(/could not determine the network/);
  });

  it('warns in non-production when an explicit network mismatches the detected one', () => {
    const originalEnv = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'development';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const client = new SoroStreamClient({
        network: 'mainnet',
        contractId: VALID_CONTRACT,
        walletAdapter: makeAdapter(),
        rpcUrl: 'https://soroban-testnet.stellar.org',
        skipPeerCheck: true,
      });
      expect(client.getNetwork()).toBe('mainnet');
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0]![0]).toContain('testnet');
      expect(warnSpy.mock.calls[0]![0]).toContain('mainnet');
    } finally {
      process.env['NODE_ENV'] = originalEnv;
    }
  });

  it('does not warn when the explicit network matches the detected one', () => {
    const originalEnv = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'development';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      new SoroStreamClient({
        network: 'testnet',
        contractId: VALID_CONTRACT,
        walletAdapter: makeAdapter(),
        rpcUrl: 'https://soroban-testnet.stellar.org',
        skipPeerCheck: true,
      });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      process.env['NODE_ENV'] = originalEnv;
    }
  });

  it('does not warn in production even when the network mismatches', () => {
    const originalEnv = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      new SoroStreamClient({
        network: 'mainnet',
        contractId: VALID_CONTRACT,
        walletAdapter: makeAdapter(),
        rpcUrl: 'https://soroban-testnet.stellar.org',
        skipPeerCheck: true,
      });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      process.env['NODE_ENV'] = originalEnv;
    }
  });
});
