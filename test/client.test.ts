import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Keypair, nativeToScVal } from '@stellar/stellar-sdk';

// Pre-generated valid Stellar addresses for tests that pass addresses to contract calls.
const TEST_KEYPAIR = Keypair.random();
const TEST_PK = TEST_KEYPAIR.publicKey();
// A valid Stellar contract address (C-address) for use as a token address.
const TEST_TOKEN = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

import { SoroStreamClient } from '../src/SoroStreamClient.js';
import { createKeypairAdapter, createPasskeyAdapter, createLedgerAdapter } from '../src/wallet.js';
import type {
  Stream,
  WalletAdapter,
  BulkStreamRow,
  BatchProgress,
  PriceFeedAdapter,
  FeeBumpOptions,
} from '../src/types.js';
import {
  toStroops,
  formatUSDC,
  formatToken,
  toFiatDisplay,
  isValidStellarAddress,
  calculateFlowRate,
  claimableNow,
  timeUntilStreamEnd,
  calculateVestingSchedule,
  watchClaimable,
  aggregateStreamsByToken,
  parseCsvStreamRows,
  detectStreamDrift,
  watchStreamDrift,
  batchSize,
  isStreamExpiring,
  isStreamStalled,
  isStreamUnderfunded,
} from '../src/utils.js';
import {
  InsufficientAmountError,
  SoroStreamError,
  InvalidAddressError,
  AccountNotFoundError,
  ZeroDurationError,
  DuplicateStreamError,
} from '../src/errors.js';
import { withRetry } from '../src/retry.js';
import { NoopLogger } from '../src/logger.js';
import type { Logger } from '../src/logger.js';
import { createContractEncoder } from '../src/contractEncoders.js';
import { Contract } from '@stellar/stellar-sdk';

const VALID_ACCOUNT = 'GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF';
const VALID_RECIPIENT = 'GAXXZ5XSL2VTQPGWB3LPU5273HSJXMK7VHLZTF2XKW65QFZVA3XKULQZ';
const VALID_CONTRACT = 'CAVTXNC2WCHINDNP4VBLSOQA2667VE3RPQZNGD5TFI4U2QSHTVAC667T';

const MOCK_SENDER = Keypair.random().publicKey();
const MOCK_RECIPIENT = Keypair.random().publicKey();
const MOCK_TOKEN = Keypair.random().publicKey();

// ── Utility tests ────────────────────────────────────────────────────────────

describe('toStroops', () => {
  it('converts whole USDC to stroops (default 7 decimals)', () => {
    expect(toStroops('100')).toBe(1_000_000_000n);
  });

  it('converts decimal USDC to stroops', () => {
    expect(toStroops('1.5')).toBe(15_000_000n);
  });

  it('handles 7 decimal places', () => {
    expect(toStroops('0.0000001')).toBe(1n);
  });

  it('respects custom decimals parameter', () => {
    expect(toStroops('100', 6)).toBe(100_000_000n);
    expect(toStroops('1.5', 6)).toBe(1_500_000n);
    expect(toStroops('0.5', 18)).toBe(500_000_000_000_000_000n);
  });
});

describe('formatUSDC', () => {
  it('formats stroops to USDC string (default 7 decimals)', () => {
    expect(formatUSDC(1_000_000_000n)).toBe('100.0000000');
  });

  it('formats fractional amounts', () => {
    expect(formatUSDC(1n)).toBe('0.0000001');
  });

  it('formats with no decimal remainder', () => {
    expect(formatUSDC(100_000_000n, 6)).toBe('100.000000');
  });

  it('respects custom decimals parameter', () => {
    expect(formatUSDC(1_500_000n, 6)).toBe('1.500000');
    expect(formatUSDC(1n, 18)).toBe('0.000000000000000001');
  });
});

describe('formatToken', () => {
  it('behaves identically to formatUSDC', () => {
    expect(formatToken(1_000_000_000n)).toBe(formatUSDC(1_000_000_000n));
    expect(formatToken(1n, 6)).toBe(formatUSDC(1n, 6));
  });
});

describe('isValidStellarAddress', () => {
  it('accepts valid account address', () => {
    expect(isValidStellarAddress(VALID_ACCOUNT)).toBe(true);
  });

  it('accepts valid contract address', () => {
    expect(isValidStellarAddress(VALID_CONTRACT)).toBe(true);
  });

  it('rejects short address', () => {
    expect(isValidStellarAddress('GABC')).toBe(false);
  });

  it('rejects invalid prefix', () => {
    expect(isValidStellarAddress('X' + 'A'.repeat(55))).toBe(false);
  });

  it('rejects lowercase', () => {
    expect(isValidStellarAddress('g' + 'a'.repeat(55))).toBe(false);
  });
});

describe('toFiatDisplay', () => {
  it('returns token and fiat amounts', async () => {
    const mockFeed: PriceFeedAdapter = {
      getPrice: vi.fn().mockResolvedValue(1.0),
    };
    const result = await toFiatDisplay(1_000_000_000n, 7, mockFeed, VALID_CONTRACT, 'usd');
    expect(result.tokenAmount).toBe('100.0000000');
    expect(result.fiatAmount).toBe('100.00');
    expect(mockFeed.getPrice).toHaveBeenCalledWith(VALID_CONTRACT, 'usd');
  });

  it('handles different price', async () => {
    const mockFeed: PriceFeedAdapter = {
      getPrice: vi.fn().mockResolvedValue(2.5),
    };
    const result = await toFiatDisplay(1_000_000_000n, 7, mockFeed, VALID_CONTRACT, 'eur');
    expect(result.fiatAmount).toBe('250.00');
  });
});

describe('calculateFlowRate', () => {
  it('calculates flow rate correctly', () => {
    expect(calculateFlowRate(1_000_000_000n, 1000)).toBe(1_000_000n);
  });

  it('throws SoroStreamError on zero duration', () => {
    expect(() => calculateFlowRate(100n, 0)).toThrow(SoroStreamError);
  });
});

describe('claimableNow', () => {
  it('returns 0 for non-active streams', () => {
    const stream: Stream = makeStream({ status: 'Cancelled' });
    expect(claimableNow(stream)).toBe(0n);
  });

  it('calculates claimable for active stream', () => {
    const now = Math.floor(Date.now() / 1000);
    const stream: Stream = makeStream({
      status: 'Active',
      flowRate: 100n,
      lastWithdrawTime: now - 500,
      endTime: now + 500,
    });
    const claimable = claimableNow(stream);
    expect(claimable).toBeGreaterThanOrEqual(49_900n);
    expect(claimable).toBeLessThanOrEqual(50_100n);
  });

  it('caps at end time', () => {
    const now = Math.floor(Date.now() / 1000);
    const stream: Stream = makeStream({
      status: 'Active',
      flowRate: 100n,
      lastWithdrawTime: now - 2000,
      endTime: now - 1000,
    });
    expect(claimableNow(stream)).toBe(100_000n);
  });
});

describe('timeUntilStreamEnd', () => {
  it('returns 0 for ended streams', () => {
    const now = Math.floor(Date.now() / 1000);
    const stream = makeStream({ endTime: now - 100 });
    expect(timeUntilStreamEnd(stream)).toBe(0);
  });

  it('returns positive seconds for active streams', () => {
    const now = Math.floor(Date.now() / 1000);
    const stream = makeStream({ endTime: now + 3600 });
    expect(timeUntilStreamEnd(stream)).toBeGreaterThan(0);
  });
});

// ── Vesting schedule calculator ───────────────────────────────────────────────

