import { useState, useEffect, useCallback, useRef } from 'react';
import type { SoroStreamClient, Stream, StreamFilterCriteria } from '@sorostream/sdk';

/** How to specify which streams to load. */
export type StreamListSource = { ids: string[] } | { sender: string } | { recipient: string };

export interface UseStreamListOptions {
  /** Poll interval in milliseconds. Set to 0 to disable polling. Default: 0. */
  intervalMs?: number;
  /** Optional filter criteria applied when fetching by sender or recipient. */
  filter?: StreamFilterCriteria;
}

export interface UseStreamListResult {
  streams: Stream[];
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

function unwrapStreams(
  result: Stream[] | { streams: Stream[]; cursor: string | null; hasMore: boolean },
): Stream[] {
  return Array.isArray(result) ? result : result.streams;
}

/**
 * React hook for fetching a list of SoroStreams.
 *
 * The source can be a list of stream IDs, a sender address, or a recipient
 * address. Optionally polls on an interval.
 *
 * @param client - A connected `SoroStreamClient` instance (or null).
 * @param source - `{ ids }`, `{ sender }`, or `{ recipient }` specifying which streams to load.
 * @param options - Poll interval and optional filter criteria.
 * @returns `{ streams, loading, error, refetch }`
 *
 * @example
 * ```tsx
 * const { streams, loading } = useStreamList(client, { ids: ["1", "2", "3"] });
 *
 * // Or: refresh every 10 seconds
 * const { streams } = useStreamList(
 *   client,
 *   { recipient: "GABCD..." },
 *   { intervalMs: 10_000 },
 * );
 * ```
 */
export function useStreamList(
  client: SoroStreamClient | null,
  source: StreamListSource | null,
  options: UseStreamListOptions = {},
): UseStreamListResult {
  const { intervalMs = 0, filter } = options;

  const [streams, setStreams] = useState<Stream[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Use refs for values that should not re-trigger the effect but are used inside it
  const filterRef = useRef(filter);
  filterRef.current = filter;

  // Stable serialized key to detect source identity changes
  const sourceKey = source == null ? 'null' : JSON.stringify(source);

  const fetchStreams = useCallback(
    async (
      activeClient: SoroStreamClient,
      activeSource: StreamListSource,
      signal: AbortSignal,
    ): Promise<void> => {
      setLoading(true);
      setError(null);

      try {
        let result: Stream[];
        const currentFilter = filterRef.current;

        if ('ids' in activeSource) {
          const { ids } = activeSource;
          if (ids.length === 0) {
            result = [];
          } else if (typeof (activeClient as any).getStreams === 'function') {
            // Batch fetch if available (issue #427)
            result = await (activeClient as any).getStreams(ids);
          } else {
            const settled = await Promise.all(ids.map((id) => activeClient.getStream(id)));
            result = settled;
          }
        } else if ('sender' in activeSource) {
          result = unwrapStreams(await activeClient.getStreamsBySender(activeSource.sender));
        } else {
          result = unwrapStreams(
            await activeClient.getStreamsByRecipient(
              activeSource.recipient,
              undefined,
              currentFilter,
            ),
          );
        }

        if (!signal.aborted) {
          setStreams(result);
          setLoading(false);
        }
      } catch (err) {
        if (!signal.aborted) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setStreams([]);
          setLoading(false);
        }
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [],
  );

  // Track fetch trigger count for manual refetch support
  const [fetchTick, setFetchTick] = useState(0);

  const refetch = useCallback(() => {
    setFetchTick((t) => t + 1);
  }, []);

  useEffect(() => {
    if (!client || !source) {
      setStreams([]);
      setLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;

    // Initial fetch
    void fetchStreams(client, source, signal);

    let timerId: ReturnType<typeof setInterval> | null = null;
    if (intervalMs > 0) {
      timerId = setInterval(() => {
        void fetchStreams(client, source, signal);
      }, intervalMs);
    }

    return () => {
      controller.abort();
      if (timerId !== null) clearInterval(timerId);
    };
    // sourceKey is the stable serialized representation of `source`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, sourceKey, intervalMs, fetchStreams, fetchTick]);

  return { streams, loading, error, refetch };
}
