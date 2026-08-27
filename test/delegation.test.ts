import { describe, it, expect } from 'vitest';
import { MockSoroStreamClient } from '../src/mock.js';

const DELEGATOR = 'GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF';
const DELEGATE_1 = 'GA2H2AWK2BA4CKP5ORL4T2J5R7OAM7V2O24V2U2S3Q53G2V2O24V2U2S';
const DELEGATE_2 = 'GB3H3AWK3BA3CKP3ORL3T3J3R3OAM3V3O33V3U3S3Q53G3V3O33V3U3S';

describe('Delegation helpers (Issue #349)', () => {
  it('addDelegate submits correct instruction and adds delegate to getDelegates', async () => {
    const mock = new MockSoroStreamClient();
    mock.setSender(DELEGATOR);

    // Initial delegates list should be empty
    const initialDelegates = await mock.getDelegates(DELEGATOR);
    expect(initialDelegates).toEqual([]);

    // Call addDelegate
    const result = await mock.addDelegate(DELEGATE_1);
    expect(result.txHash).toBeDefined();

    // Assert delegate appears in getDelegates
    const delegatesAfterAdd = await mock.getDelegates(DELEGATOR);
    expect(delegatesAfterAdd).toContain(DELEGATE_1);
    expect(delegatesAfterAdd.length).toBe(1);
  });

  it('handles multiple delegates and getDelegates queries correctly', async () => {
    const mock = new MockSoroStreamClient();
    mock.setSender(DELEGATOR);

    await mock.addDelegate(DELEGATE_1);
    await mock.addDelegate(DELEGATE_2);

    const delegates = await mock.getDelegates(DELEGATOR);
    expect(delegates).toContain(DELEGATE_1);
    expect(delegates).toContain(DELEGATE_2);
    expect(delegates.length).toBe(2);
  });

  it('revokeDelegate removes delegate from getDelegates', async () => {
    const mock = new MockSoroStreamClient();
    mock.setSender(DELEGATOR);

    await mock.addDelegate(DELEGATE_1);
    await mock.addDelegate(DELEGATE_2);

    // Call revokeDelegate
    const revokeResult = await mock.revokeDelegate(DELEGATE_1);
    expect(revokeResult.txHash).toBeDefined();

    // Assert delegate removed from getDelegates
    const delegatesAfterRevoke = await mock.getDelegates(DELEGATOR);
    expect(delegatesAfterRevoke).not.toContain(DELEGATE_1);
    expect(delegatesAfterRevoke).toContain(DELEGATE_2);
    expect(delegatesAfterRevoke.length).toBe(1);
  });
});
