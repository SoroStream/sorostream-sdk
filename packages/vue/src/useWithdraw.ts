import { ref, toValue } from 'vue';
import type { WithdrawParams } from '@sorostream/sdk';
import type { MaybeRefOrGetterLike, UseWithdrawReturn, WithdrawClientLike } from './types.js';

/**
 * Vue 3 composable for withdrawing claimable funds from a stream (issue #422).
 *
 * Tracks submission state so a button can be disabled while the transaction is
 * in flight, and exposes the resulting transaction hash and amount. Errors are
 * both captured in `error` and re-thrown, so `try`/`catch` and template-driven
 * error display both work.
 *
 * @param client - The SoroStream client (value, `ref`, or getter).
 * @returns Reactive `{ withdraw, submitting, error, txHash, amount, reset }`.
 *
 * @example
 * ```vue
 * <script setup lang="ts">
 * import { useWithdraw } from "@sorostream/vue";
 * const { withdraw, submitting, error, txHash } = useWithdraw(client);
 * </script>
 *
 * <template>
 *   <button :disabled="submitting" @click="withdraw('42').catch(() => {})">
 *     {{ submitting ? "Withdrawing…" : "Withdraw" }}
 *   </button>
 *   <p v-if="txHash">Sent: {{ txHash }}</p>
 *   <p v-if="error">{{ error.message }}</p>
 * </template>
 * ```
 */
export function useWithdraw(
  client: MaybeRefOrGetterLike<WithdrawClientLike | null | undefined>,
): UseWithdrawReturn {
  const submitting = ref(false);
  const error = ref<Error | null>(null);
  const txHash = ref<string | null>(null);
  const amount = ref<string | null>(null);

  const reset = (): void => {
    error.value = null;
    txHash.value = null;
    amount.value = null;
  };

  const withdraw = async (
    streamIdOrParams: string | WithdrawParams,
  ): Promise<{ txHash: string; amount: string }> => {
    const activeClient = toValue(client);
    if (!activeClient) {
      const err = new Error('useWithdraw: no SoroStream client provided');
      error.value = err;
      throw err;
    }

    const params: WithdrawParams =
      typeof streamIdOrParams === 'string' ? { streamId: streamIdOrParams } : streamIdOrParams;

    submitting.value = true;
    error.value = null;
    try {
      const result = await activeClient.withdraw(params);
      txHash.value = result.txHash;
      amount.value = result.amount;
      return result;
    } catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      error.value = wrapped;
      throw wrapped;
    } finally {
      submitting.value = false;
    }
  };

  return { withdraw, submitting, error, txHash, amount, reset };
}
