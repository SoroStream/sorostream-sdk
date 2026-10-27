import { rpc } from '@stellar/stellar-sdk';

type LedgerProvider = { getLatestLedger(): Promise<rpc.Api.GetLatestLedgerResponse> };

/** Default relative jitter bound (±20% of `pollIntervalMs`). */
const DEFAULT_JITTER_RATIO = 0.2;

/** Maximum allowed relative jitter ratio (50% of `pollIntervalMs`). */
const MAX_JITTER_RATIO = 0.5;

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
   * Relative jitter bound applied to `pollIntervalMs` (`0` to `0.5`).
   * Each poll delay is sampled uniformly from
   * `[pollIntervalMs * (1 - jitterRatio), pollIntervalMs * (1 + jitterRatio)]`
   * and capped at the remaining time before `timeoutMs`.
   * Defaults to `0.2` (±20%).
   */
  jitterRatio?: number;
  /**
   * Optional random number generator returning values in `[0, 1)`.
   * Defaults to `Math.random`.
   */
  random?: () => number;
  /**
   * Optional `AbortSignal` that cancels the wait early.
   */
  signal?: AbortSignal;
}

function abortError(): DOMException {
  return new DOMException('waitForLedger aborted', 'AbortError');
}

function computeJitteredDelayMs(
  pollIntervalMs: number,
  jitterRatio: number,
  random: () => number,
): number {
  if (pollIntervalMs <= 0 || jitterRatio <= 0) {
    return Math.max(0, pollIntervalMs);
  }
  const boundedRatio = Math.min(Math.max(jitterRatio, 0), MAX_JITTER_RATIO);
  const sample = Math.min(Math.max(random(), 0), 1);
  const offset = (sample * 2 - 1) * (pollIntervalMs * boundedRatio);
  return Math.max(1, Math.round(pollIntervalMs + offset));
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
  const jitterRatio = options.jitterRatio ?? DEFAULT_JITTER_RATIO;
  const random = options.random ?? Math.random;
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

    const jitteredIntervalMs = computeJitteredDelayMs(pollIntervalMs, jitterRatio, random);
    const delayMs = Math.min(jitteredIntervalMs, remaining);

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
      timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, delayMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }
}
