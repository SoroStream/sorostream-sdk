import { useState, useCallback } from 'react';
import type { SoroStreamClient, CreateStreamParams } from '@sorostream/sdk';

interface UseCreateStreamResult {
  createStream: (params: CreateStreamParams) => Promise<{ streamId: string; txHash: string }>;
  loading: boolean;
  error: Error | null;
  data: { streamId: string; txHash: string } | null;
}

/**
 * React hook for creating a SoroStream.
 *
 * @param client - A connected `SoroStreamClient` instance.
 */
export function useCreateStream(client: SoroStreamClient | null): UseCreateStreamResult {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [data, setData] = useState<{
    streamId: string;
    txHash: string;
  } | null>(null);

  const createStream = useCallback(
    async (params: CreateStreamParams) => {
      if (!client) throw new Error('SoroStreamClient not provided');

      setLoading(true);
      setError(null);
      setData(null);

      try {
        const result = await client.createStream(params);
        setData(result);
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

  return { createStream, loading, error, data };
}
