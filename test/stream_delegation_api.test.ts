/**
 * Tests for issue #329: Stream-scoped delegation API
 * grantDelegate(streamId, delegate) and revokeDelegateFromStream(streamId, delegate)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockSoroStreamClient } from '../src/mock.js';
import { SoroStreamClient } from '../src/SoroStreamClient.js';
import type { WalletAdapter } from '../src/types.js';

const VALID_CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const SENDER_PK = 'GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF';
const DELEGATE_A = 'GAXXZ5XSL2VTQPGWB3LPU5273HSJXMK7VHLZTF2XKW65QFZVA3XKULQZ';
const DELEGATE_B = 'GBCDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4';

// ── MockSoroStreamClient tests ────────────────────────────────────────────────

describe('Issue #329 — grantDelegate/revokeDelegateFromStream (Mock)', () => {
  let mock: MockSoroStreamClient;
  let streamId: string;

  beforeEach(async () => {
    mock = new MockSoroStreamClient(SENDER_PK);
    const { streamId: id } = await mock.createStream({
      recipient: DELEGATE_A,
      token: 'GUSDC000000000000000000000000000000000000000000000000000',
      amount: 1_000_000_000n,
      durationSeconds: 3600,
      autoRenew: false,
    });
    streamId = id;
  });

  it('initially returns empty delegates list for a stream', async () => {
    const delegates = await mock.getStreamDelegates(streamId);
    expect(delegates).toEqual([]);
  });

  it('grantDelegate adds delegate to the stream and returns txHash', async () => {
    const result = await mock.grantDelegate(streamId, DELEGATE_A);
    expect(result.txHash).toBeDefined();
    expect(result.txHash).toContain(streamId);
    expect(result.txHash).toContain(DELEGATE_A);

    const delegates = await mock.getStreamDelegates(streamId);
    expect(delegates).toContain(DELEGATE_A);
    expect(delegates).toHaveLength(1);
  });

  it('grantDelegate supports multiple delegates on the same stream', async () => {
    await mock.grantDelegate(streamId, DELEGATE_A);
    await mock.grantDelegate(streamId, DELEGATE_B);

    const delegates = await mock.getStreamDelegates(streamId);
    expect(delegates).toContain(DELEGATE_A);
    expect(delegates).toContain(DELEGATE_B);
    expect(delegates).toHaveLength(2);
  });

  it('grantDelegate is idempotent — adding the same delegate twice keeps only one entry', async () => {
    await mock.grantDelegate(streamId, DELEGATE_A);
    await mock.grantDelegate(streamId, DELEGATE_A);

    const delegates = await mock.getStreamDelegates(streamId);
    expect(delegates.filter((d) => d === DELEGATE_A)).toHaveLength(1);
  });

  it('revokeDelegateFromStream removes the delegate and returns txHash', async () => {
    await mock.grantDelegate(streamId, DELEGATE_A);
    await mock.grantDelegate(streamId, DELEGATE_B);

    const result = await mock.revokeDelegateFromStream(streamId, DELEGATE_A);
    expect(result.txHash).toBeDefined();
    expect(result.txHash).toContain(streamId);

    const delegates = await mock.getStreamDelegates(streamId);
    expect(delegates).not.toContain(DELEGATE_A);
    expect(delegates).toContain(DELEGATE_B);
    expect(delegates).toHaveLength(1);
  });

  it('revokeDelegateFromStream on a non-existent delegate is a no-op', async () => {
    await mock.grantDelegate(streamId, DELEGATE_A);
    await mock.revokeDelegateFromStream(streamId, DELEGATE_B); // not granted

    const delegates = await mock.getStreamDelegates(streamId);
    expect(delegates).toContain(DELEGATE_A);
    expect(delegates).toHaveLength(1);
  });

  it('grantDelegate throws for a non-existent stream', async () => {
    await expect(mock.grantDelegate('nonexistent-stream', DELEGATE_A)).rejects.toThrow(
      /Stream not found/,
    );
  });

  it('revokeDelegateFromStream throws for a non-existent stream', async () => {
    await expect(
      mock.revokeDelegateFromStream('nonexistent-stream', DELEGATE_A),
    ).rejects.toThrow(/Stream not found/);
  });

  it('delegates are scoped to their stream — different streams have independent delegate lists', async () => {
    const { streamId: streamId2 } = await mock.createStream({
      recipient: DELEGATE_B,
      token: 'GUSDC000000000000000000000000000000000000000000000000000',
      amount: 500_000_000n,
      durationSeconds: 1800,
      autoRenew: false,
    });

    await mock.grantDelegate(streamId, DELEGATE_A);
    // DELEGATE_A should NOT appear in streamId2 delegates
    const delegates2 = await mock.getStreamDelegates(streamId2);
    expect(delegates2).not.toContain(DELEGATE_A);
    expect(delegates2).toHaveLength(0);
  });
});

// ── SoroStreamClient tests ────────────────────────────────────────────────────

describe('Issue #329 — grantDelegate/revokeDelegateFromStream (SoroStreamClient)', () => {
  let client: SoroStreamClient;
  let mockAdapter: WalletAdapter;

  beforeEach(() => {
    mockAdapter = {
      getPublicKey: vi.fn().mockResolvedValue(SENDER_PK),
      signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
      isConnected: vi.fn().mockResolvedValue(true),
    };

    client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: mockAdapter,
    });
  });

  it('grantDelegate calls buildAndSubmit with grant_stream_delegate instruction', async () => {
    const buildAndSubmitSpy = vi
      .spyOn(client as any, 'buildAndSubmit')
      .mockResolvedValue({ txHash: 'mock-tx-grant', ledger: 0 });

    const result = await client.grantDelegate('stream-1', DELEGATE_A);
    expect(result.txHash).toBe('mock-tx-grant');
    expect(buildAndSubmitSpy).toHaveBeenCalledTimes(1);
    const [, , , operationName] = buildAndSubmitSpy.mock.calls[0] as [any, any, any, string];
    expect(operationName).toBe('grantDelegate');
  });

  it('revokeDelegateFromStream calls buildAndSubmit with revoke_stream_delegate instruction', async () => {
    const buildAndSubmitSpy = vi
      .spyOn(client as any, 'buildAndSubmit')
      .mockResolvedValue({ txHash: 'mock-tx-revoke', ledger: 0 });

    const result = await client.revokeDelegateFromStream('stream-1', DELEGATE_A);
    expect(result.txHash).toBe('mock-tx-revoke');
    expect(buildAndSubmitSpy).toHaveBeenCalledTimes(1);
    const [, , , operationName] = buildAndSubmitSpy.mock.calls[0] as [any, any, any, string];
    expect(operationName).toBe('revokeDelegateFromStream');
  });

  it('grantDelegate throws InvalidAddressError for a bad delegate address', async () => {
    await expect(client.grantDelegate('stream-1', 'not-an-address')).rejects.toThrow(
      /invalid.*address/i,
    );
  });

  it('revokeDelegateFromStream throws InvalidAddressError for a bad delegate address', async () => {
    await expect(
      client.revokeDelegateFromStream('stream-1', 'not-an-address'),
    ).rejects.toThrow(/invalid.*address/i);
  });
});
