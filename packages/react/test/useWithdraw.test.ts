import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { effectScope } from 'vue';

import { useWithdraw } from '../src/useWithdraw.js';
import { useWithdraw as useVueWithdraw } from '../../vue/src/useWithdraw.js';
import type { WithdrawParams } from '../../../src/types.js';
import { assertStellarAddress } from '../../../src/utils.js';

function makeClient(withdrawImpl: ReturnType<typeof vi.fn>): {
  withdraw: typeof withdrawImpl;
} {
  return {
    withdraw: withdrawImpl,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useWithdraw', () => {
  it('returns { withdraw, loading, error, txResult }', () => {
    const client = makeClient(vi.fn());
    const { result } = renderHook(() => useWithdraw(client));

    expect(result.current.withdraw).toBeInstanceOf(Function);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.txResult).toBeNull();
  });

  it('throws when no client is provided', async () => {
    const { result } = renderHook(() => useWithdraw(null));
    await act(async () => {
      await expect(result.current.withdraw('1')).rejects.toThrow(/no SoroStream client/i);
    });
    expect(result.current.error).toBeInstanceOf(Error);
  });

  it('sets loading true from call initiation until confirmation', async () => {
    let resolveWithdraw: (v: { txHash: string; amount: string }) => void = () => {
      throw new Error('withdraw was not awaited');
    };
    const withdraw = vi.fn(
      () =>
        new Promise<{ txHash: string; amount: string }>((resolve) => {
          resolveWithdraw = resolve;
        }),
    );
    const client = makeClient(withdraw);
    const { result } = renderHook(() => useWithdraw(client));

    let captured: { txHash: string; amount: string } | undefined;
    const promise = result.current.withdraw('42').then((r) => {
      captured = r;
    });

    // Flush microtasks so the hook's async body runs up to the await.
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.loading).toBe(true);
    expect(result.current.txResult).toBeNull();
    expect(withdraw).toHaveBeenCalledWith({ streamId: '42' });

    await act(async () => {
      resolveWithdraw({ txHash: 'tx-1', amount: '500' });
      await promise;
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.txResult).toEqual({ txHash: 'tx-1', amount: '500' });
    expect(captured).toEqual({ txHash: 'tx-1', amount: '500' });
  });

  it('accepts full WithdrawParams', async () => {
    const withdraw = vi.fn().mockResolvedValue({ txHash: 'tx-2', amount: '1' });
    const client = makeClient(withdraw);
    const { result } = renderHook(() => useWithdraw(client));

    const params: WithdrawParams = { streamId: '7' };
    await act(async () => {
      await result.current.withdraw(params);
    });

    expect(withdraw).toHaveBeenCalledWith({ streamId: '7' });
  });

  it('records and rethrows failures', async () => {
    const withdraw = vi.fn().mockRejectedValue(new Error('insufficient claimable'));
    const client = makeClient(withdraw);
    const { result } = renderHook(() => useWithdraw(client));

    await act(async () => {
      await expect(result.current.withdraw('42')).rejects.toThrow('insufficient claimable');
    });

    expect(result.current.error?.message).toBe('insufficient claimable');
    expect(result.current.loading).toBe(false);
    expect(result.current.txResult).toBeNull();
  });

  it('withdraws from the in-memory mock client', async () => {
    const { MockSoroStreamClient } = await import('../../../src/mock.js');
    const mock = new MockSoroStreamClient();
    const { streamId } = await mock.createStream({
      recipient: assertStellarAddress('GAXXZ5XSL2VTQPGWB3LPU5273HSJXMK7VHLZTF2XKW65QFZVA3XKULQZ'),
      token: assertStellarAddress('CAVTXNC2WCHINDNP4VBLSOQA2667VE3RPQZNGD5TFI4U2QSHTVAC667T'),
      amount: 1_000_000n,
      durationSeconds: 3600,
      autoRenew: false,
    });
    mock.advanceTime(streamId, 600);

    const { result } = renderHook(() =>
      useWithdraw(mock as unknown as ReturnType<typeof makeClient>),
    );
    await act(async () => {
      await result.current.withdraw(streamId);
    });

    expect(result.current.txResult).toBeTruthy();
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });
});

describe('React and Vue useWithdraw parity (#770)', () => {
  it('exposes equivalent success outcomes with framework-specific state shapes', async () => {
    const response = { txHash: 'tx-parity', amount: '500' };
    const client = makeClient(vi.fn().mockResolvedValue(response));
    const reactHook = renderHook(() => useWithdraw(client));
    const vueScope = effectScope();

    try {
      const vueHook = vueScope.run(() => useVueWithdraw(client));
      if (!vueHook) throw new Error('Vue effect scope did not return a hook result');

      await act(async () => {
        await Promise.all([reactHook.result.current.withdraw('42'), vueHook.withdraw('42')]);
      });

      expect(client.withdraw).toHaveBeenCalledTimes(2);
      expect(client.withdraw).toHaveBeenNthCalledWith(1, { streamId: '42' });
      expect(client.withdraw).toHaveBeenNthCalledWith(2, { streamId: '42' });
      expect(reactHook.result.current.loading).toBe(vueHook.submitting.value);
      expect(reactHook.result.current.error?.message ?? null).toBe(
        vueHook.error.value?.message ?? null,
      );
      expect(reactHook.result.current.txResult).toEqual(response);
      expect({ txHash: vueHook.txHash.value, amount: vueHook.amount.value }).toEqual(response);
    } finally {
      vueScope.stop();
    }
  });

  it('exposes equivalent errors and cleared transaction state', async () => {
    const client = makeClient(vi.fn().mockRejectedValue(new Error('RPC unavailable')));
    const reactHook = renderHook(() => useWithdraw(client));
    const vueScope = effectScope();

    try {
      const vueHook = vueScope.run(() => useVueWithdraw(client));
      if (!vueHook) throw new Error('Vue effect scope did not return a hook result');

      await act(async () => {
        await expect(reactHook.result.current.withdraw('42')).rejects.toThrow('RPC unavailable');
        await expect(vueHook.withdraw('42')).rejects.toThrow('RPC unavailable');
      });

      expect(reactHook.result.current.loading).toBe(vueHook.submitting.value);
      expect(reactHook.result.current.error?.message).toBe(vueHook.error.value?.message);
      expect(reactHook.result.current.txResult).toBeNull();
      expect(vueHook.txHash.value).toBeNull();
      expect(vueHook.amount.value).toBeNull();
    } finally {
      vueScope.stop();
    }
  });
});
