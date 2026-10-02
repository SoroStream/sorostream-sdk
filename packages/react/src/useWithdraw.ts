import { useState, useCallback } from 'react';
import type { SoroStreamClient, WithdrawParams } from '@sorostream/sdk';

export interface UseWithdrawResult {
  withdraw: (
    streamIdOrParams: string | WithdrawParams,
  ) => Promise<{ txHash: string; amount: string }>;
  loading: boolean;
  error: Error | null;
  txResult: { txHash: string; amount: string } | null;
}

/**
 * React hook for withdrawing claimable funds from a SoroStream.
 *
 * Returns `{ withdraw, loading, error, txResult }`. `loading` is true from call
 * initiation until confirmation, `error` is set when the transaction fails,
 * and `txResult` holds the `{ txHash, amount }` on success.
 *
 * @param client - A connected `SoroStreamClient` instance (or null).
 * @returns `{ withdraw, loading, error, txResult }`
 *
 * @example
 * ```tsx
 * const { withdraw, loading, error, txResult } = useWithdraw(client);
 *
 * return (
 *   <button disabled={loading} onClick={() => withdraw("42").catch(() => {})}>
 *     {loading ? "Withdrawing…" : "Withdraw"}
 *   </button>
 * );
 * ```
 */
export function useWithdraw(client: SoroStreamClient | null): UseWithdrawResult {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [txResult, setTxResult] = useState<{ txHash: string; amount: string } | null>(null);

  const withdraw = useCallback(
    async (
      streamIdOrParams: string | WithdrawParams,
    ): Promise<{ txHash: string; amount: string }> => {
      if (!client) {
        const err = new Error('useWithdraw: no SoroStream client provided');
        setError(err);
        throw err;
      }

      const params: WithdrawParams =
        typeof streamIdOrParams === 'string' ? { streamId: streamIdOrParams } : streamIdOrParams;

      setLoading(true);
      setError(null);

      try {
        const result = await client.withdraw(params);
        setTxResult(result);
        return result;
      } catch (err) {
        const wrapped = err instanceof Error ? err : new Error(String(err));
        setError(wrapped);
        throw wrapped;
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  return { withdraw, loading, error, txResult };
}