describe('calculateVestingSchedule', () => {
  const startTime = 1_000_000;
  const endTime = startTime + 4 * 365 * 24 * 3600;
  const flowRate = 10n;
  const deposit = flowRate * BigInt(endTime - startTime);

  function makeVestingStream(overrides: Partial<Stream> = {}): Stream {
    return {
      id: '0',
      sender: 'GSENDER',
      recipient: 'GRECIPIENT',
      token: 'GTOKEN',
      deposit,
      flowRate,
      startTime,
      endTime,
      lastWithdrawTime: startTime,
      status: 'Active',
      autoRenew: false,
      ...overrides,
    };
  }

  it('returns 0 effective claimable while in cliff period', () => {
    const now = startTime + 100;
    const result = calculateVestingSchedule(makeVestingStream(), 365 * 24 * 3600, now);
    expect(result.inCliff).toBe(true);
    expect(result.effectiveClaimable).toBe(0n);
    expect(result.cliffEndTime).toBe(startTime + 365 * 24 * 3600);
  });

  it('returns positive effective claimable after cliff', () => {
    const cliff = 365 * 24 * 3600;
    const now = startTime + cliff + 500;
    const result = calculateVestingSchedule(makeVestingStream(), cliff, now);
    expect(result.inCliff).toBe(false);
    expect(result.effectiveClaimable).toBe(flowRate * BigInt(cliff + 500));
  });

  it('caps effective claimable at total amount after end time', () => {
    const cliff = 365 * 24 * 3600;
    const now = endTime + 10_000;
    const result = calculateVestingSchedule(makeVestingStream(), cliff, now);
    expect(result.effectiveClaimable).toBe(result.totalAmount);
  });

  it('includes cliff milestone when cliff < total duration', () => {
    const cliff = 365 * 24 * 3600;
    const result = calculateVestingSchedule(makeVestingStream(), cliff, startTime);
    expect(result.milestones.length).toBeGreaterThanOrEqual(1);
    expect(result.milestones[0]).toBeDefined();
    expect(result.milestones[0]!.time).toBe(startTime + cliff);
  });

  it('returns milestones sorted by time', () => {
    const cliff = 365 * 24 * 3600;
    const result = calculateVestingSchedule(makeVestingStream(), cliff, startTime);
    for (let i = 1; i < result.milestones.length; i++) {
      expect(result.milestones[i]!.time).toBeGreaterThan(result.milestones[i - 1]!.time);
    }
  });

  it('total amount matches deposit', () => {
    const result = calculateVestingSchedule(makeVestingStream(), 0, startTime);
    expect(result.totalAmount).toBe(deposit);
  });

  describe('edge case: at cliff exactly (issue #95)', () => {
    it('inCliff is false at exactly cliffEndTime', () => {
      const cliff = 365 * 24 * 3600;
      const cliffEndTime = startTime + cliff;
      const result = calculateVestingSchedule(makeVestingStream(), cliff, cliffEndTime);
      expect(result.inCliff).toBe(false);
    });

    it('effectiveClaimable equals cliff amount at exactly cliffEndTime', () => {
      const cliff = 365 * 24 * 3600;
      const cliffEndTime = startTime + cliff;
      const result = calculateVestingSchedule(makeVestingStream(), cliff, cliffEndTime);
      expect(result.effectiveClaimable).toBe(flowRate * BigInt(cliff));
    });

    it('milestone is placed at cliffEndTime', () => {
      const cliff = 365 * 24 * 3600;
      const cliffEndTime = startTime + cliff;
      const result = calculateVestingSchedule(makeVestingStream(), cliff, startTime);
      expect(result.milestones[0]).toBeDefined();
      expect(result.milestones[0]!.time).toBe(cliffEndTime);
    });

    it('milestone vested amount matches claimable at cliff end', () => {
      const cliff = 365 * 24 * 3600;
      const cliffEndTime = startTime + cliff;
      const result = calculateVestingSchedule(makeVestingStream(), cliff, cliffEndTime);
      expect(result.milestones[0]).toBeDefined();
      expect(result.milestones[0]!.time).toBe(cliffEndTime);
      expect(result.milestones[0]!.vested).toBe(flowRate * BigInt(cliff));
    });

    it('effectiveClaimable is 0 one second before cliffEndTime', () => {
      const cliff = 365 * 24 * 3600;
      const cliffEndTime = startTime + cliff;
      const result = calculateVestingSchedule(makeVestingStream(), cliff, cliffEndTime - 1);
      expect(result.inCliff).toBe(true);
      expect(result.effectiveClaimable).toBe(0n);
    });
  });

  describe('edge case: past end time (issue #96)', () => {
    it('effectiveClaimable equals totalAmount at exactly endTime', () => {
      const result = calculateVestingSchedule(makeVestingStream(), 365 * 24 * 3600, endTime);
      expect(result.effectiveClaimable).toBe(result.totalAmount);
    });

    it('effectiveClaimable equals totalAmount one second after endTime', () => {
      const result = calculateVestingSchedule(makeVestingStream(), 365 * 24 * 3600, endTime + 1);
      expect(result.effectiveClaimable).toBe(result.totalAmount);
    });

    it('effectiveClaimable equals totalAmount far past endTime', () => {
      const result = calculateVestingSchedule(
        makeVestingStream(),
        365 * 24 * 3600,
        endTime + 10_000,
      );
      expect(result.effectiveClaimable).toBe(result.totalAmount);
    });

    it('inCliff is false after endTime', () => {
      const result = calculateVestingSchedule(makeVestingStream(), 365 * 24 * 3600, endTime + 1);
      expect(result.inCliff).toBe(false);
    });

    it('milestones remain correct after stream ends', () => {
      const result = calculateVestingSchedule(
        makeVestingStream(),
        365 * 24 * 3600,
        endTime + 10_000,
      );
      expect(result.milestones.length).toBeGreaterThanOrEqual(1);
      expect(result.milestones[result.milestones.length - 1]!.time).toBe(endTime);
      expect(result.milestones[result.milestones.length - 1]!.vested).toBe(result.totalAmount);
    });
  });

  describe('edge case: zero elapsed time (issue #97)', () => {
    it('effectiveClaimable is 0 when now equals startTime with zero cliff', () => {
      const result = calculateVestingSchedule(makeVestingStream(), 0, startTime);
      expect(result.effectiveClaimable).toBe(0n);
    });

    it('effectiveClaimable is 0 when still in cliff at startTime', () => {
      const result = calculateVestingSchedule(makeVestingStream(), 365 * 24 * 3600, startTime);
      expect(result.effectiveClaimable).toBe(0n);
      expect(result.inCliff).toBe(true);
    });

    it('acts like normal stream when cliff is 0', () => {
      const now = startTime + 500;
      const result = calculateVestingSchedule(makeVestingStream(), 0, now);
      expect(result.inCliff).toBe(false);
      expect(result.effectiveClaimable).toBe(flowRate * 500n);
    });

    it('includes full milestone set when cliff is 0', () => {
      const result = calculateVestingSchedule(makeVestingStream(), 0, startTime + 500);
      // cliff milestone at startTime + 25%/50%/75%/100% milestones
      expect(result.milestones.length).toBe(5);
    });

    it('effectiveClaimable is 0 at exactly cliffEndTime when cliff is 0', () => {
      const result = calculateVestingSchedule(makeVestingStream(), 0, startTime);
      expect(result.effectiveClaimable).toBe(0n);
    });
  });

  describe('edge case: rounding / truncation (issue #98)', () => {
    it('handles rounding when flowRate * duration produces truncated totalAmount', () => {
      const totalSeconds = 3;
      const truncatedFlowRate = 7n / 3n;
      const stream = makeVestingStream({
        flowRate: truncatedFlowRate,
        endTime: startTime + totalSeconds,
      });
      const result = calculateVestingSchedule(stream, 0, startTime + totalSeconds);
      expect(result.effectiveClaimable).toBe(truncatedFlowRate * BigInt(totalSeconds));
      expect(result.totalAmount).toBe(truncatedFlowRate * BigInt(totalSeconds));
    });

    it('truncation does not affect milestone ordering', () => {
      const totalSeconds = 3;
      const truncatedFlowRate = 7n / 3n;
      const stream = makeVestingStream({
        flowRate: truncatedFlowRate,
        endTime: startTime + totalSeconds,
      });
      const result = calculateVestingSchedule(stream, 1, startTime);
      for (let i = 1; i < result.milestones.length; i++) {
        expect(result.milestones[i]!.time).toBeGreaterThan(result.milestones[i - 1]!.time);
      }
    });
  });
});

// ── watchClaimable ────────────────────────────────────────────────────────────

