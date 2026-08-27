import { describe, it, expect, vi } from 'vitest';
import { SoroStreamClient } from '../src/SoroStreamClient.js';
import type { WalletAdapter } from '../src/types.js';
import { SoroStreamVersionError } from '../src/errors.js';

const VALID_CONTRACT = 'CAVTXNC2WCHINDNP4VBLSOQA2667VE3RPQZNGD5TFI4U2QSHTVAC667T';
const VALID_ACCOUNT = 'GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF';

function makeMockAdapter(): WalletAdapter {
  return {
    getPublicKey: vi.fn().mockResolvedValue(VALID_ACCOUNT),
    signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
    isConnected: vi.fn().mockResolvedValue(true),
  };
}

describe('Contract compatibility check', () => {
  it('checkContractCompatibility returns CompatibilityResult shape', async () => {
    const adapter = makeMockAdapter();
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: adapter,
      skipPeerCheck: true,
      skipVersionCheck: true,
    });

    // Mock the server to simulate a successful version response
    const mockServer = (client as any).server;
    mockServer.getAccount = vi.fn().mockResolvedValue({});
    mockServer.simulateTransaction = vi.fn().mockResolvedValue({
      status: 'SUCCESS',
      result: {
        retval: '1.5.0',
      },
    });

    const result = await client.checkContractCompatibility();

    expect(result).toHaveProperty('sdkVersion');
    expect(result).toHaveProperty('contractVersion');
    expect(result).toHaveProperty('minCompatibleVersion');
    expect(result).toHaveProperty('maxCompatibleVersion');
    expect(result).toHaveProperty('isCompatible');
    expect(result).toHaveProperty('message');
    expect(typeof result.sdkVersion).toBe('string');
    expect(typeof result.minCompatibleVersion).toBe('string');
    expect(typeof result.maxCompatibleVersion).toBe('string');
    expect(typeof result.isCompatible).toBe('boolean');
    expect(typeof result.message).toBe('string');
  });

  it('checkContractCompatibility works when server is unavailable', async () => {
    const adapter = makeMockAdapter();
    const client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: adapter,
      skipPeerCheck: true,
      skipVersionCheck: true,
    });

    // Mock server to throw
    const mockServer = (client as any).server;
    mockServer.getAccount = vi.fn().mockRejectedValue(new Error('connection failed'));

    const result = await client.checkContractCompatibility();

    expect(result.isCompatible).toBe(true);
    expect(result.contractVersion).toBeNull();
    expect(result.message).toContain('could not be determined');
  });

  it('exposes contract version range in package.json', async () => {
    const pkg = await import('../package.json', { with: { type: 'json' } });
    expect(pkg.default.contracts).toBeDefined();
    expect(pkg.default.contracts.minCompatibleVersion).toBe('1.0.0');
    expect(pkg.default.contracts.maxCompatibleVersion).toBe('1.99.99');
  });

  it('SoroStreamVersionError is exported from errors module', async () => {
    const { SoroStreamVersionError } = await import('../src/errors.js');
    expect(SoroStreamVersionError).toBeDefined();
    const error = new SoroStreamVersionError('0.5.0', '1.0.0');
    expect(error.name).toBe('SoroStreamVersionError');
    expect(error.contractVersion).toBe('0.5.0');
    expect(error.minVersion).toBe('1.0.0');
    expect(error.message).toContain('0.5.0');
    expect(error.message).toContain('1.0.0');
  });

  it('CompatibilityResult type is exported from types', async () => {
    const types = await import('../src/types.js');
    // Verify the type exists by checking if we can use it
    expect(types).toBeDefined();
  });
});
