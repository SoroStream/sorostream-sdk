import { ref, shallowRef, toValue, watch, getCurrentScope, onScopeDispose } from 'vue';
import type { Stream } from '@sorostream/sdk';
import type {
  MaybeRefOrGetterLike,
  StreamReaderLike,
  UseStreamOptions,
  UseStreamReturn,
} from './types.js';

/**
 * Vue 3 composable that reactively binds to a single stream (issue #422).
 *
 * The stream is fetched when the composable is set up and, by default, kept up
 * to date through the SDK's RxJS-compatible `observeStream()` observable
 * (issue #423) — so every component observing the same stream shares one poll
 * loop instead of starting its own. The subscription is torn down automatically
 * when the component (or surrounding effect scope) is disposed, and restarted
 * whenever `client` or `streamId` changes.
 *
 * @param client - The SoroStream client (value, `ref`, or getter). `null`
 *   resets the state, which makes wallet-gated screens straightforward.
 * @param streamId - The stream to bind to (value, `ref`, or getter).
 * @param options - Polling interval and fetch behaviour.
 * @returns Reactive `{ stream, loading, error, refresh }`.
 *
 * @example
 * ```vue
 * <script setup lang="ts">
 * import { useStream } from "@sorostream/vue";
 * const props = defineProps<{ streamId: string }>();
 * const { stream, loading, error, refresh } = useStream(client, () => props.streamId);
 * </script>
 *
 * <template>
 *   <p v-if="loading">Loading…</p>
 *   <p v-else-if="error">{{ error.message }}</p>
 *   <p v-else-if="stream">{{ stream.status }} — {{ stream.deposit }}</p>
 *   <button @click="refresh">Reload</button>
 * </template>
 * ```
 */
export function useStream(
  client: MaybeRefOrGetterLike<StreamReaderLike | null | undefined>,
  streamId: MaybeRefOrGetterLike<string | null | undefined>,
  options: UseStreamOptions = {},
): UseStreamReturn {
  const { intervalMs = 5_000, live = true, immediate = true } = options;

  const stream = shallowRef<Stream | null>(null);
  const loading = ref(false);
  const error = ref<Error | null>(null);

  let teardown: (() => void) | null = null;
  // `startToken` changes whenever the inputs change (invalidating a live
  // subscription); `fetchToken` guards out-of-order `refresh()` results.
  let startToken = 0;
  let fetchToken = 0;

  const toError = (value: unknown): Error =>
    value instanceof Error ? value : new Error(String(value));

  const stop = (): void => {
    teardown?.();
    teardown = null;
  };

  const fetchOnce = async (refresh: boolean): Promise<void> => {
    const activeClient = toValue(client);
    const activeId = toValue(streamId);
    if (!activeClient || !activeId) {
      stream.value = null;
      loading.value = false;
      error.value = null;
      return;
    }

    const fetchAt = ++fetchToken;
    const startedAt = startToken;
    loading.value = true;
    error.value = null;
    const isStale = (): boolean => fetchAt !== fetchToken || startedAt !== startToken;
    try {
      const result = await activeClient.getStream(activeId, { refresh });
      if (isStale()) return;
      stream.value = result;
    } catch (err) {
      if (isStale()) return;
      error.value = toError(err);
      stream.value = null;
    } finally {
      if (!isStale()) loading.value = false;
    }
  };

  const start = (): void => {
    stop();

    const activeClient = toValue(client);
    const activeId = toValue(streamId);

    // Bump the token so pending work from a previous input can't overwrite the
    // state we are about to establish.
    const current = ++startToken;
    fetchToken++;

    if (!activeClient || !activeId) {
      stream.value = null;
      loading.value = false;
      error.value = null;
      return;
    }

    if (!live || typeof activeClient.observeStream !== 'function') {
      void fetchOnce(false);
      return;
    }

    loading.value = true;
    error.value = null;

    const subscription = activeClient.observeStream(activeId, { intervalMs }).subscribe({
      next: (value: Stream) => {
        if (current !== startToken) return;
        stream.value = value;
        loading.value = false;
        error.value = null;
      },
      error: (err: unknown) => {
        if (current !== startToken) return;
        error.value = toError(err);
        stream.value = null;
        loading.value = false;
      },
      complete: () => {
        if (current !== startToken) return;
        loading.value = false;
      },
    });

    teardown = () => subscription.unsubscribe();
  };

  watch(
    [() => toValue(client), () => toValue(streamId)],
    () => {
      if (immediate) start();
    },
    { immediate: true },
  );

  if (getCurrentScope()) onScopeDispose(stop);

  return {
    stream,
    loading,
    error,
    refresh: () => fetchOnce(true),
  };
}
