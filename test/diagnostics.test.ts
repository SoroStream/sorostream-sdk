/**
 * Tests for issue #391: client.diagnostics() method
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SoroStreamClient } from '../src/SoroStreamClient.js';
import { MockSoroStreamClient } from '../src/mock.js';
import type { WalletAdapter } from '../src/types.js';

const VALID_CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const SENDER_PK = 'GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF';

function makeAdapter(name?: string): WalletAdapter {
  const adapter: WalletAdapter & { name?: string } = {
    getPublicKey: vi.fn().mockResolvedValue(SENDER_PK),
    signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
    isConnected: vi.fn().mockResolvedValue(true),
  };
  if (name) adapter.name = name;
  return adapter;
}

describe('Issue #391 — client.diagnostics()', () => {
  let client: SoroStreamClient;

  beforeEach(() => {
    client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: makeAdapter(),
    });
  });

  it('returns sdkVersion as a semver string', () => {
    const info = client.diagnostics();
    expect(info.sdkVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('returns the active network', () => {
    const info = client.diagnostics();
    expect(info.network).toBe('testnet');
  });

  it('returns a non-null walletAdapter name when an adapter is set', () => {
    const info = client.diagnostics();
    expect(info.walletAdapter).not.toBeNull();
    expect(typeof info.walletAdapter).toBe('string');
  });

  it('returns null walletAdapter when no adapter is configured', () => {
    const readOnlyClient = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
    });
    const info = readOnlyClient.diagnostics();
    expect(info.walletAdapter).toBeNull();
  });

  it('returns the named adapter display name when adapter.name is set', () => {
    const namedClient = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: makeAdapter('freighter'),
    });
    const info = namedClient.diagnostics();
    expect(info.walletAdapter).toBe('freighter');
  });

  it('returns pollingIntervalMs as a positive number', () => {
    const info = client.diagnostics();
    expect(typeof info.pollingIntervalMs).toBe('number');
    expect(info.pollingIntervalMs).toBeGreaterThan(0);
  });

  it('returns lastRpcTimestampMs as null before any RPC call', () => {
    const info = client.diagnostics();
    expect(info.lastRpcTimestampMs).toBeNull();
  });

  it('returns mainnet network when configured on mainnet', () => {
    const mainnetClient = new SoroStreamClient({
      network: 'mainnet',
      contractId: VALID_CONTRACT,
      walletAdapter: makeAdapter(),
    });
    const info = mainnetClient.diagnostics();
    expect(info.network).toBe('mainnet');
  });

  it('diagnostics result shape has all required fields', () => {
    const info = client.diagnostics();
    expect(info).toHaveProperty('sdkVersion');
    expect(info).toHaveProperty('network');
    expect(info).toHaveProperty('walletAdapter');
    expect(info).toHaveProperty('pollingIntervalMs');
    expect(info).toHaveProperty('lastRpcTimestampMs');
  });
});

describe('Issue #391 — MockSoroStreamClient.diagnostics()', () => {
  it('returns a valid DiagnosticsResult', () => {
    const mock = new MockSoroStreamClient();
    const info = mock.diagnostics();
    expect(info.sdkVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(info.network).toBe('testnet');
    expect(info.walletAdapter).toBe('mock');
    expect(info.pollingIntervalMs).toBeGreaterThan(0);
    expect(info.lastRpcTimestampMs).toBeNull();
  });
});