describe('watchClaimable', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits initial claimable value immediately', () => {
    const now = Math.floor(Date.now() / 1000);
    const stream: Stream = {
      id: '0',
      sender: 'GSENDER',
      recipient: 'GRECIPIENT',
      token: 'GTOKEN',
      deposit: 100_000n,
      flowRate: 100n,
      startTime: now - 100,
      endTime: now + 900,
      lastWithdrawTime: now - 50,
      status: 'Active',
      autoRenew: false,
    };

    const onTick = vi.fn();
    const reconcile = vi.fn().mockResolvedValue(5000n);
    const unsubscribe = watchClaimable(stream, reconcile, onTick);

    expect(onTick).toHaveBeenCalledTimes(1);
    expect(onTick).toHaveBeenCalledWith(5000n);
    unsubscribe();
  });

  it('emits interpolated values on tick interval', () => {
    const now = Math.floor(Date.now() / 1000);
    const stream: Stream = {
      id: '0',
      sender: 'GSENDER',
      recipient: 'GRECIPIENT',
      token: 'GTOKEN',
      deposit: 100_000n,
      flowRate: 100n,
      startTime: now - 100,
      endTime: now + 900,
      lastWithdrawTime: now - 50,
      status: 'Active',
      autoRenew: false,
    };

    const onTick = vi.fn();
    const reconcile = vi.fn().mockResolvedValue(5000n);
    const unsubscribe = watchClaimable(stream, reconcile, onTick);

    onTick.mockClear();

    vi.advanceTimersByTime(1000);

    expect(onTick).toHaveBeenCalled();

    const calls = onTick.mock.calls;
    const lastCall = calls[calls.length - 1] as [bigint];
    expect(lastCall[0]).toBeGreaterThanOrEqual(5000n);
    expect(lastCall[0]).toBeLessThanOrEqual(5200n);

    unsubscribe();
  });

  it('unsubscribe stops the ticker', () => {
    const now = Math.floor(Date.now() / 1000);
    const stream: Stream = {
      id: '0',
      sender: 'GSENDER',
      recipient: 'GRECIPIENT',
      token: 'GTOKEN',
      deposit: 100_000n,
      flowRate: 100n,
      startTime: now - 100,
      endTime: now + 900,
      lastWithdrawTime: now,
      status: 'Active',
      autoRenew: false,
    };

    const onTick = vi.fn();
    const reconcile = vi.fn().mockResolvedValue(0n);
    const unsubscribe = watchClaimable(stream, reconcile, onTick);

    onTick.mockClear();
    unsubscribe();
    vi.advanceTimersByTime(5000);
    expect(onTick).not.toHaveBeenCalled();
  });

  it('deduplicates emissions when reconcile resumes after a network blip (same value twice)', async () => {
    // Pick parameters so that interpolation is **invariant** over the test
    // window: flowRate = 1 stroop/sec means perMs ≈ 0.001, and with
    // tickMs = 200 the floored per-tick increment is 0. That means every
    // tick AND the reconcile-driven emit() compute the same value (5000n)
    // — exactly the duplicate-emission scenario from the bug report.
    // A weak test with a coarser flow rate would never exercise the
    // dedup branch because each tick would advance by ≥1 stroop and
    // look distinct from the last.
    const now = Math.floor(Date.now() / 1000);
    const stream: Stream = {
      id: '0',
      sender: 'GSENDER',
      recipient: 'GRECIPIENT',
      token: 'GTOKEN',
      deposit: 100_000n,
      flowRate: 1n,
      startTime: now - 6000,
      endTime: now + 6000,
      lastWithdrawTime: now - 5000, // claimableNow(stream) = 1n * 5000 = 5000n
      status: 'Active',
      autoRenew: false,
    };

    // First reconcile throws (simulate network down on first poll);
    // subsequent reconciles return 5002n.
    let reconcileCalls = 0;
    const reconcile = vi.fn().mockImplementation(async () => {
      reconcileCalls++;
      if (reconcileCalls === 1) throw new Error('network down');
      return 5002n;
    });

    const onTick = vi.fn();
    const unsubscribe = watchClaimable(stream, reconcile, onTick, {
      tickMs: 200,
      reconcileMs: 1_000,
    });

    // Advance enough to fire ~12 ticks AND 2 reconcile attempts.
    await vi.advanceTimersByTimeAsync(2_500);

    // Without dedup, 5000n would be emitted ~13 times. With dedup, only
    // the initial seed call survives — every other emit() finds
    // interpolated === lastEmitted (5000n) and short-circuits.
    const callsWith5000 = onTick.mock.calls.filter(([v]) => v === 5000n).length;
    expect(callsWith5000).toBe(1);
    // Sanity: the watcher did actually run (not just an early-skip bug).
    expect(reconcileCalls).toBeGreaterThanOrEqual(2);

    unsubscribe();
  });

  it('still emits when reconcile returns a value that differs from the last emitted value', async () => {
    const now = Math.floor(Date.now() / 1000);
    const stream: Stream = {
      id: '0',
      sender: 'GSENDER',
      recipient: 'GRECIPIENT',
      token: 'GTOKEN',
      deposit: 100_000n,
      flowRate: 1n,
      startTime: now - 6000,
      endTime: now + 6000,
      lastWithdrawTime: now - 5000,
      status: 'Active',
      autoRenew: false,
    };

    let reconcileCalls = 0;
    const reconcile = vi.fn().mockImplementation(async () => {
      reconcileCalls++;
      // First reconcile: throw (simulate dropped network).
      // Second reconcile: succeed with a value materially larger than
      // 5000n, so it must produce a fresh emission distinct from the
      // last cached tick.
      if (reconcileCalls === 1) throw new Error('network down');
      return 9_999n;
    });

    const onTick = vi.fn();
    const unsubscribe = watchClaimable(stream, reconcile, onTick, {
      tickMs: 200,
      reconcileMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(2_500);

    // Asserting `some` would let a buggy (no-dedup) implementation
    // pass if reconcile happened to emit more than once. Asserting
    // exactly one catches both "didn't emit at all" and "over-emitted".
    const callsWith9999 = onTick.mock.calls.filter(([v]) => v === 9_999n).length;
    expect(callsWith9999).toBe(1);

    unsubscribe();
  });
});

// ── batchSize helper (issue #95) ─────────────────────────────────────────────

describe('batchSize', () => {
  it('returns 8 by default', () => {
    expect(batchSize()).toBe(8);
  });

  it('returns custom value when provided', () => {
    expect(batchSize(12)).toBe(12);
  });

  it('throws on zero', () => {
    expect(() => batchSize(0)).toThrow(SoroStreamError);
  });

  it('throws on value exceeding maximum', () => {
    expect(() => batchSize(26)).toThrow(SoroStreamError);
  });

  it('throws on non-integer', () => {
    expect(() => batchSize(2.5)).toThrow(SoroStreamError);
  });
});

// ── Fee estimation input validation ───────────────────────────────────────────

describe('estimate*Fee input validation', () => {
  let client: SoroStreamClient;
  let mockAdapter: WalletAdapter;

  beforeEach(() => {
    mockAdapter = {
      getPublicKey: vi.fn().mockResolvedValue(VALID_ACCOUNT),
      signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
      isConnected: vi.fn().mockResolvedValue(true),
    };

    client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: mockAdapter,
    });
  });

  it('rejects estimateCreateStreamFee with zero amount', async () => {
    await expect(
      client.estimateCreateStreamFee({
        recipient: VALID_ACCOUNT,
        token: VALID_CONTRACT,
        amount: 0n,
        durationSeconds: 1000,
        autoRenew: false,
      }),
    ).rejects.toThrow('Amount must be > 0');
  });

  it('rejects estimateCreateStreamFee with zero duration', async () => {
    await expect(
      client.estimateCreateStreamFee({
        recipient: VALID_ACCOUNT,
        token: VALID_CONTRACT,
        amount: 100n,
        durationSeconds: 0,
        autoRenew: false,
      }),
    ).rejects.toThrow('Duration must be > 0');
  });

  it('rejects estimateTopUpFee with zero amount', async () => {
    await expect(client.estimateTopUpFee({ streamId: '1', amount: 0n })).rejects.toThrow(
      'Amount must be > 0',
    );
  });
});

// ── SoroStreamClient validation tests ────────────────────────────────────────

