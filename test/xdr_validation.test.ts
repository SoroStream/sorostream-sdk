/**
 * Tests for Issue #546: XDR validation throws a typed {@link XdrValidationError}
 * (extending {@link SoroStreamError}) with a structured `code` field instead of
 * an untyped `Error`, and the error class is exported from the package root.
 */
import { describe, it, expect } from 'vitest';
import { Account, Contract, Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';
import { assertEnvelopeUnmutated } from '../src/xdrValidation.js';
import { createContractEncoder } from '../src/contractEncoders.js';
import { XdrValidationError, SoroStreamError } from '../src/errors.js';
import {
  XdrValidationError as RootXdrValidationError,
  SoroStreamError as RootError,
} from '../src/index.js';

const CONTRACT_ID = 'CAVTXNC2WCHINDNP4VBLSOQA2667VE3RPQZNGD5TFI4U2QSHTVAC667T';
const NETWORK = Networks.TESTNET;

function buildPauseTransaction(streamId: string) {
  const keypair = Keypair.random();
  const account = new Account(keypair.publicKey(), '123');
  const operation = createContractEncoder(new Contract(CONTRACT_ID), 'v1').pauseStream(
    streamId,
    keypair.publicKey(),
  );
  return new TransactionBuilder(account, { fee: '100', networkPassphrase: NETWORK })
    .addOperation(operation)
    .setTimeout(30)
    .build();
}

describe('Issue #546: assertEnvelopeUnmutated throws XdrValidationError', () => {
  it('accepts a signed envelope that matches the submitted transaction', () => {
    const tx = buildPauseTransaction('1');
    expect(() => assertEnvelopeUnmutated(tx, tx.toXDR(), NETWORK)).not.toThrow();
  });

  it('throws XdrValidationError with code INVALID_XDR for undecodable input', () => {
    const tx = buildPauseTransaction('1');
    let caught: unknown;
    try {
      assertEnvelopeUnmutated(tx, 'this-is-not-valid-xdr', NETWORK);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(XdrValidationError);
    expect(caught).toBeInstanceOf(SoroStreamError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as XdrValidationError).code).toBe('INVALID_XDR');
    expect((caught as XdrValidationError).message).toContain('invalid XDR');
  });

  it('throws XdrValidationError with code ENVELOPE_MUTATED for a swapped envelope', () => {
    const original = buildPauseTransaction('1');
    const different = buildPauseTransaction('2');
    let caught: unknown;
    try {
      assertEnvelopeUnmutated(original, different.toXDR(), NETWORK);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(XdrValidationError);
    expect(caught).toBeInstanceOf(SoroStreamError);
    expect((caught as XdrValidationError).code).toBe('ENVELOPE_MUTATED');
  });

  it('carries a structured code field on the error', () => {
    const tx = buildPauseTransaction('1');
    try {
      assertEnvelopeUnmutated(tx, 'garbage-xdr', NETWORK);
    } catch (err) {
      const validationError = err as XdrValidationError;
      expect(typeof validationError.code).toBe('string');
      expect(validationError.name).toBe('XdrValidationError');
      return;
    }
    throw new Error('expected assertEnvelopeUnmutated to throw');
  });
});

describe('Issue #546: XdrValidationError is exported from the package root', () => {
  it('is the same class exported from the package root', () => {
    expect(RootXdrValidationError).toBe(XdrValidationError);
    expect(RootError).toBe(SoroStreamError);
    const err = new RootXdrValidationError('INVALID_XDR', 'root export');
    expect(err).toBeInstanceOf(RootXdrValidationError);
    expect(err).toBeInstanceOf(XdrValidationError);
    expect(err).toBeInstanceOf(SoroStreamError);
    expect(err.code).toBe('INVALID_XDR');
  });
});
