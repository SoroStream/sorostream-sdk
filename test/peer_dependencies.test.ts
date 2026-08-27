/**
 * Tests for issue #213: validate the consumer's installed
 * `@stellar/stellar-sdk` peer version at client construction time.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkPeerDependencies } from '../src/peerDependencies.js';
import { SoroStreamDependencyError } from '../src/errors.js';
import { SoroStreamClient } from '../src/SoroStreamClient.js';
import type { WalletAdapter } from '../src/types.js';

const VALID_CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

function makeAdapter(): WalletAdapter {
  return {
    getPublicKey: vi.fn().mockResolvedValue('GABC123'),
    signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
    isConnected: vi.fn().mockResolvedValue(true),
  };
}

describe('checkPeerDependencies', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('throws SoroStreamDependencyError for an incompatible major version', () => {
    expect(() => checkPeerDependencies('14.0.0')).toThrow(SoroStreamDependencyError);
    expect(() => checkPeerDependencies('12.9.9')).toThrow(SoroStreamDependencyError);
  });

  it('includes the required range and installed version on the thrown error', () => {
    try {
      checkPeerDependencies('14.2.0');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SoroStreamDependencyError);
      const depErr = err as SoroStreamDependencyError;
      expect(depErr.packageName).toBe('@stellar/stellar-sdk');
      expect(depErr.requiredRange).toBe('^13.3.0');
      expect(depErr.installedVersion).toBe('14.2.0');
    }
  });

  it('logs a console.warn (does not throw) for a compatible newer minor version', () => {
    expect(() => checkPeerDependencies('13.5.0')).not.toThrow();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0]).toContain('13.5.0');
  });

  it('produces no output for an exact version match', () => {
    expect(() => checkPeerDependencies('13.3.0')).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('produces no output for a patch-level difference within the same minor', () => {
    expect(() => checkPeerDependencies('13.3.7')).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('skips validation silently when the version cannot be determined', () => {
    expect(() => checkPeerDependencies(null)).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('SoroStreamClient peer dependency check integration', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('runs the peer check by default when constructing a client', () => {
    // The real installed @stellar/stellar-sdk in this environment satisfies
    // ^13.3.0 (same major), so construction must not throw either way.
    expect(
      () =>
        new SoroStreamClient({
          network: 'testnet',
          contractId: VALID_CONTRACT,
          walletAdapter: makeAdapter(),
        }),
    ).not.toThrow();
  });

  it('can be skipped via { skipPeerCheck: true }', () => {
    expect(
      () =>
        new SoroStreamClient({
          network: 'testnet',
          contractId: VALID_CONTRACT,
          walletAdapter: makeAdapter(),
          skipPeerCheck: true,
        }),
    ).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