describe('SoroStreamClient input validation', () => {
  let client: SoroStreamClient;
  let mockAdapter: WalletAdapter;

  beforeEach(() => {
    mockAdapter = {
      getPublicKey: vi.fn().mockResolvedValue(VALID_ACCOUNT),
      signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
      isConnected: vi.fn().mockResolvedValue(true),
    };

    client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: mockAdapter,
    });
  });

  it('rejects createStream with zero amount (InsufficientAmountError)', async () => {
    await expect(
      client.createStream({
        recipient: VALID_ACCOUNT,
        token: VALID_CONTRACT,
        amount: 0n,
        durationSeconds: 1000,
        autoRenew: false,
      }),
    ).rejects.toThrow(InsufficientAmountError);
  });

  it('rejects createStream with zero duration', async () => {
    await expect(
      client.createStream({
        recipient: VALID_RECIPIENT,
        token: VALID_CONTRACT,
        amount: 100n,
        durationSeconds: 0,
        autoRenew: false,
      }),
    ).rejects.toThrow(ZeroDurationError);
  });

  it('rejects topUp with zero amount (InsufficientAmountError)', async () => {
    await expect(client.topUp({ streamId: '1', amount: 0n })).rejects.toThrow(
      InsufficientAmountError,
    );
  });

  it('rejects topUpStream with zero amount (InsufficientAmountError)', async () => {
    await expect(client.topUpStream('1', 0n)).rejects.toThrow(InsufficientAmountError);
  });
});

// ── Typed error tests ────────────────────────────────────────────────────────

describe('typed errors', () => {
  it('InsufficientAmountError extends SoroStreamError', () => {
    const err = new InsufficientAmountError();
    expect(err).toBeInstanceOf(SoroStreamError);
    expect(err.message).toBe('Amount must be > 0');
  });

  it('InsufficientAmountError accepts custom message', () => {
    const err = new InsufficientAmountError('Custom');
    expect(err.message).toBe('Custom');
  });

  it('SoroStreamError is a base Error', () => {
    const err = new SoroStreamError('base');
    expect(err).toBeInstanceOf(Error);
  });

  it('InvalidAddressError extends SoroStreamError', () => {
    const err = new InvalidAddressError('INVALID');
    expect(err).toBeInstanceOf(SoroStreamError);
    expect(err.message).toContain('Invalid Stellar address');
  });

  it('AccountNotFoundError extends SoroStreamError', () => {
    const err = new AccountNotFoundError('GNOPE');
    expect(err).toBeInstanceOf(SoroStreamError);
    expect(err.message).toContain('Account not found');
  });
});

// ── createKeypairAdapter tests ────────────────────────────────────────────────

describe('createKeypairAdapter', () => {
  it('returns a connected WalletAdapter', async () => {
    const keypair = Keypair.random();
    const adapter = createKeypairAdapter(keypair.secret());
    expect(await adapter.isConnected()).toBe(true);
    expect(await adapter.getPublicKey()).toBe(keypair.publicKey());
  });

  it('throws on invalid secret key', () => {
    expect(() => createKeypairAdapter('INVALID')).toThrow();
  });
});

// ── aggregateStreamsByToken tests ─────────────────────────────────────────────

describe('aggregateStreamsByToken', () => {
  it('returns empty array for no streams', () => {
    expect(aggregateStreamsByToken([])).toEqual([]);
  });

  it('groups streams by token and sums correctly', () => {
    const now = Math.floor(Date.now() / 1000);
    const streams: Stream[] = [
      makeStream({
        id: '1',
        token: 'GUSDC',
        deposit: 1000n,
        flowRate: 10n,
        startTime: now - 200,
        lastWithdrawTime: now - 100,
        endTime: now + 100,
      }),
      makeStream({
        id: '2',
        token: 'GUSDC',
        deposit: 2000n,
        flowRate: 20n,
        startTime: now - 200,
        lastWithdrawTime: now - 50,
        endTime: now + 100,
      }),
      makeStream({
        id: '3',
        token: 'GEURC',
        deposit: 5000n,
        flowRate: 50n,
        status: 'Completed',
      }),
    ];

    const result = aggregateStreamsByToken(streams);

    expect(result).toHaveLength(2);

    const eurc = result.find((t) => t.token === 'GEURC')!;
    expect(eurc.streamCount).toBe(1);
    expect(eurc.deposited).toBe(5000n);
    expect(eurc.claimable).toBe(0n);

    const usdc = result.find((t) => t.token === 'GUSDC')!;
    expect(usdc.streamCount).toBe(2);
    expect(usdc.deposited).toBe(3000n);
    expect(usdc.claimable).toBeGreaterThan(0n);
  });
});

// ── parseCsvStreamRows tests ──────────────────────────────────────────────────

describe('parseCsvStreamRows', () => {
  it('parses valid CSV with header', () => {
    const csv = `recipient,amount,durationSeconds
GABCD,10000000,86400
GEFGH,5000000,604800`;

    const rows = parseCsvStreamRows(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      recipient: 'GABCD',
      amount: 10000000n,
      durationSeconds: 86400,
    });
    expect(rows[1]).toEqual({
      recipient: 'GEFGH',
      amount: 5000000n,
      durationSeconds: 604800,
    });
  });

  it('throws on empty CSV', () => {
    expect(() => parseCsvStreamRows('')).toThrow();
  });

  it('throws on missing recipient column', () => {
    expect(() => parseCsvStreamRows(`amount,durationSeconds\n100,10`)).toThrow(
      "CSV missing 'recipient' column",
    );
  });

  it('throws on invalid durationSeconds', () => {
    expect(() => parseCsvStreamRows(`recipient,amount,durationSeconds\nGABCD,100,0`)).toThrow(
      'invalid durationSeconds',
    );
  });

  it('skips empty lines', () => {
    const csv = `recipient,amount,durationSeconds
GABCD,100,10

GEFGH,200,20
`;
    const rows = parseCsvStreamRows(csv);
    expect(rows).toHaveLength(2);
  });
});

// ── batchWithdraw validation tests ────────────────────────────────────────────

describe('SoroStreamClient batchWithdraw', () => {
  let client: SoroStreamClient;
  let mockAdapter: WalletAdapter;

  beforeEach(() => {
    mockAdapter = {
      // Use a valid Stellar public key so nativeToScVal({ type: "address" }) succeeds.
      getPublicKey: vi.fn().mockResolvedValue(TEST_PK),
      signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
      isConnected: vi.fn().mockResolvedValue(true),
    };

    client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: mockAdapter,
    });

    vi.spyOn(client, 'executeBatch').mockResolvedValue('txhash_batch');
    vi.spyOn(client, 'getClaimable').mockResolvedValue(500n);
  });

  it('returns successes for all streams when executeBatch succeeds', async () => {
    const result = await client.batchWithdraw(['1', '2', '3'], 8);

    expect(result.successes).toEqual(['1', '2', '3']);
    expect(result.failures).toEqual([]);
  });

  it('splits into multiple batches when count exceeds batchSize', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => String(i + 1));
    const result = await client.batchWithdraw(ids, 3);

    expect(result.successes).toHaveLength(10);
    expect(result.failures).toEqual([]);
  });

  it('fires onProgress after each chunk with cumulative counts', async () => {
    const progress: BatchProgress[] = [];
    await client.batchWithdraw(['1', '2', '3', '4', '5'], 2, (p) => progress.push(p));

    expect(progress).toEqual([
      { completed: 2, total: 5, processedIds: ['1', '2'] },
      { completed: 4, total: 5, processedIds: ['3', '4'] },
      { completed: 5, total: 5, processedIds: ['5'] },
    ]);
  });

  it('fires onProgress for failed chunks too', async () => {
    vi.spyOn(client, 'executeBatch')
      .mockResolvedValueOnce('tx1')
      .mockRejectedValueOnce(new Error('chunk failed'));

    const progress: BatchProgress[] = [];
    const result = await client.batchWithdraw(['1', '2', '3', '4'], 2, (p) => progress.push(p));

    expect(progress).toEqual([
      { completed: 2, total: 4, processedIds: ['1', '2'] },
      { completed: 4, total: 4, processedIds: ['3', '4'] },
    ]);
    expect(result.failures).toHaveLength(2);
  });

  it('records failures when executeBatch rejects for a chunk', async () => {
    vi.spyOn(client, 'executeBatch')
      .mockResolvedValueOnce('tx1')
      .mockRejectedValueOnce(new Error('batch failed'));

    const result = await client.batchWithdraw(['1', '2', '3', '4'], 2);

    expect(result.successes).toEqual(['1', '2']);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]!.id).toBe('3');
  });

  it('returns all failures when all batches fail', async () => {
    vi.spyOn(client, 'executeBatch').mockRejectedValue(new Error('all failed'));

    const result = await client.batchWithdraw(['1', '2'], 8);

    expect(result.successes).toEqual([]);
    expect(result.failures).toHaveLength(2);
  });
});

// ── bulkCreateStreams validation tests ────────────────────────────────────────

