import { useState, useCallback } from 'react';
import type { SoroStreamClient, WithdrawParams } from '@sorostream/sdk';

export interface UseWithdrawResult {
  withdraw: (
    streamIdOrParams: string | WithdrawParams,
  ) => Promise<{ txHash: string; amount: string }>;
  submitting: boolean;
  error: Error | null;
  txHash: string | null;
  amount: string | null;
  reset: () => void;
}

/**
 * React hook for withdrawing claimable funds from a SoroStream.
 *
 * Tracks submission state so buttons can be disabled while the transaction
 * is in flight. Errors are both captured in `error` and re-thrown so both
 * `try`/`catch` patterns and state-driven error display work.
 *
 * @param client - A connected `SoroStreamClient` instance (or null).
 * @returns `{ withdraw, submitting, error, txHash, amount, reset }`
 *
 * @example
 * ```tsx
 * const { withdraw, submitting, error, txHash } = useWithdraw(client);
 *
 * return (
 *   <button disabled={submitting} onClick={() => withdraw("42").catch(() => {})}>
 *     {submitting ? "Withdrawing…" : "Withdraw"}
 *   </button>
 * );
 * ```
 */
export function useWithdraw(client: SoroStreamClient | null): UseWithdrawResult {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [amount, setAmount] = useState<string | null>(null);

  const reset = useCallback(() => {
    setError(null);
    setTxHash(null);
    setAmount(null);
  }, []);

  const withdraw = useCallback(
    async (
      streamIdOrParams: string | WithdrawParams,
    ): Promise<{ txHash: string; amount: string }> => {
      if (!client) {
        const err = new Error('useWithdraw: no SoroStreamClient provided');
        setError(err);
        throw err;
      }

      const params: WithdrawParams =
        typeof streamIdOrParams === 'string' ? { streamId: streamIdOrParams } : streamIdOrParams;

      setSubmitting(true);
      setError(null);

      try {
        const result = await client.withdraw(params);
        setTxHash(result.txHash);
        setAmount(result.amount);
        return result;
      } catch (err) {
        const wrapped = err instanceof Error ? err : new Error(String(err));
        setError(wrapped);
        throw wrapped;
      } finally {
        setSubmitting(false);
      }
    },
    [client],
  );

  return { withdraw, submitting, error, txHash, amount, reset };
}
