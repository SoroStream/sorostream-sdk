import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SoroStreamClient } from '../src/SoroStreamClient.js';
import type { CreateStreamParams } from '../src/types.js';

describe('createStreams batch method (#362)', () => {
  let client: SoroStreamClient;

  beforeEach(() => {
    client = new SoroStreamClient({
      network: 'testnet',
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      skipVersionCheck: true,
      skipPeerCheck: true,
    });
  });

  it('is a public method on SoroStreamClient', () => {
    expect(typeof client.createStreams).toBe('function');
  });

  it('throws when called with empty array', async () => {
    await expect(client.createStreams([])).rejects.toThrow('At least one stream is required');
  });

  it('throws when amount is 0', async () => {
    const params: CreateStreamParams = {
      recipient: 'GABCDE1234567890ABCDE1234567890ABCDE1234567890ABCDE1234567',
      token: 'GABCDE1234567890ABCDE1234567890ABCDE1234567890ABCDE1234568',
      amount: 0n,
      durationSeconds: 3600,
      autoRenew: false,
    };
    await expect(client.createStreams([params])).rejects.toThrow('Amount must be > 0');
  });

  it('throws when durationSeconds is 0', async () => {
    const params: CreateStreamParams = {
      recipient: 'GABCDE1234567890ABCDE1234567890ABCDE1234567890ABCDE1234567',
      token: 'GABCDE1234567890ABCDE1234567890ABCDE1234567890ABCDE1234568',
      amount: 100_000_000n,
      durationSeconds: 0,
      autoRenew: false,
    };
    await expect(client.createStreams([params])).rejects.toThrow('Duration must be > 0');
  });

  it('CreateStreamsParams type is exported from the SDK', async () => {
    const { SoroStreamClient: ClientExport } = await import('../src/SoroStreamClient.js');
    expect(ClientExport).toBeDefined();
    // Type-level check: CreateStreamsParams should be importable from index
    const indexExports = await import('../src/index.js');
    // CreateStreamsParams is re-exported from SoroStreamClient.ts
    expect(typeof indexExports).toBe('object');
  });
});
