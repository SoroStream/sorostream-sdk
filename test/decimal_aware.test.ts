/**
 * Tests for Issue #396: Non-7-decimal token support.
 *
 * Validates that `toStroopsForToken`, `fromStroopsForToken`,
 * `getTokenDecimals`, `convertToTokenUnits`, and `formatTokenAmount` all
 * handle tokens with non-standard decimal counts correctly.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  toStroopsForToken,
  fromStroopsForToken,
  getTokenDecimals,
  convertToTokenUnits,
  formatTokenAmount,
  _clearNegativeLookupCache,
  _getNegativeCacheEntry,
} from '../src/decimalAware.js';
import type { TokenMetadataProvider } from '../src/decimalAware.js';

afterEach(() => {
  vi.restoreAllMocks();
  _clearNegativeLookupCache();
});

// ── toStroopsForToken ─────────────────────────────────────────────────────

describe('toStroopsForToken', () => {
  it('converts a 7-decimal amount identically to toStroops', () => {
    expect(toStroopsForToken('1', 7)).toBe(10_000_000n);
    expect(toStroopsForToken('100.5000000', 7)).toBe(1_005_000_000n);
    expect(toStroopsForToken('0.0000001', 7)).toBe(1n);
  });

  it('converts a 6-decimal token (e.g. EURC)', () => {
    expect(toStroopsForToken('1', 6)).toBe(1_000_000n);
    expect(toStroopsForToken('1.000000', 6)).toBe(1_000_000n);
    expect(toStroopsForToken('0.000001', 6)).toBe(1n);
    expect(toStroopsForToken('50.50', 6)).toBe(50_500_000n);
  });

  it('truncates excess fractional digits for tokens with fewer than 7 decimals', () => {
    expect(toStroopsForToken('1.23456789', 6)).toBe(1_234_567n);
  });

  it('converts a 2-decimal token', () => {
    expect(toStroopsForToken('1.00', 2)).toBe(100n);
    expect(toStroopsForToken('99.99', 2)).toBe(9999n);
    expect(toStroopsForToken('0.01', 2)).toBe(1n);
  });

  it('converts an 18-decimal token', () => {
    expect(toStroopsForToken('1', 18)).toBe(1_000_000_000_000_000_000n);
    expect(toStroopsForToken('0.000000000000000001', 18)).toBe(1n);
  });

  it('handles zero', () => {
    expect(toStroopsForToken('0', 6)).toBe(0n);
    expect(toStroopsForToken('0.000000', 6)).toBe(0n);
  });

  it('handles negative amounts', () => {
    expect(toStroopsForToken('-1', 6)).toBe(-1_000_000n);
  });
});

// ── fromStroopsForToken ───────────────────────────────────────────────────

describe('fromStroopsForToken', () => {
  it('formats a 7-decimal token correctly', () => {
    expect(fromStroopsForToken(10_000_000n, 7)).toBe('1.0000000');
    expect(fromStroopsForToken(1n, 7)).toBe('0.0000001');
  });

  it('formats a 6-decimal token correctly', () => {
    expect(fromStroopsForToken(1_000_000n, 6)).toBe('1.000000');
    expect(fromStroopsForToken(1n, 6)).toBe('0.000001');
    expect(fromStroopsForToken(50_500_000n, 6)).toBe('50.500000');
  });

  it('formats a 2-decimal token correctly', () => {
    expect(fromStroopsForToken(100n, 2)).toBe('1.00');
    expect(fromStroopsForToken(9999n, 2)).toBe('99.99');
  });

  it('formats zero', () => {
    expect(fromStroopsForToken(0n, 6)).toBe('0.000000');
  });
});

// ── round-trip ────────────────────────────────────────────────────────────

describe('round-trip toStroopsForToken → fromStroopsForToken', () => {
  const cases: Array<[string, number]> = [
    ['1.000000', 6],
    ['100.5000000', 7],
    ['99.99', 2],
    ['0.000001', 6],
  ];

  for (const [amount, decimals] of cases) {
    it(`round-trips "${amount}" at ${decimals} decimals`, () => {
      const units = toStroopsForToken(amount, decimals);
      const back = fromStroopsForToken(units, decimals);
      expect(back).toBe(amount);
    });
  }
});

// ── getTokenDecimals ──────────────────────────────────────────────────────

describe('getTokenDecimals', () => {
  const TOKEN = 'CAVTXNC2WCHINDNP4VBLSOQA2667VE3RPQZNGD5TFI4U2QSHTVAC667T';

  it('returns the decimals from the metadata provider', async () => {
    const provider: TokenMetadataProvider = {
      getTokenMetadata: vi.fn().mockResolvedValue({ name: 'EURC', symbol: 'EURC', decimals: 6 }),
    };
    const decimals = await getTokenDecimals(TOKEN, provider);
    expect(decimals).toBe(6);
    expect(provider.getTokenMetadata).toHaveBeenCalledWith(TOKEN);
  });

  it('calls getTokenMetadata with the token address', async () => {
    const provider: TokenMetadataProvider = {
      getTokenMetadata: vi.fn().mockResolvedValue({ name: 'USDC', symbol: 'USDC', decimals: 7 }),
    };
    await getTokenDecimals(TOKEN, provider);
    expect(provider.getTokenMetadata).toHaveBeenCalledOnce();
    expect(provider.getTokenMetadata).toHaveBeenCalledWith(TOKEN);
  });
});

// ── convertToTokenUnits ───────────────────────────────────────────────────

describe('convertToTokenUnits', () => {
  const TOKEN = 'CAVTXNC2WCHINDNP4VBLSOQA2667VE3RPQZNGD5TFI4U2QSHTVAC667T';

  it('auto-fetches decimals and converts correctly (6-decimal token)', async () => {
    const provider: TokenMetadataProvider = {
      getTokenMetadata: vi.fn().mockResolvedValue({ name: 'EURC', symbol: 'EURC', decimals: 6 }),
    };
    const units = await convertToTokenUnits('50.50', TOKEN, provider);
    expect(units).toBe(50_500_000n);
  });

  it('auto-fetches decimals and converts correctly (7-decimal token)', async () => {
    const provider: TokenMetadataProvider = {
      getTokenMetadata: vi.fn().mockResolvedValue({ name: 'USDC', symbol: 'USDC', decimals: 7 }),
    };
    const units = await convertToTokenUnits('1', TOKEN, provider);
    expect(units).toBe(10_000_000n);
  });
});

// ── formatTokenAmount ─────────────────────────────────────────────────────

describe('formatTokenAmount', () => {
  const TOKEN = 'CAVTXNC2WCHINDNP4VBLSOQA2667VE3RPQZNGD5TFI4U2QSHTVAC667T';

  it('formats correctly for a 6-decimal token', async () => {
    const provider: TokenMetadataProvider = {
      getTokenMetadata: vi.fn().mockResolvedValue({ name: 'EURC', symbol: 'EURC', decimals: 6 }),
    };
    const display = await formatTokenAmount(1_500_000n, TOKEN, provider);
    expect(display).toBe('1.500000');
  });

  it('formats correctly for a 7-decimal token', async () => {
    const provider: TokenMetadataProvider = {
      getTokenMetadata: vi.fn().mockResolvedValue({ name: 'USDC', symbol: 'USDC', decimals: 7 }),
    };
    const display = await formatTokenAmount(10_000_000n, TOKEN, provider);
    expect(display).toBe('1.0000000');
  });

  it('caches via the provider (called only once)', async () => {
    const provider: TokenMetadataProvider = {
      getTokenMetadata: vi.fn().mockResolvedValue({ name: 'EURC', symbol: 'EURC', decimals: 6 }),
    };
    await formatTokenAmount(1_000_000n, TOKEN, provider);
    await formatTokenAmount(2_000_000n, TOKEN, provider);
    // Each call hits the provider — caching is the provider's responsibility
    expect(provider.getTokenMetadata).toHaveBeenCalledTimes(2);
  });
});

// ── Issue #684: negative lookup caching ───────────────────────────────────────

describe('getTokenDecimals negative-lookup cache (issue #684)', () => {
  const NON_SAC_TOKEN = 'CNONSAC000000000000000000000000000000000000000000000000001';
  const rpcError = new Error('contract not found');

  it('only calls the provider once for a failing token within TTL', async () => {
    const provider: TokenMetadataProvider = {
      getTokenMetadata: vi.fn().mockRejectedValue(rpcError),
    };

    await expect(getTokenDecimals(NON_SAC_TOKEN, provider, 60_000)).rejects.toBe(rpcError);
    await expect(getTokenDecimals(NON_SAC_TOKEN, provider, 60_000)).rejects.toBe(rpcError);
    await expect(getTokenDecimals(NON_SAC_TOKEN, provider, 60_000)).rejects.toBe(rpcError);

    // Provider was only called once; the next two were served from the cache.
    expect(provider.getTokenMetadata).toHaveBeenCalledOnce();
  });

  it('retries the RPC after the TTL expires', async () => {
    const provider: TokenMetadataProvider = {
      getTokenMetadata: vi.fn().mockRejectedValue(rpcError),
    };

    // Use a 0ms TTL so the entry expires immediately
    await expect(getTokenDecimals(NON_SAC_TOKEN, provider, 0)).rejects.toBe(rpcError);

    // Advance time slightly to ensure expiry
    await new Promise((r) => setTimeout(r, 1));

    await expect(getTokenDecimals(NON_SAC_TOKEN, provider, 0)).rejects.toBe(rpcError);

    // Both calls hit the provider because the cache entry expired
    expect(provider.getTokenMetadata).toHaveBeenCalledTimes(2);
  });

  it('does not cache successful lookups in the negative cache', async () => {
    const TOKEN_OK = 'CAVTXNC2WCHINDNP4VBLSOQA2667VE3RPQZNGD5TFI4U2QSHTVAC667T';
    const provider: TokenMetadataProvider = {
      getTokenMetadata: vi.fn().mockResolvedValue({ name: 'USDC', symbol: 'USDC', decimals: 7 }),
    };

    await getTokenDecimals(TOKEN_OK, provider);
    expect(_getNegativeCacheEntry(TOKEN_OK)).toBeUndefined();
  });

  it('negative cache is scoped per token address', async () => {
    const TOKEN_A = 'CTOKENA0000000000000000000000000000000000000000000000000001';
    const TOKEN_B = 'CTOKENB0000000000000000000000000000000000000000000000000001';
    const providerA: TokenMetadataProvider = {
      getTokenMetadata: vi.fn().mockRejectedValue(rpcError),
    };
    const providerB: TokenMetadataProvider = {
      getTokenMetadata: vi.fn().mockResolvedValue({ name: 'TKB', symbol: 'TKB', decimals: 6 }),
    };

    await expect(getTokenDecimals(TOKEN_A, providerA, 60_000)).rejects.toBeDefined();
    // TOKEN_B has a valid lookup — should not be affected by TOKEN_A's cache entry
    expect(await getTokenDecimals(TOKEN_B, providerB)).toBe(6);
    expect(providerB.getTokenMetadata).toHaveBeenCalledOnce();
  });
});

// ── Issue #990: high-level helpers propagate a cached negative lookup ─────────

describe('convertToTokenUnits / formatTokenAmount cached negative lookup (issue #990)', () => {
  const FAILING_TOKEN = 'CFAILING00000000000000000000000000000000000000000000000001';
  const OTHER_TOKEN = 'CWORKING00000000000000000000000000000000000000000000000001';
  const lookupError = new Error('token metadata unavailable');

  function failingProvider(): TokenMetadataProvider {
    return { getTokenMetadata: vi.fn().mockRejectedValue(lookupError) };
  }

  it('convertToTokenUnits rethrows the cached error on repeated calls without a new lookup', async () => {
    const provider = failingProvider();

    await expect(convertToTokenUnits('10', FAILING_TOKEN, provider)).rejects.toBe(lookupError);
    await expect(convertToTokenUnits('10', FAILING_TOKEN, provider)).rejects.toBe(lookupError);
    await expect(convertToTokenUnits('25.5', FAILING_TOKEN, provider)).rejects.toBe(lookupError);

    expect(provider.getTokenMetadata).toHaveBeenCalledOnce();
  });

  it('formatTokenAmount rethrows the cached error on repeated calls without a new lookup', async () => {
    const provider = failingProvider();

    await expect(formatTokenAmount(1_000_000n, FAILING_TOKEN, provider)).rejects.toBe(lookupError);
    await expect(formatTokenAmount(1_000_000n, FAILING_TOKEN, provider)).rejects.toBe(lookupError);
    await expect(formatTokenAmount(5n, FAILING_TOKEN, provider)).rejects.toBe(lookupError);

    expect(provider.getTokenMetadata).toHaveBeenCalledOnce();
  });

  it('the cached error is shared between convertToTokenUnits and formatTokenAmount', async () => {
    const provider = failingProvider();

    await expect(convertToTokenUnits('1', FAILING_TOKEN, provider)).rejects.toBe(lookupError);
    // The first helper populated the negative cache; the second must not look up again.
    await expect(formatTokenAmount(1n, FAILING_TOKEN, provider)).rejects.toBe(lookupError);

    expect(provider.getTokenMetadata).toHaveBeenCalledOnce();
    expect(_getNegativeCacheEntry(FAILING_TOKEN)?.error).toBe(lookupError);
  });

  it('rethrows the very same error instance rather than a wrapped copy', async () => {
    const provider = failingProvider();

    const first = await convertToTokenUnits('1', FAILING_TOKEN, provider).catch((e) => e);
    const second = await convertToTokenUnits('1', FAILING_TOKEN, provider).catch((e) => e);

    expect(first).toBe(lookupError);
    expect(second).toBe(first);
  });

  it('does not let a cached failure for one token affect another token', async () => {
    const provider: TokenMetadataProvider = {
      getTokenMetadata: vi.fn().mockImplementation(async (address: string) => {
        if (address === FAILING_TOKEN) throw lookupError;
        return { name: 'OK', symbol: 'OK', decimals: 6 };
      }),
    };

    await expect(convertToTokenUnits('1', FAILING_TOKEN, provider)).rejects.toBe(lookupError);
    await expect(convertToTokenUnits('1', FAILING_TOKEN, provider)).rejects.toBe(lookupError);

    expect(await convertToTokenUnits('1', OTHER_TOKEN, provider)).toBe(1_000_000n);
    expect(await formatTokenAmount(1_000_000n, OTHER_TOKEN, provider)).toBe('1.000000');
    // FAILING_TOKEN once, OTHER_TOKEN once per helper call (successes are not cached negatively).
    expect(provider.getTokenMetadata).toHaveBeenCalledTimes(3);
  });

  it('retries the lookup once the negative-cache entry has expired', async () => {
    vi.useFakeTimers();
    try {
      const provider = failingProvider();

      await expect(convertToTokenUnits('1', FAILING_TOKEN, provider)).rejects.toBe(lookupError);
      await expect(formatTokenAmount(1n, FAILING_TOKEN, provider)).rejects.toBe(lookupError);
      expect(provider.getTokenMetadata).toHaveBeenCalledOnce();

      // Default negative-cache TTL is 5 minutes; move just past it.
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);

      await expect(convertToTokenUnits('1', FAILING_TOKEN, provider)).rejects.toBe(lookupError);
      expect(provider.getTokenMetadata).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
