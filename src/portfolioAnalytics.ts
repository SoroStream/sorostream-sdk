// ── Issue #336: Portfolio analytics ──────────────────────────────────────────

import type { Stream, PortfolioStats } from './types.js';
import { claimableNow, isExpired } from './utils.js';

/** Number of seconds in a month (30 days) for monthly outflow/inflow calcs. */
const SECONDS_PER_MONTH = 30 * 24 * 60 * 60;

/**
 * Returns `true` when the stream is non-cancelled, non-completed, and
 * not yet expired.
 */
function isActiveNonExpired(s: Stream): boolean {
  if (s.status === 'Cancelled' || s.status === 'Completed') return false;
  return !isExpired(s);
}

/**
 * Aggregates portfolio-level statistics for all streams belonging to the
 * given address.
 *
 * @param address - The Stellar address to query.
 * @param getStreamsBySender - Async function returning all streams sent by `address`.
 * @param getStreamsByRecipient - Async function returning all streams received by `address`.
 * @returns `PortfolioStats` with counts and monetary aggregates.
 */
export async function getPortfolioStats(
  address: string,
  getStreamsBySender: (sender: string) => Promise<Stream[]>,
  getStreamsByRecipient: (recipient: string) => Promise<Stream[]>,
): Promise<PortfolioStats> {
  const [sent, received] = await Promise.all([
    getStreamsBySender(address),
    getStreamsByRecipient(address),
  ]);

  const activeSent = sent.filter(isActiveNonExpired);
  const activeReceived = received.filter(isActiveNonExpired);

  // Total claimable across active received streams
  let totalClaimable = 0n;
  for (const s of activeReceived) {
    totalClaimable += claimableNow(s);
  }

  // Monthly outflow = sum over active sent streams of (flowRate * 30 days)
  let totalMonthlyOutflow = 0n;
  for (const s of activeSent) {
    totalMonthlyOutflow += s.flowRate * BigInt(SECONDS_PER_MONTH);
  }

  // Monthly inflow = sum over active received streams of (flowRate * 30 days)
  let totalMonthlyInflow = 0n;
  for (const s of activeReceived) {
    totalMonthlyInflow += s.flowRate * BigInt(SECONDS_PER_MONTH);
  }

  return {
    activeSentCount: activeSent.length,
    activeReceivedCount: activeReceived.length,
    totalClaimable,
    totalMonthlyOutflow,
    totalMonthlyInflow,
  };
}
