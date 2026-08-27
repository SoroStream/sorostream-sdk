import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { from, combineLatest } from 'rxjs';
import { map, take, distinctUntilChanged, filter as rxFilter } from 'rxjs/operators';

import { SoroStreamClient } from '../src/SoroStreamClient.js';
import { MockSoroStreamClient } from '../src/mock.js';
import { SoroStreamObservable, shareLatest, observableSymbol } from '../src/observable.js';
import { StreamNotFoundError } from '../src/errors.js';
import type { Stream, WalletAdapter } from '../src/types.js';

const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const SENDER = 'GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF';
const RECIPIENT = 'GAXXZ5XSL2VTQPGWB3LPU5273HSJXMK7VHLZTF2XKW65QFZVA3XKULQZ';
const TOKEN = 'CAVTXNC2WCHINDNP4VBLSOQA2667VE3RPQZNGD5TFI4U2QSHTVAC667T';

const STREAM_TYPE_MAP = {
  id: ['symbol', 'string'],
  sender: ['symbol', 'string'],
  recipient: ['symbol', 'string'],
  token: ['symbol', 'string'],
  deposit: ['symbol', 'i128'],
  flow_rate: ['symbol', 'i128'],
  start_time: ['symbol', 'u64'],
  end_time: ['symbol', 'u64'],
  last_withdraw_time: ['symbol', 'u64'],
  status: ['symbol', 'string'],
  auto_renew: ['symbol', 'bool'],
} as const;

function streamScVal(id: string, overrides: Record<string, unknown> = {}): xdr.ScVal {
  return nativeToScVal(
    {
      id,
      sender: SENDER,
      recipient: RECIPIENT,
      token: TOKEN,
      deposit: 1_000_000n,
      flow_rate: 100n,
      start_time: 1_700_000_000,
      end_time: 1_700_010_000,
      last_withdraw_time: 1_700_000_000,
      status: 'Active',
      auto_renew: false,
      ...overrides,
    },
    { type: STREAM_TYPE_MAP as unknown as Record<string, [string, string]> },
  );
}