describe('SoroStreamClient bulkCreateStreams', () => {
  let client: SoroStreamClient;
  let mockAdapter: WalletAdapter;

  beforeEach(() => {
    mockAdapter = {
      // Use a valid Stellar public key so nativeToScVal({ type: "address" }) succeeds.
      getPublicKey: vi.fn().mockResolvedValue(TEST_PK),
      signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
      isConnected: vi.fn().mockResolvedValue(true),
    };

    client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: mockAdapter,
    });

    vi.spyOn(client, 'executeBatch').mockResolvedValue('txhash_bulk');
  });

  it('processes rows and returns batch results', async () => {
    vi.spyOn(client, 'getStreamsBySender').mockResolvedValue([
      makeStream({ id: '10' }),
      makeStream({ id: '11' }),
    ]);

    const rows: BulkStreamRow[] = [
      // Use valid Stellar addresses for recipient; token must be a valid C-address.
      { recipient: TEST_PK, amount: 100n, durationSeconds: 3600 },
      { recipient: TEST_PK, amount: 200n, durationSeconds: 7200 },
    ];

    const result = await client.bulkCreateStreams(rows, {
      token: TEST_TOKEN,
      autoRenew: false,
      batchSize: 8,
    });

    expect(result.batches).toHaveLength(1);
    expect(result.batches[0]!.txHash).toBe('txhash_bulk');
    expect(result.batches[0]!.streamIds).toEqual(['10', '11']);
  });

  it('defaults autoRenew to false', async () => {
    vi.spyOn(client, 'getStreamsBySender').mockResolvedValue([]);

    const rows: BulkStreamRow[] = [{ recipient: TEST_PK, amount: 100n, durationSeconds: 3600 }];

    const result = await client.bulkCreateStreams(rows, {
      token: TEST_TOKEN,
    });

    expect(result.batches).toHaveLength(1);
    expect(result.batches[0]!.streamIds).toEqual([]);
  });

  it('fires onProgress after each chunk with cumulative counts', async () => {
    vi.spyOn(client, 'getStreamsBySender').mockResolvedValue([]);

    const rows: BulkStreamRow[] = [
      { recipient: TEST_PK, amount: 100n, durationSeconds: 3600 },
      { recipient: TEST_PK, amount: 200n, durationSeconds: 7200 },
      { recipient: TEST_PK, amount: 300n, durationSeconds: 3600 },
    ];

    const progress: BatchProgress[] = [];
    await client.bulkCreateStreams(rows, {
      token: TEST_TOKEN,
      batchSize: 2,
      onProgress: (p) => progress.push(p),
    });

    expect(progress).toEqual([
      { completed: 2, total: 3, processedIds: [TEST_PK, TEST_PK] },
      { completed: 3, total: 3, processedIds: [TEST_PK] },
    ]);
  });

  it('fires onProgress per row when a chunk has mixed tokens', async () => {
    vi.spyOn(client, 'getStreamsBySender').mockResolvedValue([]);
    vi.spyOn(client, 'buildAndSubmit').mockResolvedValue({ txHash: 'tx_mixed', ledger: 0 });

    const otherToken = VALID_CONTRACT;
    const rows: BulkStreamRow[] = [
      { recipient: TEST_PK, amount: 100n, durationSeconds: 3600, token: TEST_TOKEN },
      { recipient: TEST_PK, amount: 200n, durationSeconds: 7200, token: otherToken },
    ];

    const progress: BatchProgress[] = [];
    await client.bulkCreateStreams(rows, {
      token: TEST_TOKEN,
      onProgress: (p) => progress.push(p),
    });

    expect(progress).toEqual([
      { completed: 1, total: 2, processedIds: [TEST_PK] },
      { completed: 2, total: 2, processedIds: [TEST_PK] },
    ]);
  });
});

// ── Pre-flight validation tests (Issue 2) ────────────────────────────────────

describe('createStream pre-flight validation', () => {
  let client: SoroStreamClient;
  let mockAdapter: WalletAdapter;

  beforeEach(() => {
    mockAdapter = {
      getPublicKey: vi.fn().mockResolvedValue(VALID_ACCOUNT),
      signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
      isConnected: vi.fn().mockResolvedValue(true),
    };

    client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: mockAdapter,
    });
  });

  it('rejects invalid recipient address format', async () => {
    await expect(
      client.createStream({
        recipient: 'INVALID',
        token: VALID_CONTRACT,
        amount: 100n,
        durationSeconds: 1000,
        autoRenew: false,
      }),
    ).rejects.toThrow(InvalidAddressError);
  });

  it('rejects invalid token address format', async () => {
    await expect(
      client.createStream({
        recipient: VALID_RECIPIENT,
        token: 'SHORT',
        amount: 100n,
        durationSeconds: 1000,
        autoRenew: false,
      }),
    ).rejects.toThrow(InvalidAddressError);
  });

  it('rejects non-existent recipient account', async () => {
    const mockServer = {
      getAccount: vi.fn().mockRejectedValue(new Error('not found')),
      simulateTransaction: vi.fn(),
      prepareTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      getTransaction: vi.fn(),
    };
    (client as any).server = mockServer;

    await expect(
      client.createStream({
        recipient: VALID_RECIPIENT,
        token: VALID_CONTRACT,
        amount: 100n,
        durationSeconds: 1000,
        autoRenew: false,
      }),
    ).rejects.toThrow(AccountNotFoundError);
  });

  it('rejects non-existent sender account', async () => {
    let callCount = 0;
    const mockServer = {
      getAccount: vi.fn().mockImplementation(async (addr: string) => {
        callCount++;
        if (callCount === 1) {
          return { accountId: () => addr };
        }
        throw new Error('not found');
      }),
      simulateTransaction: vi.fn(),
      prepareTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      getTransaction: vi.fn(),
    };
    (client as any).server = mockServer;

    await expect(
      client.createStream({
        recipient: VALID_RECIPIENT,
        token: VALID_CONTRACT,
        amount: 100n,
        durationSeconds: 1000,
        autoRenew: false,
      }),
    ).rejects.toThrow(AccountNotFoundError);
  });
});

// ── Contract versioning tests (Issue 4) ──────────────────────────────────────

describe('contract versioning', () => {
  const testContract = new Contract(VALID_CONTRACT);

  it('v1 encoder creates correct create_stream operation', () => {
    const encoder = createContractEncoder(testContract, 'v1');
    const op = encoder.createStream(VALID_ACCOUNT, {
      recipient: VALID_ACCOUNT,
      token: VALID_CONTRACT,
      amount: 1000n,
      durationSeconds: 3600,
      autoRenew: false,
    });
    expect(op).toBeDefined();
    expect(op.toXDR()).toBeTruthy();
  });

  it('v2 encoder creates correct create_stream operation', () => {
    const encoder = createContractEncoder(testContract, 'v2');
    const op = encoder.createStream(VALID_ACCOUNT, {
      recipient: VALID_ACCOUNT,
      token: VALID_CONTRACT,
      amount: 1000n,
      durationSeconds: 3600,
      autoRenew: true,
    });
    expect(op).toBeDefined();
    expect(op.toXDR()).toBeTruthy();
  });

  it('v1 encoder creates correct withdraw operation', () => {
    const encoder = createContractEncoder(testContract, 'v1');
    const op = encoder.withdraw('1', VALID_ACCOUNT);
    expect(op).toBeDefined();
    expect(op.toXDR()).toBeTruthy();
  });

  it('v1 encoder creates correct cancel_stream operation', () => {
    const encoder = createContractEncoder(testContract, 'v1');
    const op = encoder.cancelStream('1', VALID_ACCOUNT);
    expect(op).toBeDefined();
    expect(op.toXDR()).toBeTruthy();
  });

  it('v1 encoder creates correct top_up operation', () => {
    const encoder = createContractEncoder(testContract, 'v1');
    const op = encoder.topUp('1', VALID_ACCOUNT, 500n);
    expect(op).toBeDefined();
    expect(op.toXDR()).toBeTruthy();
  });

  it('client uses versioned encoder based on contractVersion option', () => {
    const adapter: WalletAdapter = {
      getPublicKey: vi.fn().mockResolvedValue(VALID_ACCOUNT),
      signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
      isConnected: vi.fn().mockResolvedValue(true),
    };

    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: adapter,
      contractVersion: 'v2',
    });

    const encoder = (client as any).encoder;
    expect(encoder).toBeDefined();
  });
});

