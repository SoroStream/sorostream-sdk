/**
 * Tests for issue #231: createStream must detect when a nonce is provided but
 * the deployed contract does not support it, and emit a console.warn (or throw
 * if strict: true is set in WriteOptions).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SoroStreamClient } from '../src/SoroStreamClient.js';
import { NonceNotSupportedError } from '../src/errors.js';
import type { WalletAdapter } from '../src/types.js';
import { rpc, nativeToScVal } from '@stellar/stellar-sdk';

const VALID_CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const VALID_ACCOUNT = 'GAXXZ5XSL2VTQPGWB3LPU5273HSJXMK7VHLZTF2XKW65QFZVA3XKULQZ';
const VALID_RECIPIENT = 'GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF';
const VALID_TOKEN = 'CAVTXNC2WCHINDNP4VBLSOQA2667VE3RPQZNGD5TFI4U2QSHTVAC667T';

function makeAdapter(): WalletAdapter {
  return {
    getPublicKey: vi.fn().mockResolvedValue(VALID_ACCOUNT),
    signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
    isConnected: vi.fn().mockResolvedValue(true),
  };
}

function makeClient() {
  const adapter = makeAdapter();
  const client = new SoroStreamClient({
    network: 'testnet',
    contractId: VALID_CONTRACT,
    walletAdapter: adapter,
    skipPeerCheck: true,
  });
  return client;
}

/** Simulate a contract that does NOT support nonces (no get_version or version < 2). */
function mockNoNonceSupport(client: SoroStreamClient) {
  vi.spyOn(client as any, 'simulateOp').mockImplementation((op: unknown) => {
    // get_version returns a simulation error (old contract)
    return Promise.resolve({
      error: 'missing entry',
      ...{},
    } as unknown as rpc.Api.SimulateTransactionErrorResponse);
  });
}

/** Simulate a contract that DOES support nonces (version >= 2). */
function mockNonceSupport(client: SoroStreamClient) {
  vi.spyOn(client as any, 'simulateOp').mockImplementation(() =>
    Promise.resolve({
      result: {
        retval: nativeToScVal({ major: 2, minor: 0, nonce_support: true }, { type: 'map' }),
      },
      latestLedger: 100,
    } as unknown as rpc.Api.SimulateTransactionSuccessResponse),
  );
}

// ── supportsNonce ─────────────────────────────────────────────────────────────

describe('#231 supportsNonce()', () => {
  it('returns false when get_version returns a simulation error (old contract)', async () => {
    const client = makeClient();
    vi.spyOn(client as any, 'simulateOp').mockResolvedValue({
      error: 'missing entry',
    });
    // isSimulationError returns true for objects with an "error" key
    vi.spyOn(rpc.Api, 'isSimulationError').mockReturnValue(true);

    const result = await client.supportsNonce();
    expect(result).toBe(false);
  });

  it('returns true when contract reports nonce_support: true in version map', async () => {
    const client = makeClient();
    vi.spyOn(rpc.Api, 'isSimulationError').mockReturnValue(false);
    vi.spyOn(client as any, 'simulateOp').mockResolvedValue({
      result: {
        retval: nativeToScVal({ major: 2, minor: 0, nonce_support: true }, { type: 'map' }),
      },
      latestLedger: 100,
    });

    const result = await client.supportsNonce();
    expect(result).toBe(true);
  });

  it('caches the result so simulateOp is only called once', async () => {
    const client = makeClient();
    vi.spyOn(rpc.Api, 'isSimulationError').mockReturnValue(true);
    const simulateSpy = vi
      .spyOn(client as any, 'simulateOp')
      .mockResolvedValue({ error: 'missing entry' });

    await client.supportsNonce();
    await client.supportsNonce();
    await client.supportsNonce();

    expect(simulateSpy).toHaveBeenCalledTimes(1);
  });

  it('resets the cache when setNetwork is called', async () => {
    const client = makeClient();
    vi.spyOn(rpc.Api, 'isSimulationError').mockReturnValue(true);
    const simulateSpy = vi
      .spyOn(client as any, 'simulateOp')
      .mockResolvedValue({ error: 'missing entry' });

    await client.supportsNonce();
    expect(simulateSpy).toHaveBeenCalledTimes(1);

    client.setNetwork('mainnet');

    await client.supportsNonce();
    expect(simulateSpy).toHaveBeenCalledTimes(2);
  });
});

