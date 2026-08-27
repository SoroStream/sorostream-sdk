import { ref, shallowRef, toValue, watch, getCurrentScope, onScopeDispose } from 'vue';
import type { Stream } from '@sorostream/sdk';
import type {
  MaybeRefOrGetterLike,
  StreamListSource,
  StreamReaderLike,
  UseStreamListOptions,
  UseStreamListReturn,
} from './types.js';

function unwrapStreams(
  result: Stream[] | { streams: Stream[]; cursor: string | null; hasMore: boolean },
): Stream[] {
  return Array.isArray(result) ? result : result.streams;
}

/**
 * Vue 3 composable that reactively binds to a list of streams (issue #422).
 *
 * The source can be explicit stream IDs, a sender address, or a recipient
 * address, and may be reactive (a `ref` or getter) so the list reloads whenever
 * the selection changes.
 *
 * When the source is `{ ids }` and the client exposes the batch reader added in
 * issue #427, every ID is fetched in **one** RPC call instead of one call per
 * row — which is what makes stream tables cheap to render.
 *
 * @param client - The SoroStream client (value, `ref`, or getter).
 * @param source - `{ ids }`, `{ sender }`, or `{ recipient }` (value, `ref`, or getter).
 * @param options - Poll interval, filter, and fetch behaviour.
 * @returns Reactive `{ streams, loading, error, refresh }`.
 *
 * @example
 * ```vue
 * <script setup lang="ts">
 * import { useStreamList } from "@sorostream/vue";
 *
 * // One RPC call for the whole table (issue #427)
 * const { streams, loading } = useStreamList(client, { ids: ["1", "2", "3"] });
 *
 * // Or everything a recipient can claim, refreshed every 10s
 * const inbox = useStreamList(client, () => ({ recipient: address.value }), {
 *   intervalMs: 10_000,
 *   filter: { activeOnly: true },
 * });
 * </script>
 * ```
 */
export function useStreamList(
  client: MaybeRefOrGetterLike<StreamReaderLike | null | undefined>,
  source: MaybeRefOrGetterLike<StreamListSource | null | undefined>,
  options: UseStreamListOptions = {},
): UseStreamListReturn {
  const { intervalMs = 0, immediate = true, filter } = options;

  const streams = shallowRef<Stream[]>([]);
  const loading = ref(false);
  const error = ref<Error | null>(null);

  let timer: ReturnType<typeof setInterval> | null = null;
  let token = 0;

  const toError = (value: unknown): Error =>
    value instanceof Error ? value : new Error(String(value));

  const stopPolling = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const load = async (): Promise<void> => {
    const activeClient = toValue(client);
    const activeSource = toValue(source);

    if (!activeClient || !activeSource) {
      streams.value = [];
      loading.value = false;
      error.value = null;
      return;
    }

    const current = ++token;
    loading.value = true;
    error.value = null;

    try {
      let result: Stream[];

      if (activeSource.ids !== undefined) {
        const ids = activeSource.ids;
        if (ids.length === 0) {
          result = [];
        } else if (typeof activeClient.getStreams === 'function') {
          // Issue #427: a single batched RPC call for the whole list.
          result = await activeClient.getStreams(ids);
        } else {
          const settled = await Promise.all(ids.map((id) => activeClient.getStream(id)));
          result = settled;
        }
      } else if (activeSource.sender !== undefined) {
        if (typeof activeClient.getStreamsBySender !== 'function') {
          throw new Error('useStreamList: client does not support getStreamsBySender()');
        }
        result = unwrapStreams(await activeClient.getStreamsBySender(activeSource.sender));
      } else {
        if (typeof activeClient.getStreamsByRecipient !== 'function') {
          throw new Error('useStreamList: client does not support getStreamsByRecipient()');
        }
        result = unwrapStreams(
          await activeClient.getStreamsByRecipient(activeSource.recipient, undefined, filter),
        );
      }

      if (current !== token) return;
      streams.value = result;
    } catch (err) {
      if (current !== token) return;
      error.value = toError(err);
      streams.value = [];
    } finally {
      if (current === token) loading.value = false;
    }
  };

  const restart = (): void => {
    stopPolling();
    void load();
    if (intervalMs > 0) {
      timer = setInterval(() => void load(), intervalMs);
      // Never keep a Node process (SSR, tests) alive because of a poll loop.
      (timer as unknown as { unref?: () => void }).unref?.();
    }
  };

  watch(
    [() => toValue(client), () => toValue(source)],
    () => {
      if (immediate) restart();
    },
    { immediate: true, deep: true },
  );

  if (getCurrentScope()) onScopeDispose(stopPolling);

  return {
    streams,
    loading,
    error,
    refresh: load,
  };
}
