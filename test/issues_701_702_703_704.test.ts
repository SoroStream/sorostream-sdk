import { describe, it, expect, vi, afterEach } from 'vitest';
import { Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';
import { CircuitBreaker } from '../src/circuitBreaker.js';
import { buildUnsignedXdr } from '../src/serialization.js';
import { parseMemo } from '../src/utils.js';
import { SoroStreamMemoError } from '../src/errors.js';
import { createLogger, withModule, NoopLogger, NamespacedLogger } from '../src/logger.js';
import type { Logger } from '../src/logger.js';
import { Telemetry } from '../src/telemetry.js';
import type { Span } from '../src/telemetry.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('issue #701: half-open probe interval is independent of the open-state cooldown', () => {
  it('defaults the probe interval to the cooldown', () => {
    expect(new CircuitBreaker({ cooldownMs: 40 })['halfOpenProbeIntervalMs']).toBe(40);
    expect(new CircuitBreaker()['halfOpenProbeIntervalMs']).toBe(30_000);
  });

  it('accepts a probe interval configured separately from the cooldown', () => {
    const breaker = new CircuitBreaker({ cooldownMs: 40, halfOpenProbeIntervalMs: 5 });
    expect(breaker['cooldownMs']).toBe(40);
    expect(breaker['halfOpenProbeIntervalMs']).toBe(5);
  });

  it('gates probes on the probe interval, not the cooldown', async () => {
    const breaker = new CircuitBreaker({
      threshold: 1,
      cooldownMs: 5,
      halfOpenProbeIntervalMs: 250,
    });

    await expect(breaker.call(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(breaker.getState()).toBe('OPEN');

    // Cooldown has long elapsed, so this call becomes the first probe.
    await sleep(20);
    let releaseProbe!: () => void;
    const hangingProbe = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const inFlight = breaker.call(() => hangingProbe);
    await sleep(5);
    expect(breaker.getState()).toBe('HALF_OPEN');

    // The cooldown (5ms) is elapsed, but the 250ms probe interval is not.
    await expect(breaker.call(() => Promise.resolve('rejected'))).rejects.toThrow(/half-open/);
    expect(breaker.getState()).toBe('HALF_OPEN');

    // Once the probe interval elapses the next probe is allowed, despite the
    // cooldown having been irrelevant for the whole half-open period.
    await sleep(260);
    await expect(breaker.call(() => Promise.resolve('second probe'))).resolves.toBe('second probe');
    expect(breaker.getState()).toBe('CLOSED');

    releaseProbe();
    await expect(inFlight).resolves.toBeUndefined();
  });
});

describe('issue #702: telemetry flushes the pending batch on page unload', () => {
  type Listener = () => void;
  let docListeners: Record<string, Listener[]>;
  let winListeners: Record<string, Listener[]>;
  let sendBeacon: ReturnType<typeof vi.fn>;

  const dispatch = (bucket: Record<string, Listener[]>, type: string) => {
    for (const listener of bucket[type] ?? []) listener();
  };

  const stubDom = (visibilityState: string) => {
    docListeners = {};
    winListeners = {};
    const doc = {
      visibilityState,
      addEventListener: (type: string, fn: Listener) => {
        (docListeners[type] ??= []).push(fn);
      },
      removeEventListener: (type: string, fn: Listener) => {
        docListeners[type] = (docListeners[type] ?? []).filter((l) => l !== fn);
      },
    };
    const win = {
      addEventListener: (type: string, fn: Listener) => {
        (winListeners[type] ??= []).push(fn);
      },
      removeEventListener: (type: string, fn: Listener) => {
        winListeners[type] = (winListeners[type] ?? []).filter((l) => l !== fn);
      },
    };
    sendBeacon = vi.fn((..._args: unknown[]) => true);
    vi.stubGlobal('document', doc);
    vi.stubGlobal('window', win);
    vi.stubGlobal('navigator', { sendBeacon });
  };

  const pendingSpan = () =>
    ({
      setAttributes: vi.fn(),
      end: vi.fn(),
      recordException: vi.fn(),
      setAttribute: vi.fn(),
    }) as unknown as Span;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('redacts address-bearing error details before recording an exception', () => {
    const telemetry = new Telemetry(false);
    const span = pendingSpan();
    const address = 'GABC2DEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV';

    telemetry.recordError(span, new Error(`Invalid state for wallet ${address}`));

    const recordedError = vi.mocked(span.recordException).mock.calls[0]![0];
    expect(recordedError.message).toBe('Error details redacted');
    expect(recordedError.stack).not.toContain(address);
    expect(span.setAttribute).toHaveBeenCalledWith('error', true);
    telemetry.dispose();
  });

  it('flushes the pending batch when visibilitychange reports hidden', () => {
    stubDom('hidden');
    const telemetry = new Telemetry(true);
    const span = pendingSpan();
    telemetry.endSpan(span);
    expect(telemetry.pendingCount).toBe(1);

    dispatch(docListeners, 'visibilitychange');

    expect(telemetry.pendingCount).toBe(0);
    expect(span.end).toHaveBeenCalledTimes(1);
    telemetry.dispose();
  });

  it('ignores visibilitychange while the page is still visible', () => {
    stubDom('visible');
    const telemetry = new Telemetry(true);
    telemetry.endSpan(pendingSpan());

    dispatch(docListeners, 'visibilitychange');

    expect(telemetry.pendingCount).toBe(1);
    telemetry.dispose();
  });

  it('flushes the pending batch when beforeunload fires', () => {
    stubDom('hidden');
    const telemetry = new Telemetry(true);
    const span = pendingSpan();
    telemetry.endSpan(span);

    dispatch(winListeners, 'beforeunload');

    expect(telemetry.pendingCount).toBe(0);
    expect(span.end).toHaveBeenCalledTimes(1);
    telemetry.dispose();
  });

  it('ships the flushed batch with navigator.sendBeacon when configured', () => {
    stubDom('hidden');
    const beaconUrl = 'https://example.test/telemetry';
    const telemetry = new Telemetry(true, undefined, { beaconUrl });
    telemetry.endSpan(pendingSpan());

    dispatch(docListeners, 'visibilitychange');

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(sendBeacon.mock.calls[0]![0]).toBe(beaconUrl);
    const payload = JSON.parse(sendBeacon.mock.calls[0]![1] as string) as { spanCount: number };
    expect(payload.spanCount).toBe(1);
    telemetry.dispose();
  });

  it('removes the unload listeners on dispose', () => {
    stubDom('hidden');
    const telemetry = new Telemetry(true);
    telemetry.endSpan(pendingSpan());
    telemetry.dispose();

    dispatch(docListeners, 'visibilitychange');
    dispatch(winListeners, 'beforeunload');

    expect(telemetry.pendingCount).toBe(1);
    expect(docListeners['visibilitychange']).toHaveLength(0);
    expect(winListeners['beforeunload']).toHaveLength(0);
  });

  it('registers no listeners when telemetry is disabled', () => {
    stubDom('hidden');
    const telemetry = new Telemetry(false);

    expect(docListeners['visibilitychange'] ?? []).toHaveLength(0);
    expect(winListeners['beforeunload'] ?? []).toHaveLength(0);
    telemetry.dispose();
  });
});

describe('issue #703: per-module logger level overrides', () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  const captureConsole = () => {
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  };

  const messages = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.map((c) => String(c[0]));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lets a module log at a raised level while other modules stay silenced', () => {
    captureConsole();
    const logger = createLogger({
      minLevel: 'error',
      moduleLevels: { retry: 'debug', connectionPool: 'silent' },
    });

    withModule(logger, 'retry').debug('retrying request');
    withModule(logger, 'connectionPool').error('pool exhausted');
    logger.error('global error');

    expect(messages(debugSpy)).toContain('[sorostream] retrying request');
    expect(messages(errorSpy)).toEqual(['[sorostream] global error']);
  });

  it('applies module overrides in both directions and falls back to the global level', () => {
    captureConsole();
    const logger = createLogger({
      minLevel: 'debug',
      moduleLevels: { noisy: 'error' },
    });

    withModule(logger, 'noisy').info('noisy module info');
    withModule(logger, 'noisy').error('noisy module error');
    withModule(logger, 'unknown-module').debug('unconfigured module');
    logger.info('global info');

    expect(messages(infoSpy)).toEqual(['[sorostream] global info']);
    expect(messages(errorSpy)).toEqual(['[sorostream] noisy module error']);
    expect(messages(debugSpy)).toEqual(['[sorostream] unconfigured module']);
  });

  it('honours module overrides when the global level is silent', () => {
    captureConsole();
    const logger = createLogger({
      minLevel: 'silent',
      moduleLevels: { connectionPool: 'debug' },
    });

    logger.debug('global debug');
    withModule(logger, 'connectionPool').debug('pool debug');

    expect(messages(debugSpy)).toEqual(['[sorostream] pool debug']);
    expect(messages(infoSpy)).toEqual([]);
  });

  it('keeps existing behaviour when no module levels are configured', () => {
    captureConsole();
    const logger = createLogger({ minLevel: 'warn' });

    logger.debug('dropped');
    logger.warn('kept');
    const scoped: Logger = withModule(logger, 'anything');
    scoped.warn('kept via withModule');

    expect(messages(debugSpy)).toEqual([]);
    expect(messages(warnSpy)).toEqual(['[sorostream] kept', '[sorostream] kept via withModule']);
    expect(withModule(new NoopLogger(), 'anything')).toBeInstanceOf(NoopLogger);
  });

  it('exposes the effective level per namespace', () => {
    const logger = createLogger({ minLevel: 'warn', moduleLevels: { retry: 'debug' } });

    expect(logger).toBeInstanceOf(NamespacedLogger);
    expect((logger as NamespacedLogger).effectiveLevel).toBe('warn');
    expect((withModule(logger, 'retry') as NamespacedLogger).effectiveLevel).toBe('debug');
    expect((withModule(logger, 'other') as NamespacedLogger).effectiveLevel).toBe('warn');
  });

  it('supports custom delegates with module overrides', () => {
    const lines: string[] = [];
    const delegate: Logger = {
      debug: (m) => lines.push(`debug:${m}`),
      info: (m) => lines.push(`info:${m}`),
      warn: (m) => lines.push(`warn:${m}`),
      error: (m) => lines.push(`error:${m}`),
    };
    const logger = createLogger({
      minLevel: 'silent',
      delegate,
      sanitize: false,
      moduleLevels: { retry: 'debug' },
    });

    withModule(logger, 'retry').debug('kept');
    withModule(logger, 'retry').info('kept too');
    withModule(logger, 'other').info('silenced elsewhere');
    logger.error('silenced globally');

    expect(lines).toEqual(['debug:kept', 'info:kept too']);
  });
});

