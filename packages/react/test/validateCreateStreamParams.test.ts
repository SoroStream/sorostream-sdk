/**
 * Tests for issue #800: validateCreateStreamParams (React package) should
 * reject the same invalid inputs that the SDK core's create_stream validation
 * (and ultimately the Soroban contract) rejects, preventing the user from
 * receiving false confidence right before a doomed transaction.
 *
 * RELATIONSHIP BETWEEN THIS HELPER AND AUTHORITATIVE SERVER-SIDE VALIDATION
 * ─────────────────────────────────────────────────────────────────────────
 * `validateCreateStreamParams` is a **client-side pre-validation helper**.
 * Its purpose is to give the developer fast, clear feedback _before_ a
 * transaction is submitted, so no network round-trip or transaction fee is
 * wasted on obviously invalid parameters.
 *
 * The authoritative validation lives in two places:
 *   1. `SoroStreamClient.createStream` (TypeScript, pre-flight checks).
 *   2. The Soroban smart contract's `create_stream` entry point
 *      (`validation.rs` in SoroStream/contract).
 *
 * This helper must stay in sync with both. Whenever a new boundary case is
 * added to the contract or the SDK core, a corresponding case must be added
 * here. The test matrix below is the living contract between this helper and
 * the authoritative validators — changes to either side should trigger a
 * review of the other.
 *
 * BOUNDARY CASES COVERED
 * ─────────────────────
 * Required fields (null/undefined/empty):
 *   • params itself is null or not an object
 *   • recipient missing or empty string
 *   • token missing or empty string
 *   • amount is not a bigint
 *   • amount is zero (≤ 0n)
 *   • amount is negative
 *   • durationSeconds missing or non-finite (NaN, Infinity)
 *   • autoRenew missing or wrong type
 *
 * Type / shape violations:
 *   • amount as a string (common mistake)
 *   • amount as a number instead of bigint
 *   • durationSeconds as a string
 *   • recipient as a number
 *
 * Happy-path smoke tests (should NOT throw):
 *   • minimal valid params
 *   • valid params with all optional fields
 *   • very large bigint amount
 *   • durationSeconds = 1 (minimum plausible value > 0)
 */
import { describe, it, expect } from 'vitest';

import { validateCreateStreamParams } from '../src/useCreateStream.js';
import type { CreateStreamParams } from '../../../src/types.js';
import { assertStellarAddress } from '../../../src/utils.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const RECIPIENT = assertStellarAddress('GAXXZ5XSL2VTQPGWB3LPU5273HSJXMK7VHLZTF2XKW65QFZVA3XKULQZ');
const TOKEN = assertStellarAddress('CAVTXNC2WCHINDNP4VBLSOQA2667VE3RPQZNGD5TFI4U2QSHTVAC667T');

