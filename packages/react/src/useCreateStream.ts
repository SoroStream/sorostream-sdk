import { useState, useCallback } from 'react';
import type {
  SoroStreamClient,
  CreateStreamParams,
  CreateStreamDryRunResult,
} from '@sorostream/sdk';

export interface UseCreateStreamResult {
  create: (
    params: CreateStreamParams,
  ) => Promise<{ streamId: string; txHash: string } | CreateStreamDryRunResult>;
  loading: boolean;
  error: Error | null;
  txResult: { streamId: string; txHash: string } | CreateStreamDryRunResult | null;
  reset: () => void;
}

/**
 * Validates a {@link CreateStreamParams} object client-side before submission.
 *
 * Throws a descriptive {@link Error} for any missing or invalid field so the
 * caller can surface the problem without issuing a doomed on-chain
 * transaction. This runs before the SDK's own pre-flight validation.
 *
 * @param params - The parameters to validate.
 * @throws {Error} When a required field is missing or malformed.
 */
export function validateCreateStreamParams(params: CreateStreamParams): void {
  if (!params || typeof params !== 'object') {
    throw new Error('useCreateStream: params must be a non-null object');
  }

  if (typeof params.recipient !== 'string' || params.recipient.trim() === '') {
    throw new Error('useCreateStream: recipient is required and must be a string');
  }
  if (typeof params.token !== 'string' || params.token.trim() === '') {
    throw new Error('useCreateStream: token is required and must be a string');
  }
  if (typeof params.amount !== 'bigint' || params.amount <= 0n) {
    throw new Error('useCreateStream: amount is required and must be a positive bigint');
  }
  if (typeof params.durationSeconds !== 'number' || !Number.isFinite(params.durationSeconds)) {
    throw new Error('useCreateStream: durationSeconds is required and must be a finite number');
  }
  if (typeof params.autoRenew !== 'boolean') {
    throw new Error('useCreateStream: autoRenew is required and must be a boolean');
  }
}

/**
 * React hook for creating a SoroStream.
 *
 * Returns `{ create, loading, error, txResult, reset }`. `create(params)`
 * validates the parameters client-side before submitting, tracks loading
 * state from call initiation until confirmation, and exposes the resulting
 * `{ streamId, txHash }` in `txResult`. `reset()` clears `error` and
 * `txResult` so the hook can be re-used after a failure.
 *
 * @param client - A connected `SoroStreamClient` instance (or null).
 * @returns `{ create, loading, error, txResult, reset }`
 *
 * @example
 * ```tsx
 * const { create, loading, error, txResult, reset } = useCreateStream(client);
 *
 * return (
 *   <button disabled={loading} onClick={() => create({ recipient, token, amount: 100n, durationSeconds: 3600, autoRenew: false }).catch(() => {})}>
 *     {loading ? 'Creating…' : 'Create stream'}
 *   </button>
 * );
 * ```
 */
export function useCreateStream(client: SoroStreamClient | null): UseCreateStreamResult {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [txResult, setTxResult] = useState<
    { streamId: string; txHash: string } | CreateStreamDryRunResult | null
  >(null);

  const reset = useCallback(() => {
    setError(null);
    setTxResult(null);
  }, []);

  const create = useCallback(
    async (
      params: CreateStreamParams,
    ): Promise<{ streamId: string; txHash: string } | CreateStreamDryRunResult> => {
      if (!client) {
        const err = new Error('useCreateStream: no SoroStreamClient provided');
        setError(err);
        throw err;
      }

      try {
        // Client-side validation runs before any submission so invalid params
        // surface a clear error without consuming retry budget or a tx.
        validateCreateStreamParams(params);

        setLoading(true);
        setError(null);
        setTxResult(null);

        const result = await client.createStream(params);
        setTxResult(result);
        setLoading(false);
        return result;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        setLoading(false);
        throw e;
      }
    },
    [client],
  );

  return { create, loading, error, txResult, reset };
}
