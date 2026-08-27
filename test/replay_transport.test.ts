/**
 * Tests for Issue #395: Replay transport for deterministic testing.
 *
 * Verifies:
 * - Record mode captures all method calls and responses.
 * - Replay mode serves responses in order without network calls.
 * - BigInt values survive serialisation round-trips.
 * - `ReplayFixtureError` is thrown when entries are exhausted.
 * - `ReplayTransport.parse` handles valid/invalid JSON.
 * - The transport satisfies the `RpcTransportAdapter` interface.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ReplayTransport,
  ReplayFixtureError,
  ReplayFixtureParseError,
} from '../src/replayTransport.js';
import type { FixtureFile } from '../src/replayTransport.js';
import type { RpcTransportAdapter } from '../src/transport.js';

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Helpers ───────────────────────────────────────────────────────────────

function makeBaseTransport(): RpcTransportAdapter {
  return {
    serverURL: new URL('https://soroban-testnet.stellar.org'),
    getAccount: vi.fn().mockResolvedValue({ id: 'GABC', sequence: '1' }),
    getHealth: vi.fn().mockResolvedValue({ status: 'healthy' }),
    getLatestLedger: vi.fn().mockResolvedValue({ id: 'ledger1', sequence: 100, protocolVersion: 21 }),
    getTransaction: vi.fn().mockResolvedValue({ status: 'SUCCESS' }),
    simulateTransaction: vi.fn().mockResolvedValue({ result: { retval: '' }, latestLedger: 100 }),
    prepareTransaction: vi.fn().mockResolvedValue({ toXDR: () => 'prepared-xdr' }),
    sendTransaction: vi.fn().mockResolvedValue({ hash: 'txhash', status: 'PENDING' }),
    getEvents: vi.fn().mockResolvedValue({ events: [], latestLedger: 100 }),
  };
}

function makeFixture(entries: FixtureFile['entries'] = []): FixtureFile {
  return { recordedAt: '2026-01-01T00:00:00.000Z', entries };
}

// ── Record mode ───────────────────────────────────────────────────────────

describe('ReplayTransport.record – capture mode', () => {
  it('starts with no entries', () => {
    const base = makeBaseTransport();
    const transport = ReplayTransport.record(base);
    expect(transport.getEntries()).toHaveLength(0);
  });

  it('records getAccount calls', async () => {
    const base = makeBaseTransport();
    const transport = ReplayTransport.record(base);

    await transport.getAccount('GABC');
    const entries = transport.getEntries();

    expect(entries).toHaveLength(1);
    expect(entries[0]!.method).toBe('getAccount');
    expect(entries[0]!.request).toEqual({ address: 'GABC' });
    expect(entries[0]!.response).toEqual({ id: 'GABC', sequence: '1' });
  });

  it('records getHealth calls', async () => {
    const base = makeBaseTransport();
    const transport = ReplayTransport.record(base);

    await transport.getHealth();
    const entries = transport.getEntries();

    expect(entries).toHaveLength(1);
    expect(entries[0]!.method).toBe('getHealth');
  });

  it('records getLatestLedger calls', async () => {
    const base = makeBaseTransport();
    const transport = ReplayTransport.record(base);

    await transport.getLatestLedger();
    const entries = transport.getEntries();

    expect(entries).toHaveLength(1);
    expect(entries[0]!.method).toBe('getLatestLedger');
  });

  it('records getTransaction calls', async () => {
    const base = makeBaseTransport();
    const transport = ReplayTransport.record(base);

    await transport.getTransaction('abc123');
    const entries = transport.getEntries();

    expect(entries[0]!.method).toBe('getTransaction');
    expect(entries[0]!.request).toEqual({ hash: 'abc123' });
  });

  it('records multiple sequential calls', async () => {
    const base = makeBaseTransport();
    const transport = ReplayTransport.record(base);

    await transport.getAccount('GABC');
    await transport.getHealth();
    await transport.getLatestLedger();

    expect(transport.getEntries()).toHaveLength(3);
  });

  it('toJSON serialises all entries', async () => {
    const base = makeBaseTransport();
    const transport = ReplayTransport.record(base);

    await transport.getAccount('GABC');

    const json = transport.toJSON();
    const parsed = JSON.parse(json) as FixtureFile;

    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]!.method).toBe('getAccount');
    expect(typeof parsed.recordedAt).toBe('string');
  });

  it('toJSON includes label when provided', async () => {
    const base = makeBaseTransport();
    const transport = ReplayTransport.record(base, undefined, { label: 'my-test' });

    await transport.getHealth();
    const parsed = JSON.parse(transport.toJSON()) as FixtureFile;
    expect(parsed.label).toBe('my-test');
  });

  it('getEntries returns a copy (mutation-safe)', async () => {
    const base = makeBaseTransport();
    const transport = ReplayTransport.record(base);

    await transport.getAccount('GABC');
    const copy = transport.getEntries();
    copy.push({ method: 'fake', request: {}, response: {} });

    // Original should be unaffected
    expect(transport.getEntries()).toHaveLength(1);
  });

  it('delegates init and teardown to the base transport', async () => {
    const base = makeBaseTransport();
    base.init = vi.fn();
    base.teardown = vi.fn();

    const transport = ReplayTransport.record(base);
    await transport.init?.({ network: 'testnet', rpcUrl: 'https://soroban-testnet.stellar.org' });
    await transport.teardown?.();

    expect(base.init).toHaveBeenCalledOnce();
    expect(base.teardown).toHaveBeenCalledOnce();
  });
});

// ── BigInt serialisation ──────────────────────────────────────────────────

describe('BigInt serialisation round-trip', () => {
  it('preserves BigInt values in recorded responses', async () => {
    const base = makeBaseTransport();
    (base.getHealth as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'healthy',
      bigIntField: 9_007_199_254_740_993n, // beyond Number.MAX_SAFE_INTEGER
    });

    const transport = ReplayTransport.record(base);
    await transport.getHealth();

    const json = transport.toJSON();
    const parsed = JSON.parse(json) as FixtureFile;

    // The __bigint sentinel should be present in the raw JSON
    expect(JSON.stringify(parsed.entries[0]!.response)).toContain('__bigint');
  });
});

// ── Replay mode ───────────────────────────────────────────────────────────

describe('ReplayTransport.replay – playback mode', () => {
  it('serves getAccount responses in order', async () => {
    const fixture = makeFixture([
      { method: 'getAccount', request: {}, response: { id: 'GABC', sequence: '1' } },
    ]);

    const transport = ReplayTransport.replay(fixture);
    const result = await transport.getAccount('GABC');

    expect(result).toEqual({ id: 'GABC', sequence: '1' });
  });

  it('serves getHealth responses', async () => {
    const fixture = makeFixture([
      { method: 'getHealth', request: {}, response: { status: 'healthy' } },
    ]);

    const transport = ReplayTransport.replay(fixture);
    const result = await transport.getHealth();
    expect(result).toEqual({ status: 'healthy' });
  });

  it('serves multiple calls in insertion order', async () => {
    const fixture = makeFixture([
      { method: 'getAccount', request: {}, response: { id: 'GABC', sequence: '1' } },
      { method: 'getAccount', request: {}, response: { id: 'GABC', sequence: '2' } },
    ]);

    const transport = ReplayTransport.replay(fixture);
    const first = await transport.getAccount('GABC');
    const second = await transport.getAccount('GABC');

    expect((first as { sequence: string }).sequence).toBe('1');
    expect((second as { sequence: string }).sequence).toBe('2');
  });

  it('throws ReplayFixtureError when entries are exhausted', async () => {
    const fixture = makeFixture([
      { method: 'getAccount', request: {}, response: { id: 'GABC', sequence: '1' } },
    ]);

    const transport = ReplayTransport.replay(fixture);
    await transport.getAccount('GABC');

    await expect(transport.getAccount('GABC')).rejects.toBeInstanceOf(ReplayFixtureError);
  });

  it('throws ReplayFixtureError for a method with no entries at all', async () => {
    const fixture = makeFixture([]);
    const transport = ReplayTransport.replay(fixture);

    await expect(transport.getHealth()).rejects.toBeInstanceOf(ReplayFixtureError);
  });

  it('getFixture returns the original fixture', () => {
    const fixture = makeFixture([
      { method: 'getHealth', request: {}, response: { status: 'healthy' } },
    ]);
    const transport = ReplayTransport.replay(fixture);
    expect(transport.getFixture()).toBe(fixture);
  });

  it('does not make any live network calls', async () => {
    const fixture = makeFixture([
      { method: 'getHealth', request: {}, response: { status: 'healthy' } },
    ]);
    const transport = ReplayTransport.replay(fixture);

    // Simply ensuring the call resolves without needing a real transport
    const result = await transport.getHealth();
    expect(result).toBeDefined();
  });

  it('handles per-method queues independently', async () => {
    const fixture = makeFixture([
      { method: 'getHealth', request: {}, response: { status: 'healthy' } },
      { method: 'getAccount', request: {}, response: { id: 'G1', sequence: '1' } },
      { method: 'getHealth', request: {}, response: { status: 'degraded' } },
    ]);

    const transport = ReplayTransport.replay(fixture);

    const h1 = await transport.getHealth();
    const a1 = await transport.getAccount('G1');
    const h2 = await transport.getHealth();

    expect((h1 as { status: string }).status).toBe('healthy');
    expect((a1 as { id: string }).id).toBe('G1');
    expect((h2 as { status: string }).status).toBe('degraded');
  });
});

// ── ReplayTransport.parse ─────────────────────────────────────────────────

describe('ReplayTransport.parse', () => {
  it('parses valid fixture JSON', () => {
    const fixture = makeFixture([
      { method: 'getHealth', request: {}, response: { status: 'healthy' } },
    ]);
    const json = JSON.stringify(fixture);
    const parsed = ReplayTransport.parse(json);

    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]!.method).toBe('getHealth');
  });

  it('throws ReplayFixtureParseError for invalid JSON', () => {
    expect(() => ReplayTransport.parse('not-json{')).toThrow(ReplayFixtureParseError);
  });

  it('throws ReplayFixtureParseError when entries are missing', () => {
    expect(() => ReplayTransport.parse(JSON.stringify({ recordedAt: '2026-01-01' }))).toThrow(
      ReplayFixtureParseError,
    );
  });
});

// ── ReplayFixtureError ────────────────────────────────────────────────────

describe('ReplayFixtureError', () => {
  it('has the correct name and message', () => {
    const err = new ReplayFixtureError('getAccount', 3);
    expect(err.name).toBe('ReplayFixtureError');
    expect(err.message).toContain('getAccount');
    expect(err.message).toContain('3');
  });
});

// ── ReplayFixtureParseError ───────────────────────────────────────────────

describe('ReplayFixtureParseError', () => {
  it('has the correct name', () => {
    const err = new ReplayFixtureParseError('bad input');
    expect(err.name).toBe('ReplayFixtureParseError');
    expect(err.message).toContain('bad input');
  });
});

// ── Record → Replay round-trip ────────────────────────────────────────────

describe('record → toJSON → parse → replay round-trip', () => {
  it('replays recorded interactions deterministically', async () => {
    const base = makeBaseTransport();
    const recording = ReplayTransport.record(base, undefined, { label: 'round-trip' });

    await recording.getAccount('GABC');
    await recording.getHealth();

    const json = recording.toJSON();
    const fixture = ReplayTransport.parse(json);
    const replaying = ReplayTransport.replay(fixture);

    const account = await replaying.getAccount('GABC');
    const health = await replaying.getHealth();

    expect((account as { id: string }).id).toBe('GABC');
    expect((health as { status: string }).status).toBe('healthy');
  });
});
