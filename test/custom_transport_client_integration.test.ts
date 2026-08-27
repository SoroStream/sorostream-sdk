import { describe, expect, it, vi } from 'vitest';
import { SoroStreamClient } from '../src/SoroStreamClient.js';
import type { RpcTransportAdapter, RpcTransportInitContext } from '../src/transport.js';
import type { WalletAdapter } from '../src/types.js';

// NOTE: like every other test file that imports SoroStreamClient.ts
// (test/client.test.ts included), this file cannot execute right now.
// SoroStreamClient.ts and utils.ts have several pre-existing, unrelated
// syntax/duplicate-declaration bugs from earlier merges — e.g. a missing
// `}` around SoroStreamClient.ts:474, duplicate `tx`/`txHash` declarations
// in withdraw/cancelStream, and a duplicated STRING_FIELD_LIMITS/
// validateStringLength block in utils.ts — that break esbuild's transform
// for the whole module graph. These predate this change and are out of
// scope here. See the sibling test/custom_transport.test.ts for the
// transport tests that do run today (doc content + createDefaultRpcTransport,
// neither of which import SoroStreamClient.ts). This file's assertions were
// checked by manual code review of the wiring added in SoroStreamClient.ts
// (init/setNetwork/disconnect) rather than by executing it — once the
// pre-existing bugs above are fixed, this file should be re-run to confirm.

const VALID_ACCOUNT = 'GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF';
const VALID_CONTRACT = 'CAVTXNC2WCHINDNP4VBLSOQA2667VE3RPQZNGD5TFI4U2QSHTVAC667T';

const walletAdapter: WalletAdapter = {
  getPublicKey: vi.fn().mockResolvedValue(VALID_ACCOUNT),
  signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
  isConnected: vi.fn().mockResolvedValue(true),
};

/** A fully in-memory RpcTransportAdapter — no network access, ever. */
function createMockTransport(): RpcTransportAdapter & {
  initCalls: RpcTransportInitContext[];
  teardownCalls: number;
} {
  return {
    initCalls: [] as RpcTransportInitContext[],
    teardownCalls: 0,
    init(context: RpcTransportInitContext) {
      this.initCalls.push(context);
    },
    getAccount: vi.fn().mockResolvedValue({ accountId: () => VALID_ACCOUNT }),
    getHealth: vi.fn().mockResolvedValue({ status: 'healthy' }),
    getLatestLedger: vi.fn().mockResolvedValue({ id: 'abc', sequence: 1, protocolVersion: '21' }),
    getTransaction: vi.fn().mockResolvedValue({ status: 'SUCCESS' }),
    simulateTransaction: vi.fn().mockResolvedValue({ result: { retval: undefined } }),
    prepareTransaction: vi.fn(),
    sendTransaction: vi.fn(),
    getEvents: vi.fn().mockResolvedValue({ events: [], latestLedger: 1, cursor: '0' }),
    teardown() {
      this.teardownCalls++;
    },
  };
}

describe('RpcTransportAdapter wired into SoroStreamClient', () => {
  it('calls init() on the custom transport at construction with network/rpcUrl', () => {
    const transport = createMockTransport();
    new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter,
      transport,
    });

    expect(transport.initCalls).toHaveLength(1);
    expect(transport.initCalls[0]).toEqual({
      network: 'testnet',
      rpcUrl: 'https://soroban-testnet.stellar.org',
    });
  });

  it('routes healthCheck() through the custom transport instead of a real rpc.Server', async () => {
    const transport = createMockTransport();
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter,
      transport,
    });

    const result = await client.healthCheck();

    expect(transport.getHealth).toHaveBeenCalledTimes(1);
    expect(result.rpcReachable).toBe(true);
  });

  it('keeps the same custom transport instance across setNetwork(), re-invoking init()', async () => {
    const transport = createMockTransport();
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter,
      transport,
    });

    client.setNetwork('mainnet');

    expect(transport.initCalls).toHaveLength(2);
    expect(transport.initCalls[1]).toEqual({
      network: 'mainnet',
      rpcUrl: 'https://soroban.stellar.org',
    });

    // Still the same mock instance — healthCheck should still route through it.
    await client.healthCheck();
    expect(transport.getHealth).toHaveBeenCalledTimes(1);
  });

  it("disconnect() calls the custom transport's teardown()", async () => {
    const transport = createMockTransport();
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter,
      transport,
    });

    await client.disconnect();

    expect(transport.teardownCalls).toBe(1);
  });

  it('disconnect() is a safe no-op when no custom transport (and thus no teardown) was configured', async () => {
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter,
    });

    await expect(client.disconnect()).resolves.toBeUndefined();
  });
});