// ── createStream nonce handling ───────────────────────────────────────────────

describe('#231 createStream — nonce field handling', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('emits console.warn when nonce is provided but contract does not support it', async () => {
    const client = makeClient();

    // supportsNonce → false
    vi.spyOn(client, 'supportsNonce').mockResolvedValue(false);

    // Stub the rest of createStream internals so they don't fail
    vi.spyOn(client as any, 'validateStreamParams').mockResolvedValue(undefined);
    vi.spyOn(client as any, 'checkAllowance').mockResolvedValue(undefined);
    vi.spyOn(client as any, 'buildAndSubmit').mockResolvedValue({ txHash: 'txhash', ledger: 0 });
    vi.spyOn(client, 'getStreamsBySender').mockResolvedValue([
      {
        id: '1',
        sender: VALID_ACCOUNT,
        recipient: VALID_RECIPIENT,
        token: VALID_TOKEN,
        deposit: 100n,
        flowRate: 1n,
        startTime: 0,
        endTime: 3600,
        lastWithdrawTime: 0,
        status: 'Active',
        autoRenew: false,
      },
    ]);

    await client.createStream({
      recipient: VALID_RECIPIENT,
      token: VALID_TOKEN,
      amount: 1_000_000_000n,
      durationSeconds: 3600,
      autoRenew: false,
      nonce: 'abc-123',
    });

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0]).toContain('nonce');
    expect(warnSpy.mock.calls[0]![0]).toContain('does not support');
  });

  it('throws NonceNotSupportedError when strict:true and contract does not support nonce', async () => {
    const client = makeClient();

    vi.spyOn(client, 'supportsNonce').mockResolvedValue(false);

    await expect(
      client.createStream(
        {
          recipient: VALID_RECIPIENT,
          token: VALID_TOKEN,
          amount: 1_000_000_000n,
          durationSeconds: 3600,
          autoRenew: false,
          nonce: 'abc-123',
        },
        undefined, // no abort signal
        { strict: true },
      ),
    ).rejects.toThrow(NonceNotSupportedError);

    // No warning should be emitted when we throw
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not warn or throw when nonce is provided and contract supports it', async () => {
    const client = makeClient();

    vi.spyOn(client, 'supportsNonce').mockResolvedValue(true);
    vi.spyOn(client as any, 'validateStreamParams').mockResolvedValue(undefined);
    vi.spyOn(client as any, 'checkAllowance').mockResolvedValue(undefined);
    vi.spyOn(client as any, 'buildAndSubmit').mockResolvedValue({ txHash: 'txhash', ledger: 0 });
    vi.spyOn(client, 'getStreamsBySender').mockResolvedValue([
      {
        id: '1',
        sender: VALID_ACCOUNT,
        recipient: VALID_RECIPIENT,
        token: VALID_TOKEN,
        deposit: 100n,
        flowRate: 1n,
        startTime: 0,
        endTime: 3600,
        lastWithdrawTime: 0,
        status: 'Active',
        autoRenew: false,
      },
    ]);

    await client.createStream({
      recipient: VALID_RECIPIENT,
      token: VALID_TOKEN,
      amount: 1_000_000_000n,
      durationSeconds: 3600,
      autoRenew: false,
      nonce: 'abc-123',
    });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not call supportsNonce when no nonce is provided', async () => {
    const client = makeClient();

    const nonceSpy = vi.spyOn(client, 'supportsNonce');
    vi.spyOn(client as any, 'validateStreamParams').mockResolvedValue(undefined);
    vi.spyOn(client as any, 'checkAllowance').mockResolvedValue(undefined);
    vi.spyOn(client as any, 'buildAndSubmit').mockResolvedValue({ txHash: 'txhash', ledger: 0 });
    vi.spyOn(client, 'getStreamsBySender').mockResolvedValue([
      {
        id: '1',
        sender: VALID_ACCOUNT,
        recipient: VALID_RECIPIENT,
        token: VALID_TOKEN,
        deposit: 100n,
        flowRate: 1n,
        startTime: 0,
        endTime: 3600,
        lastWithdrawTime: 0,
        status: 'Active',
        autoRenew: false,
      },
    ]);

    await client.createStream({
      recipient: VALID_RECIPIENT,
      token: VALID_TOKEN,
      amount: 1_000_000_000n,
      durationSeconds: 3600,
      autoRenew: false,
      // no nonce
    });

    expect(nonceSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
