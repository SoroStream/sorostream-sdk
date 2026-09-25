import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useCreateStream, validateCreateStreamParams } from '../src/useCreateStream.js';
import type { CreateStreamParams } from '../../../src/types.js';

const RECIPIENT = 'GAXXZ5XSL2VTQPGWB3LPU5273HSJXMK7VHLZTF2XKW65QFZVA3XKULQZ';
const TOKEN = 'CAVTXNC2WCHINDNP4VBLSOQA2667VE3RPQZNGD5TFI4U2QSHTVAC667T';

function validParams(overrides: Partial<CreateStreamParams> = {}): CreateStreamParams {
  return {
    recipient: RECIPIENT,
    token: TOKEN,
    amount: 1_000_000n,
    durationSeconds: 3600,
    autoRenew: false,
    ...overrides,
  };
}

function makeClient(createImpl: ReturnType<typeof vi.fn>) {
  return {
    createStream: createImpl,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('validateCreateStreamParams', () => {
  it('accepts a fully valid params object', () => {
    expect(() => validateCreateStreamParams(validParams())).not.toThrow();
  });

  it('rejects null/undefined params', () => {
    expect(() => validateCreateStreamParams(null as unknown as CreateStreamParams)).toThrow(
      /must be a non-null object/,
    );
  });

  it('rejects a missing recipient', () => {
    expect(() =>
      validateCreateStreamParams(validParams({ recipient: '' })),
    ).toThrow(/recipient is required/);
  });

  it('rejects a missing token', () => {
    expect(() => validateCreateStreamParams(validParams({ token: '' }))).toThrow(
      /token is required/,
    );
  });

  it('rejects a non-positive amount', () => {
    expect(() =>
      validateCreateStreamParams(validParams({ amount: 0n })),
    ).toThrow(/amount is required/);
  });

  it('rejects a missing durationSeconds', () => {
    expect(() =>
      validateCreateStreamParams(validParams({ durationSeconds: NaN })),
    ).toThrow(/durationSeconds is required/);
  });

  it('rejects a missing autoRenew', () => {
    expect(() =>
      validateCreateStreamParams(validParams({ autoRenew: undefined as unknown as boolean })),
    ).toThrow(/autoRenew is required/);
  });
});

describe('useCreateStream', () => {
  it('returns { create, loading, error, txResult, reset }', () => {
    const client = makeClient(vi.fn());
    const { result } = renderHook(() => useCreateStream(client));

    expect(result.current.create).toBeInstanceOf(Function);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.txResult).toBeNull();
    expect(result.current.reset).toBeInstanceOf(Function);
  });

  it('throws when no client is provided', async () => {
    const { result } = renderHook(() => useCreateStream(null));
    await act(async () => {
      await expect(result.current.create(validParams())).rejects.toThrow(
        /no SoroStreamClient provided/,
      );
    });
    expect(result.current.error).toBeInstanceOf(Error);
  });

  it('rejects invalid params before submitting (client-side validation)', async () => {
    const createStream = vi.fn();
    const client = makeClient(createStream);
    const { result } = renderHook(() => useCreateStream(client));

    await act(async () => {
      await expect(result.current.create(validParams({ amount: 0n }))).rejects.toThrow(
        /amount is required/,
      );
    });

    expect(createStream).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeInstanceOf(Error);
  });

  it('sets loading true from call initiation until confirmation', async () => {
    let resolveCreate: (v: { streamId: string; txHash: string }) => void = () => {
      throw new Error('createStream was not awaited');
    };
    const createStream = vi.fn(
      () =>
        new Promise<{ streamId: string; txHash: string }>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const client = makeClient(createStream);
    const { result } = renderHook(() => useCreateStream(client));

    let captured: { streamId: string; txHash: string } | undefined;
    const promise = result.current.create(validParams()).then((r) => {
      captured = r;
    });

    // Flush microtasks so the hook's async body runs up to the await.
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.loading).toBe(true);
    expect(result.current.txResult).toBeNull();

    await act(async () => {
      resolveCreate({ streamId: '42', txHash: 'tx-abc' });
      await promise;
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.txResult).toEqual({ streamId: '42', txHash: 'tx-abc' });
    expect(captured).toEqual({ streamId: '42', txHash: 'tx-abc' });
  });

  it('records and rethrows failures', async () => {
    const createStream = vi.fn().mockRejectedValue(new Error('insufficient allowance'));
    const client = makeClient(createStream);
    const { result } = renderHook(() => useCreateStream(client));

    await act(async () => {
      await expect(result.current.create(validParams())).rejects.toThrow('insufficient allowance');
    });

    expect(result.current.error?.message).toBe('insufficient allowance');
    expect(result.current.loading).toBe(false);
    expect(result.current.txResult).toBeNull();
  });

  it('reset() clears error and txResult to allow re-use after a failure', async () => {
    const createStream = vi.fn().mockRejectedValue(new Error('boom'));
    const client = makeClient(createStream);
    const { result } = renderHook(() => useCreateStream(client));

    await act(async () => {
      await expect(result.current.create(validParams())).rejects.toThrow('boom');
    });
    expect(result.current.error).toBeInstanceOf(Error);

    act(() => {
      result.current.reset();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.txResult).toBeNull();

    // The hook is re-usable: a subsequent call should run again.
    createStream.mockResolvedValueOnce({ streamId: '7', txHash: 'tx-2' });
    await act(async () => {
      await result.current.create(validParams());
    });

    expect(result.current.txResult).toEqual({ streamId: '7', txHash: 'tx-2' });
    expect(result.current.error).toBeNull();
  });
});