function makeClient(options: Record<string, unknown> = {}): SoroStreamClient {
  const adapter: WalletAdapter = {
    getPublicKey: vi.fn().mockResolvedValue(SENDER),
    signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
    isConnected: vi.fn().mockResolvedValue(true),
  };
  return new SoroStreamClient({
    network: 'testnet',
    contractId: CONTRACT_ID,
    walletAdapter: adapter,
    skipVersionCheck: true,
    skipPeerCheck: true,
    ryowTimeoutMs: 0,
    ...options,
  });
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── Core observable semantics ────────────────────────────────────────────────

describe('SoroStreamObservable (#423)', () => {
  it('delivers values, supports positional callbacks, and completes', async () => {
    const values: number[] = [];
    let completed = false;

    const obs = new SoroStreamObservable<number>((sink) => {
      sink.next(1);
      sink.next(2);
      sink.complete();
    });

    obs.subscribe(
      (v) => values.push(v),
      undefined,
      () => {
        completed = true;
      },
    );

    expect(values).toEqual([1, 2]);
    expect(completed).toBe(true);
  });

  it('is cold: each subscription runs the producer again', () => {
    let subscribes = 0;
    const obs = new SoroStreamObservable<number>((sink) => {
      subscribes++;
      sink.next(subscribes);
    });

    const a: number[] = [];
    const b: number[] = [];
    obs.subscribe((v) => a.push(v));
    obs.subscribe((v) => b.push(v));

    expect(subscribes).toBe(2);
    expect(a).toEqual([1]);
    expect(b).toEqual([2]);
  });

  it('runs the teardown exactly once on unsubscribe and ignores later emissions', () => {
    let teardowns = 0;
    let emit: ((value: number) => void) | null = null;

    const obs = new SoroStreamObservable<number>((sink) => {
      emit = (value) => sink.next(value);
      return () => {
        teardowns++;
      };
    });

    const seen: number[] = [];
    const sub = obs.subscribe((v) => seen.push(v));
    emit!(1);
    sub.unsubscribe();
    sub.unsubscribe();
    emit!(2);

    expect(seen).toEqual([1]);
    expect(teardowns).toBe(1);
    expect(sub.closed).toBe(true);
  });

  it('routes producer errors to the error handler and stops the subscription', () => {
    const errors: unknown[] = [];
    const obs = new SoroStreamObservable<number>(() => {
      throw new Error('producer failed');
    });

    const sub = obs.subscribe({ error: (e) => errors.push(e) });
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('producer failed');
    expect(sub.closed).toBe(true);
  });

  it('supports map, filter, and pipe composition without RxJS', () => {
    const obs = new SoroStreamObservable<number>((sink) => {
      [1, 2, 3, 4].forEach((v) => sink.next(v));
      sink.complete();
    });

    const seen: string[] = [];
    obs
      .filter((v) => v % 2 === 0)
      .map((v) => `#${v}`)
      .subscribe((v) => seen.push(v));

    expect(seen).toEqual(['#2', '#4']);

    const doubled = obs.pipe((source) => source.map((v) => v * 2));
    const piped: number[] = [];
    doubled.subscribe((v) => piped.push(v));
    expect(piped).toEqual([2, 4, 6, 8]);
  });

  it('exposes the observable interop symbol used by RxJS', () => {
    const obs = new SoroStreamObservable<number>((sink) => sink.complete());
    const interop = (obs as unknown as Record<string | symbol, () => unknown>)[observableSymbol];
    expect(typeof interop).toBe('function');
    expect(interop.call(obs)).toBe(obs);
  });

  it('firstValue() resolves with the first emission', async () => {
    const obs = new SoroStreamObservable<number>((sink) => {
      setTimeout(() => sink.next(7), 1);
    });
    await expect(obs.firstValue()).resolves.toBe(7);
  });
});

describe('shareLatest (#423)', () => {
  it('shares one producer across subscribers and replays the latest value', () => {
    let producerRuns = 0;
    let teardowns = 0;
    let emit: ((value: number) => void) | null = null;

    const obs = shareLatest<number>((sink) => {
      producerRuns++;
      emit = (value) => sink.next(value);
      return () => {
        teardowns++;
      };
    });

    const a: number[] = [];
    const b: number[] = [];

    const subA = obs.subscribe((v) => a.push(v));
    emit!(1);

    // Late subscriber immediately receives the most recent value.
    const subB = obs.subscribe((v) => b.push(v));
    emit!(2);

    expect(producerRuns).toBe(1);
    expect(a).toEqual([1, 2]);
    expect(b).toEqual([1, 2]);

    subA.unsubscribe();
    expect(teardowns).toBe(0); // still one subscriber left
    subB.unsubscribe();
    expect(teardowns).toBe(1); // reference count hit zero
  });

  it('propagates an error to all subscribers and tears the producer down', () => {
    let teardowns = 0;
    let fail: ((error: unknown) => void) | null = null;
    const obs = shareLatest<number>((sink) => {
      fail = (error) => sink.error(error);
      return () => {
        teardowns++;
      };
    });

    const errors: unknown[] = [];
    obs.subscribe({ error: (e) => errors.push(e) });
    obs.subscribe({ error: (e) => errors.push(e) });
    fail!(new Error('nope'));

    expect(errors).toHaveLength(2);
    expect(teardowns).toBe(1);
  });
});

// ── client.observeStream ─────────────────────────────────────────────────────

describe('SoroStreamClient.observeStream (#423)', () => {
  let client: SoroStreamClient;

  beforeEach(() => {
    client = makeClient();
  });

  afterEach(() => {
    client.destroy();
    vi.restoreAllMocks();
  });

  it('emits the current stream on subscribe', async () => {
    vi.spyOn(client as never as { simulateOp: unknown }, 'simulateOp').mockImplementation(
      async () => ({ result: { retval: streamScVal('1') }, latestLedger: 1 }) as never,
    );

    const stream = await client.observeStream('1').firstValue();
    expect(stream.id).toBe('1');
    expect(stream.status).toBe('Active');
  });

  it('re-emits when the on-chain state changes and skips unchanged polls', async () => {
    let status = 'Active';
    vi.spyOn(client as never as { simulateOp: unknown }, 'simulateOp').mockImplementation(
      async () => ({ result: { retval: streamScVal('2', { status }) }, latestLedger: 1 }) as never,
    );

    const seen: Stream[] = [];
    const sub = client.observeStream('2', { intervalMs: 250 }).subscribe((s) => seen.push(s));

    await tick(20);
    expect(seen).toHaveLength(1);

    // Unchanged state — the next poll must not produce a duplicate emission.
    await tick(300);
    expect(seen).toHaveLength(1);

    status = 'Paused';
    await tick(300);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.status).toBe('Paused');

    sub.unsubscribe();
  });

  it('emits every poll when emitOnlyChanges is false', async () => {
    vi.spyOn(client as never as { simulateOp: unknown }, 'simulateOp').mockImplementation(
      async () => ({ result: { retval: streamScVal('3') }, latestLedger: 1 }) as never,
    );

    const seen: Stream[] = [];
    const sub = client
      .observeStream('3', { intervalMs: 250, emitOnlyChanges: false })
      .subscribe((s) => seen.push(s));

    await tick(600);
    sub.unsubscribe();
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });

  it('shares one poll loop between subscribers and stops it when the last unsubscribes', async () => {
    let rpcCalls = 0;
    vi.spyOn(client as never as { simulateOp: unknown }, 'simulateOp').mockImplementation(
      async () => {
        rpcCalls++;
        return { result: { retval: streamScVal('4') }, latestLedger: 1 } as never;
      },
    );

    const observable = client.observeStream('4', { intervalMs: 250 });
    const a: Stream[] = [];
    const b: Stream[] = [];
    const subA = observable.subscribe((s) => a.push(s));
    await tick(20);
    const subB = observable.subscribe((s) => b.push(s));

    // Both subscribers see the value; the second one did not trigger a fetch.
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(rpcCalls).toBe(1);

    await tick(300);
    const afterPoll = rpcCalls;
    expect(afterPoll).toBeGreaterThan(1);

    subA.unsubscribe();
    subB.unsubscribe();
    await tick(300);
    // No further polling after the last unsubscribe.
    expect(rpcCalls).toBe(afterPoll);
  });

  it('completes when the stream reaches a terminal state', async () => {
    vi.spyOn(client as never as { simulateOp: unknown }, 'simulateOp').mockImplementation(
      async () =>
        ({
          result: { retval: streamScVal('5', { status: 'Completed' }) },
          latestLedger: 1,
        }) as never,
    );

    let completed = false;
    const seen: Stream[] = [];
    client.observeStream('5', { intervalMs: 250 }).subscribe({
      next: (s) => seen.push(s),
      complete: () => {
        completed = true;
      },
    });

    await tick(20);
    expect(seen).toHaveLength(1);
    expect(completed).toBe(true);
  });

  it('surfaces read errors through the error channel', async () => {
    vi.spyOn(client as never as { simulateOp: unknown }, 'simulateOp').mockImplementation(
      async () => ({ error: 'stream missing' }) as never,
    );

    const errors: unknown[] = [];
    client.observeStream('404').subscribe({ error: (e) => errors.push(e) });
    await tick(20);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(StreamNotFoundError);
  });

  it('destroy() stops an active observable poll loop', async () => {
    let rpcCalls = 0;
    vi.spyOn(client as never as { simulateOp: unknown }, 'simulateOp').mockImplementation(
      async () => {
        rpcCalls++;
        return { result: { retval: streamScVal('6') }, latestLedger: 1 } as never;
      },
    );

    client.observeStream('6', { intervalMs: 200 }).subscribe(() => {});
    await tick(20);
    client.destroy();
    const afterDestroy = rpcCalls;
    await tick(300);
    expect(rpcCalls).toBe(afterDestroy);
  });

  it('observeClaimable emits the claimable balance and shares the loop', async () => {
    let value = 100;
    vi.spyOn(client as never as { simulateOp: unknown }, 'simulateOp').mockImplementation(
      async () =>
        ({ result: { retval: nativeToScVal(value, { type: 'i128' }) }, latestLedger: 1 }) as never,
    );

    const seen: bigint[] = [];
    const sub = client.observeClaimable('7', { intervalMs: 250 }).subscribe((v) => seen.push(v));

    await tick(20);
    expect(seen).toEqual([100n]);

    value = 250;
    await tick(300);
    expect(seen).toEqual([100n, 250n]);
    sub.unsubscribe();
  });
});

