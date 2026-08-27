import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockSoroStreamClient } from '../src/mock.js';
import { SoroStreamClient } from '../src/SoroStreamClient.js';
import type { WalletAdapter } from '../src/types.js';

const VALID_CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const DELEGATOR_PK = 'GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF';
const DELEGATE_PK = 'GAXXZ5XSL2VTQPGWB3LPU5273HSJXMK7VHLZTF2XKW65QFZVA3XKULQZ';

describe('Issue #349 — Delegation SDK helpers (Mock client flow)', () => {
  it('runs addDelegate, getDelegates, and revokeDelegate flows end-to-end', async () => {
    const mock = new MockSoroStreamClient();

    // 1. Initial state: no delegates
    const initialDelegates = await mock.getDelegates();
    expect(initialDelegates).toEqual([]);

    // 2. Add delegate
    const addResult = await mock.addDelegate(DELEGATE_PK);
    expect(addResult.txHash).toContain(DELEGATE_PK);

    // 3. Query delegates: should contain added delegate
    const currentDelegates = await mock.getDelegates();
    expect(currentDelegates).toContain(DELEGATE_PK);

    // 4. Revoke delegate
    const revokeResult = await mock.revokeDelegate(DELEGATE_PK);
    expect(revokeResult.txHash).toContain(DELEGATE_PK);

    // 5. Query delegates: should no longer contain revoked delegate
    const finalDelegates = await mock.getDelegates();
    expect(finalDelegates).not.toContain(DELEGATE_PK);
  });
});

describe('Issue #349 — Delegation SDK helpers instruction encoding (SoroStreamClient)', () => {
  let client: SoroStreamClient;
  let mockAdapter: WalletAdapter;

  beforeEach(() => {
    mockAdapter = {
      getPublicKey: vi.fn().mockResolvedValue(DELEGATOR_PK),
      signTransaction: vi.fn().mockResolvedValue('signed_xdr'),
      isConnected: vi.fn().mockResolvedValue(true),
    };

    client = new SoroStreamClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      walletAdapter: mockAdapter,
    });
  });

  it('addDelegate submits correct contract instruction', async () => {
    const buildAndSubmitSpy = vi
      .spyOn(client as any, 'buildAndSubmit')
      .mockResolvedValue({ txHash: 'txhash_add_delegate', ledger: 0 });

    const result = await client.addDelegate(DELEGATE_PK);

    expect(result.txHash).toBe('txhash_add_delegate');
    expect(buildAndSubmitSpy).toHaveBeenCalledTimes(1);
    const [, , , method] = buildAndSubmitSpy.mock.calls[0] as unknown as [any, any, any, string];
    expect(method).toBe('addDelegate');
  });

  it('revokeDelegate submits correct contract instruction', async () => {
    const buildAndSubmitSpy = vi
      .spyOn(client as any, 'buildAndSubmit')
      .mockResolvedValue({ txHash: 'txhash_revoke_delegate', ledger: 0 });

    const result = await client.revokeDelegate(DELEGATE_PK);

    expect(result.txHash).toBe('txhash_revoke_delegate');
    expect(buildAndSubmitSpy).toHaveBeenCalledTimes(1);
    const [, , , method] = buildAndSubmitSpy.mock.calls[0] as unknown as [any, any, any, string];
    expect(method).toBe('revokeDelegate');
  });
});
