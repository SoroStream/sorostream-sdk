/**
 * Decimal-aware stroop conversion utilities (Issue #396).
 *
 * SAC tokens on Stellar are assumed to have 7 decimal places, but non-standard
 * tokens (e.g. EURC with 6 decimals, or a hypothetical 2-decimal stablecoin)
 * require the stroop factor to be adjusted so that amounts are created and
 * displayed with the correct precision.
 *
 * This module provides:
 *  - `toStroopsForToken`   – converts a decimal string using the token's actual decimals
 *  - `fromStroopsForToken` – formats a stroop bigint back to a human-readable string
 *  - `getTokenDecimals`    – resolves decimals from the metadata cache or via RPC
 */

import { toStroops, formatUSDC } from './utils.js';
import type { TokenMetadata } from './types.js';

/**
 * A minimal interface for anything that can look up token metadata.
 * Both `SoroStreamClient` and `MockSoroStreamClient` satisfy this.
 */
export interface TokenMetadataProvider {
  getTokenMetadata(tokenAddress: string): Promise<TokenMetadata>;
}

// ── Negative-lookup cache (issues #684, #XXX) ────────────────────────────────
//
// SCOPING NOTE (issue #XXX):
// The cache is keyed by `networkPassphrase + '\0' + tokenAddress` rather than
// by token address alone.  A failed decimals lookup on testnet therefore never
// poisons the same token address on mainnet (or any other network), and two
// client instances pointed at different networks within the same process are
// fully isolated from each other.
//
// Callers that do not supply a network passphrase receive the sentinel key
// `'default\0<tokenAddress>'`, which preserves backward-compatible behaviour
// for single-network process deployments.

/**
 * Default TTL for caching failed/absent decimal lookups (5 minutes in ms).
 * After this window the SDK will retry the RPC call once.
 */
const DEFAULT_NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;

/** Sentinel network key used when no passphrase is supplied. */
export const DEFAULT_NETWORK_KEY = 'default';

interface NegativeEntry {
  /** The error (or `null` for a missing-decimals result) that was cached. */
  error: unknown;
  /** Absolute expiry timestamp (ms since epoch). */
  expiresAt: number;
}

/**
 * Per-process in-memory store for negative decimal lookups.
 * Keyed by `networkKey + '\0' + tokenAddress`; cleared automatically when
 * entries expire.
 */
const negativeLookupCache = new Map<string, NegativeEntry>();

/** Builds the composite cache key from a network identifier and token address. */
function negativeCacheKey(networkKey: string, tokenAddress: string): string {
  return `${networkKey}\0${tokenAddress}`;
}

/**
 * Records a failed decimals lookup so subsequent calls skip the RPC until TTL
 * expires.
 *
 * @param tokenAddress - SAC token contract address.
 * @param error        - The error thrown by the metadata provider.
 * @param ttlMs        - Cache entry lifetime (default: 5 min).
 * @param networkKey   - Network passphrase (or any unique per-network string).
 *                       Defaults to `'default'` for backward compatibility.
 *
 * @internal
 */
export function _cacheNegativeLookup(
  tokenAddress: string,
  error: unknown,
  ttlMs = DEFAULT_NEGATIVE_CACHE_TTL_MS,
  networkKey = DEFAULT_NETWORK_KEY,
): void {
  negativeLookupCache.set(negativeCacheKey(networkKey, tokenAddress), {
    error,
    expiresAt: Date.now() + ttlMs,
  });
}

/**
 * Returns the cached negative entry for `tokenAddress` on `networkKey` if it
 * is still within its TTL, or `undefined` if there is no valid entry.
 *
 * @param tokenAddress - SAC token contract address.
 * @param networkKey   - Network passphrase (or any unique per-network string).
 *                       Defaults to `'default'` for backward compatibility.
 *
 * @internal
 */
export function _getNegativeCacheEntry(
  tokenAddress: string,
  networkKey = DEFAULT_NETWORK_KEY,
): NegativeEntry | undefined {
  const key = negativeCacheKey(networkKey, tokenAddress);
  const entry = negativeLookupCache.get(key);
  if (!entry) return undefined;
  if (Date.now() >= entry.expiresAt) {
    negativeLookupCache.delete(key);
    return undefined;
  }
  return entry;
}

/**
 * Clears the negative-lookup cache entirely (useful in tests).
 *
 * @internal
 */
export function _clearNegativeLookupCache(): void {
  negativeLookupCache.clear();
}

/**
 * Converts a human-readable token amount (decimal string) to the token's
 * smallest unit (analogous to "stroops" for the token's native precision).
 *
 * When `decimals` is 7 (the standard SAC default), this is identical to
 * `toStroops(amount)`.  For other precisions the factor is adjusted so that,
 * for example, `toStroopsForToken("1.00", 6)` returns `1_000_000n`.
 *
 * @param amount   - Human-readable amount, e.g. `"100.50"`.
 * @param decimals - Number of decimal places the token uses (from `getTokenMetadata`).
 * @returns Amount in the token's smallest unit as a `bigint`.
 *
 * @example
 * ```ts
 * // EURC has 6 decimals
 * toStroopsForToken("1.000000", 6)  // → 1_000_000n
 * // USDC has 7 decimals (standard SAC)
 * toStroopsForToken("1.0000000", 7) // → 10_000_000n
 * ```
 */
