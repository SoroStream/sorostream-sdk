import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  Asset,
  BASE_FEE,
  Account,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import type { Transaction } from '@stellar/stellar-sdk';
import { wrapForFeeBump, scheduleFeeBumpMonitor } from '../src/feeBump.js';
import { BatchBuilder } from '../src/batchBuilder.js';
import { FeeBumpExpiredError } from '../src/errors.js';
import type { SoroStreamClient } from '../src/SoroStreamClient.js';

function makeInner(maxTime?: number) {
  const keypair = Keypair.random();
  const builder = new TransactionBuilder(new Account(keypair.publicKey(), '0'), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  }).addOperation(
    Operation.payment({ destination: keypair.publicKey(), asset: Asset.native(), amount: '1' }),
  );
  const tx =
    maxTime !== undefined
      ? builder.setTimebounds(0, maxTime).build()
      : builder.setTimeout(30).build();
  tx.sign(keypair);
  return { tx, keypair };
}

describe('Issue #895: wrapForFeeBump accepts base64 XDR inner', () => {
  it('produces the same fee-bump envelope for XDR string and Transaction object', () => {
    const { tx } = makeInner();
    const feeSource = Keypair.random().publicKey();
    const fromObject = wrapForFeeBump(tx, feeSource);
    const fromXdr = wrapForFeeBump(tx.toXDR(), feeSource);
    expect(fromXdr.toXDR()).toBe(fromObject.toXDR());
    expect(fromXdr.innerTransaction.hash()).toEqual(tx.hash());
  });
});

describe('Issue #896: wrapForFeeBump renew path', () => {
  const maxTime = Math.floor(Date.now() / 1000) - 60;

  it('wraps the resign callback output instead of the expired transaction', () => {
    const { tx, keypair } = makeInner(maxTime);
    let resigned: Transaction | undefined;
    const resign = vi.fn((renewed: Transaction) => {
      renewed.sign(keypair);
      resigned = renewed;
      return renewed;
    });
    const bump = wrapForFeeBump(tx, Keypair.random().publicKey(), {
      now: maxTime + 10,
      renew: { resign },
    });
    expect(resign).toHaveBeenCalledOnce();
    expect(bump.innerTransaction.hash()).toEqual(resigned!.hash());
    expect(bump.innerTransaction.hash()).not.toEqual(tx.hash());
  });

  it('throws FeeBumpExpiredError when renew is omitted', () => {
    const { tx } = makeInner(maxTime);
    expect(() => wrapForFeeBump(tx, Keypair.random().publicKey(), { now: maxTime + 10 })).toThrow(
      FeeBumpExpiredError,
    );
  });
});

describe('Issue #897: scheduleFeeBumpMonitor cancel', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not fire onExpiryApproaching after cancellation', async () => {
    vi.useFakeTimers();
    const checkInclusion = vi.fn().mockResolvedValue(false);
    const onExpiry = vi.fn();
    const cancel = scheduleFeeBumpMonitor('hash', 30, 0.8, checkInclusion, onExpiry);
    cancel();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(checkInclusion).not.toHaveBeenCalled();
    expect(onExpiry).not.toHaveBeenCalled();
  });

  it('fires onExpiryApproaching when checkInclusion rejects and not cancelled', async () => {
    vi.useFakeTimers();
    const checkInclusion = vi.fn().mockRejectedValue(new Error('network'));
    const onExpiry = vi.fn();
    scheduleFeeBumpMonitor('hash', 30, 0.8, checkInclusion, onExpiry);
    await vi.advanceTimersByTimeAsync(24_000);
    expect(onExpiry).toHaveBeenCalledWith('hash');
  });
});

describe('Issue #898: BatchBuilder.submit with zero operations', () => {
  it('rejects with the no-operations-queued message', async () => {
    const builder = new BatchBuilder({} as SoroStreamClient);
    await expect(builder.submit()).rejects.toThrow(
      'BatchBuilder: no operations queued — add at least one operation before calling submit()',
    );
  });
});
