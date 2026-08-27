/**
 * XDR envelope validation before signing (issue #459).
 *
 * Wallet adapters take an unsigned transaction XDR string and hand back a
 * signed one. Nothing structurally guarantees the returned envelope still
 * describes the same transaction — a compromised or buggy adapter could
 * swap operations, amounts, or addresses before signing. This module
 * decodes the signed envelope and compares it against the transaction that
 * was submitted for signing, so a mismatch is caught before broadcast.
 */

import { FeeBumpTransaction, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { TransactionMutatedError } from './errors.js';

/**
 * Verifies that `signedXdr` decodes to the same transaction body that was
 * submitted for signing. Compares source account, sequence number, fee,
 * operation count/types, and falls back to a full transaction-hash
 * comparison to catch any other mutation (including amounts and addresses
 * buried inside operation arguments).
 *
 * @param prepared - The transaction that was passed to the wallet adapter's `signTransaction`.
 * @param signedXdr - The signed XDR string returned by the wallet adapter.
 * @param networkPassphrase - The network passphrase used to decode `signedXdr`.
 * @throws {TransactionMutatedError} If the signed envelope does not match `prepared`.
 */
export function assertEnvelopeUnmutated(
  prepared: Transaction | FeeBumpTransaction,
  signedXdr: string,
  networkPassphrase: string,
): void {
  if (!(prepared instanceof Transaction)) {
    throw new TransactionMutatedError(
      'the transaction submitted for signing is unexpectedly a fee-bump transaction',
    );
  }

  const decoded = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);

  if (!(decoded instanceof Transaction)) {
    throw new TransactionMutatedError(
      'expected a signed transaction but received a fee-bump transaction',
    );
  }
  if (decoded.source !== prepared.source) {
    throw new TransactionMutatedError(
      `source account changed (expected ${prepared.source}, got ${decoded.source})`,
    );
  }
  if (decoded.sequence !== prepared.sequence) {
    throw new TransactionMutatedError(
      `sequence number changed (expected ${prepared.sequence}, got ${decoded.sequence})`,
    );
  }
  if (decoded.fee !== prepared.fee) {
    throw new TransactionMutatedError(`fee changed (expected ${prepared.fee}, got ${decoded.fee})`);
  }
  if (decoded.operations.length !== prepared.operations.length) {
    throw new TransactionMutatedError(
      `operation count changed (expected ${prepared.operations.length}, got ${decoded.operations.length})`,
    );
  }
  for (let i = 0; i < prepared.operations.length; i++) {
    if (decoded.operations[i]!.type !== prepared.operations[i]!.type) {
      throw new TransactionMutatedError(
        `operation ${i} type changed (expected ${prepared.operations[i]!.type}, got ${decoded.operations[i]!.type})`,
      );
    }
  }

  // Catch-all: the transaction hash covers the full tx body (source, seq,
  // fee, time bounds, memo, and every operation's arguments — including
  // amounts and addresses), so any mutation not already caught above will
  // surface here.
  if (!decoded.hash().equals(prepared.hash())) {
    throw new TransactionMutatedError(
      'transaction body does not match the envelope submitted for signing (amount, address, or other operation details differ)',
    );
  }
}