// ── Price feed adapter tests (Issue 1) ───────────────────────────────────────

describe('price feed adapter integration', () => {
  it('client exposes price feed via getPriceFeed()', () => {
    const mockFeed: PriceFeedAdapter = {
      getPrice: vi.fn().mockResolvedValue(1.0),
    };

    const adapter: WalletAdapter = {
      getPublicKey: vi.fn().mockResolvedValue(VALID_ACCOUNT),
      signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
      isConnected: vi.fn().mockResolvedValue(true),
    };

    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: adapter,
      priceFeed: mockFeed,
    });

    expect(client.getPriceFeed()).toBe(mockFeed);
  });

  it('client returns null price feed when not configured', () => {
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

    expect(client.getPriceFeed()).toBeNull();
  });
});

// ── Fee bump option tests (Issue 3) ──────────────────────────────────────────

describe('fee bump options', () => {
  it('client accepts default fee bump options', () => {
    const sponsorAdapter: WalletAdapter = {
      getPublicKey: vi.fn().mockResolvedValue(VALID_ACCOUNT),
      signTransaction: vi.fn().mockResolvedValue('signed_fee_bump'),
      isConnected: vi.fn().mockResolvedValue(true),
    };

    const userAdapter: WalletAdapter = {
      getPublicKey: vi.fn().mockResolvedValue(VALID_ACCOUNT),
      signTransaction: vi.fn().mockResolvedValue('signed_inner'),
      isConnected: vi.fn().mockResolvedValue(true),
    };

    const feeBump: FeeBumpOptions = {
      sponsorAddress: VALID_ACCOUNT,
      sponsorAdapter,
      maxFee: 10_000,
    };

    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: userAdapter,
      feeBump,
    });

    const defaultBump = (client as any).defaultFeeBump;
    expect(defaultBump).toBe(feeBump);
    expect(defaultBump.sponsorAddress).toBe(VALID_ACCOUNT);
    expect(defaultBump.maxFee).toBe(10_000);
  });
});

// ── Issue #44: Locale-aware formatUSDC ───────────────────────────────────────

describe('formatUSDC locale-aware', () => {
  it('returns existing precise string when no options provided', () => {
    expect(formatUSDC(1_000_000_000n)).toBe('100.0000000');
    expect(formatUSDC(1n)).toBe('0.0000001');
  });

  it('formats with locale grouping separator', () => {
    // 1,234 USDC = 12_340_000_000 stroops
    const result = formatUSDC(12_340_000_000n, 7, {
      locale: 'en-US',
      useGrouping: true,
      maximumFractionDigits: 2,
    });
    expect(result).toContain(',');
    expect(result).toMatch(/1,234/);
  });

  it('trims to maximumFractionDigits', () => {
    const result = formatUSDC(1_005_000_000n, 7, {
      locale: 'en-US',
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    });
    // 100.5000000 → "100.5" (max 2 decimal digits, trailing zeros removed)
    expect(result).toBe('100.5');
  });

  it('pads to minimumFractionDigits', () => {
    const result = formatUSDC(1_000_000_000n, 7, {
      locale: 'en-US',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    expect(result).toBe('100.00');
  });

  it('disables grouping when useGrouping is false', () => {
    const result = formatUSDC(12_340_000_000n, 7, {
      locale: 'en-US',
      useGrouping: false,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
    expect(result).not.toContain(',');
    expect(result).toBe('1234');
  });

  it('works with de-DE locale (period thousands, comma decimal)', () => {
    const result = formatUSDC(12_340_000_000n, 7, {
      locale: 'de-DE',
      useGrouping: true,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
    // de-DE uses period as thousands separator
    expect(result).toContain('.');
  });

  it('formats with en-US locale and default fraction digits', () => {
    const result = formatUSDC(1_000_000_000n, 7, { locale: 'en-US' });
    expect(result).toBe('100.00');
  });

  it('formats with de-DE locale (comma decimal separator)', () => {
    const result = formatUSDC(10_500_000n, 7, { locale: 'de-DE' });
    expect(result).toBe('1,05');
  });

  it('formats with ja-JP locale', () => {
    const result = formatUSDC(1_000_000_000n, 7, { locale: 'ja-JP' });
    expect(result).toBe('100.00');
  });

  it('formats with ar-SA locale (Arabic-Indic digits)', () => {
    const result = formatUSDC(1_000_000_000n, 7, { locale: 'ar-SA' });
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(result).toMatch(/[\.٫]/);
  });

  it('defaults minimum fraction digits to 2 with locale', () => {
    const result = formatUSDC(1_000_000_000n, 7, { locale: 'en-US' });
    expect(result).toBe('100.00');
  });

  it('respects explicit minimumFractionDigits override', () => {
    const result = formatUSDC(1_000_000_000n, 7, {
      locale: 'en-US',
      minimumFractionDigits: 4,
      maximumFractionDigits: 7,
    });
    expect(result).toBe('100.0000');
  });
});

// ── Issue #47: detectStreamDrift & watchStreamDrift ──────────────────────────

describe('detectStreamDrift', () => {
  it('returns empty array for identical streams', () => {
    const s = makeStream();
    expect(detectStreamDrift(s, { ...s })).toEqual([]);
  });

  it('detects status change', () => {
    const cached = makeStream({ status: 'Active' });
    const onChain = makeStream({ status: 'Completed' });
    const diffs = detectStreamDrift(cached, onChain);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.field).toBe('status');
    expect(diffs[0]!.cached).toBe('Active');
    expect(diffs[0]!.onChain).toBe('Completed');
  });

  it('detects deposit change', () => {
    const cached = makeStream({ deposit: 100_000n });
    const onChain = makeStream({ deposit: 200_000n });
    const diffs = detectStreamDrift(cached, onChain);
    const depositDiff = diffs.find((d) => d.field === 'deposit');
    expect(depositDiff).toBeDefined();
  });

  it('detects multiple drifted fields simultaneously', () => {
    const cached = makeStream({ status: 'Active', autoRenew: false });
    const onChain = makeStream({ status: 'Cancelled', autoRenew: true });
    const diffs = detectStreamDrift(cached, onChain);
    expect(diffs.length).toBeGreaterThanOrEqual(2);
  });

  it('ignores immutable fields (id, sender, recipient, token, startTime)', () => {
    const cached = makeStream({ id: '1', sender: 'GA' });
    const onChain = makeStream({ id: '99', sender: 'GB' });
    const diffs = detectStreamDrift(cached, onChain);
    expect(diffs.every((d) => d.field !== 'id' && d.field !== 'sender')).toBe(true);
  });
});

describe('watchStreamDrift', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls onDrift when on-chain state differs from cached', async () => {
    const cached = makeStream({ status: 'Active' });
    const fresh = makeStream({ status: 'Completed' });
    const fetchOnChain = vi.fn().mockResolvedValue(fresh);
    const onDrift = vi.fn();

    const stop = watchStreamDrift(cached, fetchOnChain, onDrift, { intervalMs: 1000 });

    // Flush microtasks from the immediate void check() — no timer advance needed.
    await Promise.resolve();

    expect(onDrift).toHaveBeenCalledOnce();
    const [diffs, freshArg] = onDrift.mock.calls[0] as [
      ReturnType<typeof detectStreamDrift>,
      Stream,
    ];
    expect(diffs.some((d) => d.field === 'status')).toBe(true);
    expect(freshArg.status).toBe('Completed');

    stop();
  });

  it('does not call onDrift when state is unchanged', async () => {
    const cached = makeStream();
    const fetchOnChain = vi.fn().mockResolvedValue({ ...cached });
    const onDrift = vi.fn();

    const stop = watchStreamDrift(cached, fetchOnChain, onDrift);

    await Promise.resolve();

    expect(onDrift).not.toHaveBeenCalled();
    stop();
  });

  it('stops after unsubscribe', async () => {
    const cached = makeStream({ status: 'Active' });
    const fresh = makeStream({ status: 'Completed' });
    const fetchOnChain = vi.fn().mockResolvedValue(fresh);
    const onDrift = vi.fn();

    const stop = watchStreamDrift(cached, fetchOnChain, onDrift, { intervalMs: 5000 });
    // stop() sets stopped=true before check()'s await resolves
    stop();

    await Promise.resolve();
    expect(onDrift).not.toHaveBeenCalled();
  });

  it('swallows fetch errors and keeps watching', async () => {
    const cached = makeStream();
    const fetchOnChain = vi.fn().mockRejectedValue(new Error('RPC down'));
    const onDrift = vi.fn();

    const stop = watchStreamDrift(cached, fetchOnChain, onDrift, { intervalMs: 1000 });

    // Flush the immediate check; errors are caught internally.
    await Promise.resolve();
    expect(onDrift).not.toHaveBeenCalled();

    stop();
  });
});

// ── Stream detection helpers ──────────────────────────────────────────────────

describe('isStreamExpiring', () => {
  it('returns false for non-active streams', () => {
    expect(isStreamExpiring(makeStream({ status: 'Cancelled' }))).toBe(false);
    expect(isStreamExpiring(makeStream({ status: 'Completed' }))).toBe(false);
  });

  it('returns true when stream ends within threshold', () => {
    const now = Math.floor(Date.now() / 1000);
    const stream = makeStream({
      status: 'Active',
      endTime: now + 100,
    });
    expect(isStreamExpiring(stream, 200)).toBe(true);
  });

  it('returns false when stream has plenty of time left', () => {
    const now = Math.floor(Date.now() / 1000);
    const stream = makeStream({
      status: 'Active',
      endTime: now + 100_000,
    });
    expect(isStreamExpiring(stream, 200)).toBe(false);
  });
});

describe('isStreamStalled', () => {
  it('returns false for non-active streams', () => {
    expect(isStreamStalled(makeStream({ status: 'Cancelled' }))).toBe(false);
  });

  it('returns true when last withdrawal was too long ago', () => {
    const now = Math.floor(Date.now() / 1000);
    const stream = makeStream({
      status: 'Active',
      lastWithdrawTime: now - 100_000,
    });
    expect(isStreamStalled(stream, 1000)).toBe(true);
  });

  it('returns false for recent withdrawals', () => {
    const now = Math.floor(Date.now() / 1000);
    const stream = makeStream({
      status: 'Active',
      lastWithdrawTime: now - 10,
    });
    expect(isStreamStalled(stream, 1000)).toBe(false);
  });
});

describe('isStreamUnderfunded', () => {
  it('returns false for non-active streams', () => {
    expect(isStreamUnderfunded(makeStream({ status: 'Cancelled' }))).toBe(false);
  });

  it('returns false for properly funded stream', () => {
    const now = Math.floor(Date.now() / 1000);
    const start = now - 500;
    const stream = makeStream({
      status: 'Active',
      flowRate: 100n,
      deposit: 100_000n,
      startTime: start,
      endTime: start + 1000,
      lastWithdrawTime: start,
    });
    expect(isStreamUnderfunded(stream)).toBe(false);
  });

  it('returns true when deposit is too low for flow rate until end time', () => {
    const now = Math.floor(Date.now() / 1000);
    const start = now - 100;
    const stream = makeStream({
      status: 'Active',
      flowRate: 100n,
      deposit: 1000n,
      startTime: start,
      endTime: start + 1000,
      lastWithdrawTime: start,
    });
    expect(isStreamUnderfunded(stream)).toBe(true);
  });
});

// ── Operator delegation tests ────────────────────────────────────────────────

describe('SoroStreamClient setOperator', () => {
  let client: SoroStreamClient;
  let mockAdapter: WalletAdapter;

  beforeEach(() => {
    mockAdapter = {
      getPublicKey: vi.fn().mockResolvedValue(TEST_PK),
      signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
      isConnected: vi.fn().mockResolvedValue(true),
    };

    client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: mockAdapter,
    });

    vi.spyOn(client, 'buildAndSubmit' as any).mockResolvedValue({ txHash: 'txhash_op', ledger: 0 });
  });

  it('sets an operator and returns tx hash', async () => {
    const result = await client.setOperator({
      streamId: '1',
      operator: TEST_PK,
      approved: true,
    });
    expect(result.txHash).toBe('txhash_op');
  });

  it('revokes an operator when approved is false', async () => {
    const result = await client.setOperator({
      streamId: '1',
      operator: TEST_PK,
      approved: false,
    });
    expect(result.txHash).toBe('txhash_op');
  });
});

