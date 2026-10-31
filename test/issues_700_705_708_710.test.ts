/**
 * Tests for issues #700, #705, #708, #710
 *
 * #700 — BatchBuilder does not warn when combined operations would exceed
 *         the Soroban per-transaction operation limit.
 * #705 — FeeBump wrapper cannot bump a transaction that has already partially
 *         expired in the mempool.
 * #708 — Serialization helpers have no streaming/partial deserialization path
 *         for large stream-history payloads.
 * #710 — Templates do not support conditional parameters based on token type.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  Asset,
  BASE_FEE,
  Account,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { BatchBuilder, SOROBAN_MAX_OPS_PER_TX } from '../src/batchBuilder.js';
import { BatchOperationLimitExceededError, FeeBumpExpiredError } from '../src/errors.js';
import { withFeeBump, bigintReplacer, bigintReviver } from '../src/utils.js';
import { renewTimeBounds } from '../src/feeBump.js';
import { templates } from '../src/templates.js';
import { deserializeStreamRecords, deserializeStreamFromJSON } from '../src/utils.js';
import type { SoroStreamClient } from '../src/SoroStreamClient.js';
import type { CreateStreamParams, StellarAddress, Stream } from '../src/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeBatchClient() {
  return {
    createStream: vi.fn().mockResolvedValue({ streamId: 'stream-0' }),
    cancelStream: vi.fn().mockResolvedValue({ txHash: 'tx' }),
    withdraw: vi.fn().mockResolvedValue({ txHash: 'tx' }),
  };
}

/** Builds a signed inner transaction; when `expired`, its maxTime is already in the past. */
function makeInnerTransaction(expired: boolean) {
  const keypair = Keypair.random();
  const account = new Account(keypair.publicKey(), '0');
  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  }).addOperation(
    Operation.payment({
      destination: keypair.publicKey(),
      asset: Asset.native(),
      amount: '1',
    }),
  );
  const tx = expired
    ? builder.setTimebounds(0, Math.floor(Date.now() / 1000) - 60).build()
    : builder.setTimeout(30).build();
  tx.sign(keypair);
  return { tx, keypair };
}

function makeHistoryRecord(i: number): Stream {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: `stream-${i}`,
    sender: 'GSENDER000000000000000000000000000000000000000000000000000',
    recipient: 'GRECIPIENT0000000000000000000000000000000000000000000000000',
    token: 'GTOKEN0000000000000000000000000000000000000000000000000000',
    deposit: BigInt(i + 1) * 1_000_000n,
    flowRate: BigInt(100 + i),
    startTime: now - 100,
    endTime: now + 3600,
    lastWithdrawTime: now - 100,
    status: 'Active',
    autoRenew: false,
  } as Stream;
}

const RECIPIENT = 'GRECIPIENT0000000000000000000000000000000000000000000000000' as StellarAddress;
const TOKEN = 'GTOKEN0000000000000000000000000000000000000000000000000000' as StellarAddress;

// ─────────────────────────────────────────────────────────────────────────────
// Issue #700 — BatchBuilder operation-limit validation
// ─────────────────────────────────────────────────────────────────────────────

