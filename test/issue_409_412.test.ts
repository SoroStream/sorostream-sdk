/**
 * Tests for issues #409-#412:
 *  - #409 toStroops rounding for amounts with more than 7 decimal places
 *  - #410 wallet adapter reconnect detection after Freighter lock/unlock
 *  - #411 createStream client-side validation for a past start_time
 *  - #412 stream polling must not keep the process alive after the client
 *         instance is dereferenced / destroyed
 */
import { describe, it, expect, vi } from 'vitest';
import { SoroStreamClient } from '../src/SoroStreamClient.js';
import { toStroops } from '../src/utils.js';
import { StartTimeInPastError } from '../src/errors.js';
import { unrefTimer } from '../src/events.js';
import type { WalletAdapter } from '../src/types.js';

const VALID_CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const VALID_ACCOUNT = 'GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF';
const VALID_RECIPIENT = 'GAXXZ5XSL2VTQPGWB3LPU5273HSJXMK7VHLZTF2XKW65QFZVA3XKULQZ';

function makeAdapter(): WalletAdapter {
  return {
    getPublicKey: vi.fn().mockResolvedValue(VALID_ACCOUNT),
    signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
    isConnected: vi.fn().mockResolvedValue(true),
  };
}

// ── Issue #409 ─────────────────────────────────────────────────────────────

describe('Issue #409: toStroops rounds instead of truncating past 7 decimal places', () => {
  it('rounds up when the first excess digit is >= 5', () => {
    expect(toStroops('1.123456785')).toBe(11_234_568n);
  });

  it('rounds down when the first excess digit is < 5', () => {
    expect(toStroops('1.123456749')).toBe(11_234_567n);
  });

  it('carries a round-up into the whole-number part', () => {
    expect(toStroops('0.99999995')).toBe(10_000_000n);
  });

  it('respects a custom decimals parameter when rounding', () => {
    expect(toStroops('1.5678', 3)).toBe(1_568n);
    expect(toStroops('1.5674', 3)).toBe(1_567n);
  });

  it('rounds negative amounts symmetrically', () => {
    expect(toStroops('-1.123456785')).toBe(-11_234_568n);
  });

  it('leaves amounts with <= 7 decimal places unaffected', () => {
    expect(toStroops('1.2345678')).toBe(12_345_678n);
  });
});

// ── Issue #410 ─────────────────────────────────────────────────────────────

describe('Issue #410: Freighter adapter reconnects after lock/unlock', () => {
  it('detects lock via WatchWalletChanges and re-authenticates automatically on unlock', async () => {
    type WatchPayload = { network?: string; address?: string; error?: { message: string } };
    let watchCallback: ((payload: WatchPayload) => void) | null = null;
    let currentAddress = 'GADDR1';

    vi.doMock('@stellar/freighter-api', () => ({
      isConnected: vi.fn().mockResolvedValue({ isConnected: true }),
      getAddress: vi.fn().mockImplementation(async () => ({ address: currentAddress })),
      requestAccess: vi.fn().mockResolvedValue({}),
      signTransaction: vi.fn().mockResolvedValue({ signedTxXdr: 'signed_1' }),
      WatchWalletChanges: vi.fn().mockImplementation(() => ({
        watch: (cb: (payload: WatchPayload) => void) => {
          watchCallback = cb;
        },
        stop: () => {},
      })),
    }));

    const { createFreighterAdapter: createFreighterAdapterMocked } =
      await import('../src/wallet.js');
    const adapter = await createFreighterAdapterMocked();

    // Establish an initial session.
    expect(await adapter.getPublicKey()).toBe('GADDR1');

    const connectionEvents: boolean[] = [];
    adapter.onConnectionChange!((connected) => connectionEvents.push(connected));

    // Freighter reports an empty address while locked.
    watchCallback!({ address: '' });
    expect(await adapter.isConnected()).toBe(false);

    // Freighter reports the restored address once unlocked.
    currentAddress = 'GADDR2';
    watchCallback!({ address: 'GADDR2' });
    expect(await adapter.isConnected()).toBe(true);

    expect(connectionEvents).toEqual([false, true]);

    // Signing must succeed after the reconnect without a manual re-init.
    const signed = await adapter.signTransaction('xdr-payload', 'testnet');
    expect(signed).toBe('signed_1');

    vi.doUnmock('@stellar/freighter-api');
  });

  it('re-requests wallet access when the address lookup errors out (locked session)', async () => {
    let getAddressCallCount = 0;

    vi.doMock('@stellar/freighter-api', () => ({
      isConnected: vi.fn().mockResolvedValue({ isConnected: true }),
      getAddress: vi.fn().mockImplementation(async () => {
        getAddressCallCount++;
        if (getAddressCallCount === 1) {
          return { error: { message: 'wallet is locked' } };
        }
        return { address: 'GADDR3' };
      }),
      requestAccess: vi.fn().mockResolvedValue({}),
      signTransaction: vi.fn().mockResolvedValue({ signedTxXdr: 'signed_2' }),
      WatchWalletChanges: vi.fn().mockImplementation(() => ({
        watch: () => {},
        stop: () => {},
      })),
    }));

    const { createFreighterAdapter: createFreighterAdapterMocked } =
      await import('../src/wallet.js');
    const adapter = await createFreighterAdapterMocked();

    const publicKey = await adapter.getPublicKey();
    expect(publicKey).toBe('GADDR3');
    expect(getAddressCallCount).toBeGreaterThanOrEqual(2);

    vi.doUnmock('@stellar/freighter-api');
  });
});