describe('issue #704: memo helpers validate the 28-byte limit before encoding', () => {
  const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
  const sourceAccount = Keypair.random().publicKey();
  const recipient = Keypair.random().publicKey();
  const token = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

  const xdrParams = (memo?: string) => ({
    contractId,
    sourceAccount,
    recipient,
    token,
    amount: 1000_0000000n,
    durationSeconds: 3600,
    network: 'testnet' as const,
    ...(memo !== undefined ? { memo } : {}),
  });

  it('accepts text at exactly 28 bytes and rejects 29 bytes', () => {
    expect(parseMemo('a'.repeat(28)).type).toBe('text');
    expect(() => parseMemo('a'.repeat(29))).toThrow(SoroStreamMemoError);
    expect(() => parseMemo('€'.repeat(10))).toThrow(SoroStreamMemoError);
  });

  it('keeps treating a 64-char hex string as a hash memo', () => {
    expect(parseMemo('a'.repeat(64)).type).toBe('hash');
  });

  it('builds unsigned XDR for a 28-byte memo', () => {
    const xdr = buildUnsignedXdr('createStream', xdrParams('a'.repeat(28)));
    expect(TransactionBuilder.fromXDR(xdr, Networks.TESTNET)).toBeDefined();
  });

  it('rejects an oversized memo before the transaction is built', () => {
    expect(() => buildUnsignedXdr('createStream', xdrParams('a'.repeat(29)))).toThrow(
      SoroStreamMemoError,
    );
    expect(() => buildUnsignedXdr('createStream', xdrParams('a'.repeat(29)))).toThrow(
      /exceeds 28 bytes/,
    );
  });
});