describe('Issue #700: BatchBuilder validates combined operation count', () => {
  it('accepts a batch exactly at the Soroban per-transaction limit', async () => {
    const client = makeBatchClient();
    const builder = new BatchBuilder(client as unknown as SoroStreamClient);
    for (let i = 0; i < SOROBAN_MAX_OPS_PER_TX; i++) {
      builder.withdraw(`stream-${i}`);
    }

    expect(builder.operationCount).toBe(SOROBAN_MAX_OPS_PER_TX);

    const { results } = await builder.submit();
    expect(results).toHaveLength(SOROBAN_MAX_OPS_PER_TX);
    expect(results.every((r) => r.success)).toBe(true);
    expect(client.withdraw).toHaveBeenCalledTimes(SOROBAN_MAX_OPS_PER_TX);
  });

  it('throws a typed error ahead of submission when the limit is exceeded', async () => {
    const client = makeBatchClient();
    const builder = new BatchBuilder(client as unknown as SoroStreamClient);
    for (let i = 0; i < SOROBAN_MAX_OPS_PER_TX + 1; i++) {
      builder.withdraw(`stream-${i}`);
    }

    const rejection = builder.submit();
    await expect(rejection).rejects.toBeInstanceOf(BatchOperationLimitExceededError);
    await expect(builder.submit()).rejects.toMatchObject({
      operationCount: SOROBAN_MAX_OPS_PER_TX + 1,
      maxOperations: SOROBAN_MAX_OPS_PER_TX,
    });
    // Nothing ran: the error is raised before any operation is attempted.
    expect(client.withdraw).not.toHaveBeenCalled();
    expect(client.createStream).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #705 — FeeBump time-bounds check and renewal path
// ─────────────────────────────────────────────────────────────────────────────

describe('Issue #705: FeeBump checks original time bounds before wrapping', () => {
  const feeSource = Keypair.random().publicKey();

  it('throws a clear typed error for an expired-bounds transaction instead of submitting', () => {
    const { tx } = makeInnerTransaction(true);

    expect(() => withFeeBump(tx, feeSource, { networkPassphrase: Networks.TESTNET })).toThrow(
      FeeBumpExpiredError,
    );
    expect(() => withFeeBump(tx, feeSource, { networkPassphrase: Networks.TESTNET })).toThrow(
      /expired/i,
    );
    // The same check applies to the base64 XDR input path.
    expect(() =>
      withFeeBump(tx.toXDR(), feeSource, { networkPassphrase: Networks.TESTNET }),
    ).toThrow(FeeBumpExpiredError);
  });

  it('wraps a not-yet-expired transaction unchanged', () => {
    const { tx } = makeInnerTransaction(false);
    const bump = withFeeBump(tx, feeSource, { networkPassphrase: Networks.TESTNET });
    expect(bump).toBeInstanceOf(FeeBumpTransaction);
  });

  it('renews bounds via renewTimeBounds and re-signs before wrapping', () => {
    const { tx, keypair } = makeInnerTransaction(true);

    const renewed = renewTimeBounds(tx, {
      networkPassphrase: Networks.TESTNET,
      timeoutSeconds: 60,
    });
    renewed.sign(keypair);
    const bump = withFeeBump(renewed, feeSource, { networkPassphrase: Networks.TESTNET });
    expect(bump).toBeInstanceOf(FeeBumpTransaction);
  });

  it('renews and re-signs through the wrapper renew option instead of failing', () => {
    const { tx, keypair } = makeInnerTransaction(true);

    const bump = withFeeBump(tx, feeSource, {
      networkPassphrase: Networks.TESTNET,
      renew: {
        timeoutSeconds: 60,
        resign: (renewed) => {
          renewed.sign(keypair);
          return renewed;
        },
      },
    });
    expect(bump).toBeInstanceOf(FeeBumpTransaction);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #708 — Streaming deserialization of large payloads
// ─────────────────────────────────────────────────────────────────────────────

describe('Issue #708: streaming deserialization for large payloads', () => {
  const RECORD_COUNT = 2000;
  const records = Array.from({ length: RECORD_COUNT }, (_, i) => makeHistoryRecord(i));
  const payload = JSON.stringify(records, bigintReplacer);

  it('yields records incrementally that match the non-streaming result', () => {
    const streamed = Array.from(deserializeStreamRecords(payload));

    expect(streamed).toHaveLength(RECORD_COUNT);
    expect(streamed).toEqual(records);

    // Non-streaming reference: parse the whole payload at once.
    const nonStreaming = JSON.parse(payload, bigintReviver) as Stream[];
    expect(streamed).toEqual(nonStreaming);
  });

  it('matches deserializeStreamFromJSON for individual records', () => {
    const [first] = Array.from(deserializeStreamRecords(payload));
    expect(first).toEqual(deserializeStreamFromJSON(JSON.stringify(records[0], bigintReplacer)));
  });

  it('supports early exit after the first N records', () => {
    const firstThree: Stream[] = [];
    for (const record of deserializeStreamRecords(payload)) {
      firstThree.push(record);
      if (firstThree.length === 3) break;
    }
    expect(firstThree.map((s) => s.id)).toEqual(['stream-0', 'stream-1', 'stream-2']);
  });

  it('handles empty arrays and rejects non-array payloads', () => {
    expect(Array.from(deserializeStreamRecords('[]'))).toEqual([]);
    expect(() => Array.from(deserializeStreamRecords('{"id":"1"}'))).toThrow(
      /top-level JSON array/,
    );
    expect(() => Array.from(deserializeStreamRecords('[{"id":'))).toThrow(/unterminated/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #710 — Conditional template parameters by token type
// ─────────────────────────────────────────────────────────────────────────────

describe('Issue #710: conditional template parameters by token type', () => {
  const base = {
    recipient: RECIPIENT,
    token: TOKEN,
    autoRenew: false,
    durationSeconds: 3600,
  } as const;

  it('resolves one template with two token types to different parameters', () => {
    const native = templates.minAmountStream({
      ...base,
      tokenType: 'native',
      amount: (ctx) => 10n ** BigInt(ctx.decimals) / 2n, // 0.5 XLM at 7 decimals
    });
    const stable = templates.minAmountStream({
      ...base,
      tokenType: 'stablecoin',
      decimals: 6,
      amount: (ctx) => 10n ** BigInt(ctx.decimals), // 1 unit at 6 decimals
    });

    expect(native.amount).toBe(5_000_000n);
    expect(stable.amount).toBe(1_000_000n);
    expect(native.amount).not.toBe(stable.amount);
    // Token context is consumed at instantiation, not leaked into params.
    expect(native).not.toHaveProperty('tokenType');
    expect(native).not.toHaveProperty('decimals');
    expect(native.durationSeconds).toBe(3600);
    expect(stable.recipient).toBe(RECIPIENT);
  });

  it('keeps static conditional values working unchanged', () => {
    const params = templates.minAmountStream({
      ...base,
      tokenType: 'native',
      amount: 42n,
    });
    expect(params.amount).toBe(42n);
  });

  it('leaves existing static-parameter templates unchanged', () => {
    const params = templates.biweeklyPayroll({
      recipient: RECIPIENT,
      token: TOKEN,
      amount: 1_000n,
      autoRenew: true,
    });
    expect(params.durationSeconds).toBe(14 * 86_400);
    expect(params.amount).toBe(1_000n);
    expect(params).not.toHaveProperty('tokenType');
  });
});
