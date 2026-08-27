/**
 * Tests for issue #215: the SDK must detect wallet-initiated network changes
 * (e.g. the user switches networks in Freighter mid-session) and
 * automatically re-point the client at the new network.
 */
import { describe, it, expect, vi } from 'vitest';
import { SoroStreamClient } from '../src/SoroStreamClient.js';
import type { Network, WalletAdapter } from '../src/types.js';
import { createFreighterAdapter } from '../src/wallet.js';

const VALID_CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

/** A WalletAdapter whose `onNetworkChange` is driven manually by the test. */
function makeAdapterWithNetworkChange() {
  let listener: ((network: Network) => void) | null = null;
  const adapter: WalletAdapter = {
    getPublicKey: vi.fn().mockResolvedValue('GABC123'),
    signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
    isConnected: vi.fn().mockResolvedValue(true),
    onNetworkChange(callback) {
      listener = callback;
      return () => {
        listener = null;
      };
    },
  };
  return {
    adapter,
    simulateNetworkChange(network: Network) {
      listener?.(network);
    },
  };
}

describe('#215 automatic network switch handling', () => {
  it("updates the client's network config when the wallet switches networks", () => {
    const { adapter, simulateNetworkChange } = makeAdapterWithNetworkChange();
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: adapter,
      skipPeerCheck: true,
    });

    expect(client.getNetwork()).toBe('testnet');

    simulateNetworkChange('mainnet');

    expect(client.getNetwork()).toBe('mainnet');
  });

  it("subsequent RPC calls use the new network's endpoint", () => {
    const { adapter, simulateNetworkChange } = makeAdapterWithNetworkChange();
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: adapter,
      skipPeerCheck: true,
    });

    expect((client as any).server.serverURL.toString()).toContain('soroban-testnet.stellar.org');

    simulateNetworkChange('mainnet');

    expect((client as any).server.serverURL.toString()).toContain('soroban.stellar.org');
    expect((client as any).server.serverURL.toString()).not.toContain('testnet');
  });

  it('emits a networkChanged event with the new network identifier', () => {
    const { adapter, simulateNetworkChange } = makeAdapterWithNetworkChange();
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: adapter,
      skipPeerCheck: true,
    });

    const onChanged = vi.fn();
    client.onNetworkChanged(onChanged);

    simulateNetworkChange('futurenet');

    expect(onChanged).toHaveBeenCalledOnce();
    expect(onChanged).toHaveBeenCalledWith('futurenet');
  });

  it('fires the onNetworkChange config callback when the event occurs', () => {
    const { adapter, simulateNetworkChange } = makeAdapterWithNetworkChange();
    const onNetworkChange = vi.fn();
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: adapter,
      skipPeerCheck: true,
      onNetworkChange,
    });

    simulateNetworkChange('mainnet');

    expect(onNetworkChange).toHaveBeenCalledOnce();
    expect(onNetworkChange).toHaveBeenCalledWith('mainnet');
    expect(client.getNetwork()).toBe('mainnet');
  });

  it('is a no-op when the wallet reports the network the client is already on', () => {
    const { adapter, simulateNetworkChange } = makeAdapterWithNetworkChange();
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: adapter,
      skipPeerCheck: true,
    });

    const onChanged = vi.fn();
    client.onNetworkChanged(onChanged);

    simulateNetworkChange('testnet');

    expect(onChanged).not.toHaveBeenCalled();
    expect(client.getNetwork()).toBe('testnet');
  });

  it('onNetworkChanged returns an unsubscribe function', () => {
    const { adapter, simulateNetworkChange } = makeAdapterWithNetworkChange();
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: adapter,
      skipPeerCheck: true,
    });

    const onChanged = vi.fn();
    const unsubscribe = client.onNetworkChanged(onChanged);
    unsubscribe();

    simulateNetworkChange('mainnet');

    expect(onChanged).not.toHaveBeenCalled();
  });

  it('wallet adapters without onNetworkChange do not affect construction', () => {
    const adapter: WalletAdapter = {
      getPublicKey: vi.fn().mockResolvedValue('GABC123'),
      signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
      isConnected: vi.fn().mockResolvedValue(true),
    };

    expect(
      () =>
        new SoroStreamClient({
          network: 'testnet',
          contractId: VALID_CONTRACT,
          walletAdapter: adapter,
          skipPeerCheck: true,
        }),
    ).not.toThrow();
  });
});

describe('#215 createFreighterAdapter.onNetworkChange', () => {
  it("maps Freighter network identifiers to the SDK's Network type and skips the initial baseline callback", async () => {
    let watchCallback: ((params: { network: string; error?: unknown }) => void) | null = null;
    let stopped = false;

    vi.doMock('@stellar/freighter-api', () => ({
      isConnected: vi.fn(),
      getAddress: vi.fn(),
      signTransaction: vi.fn(),
      WatchWalletChanges: vi.fn().mockImplementation(() => ({
        watch: (cb: (params: { network: string; error?: unknown }) => void) => {
          watchCallback = cb;
          return {};
        },
        stop: () => {
          stopped = true;
        },
      })),
    }));

    const { createFreighterAdapter: createFreighterAdapterMocked } =
      await import('../src/wallet.js');
    const adapter = await createFreighterAdapterMocked();

    const received: Network[] = [];
    const unsubscribe = adapter.onNetworkChange!((network) => received.push(network));

    // First poll only seeds the baseline — must not fire the callback.
    watchCallback!({ network: 'TESTNET' });
    expect(received).toEqual([]);

    // A genuine change fires with the mapped Network value.
    watchCallback!({ network: 'PUBLIC' });
    expect(received).toEqual(['mainnet']);

    // Repeating the same network again must not re-fire.
    watchCallback!({ network: 'PUBLIC' });
    expect(received).toEqual(['mainnet']);

    watchCallback!({ network: 'FUTURENET' });
    expect(received).toEqual(['mainnet', 'futurenet']);

    unsubscribe();
    expect(stopped).toBe(true);

    vi.doUnmock('@stellar/freighter-api');
  });
});
