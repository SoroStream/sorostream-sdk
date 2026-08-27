// ── Issue #337: Automatic transaction fee bump ───────────────────────────────

/**
 * Schedules a background monitor that checks whether a submitted transaction
 * has been included before its TTL expiry. If the transaction is not yet
 * included when `expiryThreshold` fraction of the TTL has elapsed, the
 * monitor calls the `onExpiryApproaching` callback so the caller can
 * resubmit with a higher fee.
 *
 * @param txHash - The hash of the submitted transaction to monitor.
 * @param ttlSeconds - The transaction's time-to-live in seconds (e.g. 30).
 * @param expiryThreshold - Fraction of TTL after which to trigger (default 0.8).
 * @param checkInclusion - Async function that resolves `true` if the tx is confirmed.
 * @param onExpiryApproaching - Called when expiry is approaching and tx is not yet included.
 * @returns A function to cancel the monitor (clears the timer).
 */
export function scheduleFeeBumpMonitor(
  txHash: string,
  ttlSeconds: number,
  expiryThreshold: number,
  checkInclusion: (txHash: string) => Promise<boolean>,
  onExpiryApproaching: (txHash: string) => void,
): () => void {
  const thresholdMs = ttlSeconds * 1000 * expiryThreshold;

  const timer = setTimeout(async () => {
    try {
      const isIncluded = await checkInclusion(txHash);
      if (!isIncluded) {
        onExpiryApproaching(txHash);
      }
    } catch {
      // If the check fails (network error), still trigger the callback
      // since we can't confirm the transaction was included.
      onExpiryApproaching(txHash);
    }
  }, thresholdMs);
  (timer as { unref?: () => void }).unref?.();

  return () => clearTimeout(timer);
}
