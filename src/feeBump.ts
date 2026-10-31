// ── Issue #337: Automatic transaction fee bump ───────────────────────────────

import { Networks, TransactionBuilder } from '@stellar/stellar-sdk';
import type { FeeBumpTransaction, Transaction } from '@stellar/stellar-sdk';
import { FeeBumpExpiredError } from './errors.js';

/**
 * Renewal path for a fee bump whose inner transaction's time bounds have
 * lapsed (issue #705). Rebuilds the inner transaction with fresh time
 * bounds via the documented `TransactionBuilder.cloneFrom` bump path.
 *
 * The rebuilt transaction is **unsigned** — changing time bounds invalidates
 * the original signatures, so the caller must re-sign it with the original
 * source key before wrapping (see `renew` on {@link FeeBumpWrapOptions}).
 *
 * @param inner - The inner transaction whose bounds should be renewed.
 * @param opts.timeoutSeconds - New timeout from now (default 30).
 * @param opts.networkPassphrase - Network passphrase (default TESTNET).
 * @returns A rebuilt, unsigned inner transaction with renewed time bounds.
 */
export function renewTimeBounds(
  inner: Transaction,
  opts?: { timeoutSeconds?: number; networkPassphrase?: string },
): Transaction {
  const timeoutSeconds = opts?.timeoutSeconds ?? 30;
  // `cloneFrom` carries over the inner transaction's existing (expired) time
  // bounds, and stellar-base's `setTimeout` refuses to overwrite an
  // already-set `max_time` as a safety check — so the renewed bounds must be
  // passed directly via `optionOverrides.timebounds` instead of chaining
  // `.setTimeout()` after the clone.
  return TransactionBuilder.cloneFrom(inner, {
    fee: inner.fee,
    networkPassphrase: opts?.networkPassphrase ?? Networks.TESTNET,
    timebounds: {
      minTime: 0,
      maxTime: Math.floor(Date.now() / 1000) + timeoutSeconds,
    },
  }).build();
}

/** Options for the renewal path of {@link wrapForFeeBump} (issue #705). */
export interface FeeBumpRenewalOptions {
  /** New timeout in seconds for the renewed inner transaction (default 30). */
  timeoutSeconds?: number;
  /**
   * Called with the rebuilt (unsigned) inner transaction after its time
   * bounds are renewed; must re-sign it with the original source key and
   * return the signed transaction.
   */
  resign: (renewed: Transaction) => Transaction;
}

/** Options for {@link wrapForFeeBump} (issue #705). */
export interface FeeBumpWrapOptions {
  /** Network passphrase (default TESTNET). */
  networkPassphrase?: string;
  /** Fee in stroops for the bump envelope (default 100). */
  baseFee?: number | string;
  /** Unix seconds to evaluate the inner transaction's bounds against (default now). */
  now?: number;
  /**
   * When set and the inner transaction's bounds have already lapsed, bounds
   * are renewed via `renewTimeBounds` and re-signed through this callback
   * instead of failing, so the bump can still be submitted.
   */
  renew?: FeeBumpRenewalOptions;
}

/**
 * Wraps an inner transaction in a Stellar fee-bump envelope after checking
 * its time bounds (issue #705).
 *
 * If the inner transaction's `maxTime` has already passed, a bump would be
 * rejected by the network without a clear explanation; this throws
 * {@link FeeBumpExpiredError} up front instead — or, when `opts.renew` is
 * provided, renews the bounds via the documented bump path and re-signs
 * before wrapping.
 *
 * @param inner - The inner transaction or its base64 XDR.
 * @param feeSource - The Stellar address paying the bump fee.
 * @param opts - Wrap options (passphrase, fee, clock, renewal path).
 * @returns The fee-bump envelope ready for submission.
 * @throws {FeeBumpExpiredError} When bounds have lapsed and no renewal path is given.
 */
export function wrapForFeeBump(
  inner: Transaction | string,
  feeSource: string,
  opts?: FeeBumpWrapOptions,
): FeeBumpTransaction {
  const passphrase = opts?.networkPassphrase ?? Networks.TESTNET;
  const tx =
    typeof inner === 'string'
      ? (TransactionBuilder.fromXDR(inner, passphrase) as Transaction)
      : inner;

  const now = opts?.now ?? Math.floor(Date.now() / 1000);
  const maxTime = Number(tx.timeBounds?.maxTime ?? 0);

  let wrapTarget = tx;
  if (maxTime > 0 && now >= maxTime) {
    if (!opts?.renew) {
      throw new FeeBumpExpiredError(maxTime);
    }
    const renewed = renewTimeBounds(tx, {
      networkPassphrase: passphrase,
      timeoutSeconds: opts.renew.timeoutSeconds,
    });
    wrapTarget = opts.renew.resign(renewed);
  }

  return TransactionBuilder.buildFeeBumpTransaction(
    feeSource,
    String(opts?.baseFee ?? 100),
    wrapTarget,
    passphrase,
  ) as FeeBumpTransaction;
}

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
