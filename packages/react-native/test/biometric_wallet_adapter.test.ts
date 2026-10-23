/**
 * Tests for issue #796: createBiometricWalletAdapter should cleanly reject
 * a transaction-signing request when the user cancels the biometric prompt
 * mid-flow, rather than hanging indefinitely or proceeding without
 * authentication.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { createBiometricWalletAdapter } from '../src/index.js';
import type { BiometricAuthenticator, BiometricWalletOptions } from '../src/index.js';
import type { WalletAdapter, Network } from '../../../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_XDR = 'AAAAAQAAAAAAAAAAAAAAAAAAAAAA';
const TEST_NETWORK: Network = 'testnet';
const TEST_PUBLIC_KEY = 'GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF';
const TEST_SIGNED_XDR = 'SIGNED_XDR_VALUE';

/** Builds a minimal WalletAdapter mock. */
function makeWalletAdapter(): WalletAdapter {
  return {
    isConnected: vi.fn().mockResolvedValue(true),
    getPublicKey: vi.fn().mockResolvedValue(TEST_PUBLIC_KEY),
    signTransaction: vi.fn().mockResolvedValue(TEST_SIGNED_XDR),
  };
}

/** Builds a BiometricAuthenticator that simulates successful authentication. */
function makeSuccessfulBiometrics(): BiometricAuthenticator {
  return {
    isAvailable: vi.fn().mockResolvedValue(true),
    authenticate: vi.fn().mockResolvedValue(true),
  };
}

/** Builds a BiometricAuthenticator that simulates the user cancelling the prompt. */
function makeCancelledBiometrics(): BiometricAuthenticator {
  return {
    isAvailable: vi.fn().mockResolvedValue(true),
    // Returns false — the standard way biometric libraries signal cancellation.
    authenticate: vi.fn().mockResolvedValue(false),
  };
}

/** Builds a BiometricAuthenticator where biometrics are unavailable. */
function makeUnavailableBiometrics(): BiometricAuthenticator {
  return {
    isAvailable: vi.fn().mockResolvedValue(false),
    authenticate: vi.fn().mockResolvedValue(false),
  };
}

/** Builds a BiometricAuthenticator where authenticate throws (hardware error). */
function makeThrowingBiometrics(msg = 'hardware error'): BiometricAuthenticator {
  return {
    isAvailable: vi.fn().mockResolvedValue(true),
    authenticate: vi.fn().mockRejectedValue(new Error(msg)),
  };
}

// ---------------------------------------------------------------------------
// signTransaction — user cancels mid-prompt
// ---------------------------------------------------------------------------

describe('createBiometricWalletAdapter (#796) — user cancels biometric prompt', () => {
  it('rejects signTransaction with a clear error when the user cancels', async () => {
    const wallet = makeWalletAdapter();
    const biometrics = makeCancelledBiometrics();
    const adapter = createBiometricWalletAdapter(wallet, biometrics);

    await expect(adapter.signTransaction(TEST_XDR, TEST_NETWORK)).rejects.toThrow(
      /biometric authentication failed or was cancelled/i,
    );
  });

  it('does NOT call wallet.signTransaction when biometrics are cancelled', async () => {
    const wallet = makeWalletAdapter();
    const biometrics = makeCancelledBiometrics();
    const adapter = createBiometricWalletAdapter(wallet, biometrics);

    await expect(adapter.signTransaction(TEST_XDR, TEST_NETWORK)).rejects.toThrow();

    // The underlying wallet must never be called — authentication gate holds.
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });

  it('the rejection is a proper Error instance, not left pending', async () => {
    const wallet = makeWalletAdapter();
    const biometrics = makeCancelledBiometrics();
    const adapter = createBiometricWalletAdapter(wallet, biometrics);

    // The promise must settle (reject), never hang indefinitely.
    const result = await Promise.race([
      adapter.signTransaction(TEST_XDR, TEST_NETWORK).catch((e: unknown) => e),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 200)),
    ]);

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/cancelled/i);
  });

  it('error message is actionable — not a vague undefined/null error', async () => {
    const wallet = makeWalletAdapter();
    const biometrics = makeCancelledBiometrics();
    const adapter = createBiometricWalletAdapter(wallet, biometrics);

    let msg = '';
    await adapter.signTransaction(TEST_XDR, TEST_NETWORK).catch((e: Error) => {
      msg = e.message;
    });

    expect(msg).not.toBe('');
    expect(msg).not.toMatch(/undefined is not/i);
    expect(msg).not.toMatch(/cannot read/i);
    // Must mention authentication or cancellation so the caller knows the cause.
    expect(msg).toMatch(/authentication|cancelled|biometric/i);
  });
});

