import { describe, it, expect, vi } from 'vitest';
import { isValidStellarAddress, isStellarAddress, assertStellarAddress } from '../src/utils.js';
import {
  StreamSimulator,
  type SimulatedWithdrawResult,
} from '../src/simulator.js';
import {
  templates,
  resolveConditionalParam,
  conditionalByTokenType,
  type TemplateTokenType,
} from '../src/templates.js';
import {
  SoroStreamObservable,
  withBackpressure,
  type BackpressureDropEvent,
} from '../src/observable.js';
import type { Stream } from '../src/types.js';

// ---------------------------------------------------------------------------
// Issue #787: Fuzz testing isValidStellarAddress against invalid version bytes
// ---------------------------------------------------------------------------

describe('Issue #787: isValidStellarAddress version-byte discriminant fuzzing', () => {
  const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  // All valid base32 characters except 'G' (public key) and 'C' (contract)
  const INVALID_DISCRIMINANTS = BASE32_ALPHABET.split('').filter(
    (char) => char !== 'G' && char !== 'C',
  );

  function generateRandomBase32(length: number): string {
    let result = '';
    for (let i = 0; i < length; i++) {
      const idx = Math.floor(Math.random() * BASE32_ALPHABET.length);
      result += BASE32_ALPHABET[idx];
    }
    return result;
  }

  it('rejects all 56-character base32 strings with non-[GC] version-byte discriminants (fuzz test)', () => {
    // Generate at least 5 fuzz samples for each invalid discriminant character
    for (const discriminant of INVALID_DISCRIMINANTS) {
      for (let run = 0; run < 5; run++) {
        // Construct a valid base32 string of length 56 starting with the invalid discriminant
        const candidate = discriminant + generateRandomBase32(55);

        expect(candidate.length).toBe(56);
        expect(/^[A-Z2-7]{56}$/.test(candidate)).toBe(true); // verifies candidate is valid base32
        expect(isValidStellarAddress(candidate)).toBe(false);
        expect(isStellarAddress(candidate)).toBe(false);
        expect(() => assertStellarAddress(candidate)).toThrow();
      }
    }
  });

  it('specifically rejects known StrKey version byte prefixes (S for seed, M for muxed, P, X, T)', () => {
    const knownOtherStrKeys = [
      'S' + generateRandomBase32(55), // Secret seed
      'M' + generateRandomBase32(55), // Muxed account (MED25519)
      'P' + generateRandomBase32(55), // Signed payload
      'X' + generateRandomBase32(55), // Pre-auth tx
      'T' + generateRandomBase32(55), // Hash tx
    ];

    for (const key of knownOtherStrKeys) {
      expect(key.length).toBe(56);
      expect(isValidStellarAddress(key)).toBe(false);
      expect(isStellarAddress(key)).toBe(false);
    }
  });

  it('continues to accept genuinely valid account (G...) and contract (C...) addresses for contrast', () => {
    const validAccount = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
    const validContract = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

    expect(isValidStellarAddress(validAccount)).toBe(true);
    expect(isStellarAddress(validAccount)).toBe(true);
    expect(assertStellarAddress(validAccount)).toBe(validAccount);

    expect(isValidStellarAddress(validContract)).toBe(true);
    expect(isStellarAddress(validContract)).toBe(true);
    expect(assertStellarAddress(validContract)).toBe(validContract);

    // Random valid 'G' and 'C' 56-character base32 strings
    for (let i = 0; i < 20; i++) {
      const gCandidate = 'G' + generateRandomBase32(55);
      const cCandidate = 'C' + generateRandomBase32(55);

      expect(isValidStellarAddress(gCandidate)).toBe(true);
      expect(isValidStellarAddress(cCandidate)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Issue #790: Simulator TTL expiry modeling at exact boundary ledger
// ---------------------------------------------------------------------------

describe('Issue #790: Simulator TTL-expiry modeling at the boundary ledger', () => {
  const now = () => Math.floor(Date.now() / 1000);

  function createMockStream(id = 'stream-ttl-test'): Stream {
    const t = now();
    return {
      id,
      sender: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
      recipient: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
      token: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
      deposit: 50_000_000n,
      flowRate: 100n,
      startTime: t - 500,
      endTime: t + 3600,
      lastWithdrawTime: t - 500,
      status: 'Active',
      autoRenew: false,
    } as Stream;
  }

  it('correctly models withdraw at exact boundary ledger, boundary - 1, and boundary + 1', () => {
    const sim = new StreamSimulator();
    const stream = createMockStream();
    const BOUNDARY_LEDGER = 1_500_000;

    sim.setStorageTtlLedger(stream.id, BOUNDARY_LEDGER);

    // 1. One ledger before the boundary (BOUNDARY_LEDGER - 1):
    // Entry is live in contract storage, simulation must SUCCEED
    sim.setLedger(BOUNDARY_LEDGER - 1);
    expect(sim.isStorageExpired(stream.id)).toBe(false);

    const beforeBoundary: SimulatedWithdrawResult = sim.simulateWithdraw(stream);
    expect(beforeBoundary.success).toBe(true);
    expect(beforeBoundary.amount).toBeGreaterThan(0n);
    expect(beforeBoundary.reason).toBeUndefined();
    expect(beforeBoundary.ledger).toBe(BOUNDARY_LEDGER - 1);

    // 2. Exact boundary ledger (BOUNDARY_LEDGER):
    // Entry has expired in contract storage, simulation must FAIL with 'storageExpired'
    sim.setLedger(BOUNDARY_LEDGER);
    expect(sim.isStorageExpired(stream.id)).toBe(true);

    const atBoundary: SimulatedWithdrawResult = sim.simulateWithdraw(stream);
    expect(atBoundary.success).toBe(false);
    expect(atBoundary.reason).toBe('storageExpired');
    expect(atBoundary.amount).toBe(0n);
    expect(atBoundary.error).toContain(`ledger ${BOUNDARY_LEDGER}`);
    expect(atBoundary.error).toContain('restored');
    expect(atBoundary.ledger).toBe(BOUNDARY_LEDGER);

    // 3. One ledger after the boundary (BOUNDARY_LEDGER + 1):
    // Entry remains expired/archived, simulation continues to FAIL with 'storageExpired'
    sim.setLedger(BOUNDARY_LEDGER + 1);
    expect(sim.isStorageExpired(stream.id)).toBe(true);

    const afterBoundary: SimulatedWithdrawResult = sim.simulateWithdraw(stream);
    expect(afterBoundary.success).toBe(false);
    expect(afterBoundary.reason).toBe('storageExpired');
    expect(afterBoundary.amount).toBe(0n);
    expect(afterBoundary.ledger).toBe(BOUNDARY_LEDGER + 1);
  });

  it('supports explicit ledger option in simulateWithdraw for atomic point-in-time checks', () => {
    const sim = new StreamSimulator();
    const stream = createMockStream();
    const BOUNDARY_LEDGER = 2_000_000;

    sim.setStorageTtlLedger(stream.id, BOUNDARY_LEDGER);

    // Check boundary - 1 directly via opts
    const resBefore = sim.simulateWithdraw(stream, undefined, { ledger: BOUNDARY_LEDGER - 1 });
    expect(resBefore.success).toBe(true);

    // Check exact boundary directly via opts
    const resAt = sim.simulateWithdraw(stream, undefined, { ledger: BOUNDARY_LEDGER });
    expect(resAt.success).toBe(false);
    expect(resAt.reason).toBe('storageExpired');

    // Check boundary + 1 directly via opts
    const resAfter = sim.simulateWithdraw(stream, undefined, { ledger: BOUNDARY_LEDGER + 1 });
    expect(resAfter.success).toBe(false);
    expect(resAfter.reason).toBe('storageExpired');
  });

  it('re-enables withdraw when storage TTL is bumped/restored past the boundary', () => {
    const sim = new StreamSimulator();
    const stream = createMockStream();
    const BOUNDARY_LEDGER = 1_000_000;

    sim.setStorageTtlLedger(stream.id, BOUNDARY_LEDGER);
    sim.setLedger(BOUNDARY_LEDGER);
    expect(sim.simulateWithdraw(stream).success).toBe(false);

    // Bump TTL by restoring / extending storage rent to a new boundary
    const NEW_BOUNDARY = BOUNDARY_LEDGER + 50_000;
    sim.setStorageTtlLedger(stream.id, NEW_BOUNDARY);

    expect(sim.isStorageExpired(stream.id)).toBe(false);
    expect(sim.simulateWithdraw(stream).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Issue #791: Conditional template parameter fallback handling
// ---------------------------------------------------------------------------

describe('Issue #791: Template conditional parameters with unhandled token types', () => {
  const baseParams = {
    recipient: 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
    token: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
    autoRenew: false,
    durationSeconds: 86_400,
  } as const;

  it('falls back to default parameter when template is instantiated with an unrecognized token type', () => {
    const branches = conditionalByTokenType<bigint>(
      {
        stablecoin: 1_000_000n,
        native: 10_000_000n,
      },
      5_000_000n, // Fallback default
    );

    const streamParams = templates.minAmountStream({
      ...baseParams,
      tokenType: 'unknown_exotic_token' as TemplateTokenType,
      amount: branches,
    });

    expect(streamParams.amount).toBe(5_000_000n);
  });

  it('falls back to defaultAmount option in minAmountStream for unhandled token types', () => {
    const streamParams = templates.minAmountStream({
      ...baseParams,
      tokenType: 'unregistered_token' as TemplateTokenType,
      amount: (ctx) => {
        if (ctx.tokenType === 'stablecoin') return 1_000_000n;
        return undefined as unknown as bigint;
      },
      defaultAmount: 2_500_000n,
    });

    expect(streamParams.amount).toBe(2_500_000n);
  });

  it('throws a clear descriptive error naming the unhandled token type when no default fallback exists', () => {
    const branchMapWithoutDefault = {
      stablecoin: 1_000_000n,
      native: 10_000_000n,
    };

    expect(() =>
      templates.minAmountStream({
        ...baseParams,
        tokenType: 'exotic_commodity' as TemplateTokenType,
        amount: branchMapWithoutDefault,
      }),
    ).toThrow(/Unhandled token type "exotic_commodity" in conditional template parameter/);
  });

  it('correctly applies recognized token type conditional branches for contrast', () => {
    const branches = conditionalByTokenType<bigint>(
      {
        stablecoin: 1_000_000n,
        native: 10_000_000n,
        volatile: 20_000_000n,
      },
      5_000_000n, // Fallback default
    );

    const stable = templates.minAmountStream({
      ...baseParams,
      tokenType: 'stablecoin',
      amount: branches,
    });
    const native = templates.minAmountStream({
      ...baseParams,
      tokenType: 'native',
      amount: branches,
    });
    const volatile = templates.minAmountStream({
      ...baseParams,
      tokenType: 'volatile',
      amount: branches,
    });

    expect(stable.amount).toBe(1_000_000n);
    expect(native.amount).toBe(10_000_000n);
    expect(volatile.amount).toBe(20_000_000n);
  });
});

// ---------------------------------------------------------------------------
// Issue #792: Observable backpressure drop notifications
// ---------------------------------------------------------------------------

describe('Issue #792: Observable backpressure drop notifications', () => {
  it('fires distinct drop-notification signal with count and dropped items under drop-oldest strategy', async () => {
    const droppedEvents: BackpressureDropEvent<number>[] = [];
    const received: number[] = [];

    const source = new SoroStreamObservable<number>((sink) => {
      // Overwhelm the buffer: emit 5 items synchronously into a buffer of capacity 2
      sink.next(1);
      sink.next(2);
      sink.next(3); // causes drop-oldest of 1
      sink.next(4); // causes drop-oldest of 2
      sink.next(5); // causes drop-oldest of 3
      sink.complete();
    });

    const backpressured = source.withBackpressure({
      maxBufferSize: 2,
      strategy: 'drop-oldest',
      onDrop: (event) => droppedEvents.push(event),
    });

    await new Promise<void>((resolve) => {
      backpressured.subscribe({
        next: (val) => received.push(val),
        complete: () => resolve(),
      });
    });

    // We expect 3 dropped events: [1], [2], [3]
    expect(droppedEvents.length).toBe(3);
    expect(droppedEvents[0]).toEqual({
      strategy: 'drop-oldest',
      droppedCount: 1,
      droppedItems: [1],
    });
    expect(droppedEvents[1]).toEqual({
      strategy: 'drop-oldest',
      droppedCount: 1,
      droppedItems: [2],
    });
    expect(droppedEvents[2]).toEqual({
      strategy: 'drop-oldest',
      droppedCount: 1,
      droppedItems: [3],
    });

    // Only the newest 2 items survive the drop-oldest buffer
    expect(received).toEqual([4, 5]);
  });

  it('fires distinct drop-notification signal with count and dropped items under drop-newest strategy', async () => {
    const droppedEvents: BackpressureDropEvent<string>[] = [];
    const received: string[] = [];

    const source = new SoroStreamObservable<string>((sink) => {
      // Overwhelm buffer of capacity 2 with 5 events
      sink.next('A');
      sink.next('B');
      sink.next('C'); // dropped under drop-newest
      sink.next('D'); // dropped under drop-newest
      sink.next('E'); // dropped under drop-newest
      sink.complete();
    });

    const backpressured = source.pipe(
      withBackpressure({
        maxBufferSize: 2,
        strategy: 'drop-newest',
        onDrop: (event) => droppedEvents.push(event),
      }),
    );

    await new Promise<void>((resolve) => {
      backpressured.subscribe({
        next: (val) => received.push(val),
        complete: () => resolve(),
      });
    });

    // 3 items dropped: 'C', 'D', 'E'
    expect(droppedEvents.length).toBe(3);
    expect(droppedEvents.map((e) => e.droppedItems[0])).toEqual(['C', 'D', 'E']);
    for (const dropEvent of droppedEvents) {
      expect(dropEvent.strategy).toBe('drop-newest');
      expect(dropEvent.droppedCount).toBe(1);
    }

    // Only the first 2 items were retained in the buffer
    expect(received).toEqual(['A', 'B']);
  });

  it('produces 0 drop notifications in the non-overwhelmed case for contrast', async () => {
    const onDrop = vi.fn();
    const received: number[] = [];

    const source = new SoroStreamObservable<number>((sink) => {
      // Buffer capacity is 10, emit only 3 items
      sink.next(100);
      sink.next(200);
      sink.next(300);
      sink.complete();
    });

    const backpressured = source.withBackpressure({
      maxBufferSize: 10,
      strategy: 'drop-oldest',
      onDrop,
    });

    await new Promise<void>((resolve) => {
      backpressured.subscribe({
        next: (val) => received.push(val),
        complete: () => resolve(),
      });
    });

    // In the non-overwhelmed case:
    expect(onDrop).not.toHaveBeenCalled();
    expect(received).toEqual([100, 200, 300]);
  });

  it('bounds queued emissions while an async consumer is still processing', async () => {
    let emit: ((value: number) => void) | null = null;
    let releaseFirst!: () => void;
    const firstConsumer = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const received: number[] = [];
    const source = new SoroStreamObservable<number>((sink) => {
      emit = (value) => sink.next(value);
    });
    const subscription = source
      .withBackpressure({ maxBufferSize: 1, strategy: 'drop-oldest' })
      .subscribe(async (value) => {
        received.push(value);
        if (value === 1) await firstConsumer;
      });

    emit!(1);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    emit!(2);
    emit!(3);
    releaseFirst();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(received).toEqual([1, 3]);
    subscription.unsubscribe();
  });
});
