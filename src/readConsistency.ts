import { rpc } from '@stellar/stellar-sdk';

type LedgerProvider = { getLatestLedger(): Promise<rpc.Api.GetLatestLedgerResponse> };

/**
 * Options for {@link waitForLedger}.
 */
export interface WaitForLedgerOptions {
  /**
   * Maximum time in milliseconds to wait for the target ledger to appear.
   * Defaults to 10 000 ms (10 seconds).
   */
  timeoutMs?: number;
  /**
   * Polling interval in milliseconds between ledger-sequence checks.
   * Defaults to 500 ms.
   */
  pollIntervalMs?: number;
  /**
   * Optional `AbortSignal` that cancels the wait early.
   */
  signal?: AbortSignal;
}

/**
 * Fraction of `pollIntervalMs` used as the maximum random jitter applied to
 * each polling delay in {@link waitForLedger}. The actual delay is
 * `pollIntervalMs` plus a random offset in
 * `[-POLL_JITTER_RATIO * pollIntervalMs, +POLL_JITTER_RATIO * pollIntervalMs]`,
 * clamped to be non-negative. This keeps the jitter bounded (default 15%) so
 * detection is not meaningfully delayed while de-synchronizing pollers.
 */
export const POLL_JITTER_RATIO = 0.15;

function abortError(): DOMException {
  return new DOMException('waitForLedger aborted', 'AbortError');
}

/**
 * Computes the next polling delay: `pollIntervalMs` plus bounded random jitter
 * of up to {@link POLL_JITTER_RATIO} of the interval, clamped to `>= 0`.
 */
function jitteredDelay(pollIntervalMs: number): number {
  const maxJitter = pollIntervalMs * POLL_JITTER_RATIO;
  const offset = (Math.random() * 2 - 1) * maxJitter;
  return Math.max(0, pollIntervalMs + offset);
}

function getLatestLedger(
  server: LedgerProvider,
  signal?: AbortSignal,
): Promise<rpc.Api.GetLatestLedgerResponse> {
  if (!signal) return server.getLatestLedger();
  if (signal.aborted) return Promise.reject(abortError());

  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    server.getLatestLedger().then(
      (ledger) => {
        cleanup();
        resolve(ledger);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/**
 * Waits until the given Soroban RPC server reports a ledger whose sequence
 * number is **at or above** `targetSequence`.
 *
 * This is the building block for read-your-own-writes (RYOW) consistency: after
 * a write mutation returns a confirmed ledger sequence, call `waitForLedger`
 * before issuing a read so you are guaranteed to query a node that has already
 * applied the mutation's ledger.
 *
 * @param server          - A Soroban `rpc.Server` instance.
 * @param targetSequence  - The minimum ledger sequence to wait for.
 * @param options         - Optional timeout/poll/abort configuration.
 *
 * @throws {Error} When `timeoutMs` elapses before the ledger is observed.
 * @throws {DOMException} With name `"AbortError"` when `signal` is aborted.
 *
 * @example
 * ```ts
 * import { waitForLedger } from "@sorostream/sdk";
 *
 * // After a write, wait for the confirmed ledger before reading:
 * const { txHash, ledger } = await client.createStream(...);
 * await waitForLedger(server, ledger);
 * const stream = await client.getStream(streamId);
 * ```
 */
export async function waitForLedger(
  server: LedgerProvider,
  targetSequence: number,
  options: WaitForLedgerOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const signal = options.signal;

  const deadline = Date.now() + timeoutMs;

  while (true) {
    if (signal?.aborted) {
      throw abortError();
    }

    const latest = await getLatestLedger(server, signal);
    if (signal?.aborted) throw abortError();
    if (latest.sequence >= targetSequence) {
      return;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `waitForLedger: timed out after ${timeoutMs}ms waiting for ledger ${targetSequence} ` +
          `(current: ${latest.sequence})`,
      );
    }

    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(abortError());
      };
      timer = setTimeout(
        () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
        Math.min(jitteredDelay(pollIntervalMs), remaining),
      );
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }
}