/** Returns a baseline valid params object; each test overrides only what it tests. */
function valid(overrides: Partial<CreateStreamParams> = {}): CreateStreamParams {
  return {
    recipient: RECIPIENT,
    token: TOKEN,
    amount: 1_000_000n,
    durationSeconds: 3600,
    autoRenew: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Happy-path: should NOT throw
// ---------------------------------------------------------------------------

describe('validateCreateStreamParams (#800) — happy path', () => {
  it('accepts a minimal, fully valid params object', () => {
    expect(() => validateCreateStreamParams(valid())).not.toThrow();
  });

  it('accepts autoRenew = true', () => {
    expect(() => validateCreateStreamParams(valid({ autoRenew: true }))).not.toThrow();
  });

  it('accepts a very large bigint amount', () => {
    expect(() =>
      validateCreateStreamParams(valid({ amount: BigInt('999999999999999999') })),
    ).not.toThrow();
  });

  it('accepts durationSeconds = 1 (minimum plausible non-zero duration)', () => {
    expect(() => validateCreateStreamParams(valid({ durationSeconds: 1 }))).not.toThrow();
  });

  it('accepts params with all optional fields set', () => {
    expect(() =>
      validateCreateStreamParams(
        valid({
          cliffSeconds: 600,
          checkDuplicate: false,
          skipAllowanceCheck: true,
          nonce: 'abc-123',
          namespace: 'payroll',
          tag: 'q4-2025',
        }),
      ),
    ).not.toThrow();
  });

  it('accepts durationSeconds as a large finite number', () => {
    expect(() =>
      validateCreateStreamParams(valid({ durationSeconds: 365 * 24 * 3600 })),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Required-field / null rejections
// ---------------------------------------------------------------------------

describe('validateCreateStreamParams (#800) — null / missing params', () => {
  it('rejects null params (mirrors contract: must be a non-null object)', () => {
    expect(() => validateCreateStreamParams(null as unknown as CreateStreamParams)).toThrow(
      /must be a non-null object/i,
    );
  });

  it('rejects undefined params', () => {
    expect(() => validateCreateStreamParams(undefined as unknown as CreateStreamParams)).toThrow(
      /must be a non-null object/i,
    );
  });

  it('rejects a primitive string instead of params object', () => {
    expect(() => validateCreateStreamParams('bad' as unknown as CreateStreamParams)).toThrow(
      /must be a non-null object/i,
    );
  });
});

// ---------------------------------------------------------------------------
// recipient
// ---------------------------------------------------------------------------

describe('validateCreateStreamParams (#800) — recipient', () => {
  it('rejects an empty recipient (mirrors contract: invalid Stellar address)', () => {
    expect(() => validateCreateStreamParams(valid({ recipient: '' as typeof RECIPIENT }))).toThrow(
      /recipient is required/i,
    );
  });

  it('rejects a whitespace-only recipient', () => {
    expect(() =>
      validateCreateStreamParams(valid({ recipient: '   ' as typeof RECIPIENT })),
    ).toThrow(/recipient is required/i);
  });

  it('rejects undefined recipient', () => {
    expect(() =>
      validateCreateStreamParams(valid({ recipient: undefined as unknown as typeof RECIPIENT })),
    ).toThrow(/recipient is required/i);
  });

  it('rejects a numeric recipient', () => {
    expect(() =>
      validateCreateStreamParams(valid({ recipient: 12345 as unknown as typeof RECIPIENT })),
    ).toThrow(/recipient is required/i);
  });
});

// ---------------------------------------------------------------------------
// token
// ---------------------------------------------------------------------------

describe('validateCreateStreamParams (#800) — token', () => {
  it('rejects an empty token (mirrors contract: invalid SAC token address)', () => {
    expect(() => validateCreateStreamParams(valid({ token: '' as typeof TOKEN }))).toThrow(
      /token is required/i,
    );
  });

  it('rejects a whitespace-only token', () => {
    expect(() => validateCreateStreamParams(valid({ token: '   ' as typeof TOKEN }))).toThrow(
      /token is required/i,
    );
  });

  it('rejects undefined token', () => {
    expect(() =>
      validateCreateStreamParams(valid({ token: undefined as unknown as typeof TOKEN })),
    ).toThrow(/token is required/i);
  });
});

// ---------------------------------------------------------------------------
// amount
// ---------------------------------------------------------------------------

describe('validateCreateStreamParams (#800) — amount', () => {
  it('rejects amount = 0n (mirrors contract: amount must be > 0)', () => {
    expect(() => validateCreateStreamParams(valid({ amount: 0n }))).toThrow(
      /amount is required.*positive bigint/i,
    );
  });

  it('rejects a negative amount (mirrors contract: amount must be > 0)', () => {
    expect(() => validateCreateStreamParams(valid({ amount: -1n }))).toThrow(
      /amount is required.*positive bigint/i,
    );
  });

  it('rejects undefined amount', () => {
    expect(() =>
      validateCreateStreamParams(valid({ amount: undefined as unknown as bigint })),
    ).toThrow(/amount is required/i);
  });

  it('rejects amount as a string (common mistake — mirrors contract type check)', () => {
    expect(() =>
      validateCreateStreamParams(valid({ amount: '1000000' as unknown as bigint })),
    ).toThrow(/amount is required/i);
  });

  it('rejects amount as a plain number instead of bigint (mirrors contract type check)', () => {
    expect(() =>
      validateCreateStreamParams(valid({ amount: 1000000 as unknown as bigint })),
    ).toThrow(/amount is required/i);
  });
});

// ---------------------------------------------------------------------------
// durationSeconds
// ---------------------------------------------------------------------------

describe('validateCreateStreamParams (#800) — durationSeconds', () => {
  it('rejects NaN durationSeconds (mirrors contract: duration must be a finite number)', () => {
    expect(() => validateCreateStreamParams(valid({ durationSeconds: NaN }))).toThrow(
      /durationSeconds is required.*finite number/i,
    );
  });

  it('rejects Infinity durationSeconds', () => {
    expect(() => validateCreateStreamParams(valid({ durationSeconds: Infinity }))).toThrow(
      /durationSeconds is required.*finite number/i,
    );
  });

  it('rejects -Infinity durationSeconds', () => {
    expect(() => validateCreateStreamParams(valid({ durationSeconds: -Infinity }))).toThrow(
      /durationSeconds is required.*finite number/i,
    );
  });

  it('rejects undefined durationSeconds', () => {
    expect(() =>
      validateCreateStreamParams(valid({ durationSeconds: undefined as unknown as number })),
    ).toThrow(/durationSeconds is required/i);
  });

  it('rejects durationSeconds as a string', () => {
    expect(() =>
      validateCreateStreamParams(valid({ durationSeconds: '3600' as unknown as number })),
    ).toThrow(/durationSeconds is required/i);
  });
});

// ---------------------------------------------------------------------------
// autoRenew
// ---------------------------------------------------------------------------

describe('validateCreateStreamParams (#800) — autoRenew', () => {
  it('rejects undefined autoRenew (mirrors contract: boolean field required)', () => {
    expect(() =>
      validateCreateStreamParams(valid({ autoRenew: undefined as unknown as boolean })),
    ).toThrow(/autoRenew is required/i);
  });

  it('rejects autoRenew as a string "true"', () => {
    expect(() =>
      validateCreateStreamParams(valid({ autoRenew: 'true' as unknown as boolean })),
    ).toThrow(/autoRenew is required/i);
  });

  it('rejects autoRenew as a number 1', () => {
    expect(() => validateCreateStreamParams(valid({ autoRenew: 1 as unknown as boolean }))).toThrow(
      /autoRenew is required/i,
    );
  });

  it('rejects autoRenew as null', () => {
    expect(() =>
      validateCreateStreamParams(valid({ autoRenew: null as unknown as boolean })),
    ).toThrow(/autoRenew is required/i);
  });
});

// ---------------------------------------------------------------------------
// Error message quality (must be actionable, not generic)
// ---------------------------------------------------------------------------

describe('validateCreateStreamParams (#800) — error message quality', () => {
  it('error for missing recipient names the field clearly', () => {
    let msg = '';
    try {
      validateCreateStreamParams(valid({ recipient: '' as typeof RECIPIENT }));
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/recipient/i);
    // Must NOT be a vague generic message.
    expect(msg).not.toBe('undefined is not an object');
    expect(msg).not.toBe('Cannot read properties of undefined');
  });

  it('error for zero amount names the field and explains the constraint', () => {
    let msg = '';
    try {
      validateCreateStreamParams(valid({ amount: 0n }));
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/amount/i);
    expect(msg).toMatch(/positive/i);
  });

  it('error for NaN durationSeconds names the field and explains the constraint', () => {
    let msg = '';
    try {
      validateCreateStreamParams(valid({ durationSeconds: NaN }));
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/durationSeconds/i);
    expect(msg).toMatch(/finite/i);
  });
});