export function toStroopsForToken(amount: string, decimals: number): bigint {
  return toStroops(amount, decimals, 'truncate');
}

/**
 * Formats a raw token amount (in the token's smallest unit) back to a
 * human-readable decimal string, using the token's actual decimal precision.
 *
 * @param units    - Amount in the token's smallest unit.
 * @param decimals - Number of decimal places the token uses (from `getTokenMetadata`).
 * @returns Human-readable string, e.g. `"1.000000"` for a 6-decimal token.
 *
 * @example
 * ```ts
 * fromStroopsForToken(1_000_000n, 6)  // → "1.000000"
 * fromStroopsForToken(10_000_000n, 7) // → "1.0000000"
 * ```
 */
export function fromStroopsForToken(units: bigint, decimals: number): string {
  return formatUSDC(units, decimals);
}

/**
 * Resolves the decimal precision for a token by querying the metadata provider
 * (which caches results after the first RPC call).
 *
 * For tokens whose decimals cannot be resolved (non-SAC tokens with no
 * on-chain metadata), the failed lookup is cached for `negativeCacheTtlMs`
 * milliseconds so that repeated calls do not re-trigger the RPC fallback
 * (issue #684).
 *
 * ### Cross-network isolation (issue #XXX)
 * The negative-lookup cache is scoped by `networkKey` so that a failed lookup
 * on testnet cannot poison the same token address on mainnet.  Pass the
 * Stellar network passphrase (e.g. `Networks.TESTNET`) or any other
 * per-network string as `networkKey`.  When omitted, entries are stored under
 * the sentinel key `'default'`, preserving backward-compatible behaviour for
 * single-network deployments.
 *
 * @param tokenAddress       - SAC token contract address.
 * @param metadataProvider   - Any object that implements `getTokenMetadata`.
 * @param negativeCacheTtlMs - TTL for caching failed lookups (default: 5 min).
 * @param networkKey         - Network passphrase or unique per-network string
 *                             used to scope the negative-lookup cache.
 *                             Defaults to `'default'`.
 * @returns The number of decimal places for this token.
 *
 * @example
 * ```ts
 * import { Networks } from '@stellar/stellar-sdk';
 * const decimals = await getTokenDecimals(eurcAddress, client, 300_000, Networks.PUBLIC);
 * const units = toStroopsForToken("50.00", decimals);
 * ```
 */
export async function getTokenDecimals(
  tokenAddress: string,
  metadataProvider: TokenMetadataProvider,
  negativeCacheTtlMs = DEFAULT_NEGATIVE_CACHE_TTL_MS,
  networkKey = DEFAULT_NETWORK_KEY,
): Promise<number> {
  // Check the negative cache first — avoids a redundant RPC call for tokens
  // that have previously failed to resolve.
  const cached = _getNegativeCacheEntry(tokenAddress, networkKey);
  if (cached) {
    throw cached.error;
  }

  try {
    const metadata = await metadataProvider.getTokenMetadata(tokenAddress);
    return metadata.decimals;
  } catch (err) {
    // Cache the failure so subsequent calls skip the RPC for this TTL window.
    _cacheNegativeLookup(tokenAddress, err, negativeCacheTtlMs, networkKey);
    throw err;
  }
}

/**
 * Converts a human-readable token amount to its smallest-unit representation,
 * automatically fetching the token's decimal precision via `metadataProvider`.
 *
 * This is the recommended high-level helper when the decimals are not known
 * ahead of time.
 *
 * @param amount           - Human-readable amount string.
 * @param tokenAddress     - SAC token contract address.
 * @param metadataProvider - Any object that implements `getTokenMetadata`.
 * @returns Amount in the token's smallest unit as a `bigint`.
 *
 * @example
 * ```ts
 * const amount = await convertToTokenUnits("100", eurcAddress, client);
 * await client.createStream({ ..., amount, token: eurcAddress });
 * ```
 */
export async function convertToTokenUnits(
  amount: string,
  tokenAddress: string,
  metadataProvider: TokenMetadataProvider,
): Promise<bigint> {
  const decimals = await getTokenDecimals(tokenAddress, metadataProvider);
  return toStroopsForToken(amount, decimals);
}

/**
 * Formats a raw token amount back to human-readable form, automatically
 * fetching the token's decimal precision via `metadataProvider`.
 *
 * @param units            - Amount in the token's smallest unit.
 * @param tokenAddress     - SAC token contract address.
 * @param metadataProvider - Any object that implements `getTokenMetadata`.
 * @returns Human-readable decimal string.
 *
 * @example
 * ```ts
 * const display = await formatTokenAmount(claimable, eurcAddress, client);
 * console.log(`Claimable: ${display} EURC`);
 * ```
 */
export async function formatTokenAmount(
  units: bigint,
  tokenAddress: string,
  metadataProvider: TokenMetadataProvider,
): Promise<string> {
  const decimals = await getTokenDecimals(tokenAddress, metadataProvider);
  return fromStroopsForToken(units, decimals);
}
