import { ref, toValue } from 'vue';
import type { CreateStreamParams, CreateStreamDryRunResult } from '@sorostream/sdk';
import type { MaybeRefOrGetterLike } from './types.js';

/** Minimal create surface required by {@link useCreateStream}. */
export interface CreateStreamClientLike {
  createStream(
    params: CreateStreamParams,
  ): Promise<{ streamId: string; txHash: string } | CreateStreamDryRunResult>;
}

/** Reactive state returned by {@link useCreateStream}. */
export interface UseCreateStreamReturn {
  /** Validates params client-side, then submits the stream-creation transaction. */
  create: (
    params: CreateStreamParams,
  ) => Promise<{ streamId: string; txHash: string } | CreateStreamDryRunResult>;
  /** `true` while the transaction is in flight. */
  loading: ReturnType<typeof ref<boolean>>;
  /** The last error, or `null`. */
  error: ReturnType<typeof ref<Error | null>>;
  /** Result of the last successful call, or `null`. */
  txResult: ReturnType<
    typeof ref<{ streamId: string; txHash: string } | CreateStreamDryRunResult | null>
  >;
  /** Clears `error` and `txResult` so the composable can be re-used after a failure. */
  reset: () => void;
}

/**
 * Validates a {@link CreateStreamParams} object client-side before submission.
 *
 * Throws a descriptive {@link Error} for any missing or invalid field so the
 * caller can surface the problem without issuing a doomed on-chain transaction.
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
 * Vue 3 composable for creating a SoroStream (mirrors the React `useCreateStream` hook, issue #765).
 *
 * Validates params client-side before submitting, tracks loading state from
 * call initiation until confirmation, and exposes the resulting
 * `{ streamId, txHash }` in `txResult`. `reset()` clears `error` and
 * `txResult` so the composable can be re-used after a failure.
 *
 * @param client - A connected client (value, `ref`, or getter). `null` causes `create()` to throw.
 * @returns Reactive `{ create, loading, error, txResult, reset }`.
 *
 * @example
 * ```vue
 * <script setup lang="ts">
 * import { useCreateStream } from "@sorostream/vue";
 * const { create, loading, error, txResult, reset } = useCreateStream(client);
 * </script>
 *
 * <template>
 *   <button :disabled="loading" @click="create(params).catch(() => {})">
 *     {{ loading ? 'Creating…' : 'Create stream' }}
 *   </button>
 *   <p v-if="txResult">Stream {{ txResult.streamId }} created.</p>
 *   <p v-if="error">{{ error.message }}</p>
 * </template>
 * ```
 */
export function useCreateStream(
  client: MaybeRefOrGetterLike<CreateStreamClientLike | null | undefined>,
): UseCreateStreamReturn {
  const loading = ref(false);
  const error = ref<Error | null>(null);
  const txResult = ref<{ streamId: string; txHash: string } | CreateStreamDryRunResult | null>(
    null,
  );

  const reset = (): void => {
    error.value = null;
    txResult.value = null;
  };

  const create = async (
    params: CreateStreamParams,
  ): Promise<{ streamId: string; txHash: string } | CreateStreamDryRunResult> => {
    const activeClient = toValue(client);
    if (!activeClient) {
      const err = new Error('useCreateStream: no SoroStream client provided');
      error.value = err;
      throw err;
    }

    try {
      // Client-side validation runs before any on-chain submission.
      validateCreateStreamParams(params);

      loading.value = true;
      error.value = null;
      txResult.value = null;

      const result = await activeClient.createStream(params);
      txResult.value = result;
      return result;
    } catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      error.value = wrapped;
      throw wrapped;
    } finally {
      loading.value = false;
    }
  };

  return { create, loading, error, txResult, reset };
}
