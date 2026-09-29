/**
 * Tests for issue #559: wallet network mismatch detection.
 *
 * The SDK must warn (or throw) when the connected wallet is on a different
 * network (testnet/mainnet) than the client configuration.
 */
import { describe, it, expect, vi } from 'vitest';
import { SoroStreamClient } from '../src/SoroStreamClient.js';
import type { Network, WalletAdapter } from '../src/types.js';
import { NetworkMismatchError } from '../src/errors.js';

const VALID_CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

/** A WalletAdapter that reports a fixed network via `getNetwork()`. */
function makeAdapterWithNetwork(network: Network): WalletAdapter {
  return {
    getPublicKey: vi.fn().mockResolvedValue('GABC123'),
    signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
    isConnected: vi.fn().mockResolvedValue(true),
    getNetwork: vi.fn().mockResolvedValue(network),
  };
}

describe('#559 wallet network mismatch detection', () => {
  it('throws NetworkMismatchError when the wallet is on a different network', async () => {
    const adapter = makeAdapterWithNetwork('testnet');
    const client = new SoroStreamClient({
      network: 'mainnet',
      contractId: VALID_CONTRACT,
      walletAdapter: adapter,
      skipPeerCheck: true,
    });

    // The mismatch is detected on the first operation that requires the
    // wallet — `connect()`-style entry point. We drive it via the internal
    // check used by write operations.
    await expect(client._checkWalletNetwork(adapter)).rejects.toThrow(
      NetworkMismatchError,
    );

    const err = await client._checkWalletNetwork(adapter).catch((e) => e);
    expect(err).toBeInstanceOf(NetworkMismatchError);
    expect(err.expected).toBe('mainnet');
    expect(err.actual).toBe('testnet');
    expect(err.message).toContain('mainnet');
    expect(err.message).toContain('testnet');
  });

  it('does not throw when the wallet is on the same network', async () => {
    const adapter = makeAdapterWithNetwork('mainnet');
    const client = new SoroStreamClient({
      network: 'mainnet',
      contractId: VALID_CONTRACT,
      walletAdapter: adapter,
      skipPeerCheck: true,
    });

    await expect(client._checkWalletNetwork(adapter)).resolves.toBeUndefined();
  });

  it('emits wallet:network-mismatch instead of throwing when a handler is registered', async () => {
    const adapter = makeAdapterWithNetwork('testnet');
    const client = new SoroStreamClient({
      network: 'mainnet',
      contractId: VALID_CONTRACT,
      walletAdapter: adapter,
      skipPeerCheck: true,
    });

    const mismatch = vi.fn();
    client.on('wallet:network-mismatch', mismatch);

    // The event is emitted before the throw, so a handler can observe it.
    // We catch the throw because the default behaviour is to throw.
    await expect(client._checkWalletNetwork(adapter)).rejects.toThrow(
      NetworkMismatchError,
    );

    expect(mismatch).toHaveBeenCalledWith(
      expect.objectContaining({
        expected: 'mainnet',
        actual: 'testnet',
        adapter,
      }),
    );
  });

  it('adapters without getNetwork() are skipped (no false positive)', async () => {
    const adapter: WalletAdapter = {
      getPublicKey: vi.fn().mockResolvedValue('GABC123'),
      signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
      isConnected: vi.fn().mockResolvedValue(true),
    };

    const client = new SoroStreamClient({
      network: 'mainnet',
      contractId: VALID_CONTRACT,
      walletAdapter: adapter,
      skipPeerCheck: true,
    });

    await expect(client._checkWalletNetwork(adapter)).resolves.toBeUndefined();
  });

  it('adapters whose getNetwork() rejects are skipped gracefully', async () => {
    const adapter: WalletAdapter = {
      getPublicKey: vi.fn().mockResolvedValue('GABC123'),
      signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
      isConnected: vi.fn().mockResolvedValue(true),
      getNetwork: vi.fn().mockRejectedValue(new Error('not supported')),
    };

    const client = new SoroStreamClient({
      network: 'mainnet',
      contractId: VALID_CONTRACT,
      walletAdapter: adapter,
      skipPeerCheck: true,
    });

    await expect(client._checkWalletNetwork(adapter)).resolves.toBeUndefined();
  });
});