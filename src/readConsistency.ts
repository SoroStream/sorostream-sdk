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
      throw new DOMException('waitForLedger aborted', 'AbortError');
    }

    const latest = await server.getLatestLedger();
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
      const timer = setTimeout(resolve, Math.min(pollIntervalMs, remaining));
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new DOMException('waitForLedger aborted', 'AbortError'));
        },
        { once: true },
      );
    });
  }
}
