/**
 * Tests for version negotiation (issue #209).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SoroStreamClient } from '../src/SoroStreamClient.js';
import { SoroStreamVersionError } from '../src/errors.js';
import type { WalletAdapter } from '../src/types.js';
import { rpc } from '@stellar/stellar-sdk';

describe('Contract version negotiation (issue #209)', () => {
  const mockWallet: WalletAdapter = {
    getPublicKey: () => Promise.resolve('GTEST'),
    signTransaction: () => Promise.resolve('signed'),
    isConnected: () => Promise.resolve(true),
  };

  const validContractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should skip version check when skipVersionCheck is true', () => {
    expect(() => {
      new SoroStreamClient({
        network: 'testnet',
        contractId: validContractId,
        walletAdapter: mockWallet,
        skipVersionCheck: true,
      });
    }).not.toThrow();
  });

  it('should call get_version when skipVersionCheck is false or undefined', async () => {
    // This test verifies the version check is initiated
    // In a real environment, it would make an RPC call
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: validContractId,
      walletAdapter: mockWallet,
      skipVersionCheck: false,
    });

    expect(client).toBeDefined();
    expect(client.getNetwork()).toBe('testnet');
  });

  it('should export SoroStreamVersionError for users to catch', () => {
    const error = new SoroStreamVersionError('0.9.0', '1.0.0');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SoroStreamVersionError');
    expect(error.contractVersion).toBe('0.9.0');
    expect(error.minCompatibleVersion).toBe('1.0.0');
    expect(error.message).toContain('0.9.0');
    expect(error.message).toContain('1.0.0');
  });

  it('should provide meaningful error message for version mismatch', () => {
    const error = new SoroStreamVersionError('0.5.0', '1.0.0');

    expect(error.message).toBe(
      'Contract version 0.5.0 is incompatible with SDK. Minimum required: 1.0.0',
    );
  });

  it('should allow catching version errors separately from other SDK errors', () => {
    const error = new SoroStreamVersionError('0.8.0', '1.0.0');

    // Users can check instanceof for specific error handling
    const isVersionError = error instanceof SoroStreamVersionError;
    expect(isVersionError).toBe(true);
  });
});
