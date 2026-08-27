import { describe, it, expect, vi, afterEach } from 'vitest';
import { watchClaimable } from '../src/utils.js';
import type { Stream } from '../src/types.js';
import { SoroStreamClient } from '../src/SoroStreamClient.js';
import type { WalletAdapter } from '../src/types.js';

const MOCK_STREAM: Stream = {
  id: '1',
  sender: 'GSENDER',
  recipient: 'GRECIPIENT',
  token: 'GTOKEN',
  deposit: 1_000_000_000n,
  flowRate: 100n, // 100 stroops/sec
  startTime: Math.floor(Date.now() / 1000) - 10,
  endTime: Math.floor(Date.now() / 1000) + 10000,
  lastWithdrawTime: Math.floor(Date.now() / 1000) - 10,
  status: 'Active',
  autoRenew: false,
};

describe('#151 watchClaimable cleanup on unsubscribe', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops calling onTick after unsubscribe and leaves no timer leaks', () => {
    vi.useFakeTimers();

    const reconcile = vi.fn().mockResolvedValue(1000n);
    const onTick = vi.fn();

    const tickMs = 200;
    const unsubscribe = watchClaimable(MOCK_STREAM, reconcile, onTick, {
      tickMs,
      reconcileMs: 5000,
    });

    // One initial call happens synchronously before any timers fire
    const callsAfterStart = onTick.mock.calls.length;

    // Advance to fire a couple of ticks
    vi.advanceTimersByTime(tickMs * 3);
    const callsBeforeUnsub = onTick.mock.calls.length;
    expect(callsBeforeUnsub).toBeGreaterThan(callsAfterStart);

    // Unsubscribe
    unsubscribe();
    const callsAtUnsub = onTick.mock.calls.length;

    // Advance well past the polling interval
    vi.advanceTimersByTime(tickMs * 10);

    // No additional calls after unsubscribe
    expect(onTick.mock.calls.length).toBe(callsAtUnsub);

    // No timer leaks
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ── Issue #228: watchClaimable restarts on network switch ─────────────────────

describe('#228 watchClaimable restarts polling on network switch', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('restarts interpolation when getNetworkVersion changes mid-session', async () => {
    vi.useFakeTimers();

    const reconcile = vi.fn().mockResolvedValueOnce(500n).mockResolvedValueOnce(2000n);
    const onTick = vi.fn();
    const onNetworkChanged = vi.fn();

    let networkVersion = 1;
    const getNetworkVersion = () => networkVersion;

    const tickMs = 200;
    const reconcileMs = 1000;

    const unsubscribe = watchClaimable(MOCK_STREAM, reconcile, onTick, {
      tickMs,
      reconcileMs,
      getNetworkVersion,
      onNetworkChanged,
    });

    // Initial tick fires synchronously
    expect(onTick).toHaveBeenCalledTimes(1);

    // Advance past first reconcile
    vi.advanceTimersByTime(reconcileMs + 50);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(onNetworkChanged).not.toHaveBeenCalled();

    // Simulate network switch
    networkVersion = 2;

    // Advance past second reconcile — should detect the version change
    vi.advanceTimersByTime(reconcileMs + 50);
    expect(onNetworkChanged).toHaveBeenCalledOnce();

    // The watcher should have restarted and called onTick with fresh values
    expect(onTick.mock.calls.length).toBeGreaterThan(1);

    unsubscribe();
    vi.useRealTimers();
  });

  it('SoroStreamClient.getNetworkVersion increments on setNetwork', () => {
    const VALID_CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
    const VALID_ACCOUNT = 'GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF';
    const adapter: WalletAdapter = {
      getPublicKey: vi.fn().mockResolvedValue(VALID_ACCOUNT),
      signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
      isConnected: vi.fn().mockResolvedValue(true),
    };

    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: adapter,
    });

    expect(client.getNetworkVersion()).toBe(0);

    client.setNetwork('mainnet');
    expect(client.getNetworkVersion()).toBe(1);

    client.setNetwork('futurenet');
    expect(client.getNetworkVersion()).toBe(2);

    // Same network is a no-op
    client.setNetwork('futurenet');
    expect(client.getNetworkVersion()).toBe(2);
  });

  it('unsubscribes cleanly after network restart', () => {
    vi.useFakeTimers();

    let networkVersion = 1;
    const reconcile = vi.fn().mockResolvedValue(1000n);
    const onTick = vi.fn();

    const unsubscribe = watchClaimable(MOCK_STREAM, reconcile, onTick, {
      tickMs: 200,
      reconcileMs: 500,
      getNetworkVersion: () => networkVersion,
    });

    // Advance past a reconcile
    vi.advanceTimersByTime(550);

    // Trigger network switch
    networkVersion = 2;

    // Advance past the next reconcile (restart happens here)
    vi.advanceTimersByTime(550);

    // Unsubscribe should clean up all timers from the restarted cycle
    unsubscribe();
    const callsAtUnsub = onTick.mock.calls.length;

    vi.advanceTimersByTime(2000);
    expect(onTick.mock.calls.length).toBe(callsAtUnsub);
    expect(vi.getTimerCount()).toBe(0);

    vi.useRealTimers();
  });
});