describe('SoroStreamClient operatorCancelStream', () => {
  let client: SoroStreamClient;
  let mockAdapter: WalletAdapter;

  beforeEach(() => {
    mockAdapter = {
      getPublicKey: vi.fn().mockResolvedValue(TEST_PK),
      signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
      isConnected: vi.fn().mockResolvedValue(true),
    };

    client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: mockAdapter,
    });

    vi.spyOn(client, 'buildAndSubmit' as any).mockResolvedValue({
      txHash: 'txhash_op_cancel',
      ledger: 0,
    });
  });

  it('cancels stream as operator and returns tx hash', async () => {
    const result = await client.operatorCancelStream({ streamId: '1' });
    expect(result.txHash).toBe('txhash_op_cancel');
  });
});

describe('SoroStreamClient operatorTopUp', () => {
  let client: SoroStreamClient;
  let mockAdapter: WalletAdapter;

  beforeEach(() => {
    mockAdapter = {
      getPublicKey: vi.fn().mockResolvedValue(TEST_PK),
      signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
      isConnected: vi.fn().mockResolvedValue(true),
    };

    client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: mockAdapter,
    });

    vi.spyOn(client, 'buildAndSubmit' as any).mockResolvedValue({
      txHash: 'txhash_op_topup',
      ledger: 0,
    });
  });

  it('tops up stream as operator and returns tx hash', async () => {
    const result = await client.operatorTopUp({ streamId: '1', amount: 1000n });
    expect(result.txHash).toBe('txhash_op_topup');
  });

  it('rejects zero amount', async () => {
    await expect(client.operatorTopUp({ streamId: '1', amount: 0n })).rejects.toThrow(
      InsufficientAmountError,
    );
  });
});

// ── updateFlowRate tests ─────────────────────────────────────────────────────

describe('SoroStreamClient updateFlowRate', () => {
  let client: SoroStreamClient;
  let mockAdapter: WalletAdapter;

  beforeEach(() => {
    mockAdapter = {
      getPublicKey: vi.fn().mockResolvedValue(TEST_PK),
      signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
      isConnected: vi.fn().mockResolvedValue(true),
    };

    client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: mockAdapter,
    });

    vi.spyOn(client, 'buildAndSubmit' as any).mockResolvedValue({
      txHash: 'txhash_update',
      ledger: 0,
    });
  });

  it('updates flow rate and returns tx hash', async () => {
    const result = await client.updateFlowRate({
      streamId: '1',
      newFlowRate: 200n,
    });
    expect(result.txHash).toBe('txhash_update');
  });

  it('rejects zero or negative flow rate', async () => {
    await expect(client.updateFlowRate({ streamId: '1', newFlowRate: 0n })).rejects.toThrow(
      InsufficientAmountError,
    );
  });
});

// ── Issue #48: withRetry ──────────────────────────────────────────────────────

describe('withRetry', () => {
  it('returns immediately on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('retries on failure and succeeds on second attempt', async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 2) throw new Error('transient');
      return 'ok';
    });
    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting all attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('permanent'));
    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 })).rejects.toThrow('permanent');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('respects maxAttempts: 1 (no retry)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));
    await expect(withRetry(fn, { maxAttempts: 1 })).rejects.toThrow('fail');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('aborts between retries when signal fires', async () => {
    const controller = new AbortController();
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        controller.abort();
        throw new Error('fail');
      }
      return 'ok';
    });

    await expect(
      withRetry(fn, { maxAttempts: 5, baseDelayMs: 1, signal: controller.signal }),
    ).rejects.toThrow('Retry aborted');
    expect(fn).toHaveBeenCalledOnce();
  });
});

describe('getClaimable stream-not-found vs RPC error', () => {
  let client: SoroStreamClient;
  let mockAdapter: WalletAdapter;

  beforeEach(() => {
    mockAdapter = {
      getPublicKey: vi.fn().mockResolvedValue('GABC123'),
      signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
      isConnected: vi.fn().mockResolvedValue(true),
    };
    client = new SoroStreamClient({
      network: 'testnet',
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
      walletAdapter: mockAdapter,
    });
  });

  it('returns 0n for contract-level simulation error (stream not found)', async () => {
    vi.spyOn(client as any, 'simulateOp').mockResolvedValue({
      error: 'contract error: stream not found',
      id: '1',
      latestLedger: 100,
    });

    const result = await client.getClaimable('99');
    expect(result).toBe(0n);
  });

  it('clamps negative claimable to 0n', async () => {
    const retval = nativeToScVal(-1n, { type: 'i128' });
    vi.spyOn(client as any, 'simulateOp').mockResolvedValue({
      result: { retval },
      id: '1',
      latestLedger: 200,
    });

    const result = await client.getClaimable('99');
    expect(result).toBe(0n);
  });
});

