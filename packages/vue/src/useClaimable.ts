import { ref, toValue, watch, getCurrentScope, onScopeDispose } from 'vue';
import type { MaybeRefOrGetterLike } from './types.js';

/** Minimal surface required by {@link useClaimable}. */
export interface ClaimableClientLike {
  getClaimable(streamId: string): Promise<bigint>;
}

/** Reactive state returned by {@link useClaimable}. */
export interface UseClaimableReturn {
  /** The current claimable amount, or `null` while loading or unavailable. */
  claimable: ReturnType<typeof ref<bigint | null>>;
  /** `true` while a fetch is in flight. */
  loading: ReturnType<typeof ref<boolean>>;
  /** The last error, or `null`. */
  error: ReturnType<typeof ref<Error | null>>;
}

/**
 * Vue 3 composable for polling the claimable balance of a stream
 * (mirrors the React `useClaimable` hook, issue #765).
 *
 * Fetches immediately and re-polls every `pollInterval` milliseconds
 * (default: 30 000). The poll loop is torn down automatically when the
 * surrounding component or effect scope is disposed, and restarted
 * whenever `client` or `streamId` changes.
 *
 * @param client - The SoroStream client (value, `ref`, or getter). `null` resets state.
 * @param streamId - The stream to poll (value, `ref`, or getter). `null` resets state.
 * @param pollInterval - Polling interval in ms (default: `30_000`).
 * @returns Reactive `{ claimable, loading, error }`.
 *
 * @example
 * ```vue
 * <script setup lang="ts">
 * import { useClaimable } from "@sorostream/vue";
 * const props = defineProps<{ streamId: string }>();
 * const { claimable, loading, error } = useClaimable(client, () => props.streamId);
 * </script>
 *
 * <template>
 *   <p v-if="loading">Loading…</p>
 *   <p v-else-if="error">{{ error.message }}</p>
 *   <p v-else>Claimable: {{ claimable }}</p>
 * </template>
 * ```
 */
export function useClaimable(
  client: MaybeRefOrGetterLike<ClaimableClientLike | null | undefined>,
  streamId: MaybeRefOrGetterLike<string | null | undefined>,
  pollInterval: number = 30_000,
): UseClaimableReturn {
  const claimable = ref<bigint | null>(null);
  const loading = ref(false);
  const error = ref<Error | null>(null);

  let cancelled = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = (): void => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  const stop = (): void => {
    cancelled = true;
    clearTimer();
  };

  async function fetchClaimable(): Promise<void> {
    const activeClient = toValue(client);
    const activeId = toValue(streamId);

    if (!activeClient || !activeId) {
      claimable.value = null;
      loading.value = false;
      error.value = null;
      return;
    }

    loading.value = true;
    error.value = null;

    try {
      const result = await activeClient.getClaimable(activeId);
      if (cancelled) return;
      claimable.value = result;
      error.value = null;
    } catch (err) {
      if (cancelled) return;
      error.value = err instanceof Error ? err : new Error(String(err));
    } finally {
      if (!cancelled) {
        loading.value = false;
        clearTimer();
        timeoutId = setTimeout(() => void fetchClaimable(), pollInterval);
        // Avoid keeping a Node/SSR process alive from the poll loop.
        (timeoutId as unknown as { unref?: () => void }).unref?.();
      }
    }
  }

  watch(
    [() => toValue(client), () => toValue(streamId)],
    () => {
      stop();
      cancelled = false;
      void fetchClaimable();
    },
    { immediate: true },
  );

  if (getCurrentScope()) onScopeDispose(stop);

  return { claimable, loading, error };
}
