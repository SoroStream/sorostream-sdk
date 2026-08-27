import { useState, useEffect } from 'react';
import type { SoroStreamClient } from '@sorostream/sdk';

interface UseClaimableResult {
  claimable: bigint | null;
  loading: boolean;
  error: Error | null;
}

/**
 * React hook for fetching the claimable amount of a stream.
 * Polls every `pollInterval` milliseconds (defaults to 30_000).
 *
 * @param client - A connected `SoroStreamClient` instance.
 * @param streamId - The stream ID to check.
 * @param pollInterval - Polling interval in ms (default 30_000).
 */
export function useClaimable(
  client: SoroStreamClient | null,
  streamId: string | null,
  pollInterval: number = 30_000,
): UseClaimableResult {
  const [claimable, setClaimable] = useState<bigint | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!client || !streamId) {
      setClaimable(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout>;
    const activeClient = client;
    const activeStreamId = streamId;

    async function fetchClaimable() {
      setLoading(true);
      setError(null);
      try {
        const result = await activeClient.getClaimable(activeStreamId);
        if (!cancelled) {
          setClaimable(result);
          setLoading(false);
          timeoutId = setTimeout(fetchClaimable, pollInterval);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
          timeoutId = setTimeout(fetchClaimable, pollInterval);
        }
      }
    }

    fetchClaimable();

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [client, streamId, pollInterval]);

  return { claimable, loading, error };
}