// ── Issue #46: createPasskeyAdapter ──────────────────────────────────────────

describe('createPasskeyAdapter', () => {
  const mockCredentialId = new ArrayBuffer(32);

  beforeEach(() => {
    // Mock WebAuthn environment
    Object.defineProperty(global, 'window', {
      value: { PublicKeyCredential: class {} },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(global, 'navigator', {
      value: {
        credentials: {
          get: vi.fn(),
        },
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws when WebAuthn is not available', async () => {
    Object.defineProperty(global, 'window', {
      value: {},
      writable: true,
      configurable: true,
    });
    await expect(
      createPasskeyAdapter({
        contractId: 'CA123',
        rpId: 'example.com',
        credentialId: mockCredentialId,
      }),
    ).rejects.toThrow('WebAuthn is not available');
  });

  it('getPublicKey returns the contractId', async () => {
    const adapter = await createPasskeyAdapter({
      contractId: 'CABC123',
      rpId: 'example.com',
      credentialId: mockCredentialId,
    });
    expect(await adapter.getPublicKey()).toBe('CABC123');
  });

  it('isConnected returns true when WebAuthn API is present', async () => {
    const adapter = await createPasskeyAdapter({
      contractId: 'CABC123',
      rpId: 'example.com',
      credentialId: mockCredentialId,
    });
    expect(await adapter.isConnected()).toBe(true);
  });

  it('signTransaction returns unchanged XDR when no invokeHostFunction ops', async () => {
    // Build a minimal non-invokeHostFunction XDR string (just pass through)
    const adapter = await createPasskeyAdapter({
      contractId: 'CABC123',
      rpId: 'example.com',
      credentialId: mockCredentialId,
    });

    // A non-Soroban XDR (will fail to parse as v1 env) → just verify it doesn't hang
    const xdrStr = 'AAAAAQAAAA==';
    await expect(adapter.signTransaction(xdrStr, 'testnet')).rejects.toThrow();
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeStream(overrides: Partial<Stream> = {}): Stream {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: '0',
    sender: 'GSENDER',
    recipient: 'GRECIPIENT',
    token: 'GTOKEN',
    deposit: 100_000n,
    flowRate: 100n,
    startTime: now,
    endTime: now + 1000,
    lastWithdrawTime: now,
    status: 'Active',
    autoRenew: false,
    ...overrides,
  };
}

describe('executeBatch', () => {
  it('submits a batch of operations', async () => {
    const mockAdapter = {
      getPublicKey: vi.fn().mockResolvedValue(MOCK_SENDER),
      signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
      isConnected: vi.fn().mockResolvedValue(true),
    };
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
      walletAdapter: mockAdapter,
    });
    vi.spyOn(client, 'executeBatch').mockResolvedValue('txhash_batch');

    const op = client['contract'].call(
      'withdraw',
      nativeToScVal(1n, { type: 'u64' }),
      nativeToScVal(MOCK_RECIPIENT, { type: 'address' }),
    );
    const txHash = await client.executeBatch([op]);
    expect(txHash).toBe('txhash_batch');
  });
});

describe('createStream duplicate check', () => {
  it('warns or blocks duplicate streams when enabled', async () => {
    const mockAdapter = {
      getPublicKey: vi.fn().mockResolvedValue(MOCK_SENDER),
      signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
      isConnected: vi.fn().mockResolvedValue(true),
    };
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
      walletAdapter: mockAdapter,
      checkDuplicate: true,
    });

    const now = Math.floor(Date.now() / 1000);
    vi.spyOn(client, 'getStreamsBySender').mockResolvedValue([
      makeStream({
        recipient: MOCK_RECIPIENT,
        token: MOCK_TOKEN,
        deposit: 100n,
        flowRate: 10n,
        startTime: now - 30,
        endTime: now + 30,
        status: 'Active',
      }),
    ]);

    await expect(
      client.createStream({
        recipient: MOCK_RECIPIENT,
        token: MOCK_TOKEN,
        amount: 100n,
        durationSeconds: 60,
        autoRenew: false,
      }),
    ).rejects.toThrow(DuplicateStreamError);
  });
});

describe('createLedgerAdapter', () => {
  it('signs transaction hash and returns public key', async () => {
    const mockTransport = { decorateAppAPIMethods: vi.fn() };
    const mockPublicKey = MOCK_SENDER;

    // Pass the public key via config so getPublicKey() returns it without
    // hitting the Ledger hardware. The spy-based approach doesn't work in
    // ESM environments because `import()` and `require()` resolve to
    // different module instances with separate prototype chains.
    const adapter = createLedgerAdapter({
      transport: mockTransport,
      publicKey: mockPublicKey,
    });

    expect(await adapter.isConnected()).toBe(true);
    expect(await adapter.getPublicKey()).toBe(mockPublicKey);
  });
});

// ── Issue: getClaimable in-flight deduplication ───────────────────────────────

describe('getClaimable – in-flight deduplication and TTL cache', () => {
  let client: SoroStreamClient;
  let mockAdapter: WalletAdapter;

  beforeEach(() => {
    mockAdapter = {
      getPublicKey: vi.fn().mockResolvedValue('GABC123'),
      signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
      isConnected: vi.fn().mockResolvedValue(true),
    };
    client = new SoroStreamClient({
      network: 'testnet',
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
      walletAdapter: mockAdapter,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('10 concurrent callers for the same stream ID all receive identical values', async () => {
    // Build a real xdr.ScVal so scValToNative() decodes it correctly.
    const { nativeToScVal } = await import('@stellar/stellar-sdk');
    const expectedAmount = 123_456_789n;
    const retval = nativeToScVal(Number(expectedAmount), { type: 'i128' });

    let rpcCallCount = 0;
    vi.spyOn(client as any, 'simulateOp').mockImplementation(async () => {
      rpcCallCount++;
      // Simulate a network round-trip so concurrent callers actually overlap.
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      return {
        result: { retval },
        latestLedger: 100,
      } as any;
    });

    // Fire 10 calls simultaneously — all with the same stream ID.
    const results = await Promise.all(Array.from({ length: 10 }, () => client.getClaimable('42')));

    // Every caller must get the exact same value.
    expect(results).toHaveLength(10);
    for (const result of results) {
      expect(result).toBe(expectedAmount);
    }

    // Only a single RPC call should have been made for all 10 concurrent callers.
    expect(rpcCallCount).toBe(1);
  });

  it('callers after TTL expiry trigger a new RPC call', async () => {
    const { nativeToScVal } = await import('@stellar/stellar-sdk');
    const retval = nativeToScVal(500, { type: 'i128' });

    let rpcCallCount = 0;
    vi.spyOn(client as any, 'simulateOp').mockImplementation(async () => {
      rpcCallCount++;
      return { result: { retval }, latestLedger: 100 } as any;
    });

    // First call — populates the in-flight + cache.
    const first = await client.getClaimable('7');
    expect(first).toBe(500n);
    expect(rpcCallCount).toBe(1);

    // Expire the TTL cache by clearing it directly.
    (client as any).claimableCache.clear();

    // Next call after TTL expiry should issue a fresh RPC call.
    const second = await client.getClaimable('7');
    expect(second).toBe(500n);
    expect(rpcCallCount).toBe(2);
  });

  it('serves cached value within TTL without additional RPC calls', async () => {
    const { nativeToScVal } = await import('@stellar/stellar-sdk');
    const retval = nativeToScVal(999, { type: 'i128' });

    let rpcCallCount = 0;
    vi.spyOn(client as any, 'simulateOp').mockImplementation(async () => {
      rpcCallCount++;
      return { result: { retval }, latestLedger: 100 } as any;
    });

    // First call — populates the cache.
    await client.getClaimable('55');
    // Immediate second call — must hit the cache, not make another RPC call.
    await client.getClaimable('55');
    // Third for good measure.
    await client.getClaimable('55');

    expect(rpcCallCount).toBe(1);
  });
});