// ── Issue #411 ─────────────────────────────────────────────────────────────

describe('Issue #411: createStream rejects a start_time in the past', () => {
  function setupClient() {
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: makeAdapter(),
      skipPeerCheck: true,
    });
    // Deterministic ledger time so the past/future comparison is stable.
    (client as any).server.getLatestLedger = vi.fn().mockResolvedValue({
      id: 'ledger-1',
      sequence: 1,
      protocolVersion: '21',
      lastLedgerCloseTime: 1_700_000_000,
    });
    (client as any).server.getAccount = vi.fn().mockResolvedValue({
      accountId: () => VALID_ACCOUNT,
    });
    return client;
  }

  it('throws StartTimeInPastError and warns when startTime predates the ledger timestamp', async () => {
    const client = setupClient();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      client.createStream({
        recipient: VALID_RECIPIENT,
        token: VALID_CONTRACT,
        amount: 100n,
        durationSeconds: 1000,
        autoRenew: false,
        startTime: 1_699_999_000,
      }),
    ).rejects.toThrow(StartTimeInPastError);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('start_time'));
    warnSpy.mockRestore();
  });

  it('does not throw StartTimeInPastError when startTime is at or after the ledger timestamp', async () => {
    const client = setupClient();

    await expect(
      (client as any).validateStreamParams({
        recipient: VALID_RECIPIENT,
        token: VALID_CONTRACT,
        amount: 100n,
        durationSeconds: 1000,
        autoRenew: false,
        startTime: 1_700_000_000,
      }),
    ).resolves.toBeUndefined();
  });

  it('does not throw StartTimeInPastError when startTime is omitted', async () => {
    const client = setupClient();

    await expect(
      (client as any).validateStreamParams({
        recipient: VALID_RECIPIENT,
        token: VALID_CONTRACT,
        amount: 100n,
        durationSeconds: 1000,
        autoRenew: false,
      }),
    ).resolves.toBeUndefined();
  });
});

// ── Issue #412 ─────────────────────────────────────────────────────────────

describe('Issue #412: stream polling stops when the client is destroyed', () => {
  it('unrefTimer calls unref() when the timer handle supports it, and is a no-op otherwise', () => {
    const nodeStyleHandle = { unref: vi.fn() };
    unrefTimer(nodeStyleHandle as any);
    expect(nodeStyleHandle.unref).toHaveBeenCalledOnce();

    const browserStyleHandle = {};
    expect(() => unrefTimer(browserStyleHandle as any)).not.toThrow();
  });

  it('destroy() stops the active event poller interval', async () => {
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      skipPeerCheck: true,
    });
    (client as any).server.getEvents = vi.fn().mockResolvedValue({
      events: [],
      cursor: undefined,
      latestLedger: 1,
    });

    const sub = client.subscribeEvents({}, () => {});
    const poller = (client as any).eventPoller;
    expect(poller).not.toBeNull();
    expect((poller as any).intervalId).not.toBeNull();

    client.destroy();

    expect((poller as any).intervalId).toBeNull();
    expect((client as any).eventPoller).toBeNull();

    sub.unsubscribe();
  });

  it('destroy() is idempotent', () => {
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      skipPeerCheck: true,
    });

    expect(() => {
      client.destroy();
      client.destroy();
    }).not.toThrow();
  });

  it('destroy() unsubscribes wallet network/connection change listeners', () => {
    const unsubNetwork = vi.fn();
    const unsubConnection = vi.fn();
    const adapter: WalletAdapter = {
      getPublicKey: vi.fn().mockResolvedValue(VALID_ACCOUNT),
      signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
      isConnected: vi.fn().mockResolvedValue(true),
      onNetworkChange: vi.fn().mockReturnValue(unsubNetwork),
      onConnectionChange: vi.fn().mockReturnValue(unsubConnection),
    };

    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: adapter,
      skipPeerCheck: true,
    });

    client.destroy();

    expect(unsubNetwork).toHaveBeenCalledOnce();
    expect(unsubConnection).toHaveBeenCalledOnce();
  });
});