// ---------------------------------------------------------------------------
// signTransaction — biometrics unavailable
// ---------------------------------------------------------------------------

describe('createBiometricWalletAdapter (#796) — biometrics unavailable', () => {
  it('rejects signTransaction with a clear error when biometrics are not available', async () => {
    const wallet = makeWalletAdapter();
    const biometrics = makeUnavailableBiometrics();
    const adapter = createBiometricWalletAdapter(wallet, biometrics);

    await expect(adapter.signTransaction(TEST_XDR, TEST_NETWORK)).rejects.toThrow(
      /biometric authentication is not available/i,
    );
  });

  it('does NOT call wallet.signTransaction when biometrics are unavailable', async () => {
    const wallet = makeWalletAdapter();
    const biometrics = makeUnavailableBiometrics();
    const adapter = createBiometricWalletAdapter(wallet, biometrics);

    await expect(adapter.signTransaction(TEST_XDR, TEST_NETWORK)).rejects.toThrow();
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });

  it('does NOT call biometrics.authenticate when isAvailable returns false', async () => {
    const wallet = makeWalletAdapter();
    const biometrics = makeUnavailableBiometrics();
    const adapter = createBiometricWalletAdapter(wallet, biometrics);

    await adapter.signTransaction(TEST_XDR, TEST_NETWORK).catch(() => {});
    expect(biometrics.authenticate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// signTransaction — biometrics throw (hardware error mid-flow)
// ---------------------------------------------------------------------------

describe('createBiometricWalletAdapter (#796) — hardware error during authentication', () => {
  it('rejects signTransaction when authenticate throws (hardware fault)', async () => {
    const wallet = makeWalletAdapter();
    const biometrics = makeThrowingBiometrics('sensor failed');
    const adapter = createBiometricWalletAdapter(wallet, biometrics);

    await expect(adapter.signTransaction(TEST_XDR, TEST_NETWORK)).rejects.toThrow('sensor failed');
  });

  it('does NOT call wallet.signTransaction when authenticate throws', async () => {
    const wallet = makeWalletAdapter();
    const biometrics = makeThrowingBiometrics();
    const adapter = createBiometricWalletAdapter(wallet, biometrics);

    await adapter.signTransaction(TEST_XDR, TEST_NETWORK).catch(() => {});
    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// signTransaction — happy path (authentication succeeds)
// ---------------------------------------------------------------------------

describe('createBiometricWalletAdapter (#796) — successful authentication allows signing', () => {
  it('resolves with the signed XDR when biometrics succeed', async () => {
    const wallet = makeWalletAdapter();
    const biometrics = makeSuccessfulBiometrics();
    const adapter = createBiometricWalletAdapter(wallet, biometrics);

    const result = await adapter.signTransaction(TEST_XDR, TEST_NETWORK);
    expect(result).toBe(TEST_SIGNED_XDR);
  });

  it('calls wallet.signTransaction with the original XDR and network', async () => {
    const wallet = makeWalletAdapter();
    const biometrics = makeSuccessfulBiometrics();
    const adapter = createBiometricWalletAdapter(wallet, biometrics);

    await adapter.signTransaction(TEST_XDR, TEST_NETWORK);
    expect(wallet.signTransaction).toHaveBeenCalledWith(TEST_XDR, TEST_NETWORK);
  });

  it('calls biometrics.authenticate with the configured promptMessage', async () => {
    const wallet = makeWalletAdapter();
    const biometrics = makeSuccessfulBiometrics();
    const options: BiometricWalletOptions = { promptMessage: 'Sign this transaction' };
    const adapter = createBiometricWalletAdapter(wallet, biometrics, options);

    await adapter.signTransaction(TEST_XDR, TEST_NETWORK);
    expect(biometrics.authenticate).toHaveBeenCalledWith({
      promptMessage: 'Sign this transaction',
    });
  });

  it('uses a default prompt message when none is provided', async () => {
    const wallet = makeWalletAdapter();
    const biometrics = makeSuccessfulBiometrics();
    const adapter = createBiometricWalletAdapter(wallet, biometrics);

    await adapter.signTransaction(TEST_XDR, TEST_NETWORK);
    expect(biometrics.authenticate).toHaveBeenCalledWith(
      expect.objectContaining({ promptMessage: expect.any(String) }),
    );
    const call = (biometrics.authenticate as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(call?.promptMessage.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// getPublicKey — biometrics gate when requireForPublicKey is set
// ---------------------------------------------------------------------------

describe('createBiometricWalletAdapter (#796) — getPublicKey biometrics gate', () => {
  it('does NOT require biometrics for getPublicKey by default', async () => {
    const wallet = makeWalletAdapter();
    const biometrics = makeSuccessfulBiometrics();
    const adapter = createBiometricWalletAdapter(wallet, biometrics);

    const key = await adapter.getPublicKey();
    expect(key).toBe(TEST_PUBLIC_KEY);
    // Without requireForPublicKey, no biometric prompt should have been shown.
    expect(biometrics.authenticate).not.toHaveBeenCalled();
  });

  it('rejects getPublicKey when requireForPublicKey=true and user cancels', async () => {
    const wallet = makeWalletAdapter();
    const biometrics = makeCancelledBiometrics();
    const adapter = createBiometricWalletAdapter(wallet, biometrics, {
      requireForPublicKey: true,
    });

    await expect(adapter.getPublicKey()).rejects.toThrow(/failed or was cancelled/i);
    expect(wallet.getPublicKey).not.toHaveBeenCalled();
  });

  it('allows getPublicKey when requireForPublicKey=true and biometrics succeed', async () => {
    const wallet = makeWalletAdapter();
    const biometrics = makeSuccessfulBiometrics();
    const adapter = createBiometricWalletAdapter(wallet, biometrics, {
      requireForPublicKey: true,
    });

    const key = await adapter.getPublicKey();
    expect(key).toBe(TEST_PUBLIC_KEY);
    expect(biometrics.authenticate).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// unlockTtlMs — TTL caching
// ---------------------------------------------------------------------------

describe('createBiometricWalletAdapter (#796) — unlockTtlMs caching', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('prompts biometrics only once within the TTL window', async () => {
    const wallet = makeWalletAdapter();
    const biometrics = makeSuccessfulBiometrics();
    const adapter = createBiometricWalletAdapter(wallet, biometrics, { unlockTtlMs: 30_000 });

    await adapter.signTransaction(TEST_XDR, TEST_NETWORK);
    await adapter.signTransaction(TEST_XDR, TEST_NETWORK);

    // TTL not yet expired — authenticate should only have been called once.
    expect(biometrics.authenticate).toHaveBeenCalledOnce();

    vi.useRealTimers();
  });

  it('prompts biometrics again after the TTL expires', async () => {
    const wallet = makeWalletAdapter();
    const biometrics = makeSuccessfulBiometrics();
    const adapter = createBiometricWalletAdapter(wallet, biometrics, { unlockTtlMs: 1_000 });

    await adapter.signTransaction(TEST_XDR, TEST_NETWORK);

    // Advance time past the TTL.
    vi.advanceTimersByTime(2_000);

    await adapter.signTransaction(TEST_XDR, TEST_NETWORK);

    // authenticate must have been called again after TTL expired.
    expect(biometrics.authenticate).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});
