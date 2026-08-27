import { useState, useEffect } from 'react';
import type { SoroStreamClient, Stream } from '@sorostream/sdk';

interface UseStreamResult {
  stream: Stream | null;
  loading: boolean;
  error: Error | null;
}

/**
 * React hook for fetching a SoroStream by ID.
 * Automatically re-fetches on mount and when `streamId` changes.
 *
 * @param client - A connected `SoroStreamClient` instance.
 * @param streamId - The stream ID to fetch.
 */
export function useStream(
  client: SoroStreamClient | null,
  streamId: string | null,
): UseStreamResult {
  const [stream, setStream] = useState<Stream | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!client || !streamId) {
      setStream(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    const activeClient = client;
    const activeStreamId = streamId;

    async function fetchStream() {
      setLoading(true);
      setError(null);
      try {
        const result = await activeClient.getStream(activeStreamId);
        if (!cancelled) {
          setStream(result);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        }
      }
    }

    fetchStream();

    return () => {
      cancelled = true;
    };
  }, [client, streamId]);

  return { stream, loading, error };
}
