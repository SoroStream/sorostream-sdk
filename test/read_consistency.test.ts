/**
 * Tests for issue #564: read-consistency guarantee on cache reads after writes.
 *
 * After a write (create, cancel, withdraw), a subsequent `getStream` for the
 * same stream bypasses the cache for one request so callers never observe
 * stale pre-write state from a lagging RPC node.
 */
import { describe, it, expect, vi } from 'vitest';
import { SoroStreamClient } from '../src/SoroStreamClient.js';
import { Account, Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';
import type { WalletAdapter } from '../src/types.js';

const VALID_CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const SENDER = 'GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF';

/**
 * Builds a wallet adapter that signs the prepared transaction by signing it
 * with a real Stellar keypair. This satisfies the SDK's
 * assertEnvelopeUnmutated guard, which decodes the signed XDR and compares it
 * to the prepared transaction.
 */
function makeSigningAdapter(): WalletAdapter {
  const kp = Keypair.random();
  return {
    getPublicKey: vi.fn().mockResolvedValue(SENDER),
    signTransaction: vi.fn().mockImplementation(async (xdr: string) => {
      const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
      tx.sign(kp);
      return tx.toXDR();
    }),
    isConnected: vi.fn().mockResolvedValue(true),
  };
}

/**
 * Injects a fully-mocked RPC server. Writes succeed immediately; reads are
 * not expected to decode a real stream in these tests (the cache is seeded
 * so the bypass behaviour is what's under test).
 */
function injectMockServer(client: SoroStreamClient) {
  const account = new Account(SENDER, '1');
  const server = {
    getAccount: vi.fn().mockResolvedValue(account),
    simulateTransaction: vi.fn().mockResolvedValue({ status: 'SUCCESS', result: { retval: undefined } }),
    prepareTransaction: vi.fn().mockImplementation((tx: unknown) => tx),
    sendTransaction: vi.fn().mockResolvedValue({ status: 'PENDING', hash: 'tx-hash' }),
    getTransaction: vi.fn().mockResolvedValue({ status: 'SUCCESS', ledger: 123 }),
    getLatestLedger: vi.fn().mockResolvedValue({ sequence: 999 }),
  };
  (client as any).server = server;
  return server;
}

describe('#564 read-consistency guarantee after writes', () => {
  it('write → immediately read → RPC is called (not cache)', async () => {
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: makeSigningAdapter(),
      skipPeerCheck: true,
      readConsistencyWindowMs: 60_000,
    });
    const server = injectMockServer(client);

    // Seed the cache with stale data so we can prove the bypass skips it.
    (client as any).streamCache.set('testnet:1', { id: '1', stale: true } as any);

    // Spy on the cache to prove the bypass skips it on the immediate read.
    const cacheGetSpy = vi.spyOn((client as any).streamCache, 'get');

    // Perform a write (cancelStream) — this records the write timestamp.
    await client.cancelStream({ streamId: '1' });

    // An immediate read must bypass the cache and hit the RPC.
    const callsBefore = server.simulateTransaction.mock.calls.length;
    // The read will throw (no retval), but it must have gone through the RPC
    // rather than the cache. Catch the error.
    await expect(client.getStream('1')).rejects.toThrow();

    expect(server.simulateTransaction.mock.calls.length).toBeGreaterThan(callsBefore);

    // The cache was NOT consulted on the bypass read.
    const bypassReadCalls = cacheGetSpy.mock.calls.filter(
      (args) => args[0] === 'testnet:1',
    );
    expect(bypassReadCalls.length).toBe(0);

    cacheGetSpy.mockRestore();
  });

  it('bypass window is configurable (default 5 s)', async () => {
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: makeSigningAdapter(),
      skipPeerCheck: true,
      readConsistencyWindowMs: 0, // disabled
    });
    const server = injectMockServer(client);

    // Seed the cache with stale data.
    (client as any).streamCache.set('testnet:1', { id: '1', stale: true } as any);

    const cacheGetSpy = vi.spyOn((client as any).streamCache, 'get');

    // Perform a write.
    await client.cancelStream({ streamId: '1' });

    // With the bypass disabled, the immediate read must serve from cache.
    const callsBefore = server.simulateTransaction.mock.calls.length;
    const stream = await client.getStream('1');
    expect(server.simulateTransaction.mock.calls.length).toBe(callsBefore);
    expect(stream).toEqual({ id: '1', stale: true });

    const bypassReadCalls = cacheGetSpy.mock.calls.filter(
      (args) => args[0] === 'testnet:1',
    );
    expect(bypassReadCalls.length).toBeGreaterThan(0);

    cacheGetSpy.mockRestore();
  });

  it('the bypass applies to exactly one read, then cache is used again', async () => {
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: makeSigningAdapter(),
      skipPeerCheck: true,
      readConsistencyWindowMs: 60_000,
    });
    const server = injectMockServer(client);

    // Seed the cache with stale data.
    (client as any).streamCache.set('testnet:1', { id: '1', stale: true } as any);

    const cacheGetSpy = vi.spyOn((client as any).streamCache, 'get');

    // Perform a write.
    await client.cancelStream({ streamId: '1' });

    // First read: bypass → RPC (will throw because no retval, but it must
    // have gone through the RPC rather than the cache).
    const callsBeforeFirst = server.simulateTransaction.mock.calls.length;
    await expect(client.getStream('1')).rejects.toThrow();
    expect(server.simulateTransaction.mock.calls.length).toBeGreaterThan(callsBeforeFirst);

    // The cache was NOT consulted on the bypass read.
    const firstReadCacheCalls = cacheGetSpy.mock.calls.filter(
      (args) => args[0] === 'testnet:1',
    );
    expect(firstReadCacheCalls.length).toBe(0);

    // Second read: cache hit (bypass consumed).
    const callsBeforeSecond = server.simulateTransaction.mock.calls.length;
    const cached = await client.getStream('1');
    expect(server.simulateTransaction.mock.calls.length).toBe(callsBeforeSecond);
    expect(cached).toEqual({ id: '1', stale: true });

    cacheGetSpy.mockRestore();
  });

  it('reads without a prior write use the cache normally', async () => {
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: makeSigningAdapter(),
      skipPeerCheck: true,
    });
    const server = injectMockServer(client);

    // Seed the cache with stale data — no write has been recorded.
    (client as any).streamCache.set('testnet:1', { id: '1', stale: true } as any);

    const callsBefore = server.simulateTransaction.mock.calls.length;
    const stream = await client.getStream('1');
    expect(server.simulateTransaction.mock.calls.length).toBe(callsBefore);
    expect(stream).toEqual({ id: '1', stale: true });
  });
});