// ── RxJS interoperability ────────────────────────────────────────────────────

describe('RxJS interoperability (#423)', () => {
  let client: SoroStreamClient;

  beforeEach(() => {
    client = makeClient();
  });

  afterEach(() => {
    client.destroy();
    vi.restoreAllMocks();
  });

  it('rxjs from() consumes observeStream() and operators compose', async () => {
    let status = 'Active';
    vi.spyOn(client as never as { simulateOp: unknown }, 'simulateOp').mockImplementation(
      async () => ({ result: { retval: streamScVal('8', { status }) }, latestLedger: 1 }) as never,
    );

    const statuses: string[] = [];
    const sub = from(client.observeStream('8', { intervalMs: 200 }))
      .pipe(
        map((s) => s.status),
        distinctUntilChanged(),
      )
      .subscribe((s) => statuses.push(s));

    await tick(20);
    status = 'Paused';
    await tick(250);

    expect(statuses).toEqual(['Active', 'Paused']);
    sub.unsubscribe();
  });

  it('composes stream and claimable observables with combineLatest', async () => {
    vi.spyOn(client as never as { simulateOp: unknown }, 'simulateOp').mockImplementation(
      async (operation: unknown) => {
        const invoke = (
          operation as {
            body(): {
              invokeHostFunctionOp(): {
                hostFunction(): { invokeContract(): { functionName(): string } };
              };
            };
          }
        )
          .body()
          .invokeHostFunctionOp()
          .hostFunction()
          .invokeContract();
        if (invoke.functionName().toString() === 'get_claimable') {
          return {
            result: { retval: nativeToScVal(42, { type: 'i128' }) },
            latestLedger: 1,
          } as never;
        }
        return { result: { retval: streamScVal('9') }, latestLedger: 1 } as never;
      },
    );

    const combined = await new Promise<{ id: string; claimable: bigint }>((resolve) => {
      combineLatest([from(client.observeStream('9')), from(client.observeClaimable('9'))])
        .pipe(
          map(([stream, claimable]) => ({ id: stream.id, claimable })),
          rxFilter((v) => v.claimable > 0n),
          take(1),
        )
        .subscribe(resolve);
    });

    expect(combined).toEqual({ id: '9', claimable: 42n });
  });

  it('rxjs take(1) unsubscribing stops the underlying poll loop', async () => {
    let rpcCalls = 0;
    vi.spyOn(client as never as { simulateOp: unknown }, 'simulateOp').mockImplementation(
      async () => {
        rpcCalls++;
        return { result: { retval: streamScVal('10') }, latestLedger: 1 } as never;
      },
    );

    await new Promise<void>((resolve) => {
      from(client.observeStream('10', { intervalMs: 100 }))
        .pipe(take(1))
        .subscribe({ complete: () => resolve() });
    });

    const afterTake = rpcCalls;
    await tick(250);
    expect(rpcCalls).toBe(afterTake);
  });

  it('works with the in-memory mock client', async () => {
    const mock = new MockSoroStreamClient();
    const { streamId } = await mock.createStream({
      recipient: RECIPIENT,
      token: TOKEN,
      amount: 1_000_000n,
      durationSeconds: 3600,
      autoRenew: false,
    });

    const statuses: string[] = [];
    const sub = from(mock.observeStream(streamId))
      .pipe(map((s) => s.status))
      .subscribe((s) => statuses.push(s));

    await mock.pause({ streamId });
    expect(statuses).toEqual(['Active', 'Paused']);
    sub.unsubscribe();
  });
});
