/**
 * Issue #760: Verify that ReplayTransport exports are reachable via the
 * public package entry point (`@sorostream/sdk`).
 *
 * The replay transport was previously unreachable by any package consumer —
 * not re-exported from index.ts, no subpath export.  This test imports it
 * via the barrel export to confirm the public surface is wired up.
 */
import { describe, it, expect } from 'vitest';

// Import from the barrel re-export, not the deep path
import {
  ReplayTransport,
  ReplayFixtureError,
  ReplayFixtureParseError,
} from '../src/index.js';
import type {
  FixtureEntry,
  FixtureFile,
  RecordTransportOptions,
  RecordingRpcTransport,
  ReplayingRpcTransport,
  ReplayOptions,
} from '../src/index.js';

// ── Helpers ─────────────────────────────────────────────────────────────

function makeFixture(entries: FixtureEntry[] = []): FixtureFile {
  return { recordedAt: '2026-01-01T00:00:00.000Z', entries };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('Issue #760: ReplayTransport exports reachable via public entry point', () => {
  it('ReplayTransport is exported and has record/replay/parse methods', () => {
    expect(ReplayTransport).toBeDefined();
    expect(typeof ReplayTransport.record).toBe('function');
    expect(typeof ReplayTransport.replay).toBe('function');
    expect(typeof ReplayTransport.parse).toBe('function');
  });

  it('ReplayFixtureError is exported and constructable', () => {
    const err = new ReplayFixtureError('getAccount', 2);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ReplayFixtureError');
    expect(err.message).toContain('getAccount');
    expect(err.message).toContain('2');
  });

  it('ReplayFixtureParseError is exported and constructable', () => {
    const err = new ReplayFixtureParseError('bad json');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ReplayFixtureParseError');
    expect(err.message).toContain('bad json');
  });

  it('FixtureEntry type is importable from the public entry point', () => {
    const entry: FixtureEntry = {
      method: 'getAccount',
      request: { address: 'GABC' },
      response: { id: 'GABC', sequence: '1' },
    };
    expect(entry.method).toBe('getAccount');
  });

  it('FixtureFile type is importable from the public entry point', () => {
    const fixture: FixtureFile = makeFixture([
      { method: 'getHealth', request: {}, response: { status: 'healthy' } },
    ]);
    expect(fixture.entries).toHaveLength(1);
  });

  it('RecordTransportOptions type is importable from the public entry point', () => {
    const opts: RecordTransportOptions = { label: 'test' };
    expect(opts.label).toBe('test');
  });

  it('ReplayOptions type is importable from the public entry point', () => {
    const opts: ReplayOptions = { sequential: true, methods: ['getAccount'] };
    expect(opts.sequential).toBe(true);
  });

  it('can create a recording transport via the public export', () => {
    const base = {
      serverURL: new URL('https://soroban-testnet.stellar.org'),
      getAccount: async () => ({ id: 'GABC', sequence: '1' }),
      getHealth: async () => ({ status: 'healthy' }),
      getLatestLedger: async () => ({ id: 'l1', sequence: 1, protocolVersion: 21 }),
      getTransaction: async () => ({ status: 'SUCCESS' }),
      simulateTransaction: async () => ({ result: { retval: '' }, latestLedger: 100 }),
      prepareTransaction: async () => ({ toXDR: () => 'xdr' }),
      sendTransaction: async () => ({ hash: 'h', status: 'PENDING' }),
      getEvents: async () => ({ events: [], latestLedger: 100 }),
    };
    const transport = ReplayTransport.record(base);
    expect(transport.getEntries()).toHaveLength(0);
  });

  it('can create a replaying transport via the public export', async () => {
    const fixture = makeFixture([
      { method: 'getHealth', request: {}, response: { status: 'healthy' } },
    ]);
    const transport = ReplayTransport.replay(fixture);
    const result = await transport.getHealth();
    expect(result).toEqual({ status: 'healthy' });
  });

  it('can parse fixture JSON via the public export', () => {
    const fixture = makeFixture([
      { method: 'getHealth', request: {}, response: { status: 'healthy' } },
    ]);
    const parsed = ReplayTransport.parse(JSON.stringify(fixture));
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]!.method).toBe('getHealth');
  });

  it('RecordingRpcTransport and ReplayingRpcTransport types are importable', () => {
    // Type-only usage — if the export is missing, TypeScript compilation fails
    const base = {
      serverURL: new URL('https://rpc.test'),
      getAccount: async () => ({ id: 'G', sequence: '0' }),
      getHealth: async () => ({ status: 'ok' }),
      getLatestLedger: async () => ({ id: 'l', sequence: 0, protocolVersion: 20 }),
      getTransaction: async () => ({ status: 'NOT_FOUND' }),
      simulateTransaction: async () => ({}),
      prepareTransaction: async () => ({}),
      sendTransaction: async () => ({ hash: '', status: 'PENDING' }),
      getEvents: async () => ({ events: [], latestLedger: 0 }),
    };
    const recording: RecordingRpcTransport = ReplayTransport.record(base);
    expect(recording.getEntries).toBeDefined();
    expect(recording.toJSON).toBeDefined();

    const fixture = makeFixture([
      { method: 'getHealth', request: {}, response: { status: 'ok' } },
    ]);
    const replaying: ReplayingRpcTransport = ReplayTransport.replay(fixture);
    expect(replaying.getFixture).toBeDefined();
  });
});
