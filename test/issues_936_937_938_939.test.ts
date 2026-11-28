/**
 * Issues #936, #937, #938 and #939.
 *
 * - #936: PluginRegistry.runBefore propagates hook errors (fail-fast) while
 *   runAfter catches and warns on them — documented as a deliberate asymmetry.
 * - #937: PluginRegistry.unregister(name) removes every plugin sharing that
 *   name, not just one.
 * - #938: assertEnvelopeUnmutated catches memo/time-bounds mutations only via
 *   the final transaction-hash fallback, since no earlier explicit check
 *   inspects either field.
 * - #939: assertEnvelopeUnmutated rejects a FeeBumpTransaction passed as
 *   either `prepared` or (decoded from) `signedXdr`.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  Account,
  Contract,
  Keypair,
  Memo,
  Networks,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { PluginRegistry } from '../src/pluginRegistry.js';
import type { SoroStreamPlugin } from '../src/types.js';
import { assertEnvelopeUnmutated } from '../src/xdrValidation.js';
import { createContractEncoder } from '../src/contractEncoders.js';
import { withFeeBump } from '../src/utils.js';
import { XdrValidationError } from '../src/errors.js';

const CONTRACT_ID = 'CAVTXNC2WCHINDNP4VBLSOQA2667VE3RPQZNGD5TFI4U2QSHTVAC667T';
const NETWORK = Networks.TESTNET;

function buildPauseTransaction(streamId: string, opts: { memo?: Memo } = {}) {
  const keypair = Keypair.random();
  const account = new Account(keypair.publicKey(), '123');
  const operation = createContractEncoder(new Contract(CONTRACT_ID), 'v1').pauseStream(
    streamId,
    keypair.publicKey(),
  );
  const builder = new TransactionBuilder(account, { fee: '100', networkPassphrase: NETWORK })
    .addOperation(operation)
    .setTimeout(30);
  if (opts.memo) builder.addMemo(opts.memo);
  return builder.build();
}

// ── #936 ──────────────────────────────────────────────────────────────────

describe('#936 PluginRegistry before/after error-handling asymmetry', () => {
  it('runBefore propagates a hook error and aborts', async () => {
    const registry = new PluginRegistry();
    const plugin: SoroStreamPlugin = {
      before: vi.fn(() => {
        throw new Error('before hook failed');
      }),
    };
    registry.register(plugin);

    await expect(
      registry.runBefore('createStream', { method: 'createStream', args: [] }),
    ).rejects.toThrow('before hook failed');
  });

  it('runAfter catches a hook error, warns, and still runs later hooks', async () => {
    const registry = new PluginRegistry();
    const failing: SoroStreamPlugin = {
      after: vi.fn(() => {
        throw new Error('after hook failed');
      }),
    };
    const laterCalls: unknown[] = [];
    const later: SoroStreamPlugin = {
      after: vi.fn((ctx, result) => {
        laterCalls.push(result);
      }),
    };
    registry.register(failing, { name: 'failing' });
    registry.register(later, { name: 'later', after: 'failing' });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      registry.runAfter('createStream', { method: 'createStream', args: [] }, 'result'),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(laterCalls).toEqual(['result']);
    warnSpy.mockRestore();
  });
});

// ── #937 ──────────────────────────────────────────────────────────────────

describe('#937 PluginRegistry.unregister(name) removes every matching plugin', () => {
  it('removes both plugins registered under the same name', () => {
    const registry = new PluginRegistry();
    const first: SoroStreamPlugin = {};
    const second: SoroStreamPlugin = {};
    registry.register(first, { name: 'shared-name' });
    registry.register(second, { name: 'shared-name' });

    expect(registry.list()).toHaveLength(2);

    const removed = registry.unregister('shared-name');

    expect(removed).toBe(true);
    expect(registry.list()).toHaveLength(0);
  });
});

// ── #938 ──────────────────────────────────────────────────────────────────

describe('#938 assertEnvelopeUnmutated catches memo/time-bounds mutation via the hash fallback', () => {
  it('throws ENVELOPE_MUTATED when only the memo differs', () => {
    // source, sequence, fee, operation count and operation types are all
    // identical between `prepared` and the signed XDR below — only the memo
    // differs — so none of the explicit field checks above the hash
    // comparison in assertEnvelopeUnmutated can trip; only the catch-all
    // `decoded.hash().equals(prepared.hash())` comparison can catch this.
    const prepared = buildPauseTransaction('1');
    const mutated = buildPauseTransactionWithSameEnvelope(prepared, {
      memo: Memo.text('mutated'),
    });

    let caught: unknown;
    try {
      assertEnvelopeUnmutated(prepared, mutated, NETWORK);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(XdrValidationError);
    expect((caught as XdrValidationError).code).toBe('ENVELOPE_MUTATED');
    expect((caught as XdrValidationError).message).toContain('transaction body does not match');
  });

  it('throws ENVELOPE_MUTATED when only time bounds differ', () => {
    const prepared = buildPauseTransaction('1');
    const mutated = buildPauseTransactionWithSameEnvelope(prepared, {
      timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 9999 },
    });

    let caught: unknown;
    try {
      assertEnvelopeUnmutated(prepared, mutated, NETWORK);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(XdrValidationError);
    expect((caught as XdrValidationError).code).toBe('ENVELOPE_MUTATED');
  });
});

/**
 * Rebuilds `prepared`'s exact envelope (same source, sequence, fee,
 * operations) from its XDR, re-signs none of it, but overrides memo and/or
 * time bounds before returning the new XDR string — isolating the mutation
 * to a field none of assertEnvelopeUnmutated's explicit checks inspect.
 */
function buildPauseTransactionWithSameEnvelope(
  prepared: ReturnType<typeof buildPauseTransaction>,
  overrides: { memo?: Memo; timebounds?: { minTime: number; maxTime: number } },
): string {
  const builder = TransactionBuilder.cloneFrom(
    prepared,
    overrides.timebounds ? { timebounds: overrides.timebounds } : {},
  );
  if (overrides.memo) builder.addMemo(overrides.memo);
  return builder.build().toXDR();
}

// ── #939 ──────────────────────────────────────────────────────────────────

describe('#939 assertEnvelopeUnmutated rejects a FeeBumpTransaction', () => {
  it('throws UNEXPECTED_TRANSACTION_TYPE when `prepared` is a FeeBumpTransaction', () => {
    const inner = buildPauseTransaction('1');
    const feeBump = withFeeBump(inner, Keypair.random().publicKey(), {
      networkPassphrase: NETWORK,
    });

    let caught: unknown;
    try {
      assertEnvelopeUnmutated(feeBump, inner.toXDR(), NETWORK);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(XdrValidationError);
    expect((caught as XdrValidationError).code).toBe('UNEXPECTED_TRANSACTION_TYPE');
    expect((caught as XdrValidationError).message).toContain('fee-bump');
  });

  it('throws UNEXPECTED_TRANSACTION_TYPE when the signed XDR decodes to a FeeBumpTransaction', () => {
    const prepared = buildPauseTransaction('1');
    const feeBump = withFeeBump(prepared, Keypair.random().publicKey(), {
      networkPassphrase: NETWORK,
    });

    let caught: unknown;
    try {
      assertEnvelopeUnmutated(prepared, feeBump.toXDR(), NETWORK);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(XdrValidationError);
    expect((caught as XdrValidationError).code).toBe('UNEXPECTED_TRANSACTION_TYPE');
    expect((caught as XdrValidationError).message).toContain('fee-bump');
  });
});
