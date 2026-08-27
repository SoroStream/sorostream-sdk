/**
 * federationPlugin.ts
 *
 * Issue #401 — Built-in plugin that automatically resolves Stellar federation
 * addresses (user*domain.com) to Stellar account IDs (G-addresses) before
 * stream creation.
 *
 * Usage:
 * ```ts
 * import { SoroStreamClient, createFederationPlugin } from "@sorostream/sdk";
 *
 * const client = new SoroStreamClient({
 *   network: "testnet",
 *   contractId: "C...",
 *   walletAdapter,
 *   plugins: [createFederationPlugin()],
 * });
 *
 * // Federation address is automatically resolved before the transaction:
 * await client.createStream({
 *   recipient: "alice*example.com",
 *   token: "GUSDC...",
 *   amount: toStroops("100"),
 *   durationSeconds: 86400,
 *   autoRenew: false,
 * });
 * ```
 */

import type { SoroStreamPlugin, MiddlewareContext } from './types.js';
import { isFederationAddress, resolveFederationAddress } from './utils.js';
import { FederationResolutionError } from './errors.js';
import type { FetchAdapter } from './adapters.js';

// ── Types ────────────────────────────────────────────────────────────────────

/** Options for {@link createFederationPlugin}. */
export interface FederationPluginOptions {
  /**
   * TTL in milliseconds for the in-memory resolution cache.
   * Once a federation address has been resolved, the result is reused
   * for subsequent calls within this window to avoid redundant network
   * round-trips.
   * Default: 300 000 ms (5 minutes).
   */
  cacheTtlMs?: number;

  /**
   * Custom `fetch` implementation. Useful for server-side environments or
   * testing. Defaults to the global `fetch`.
   */
  fetch?: FetchAdapter;

  /**
   * When `true`, a failed resolution throws and prevents the stream from
   * being created. When `false` (default), the original unresolved address
   * is kept and the SDK's own validation handles the error downstream.
   */
  throwOnResolutionFailure?: boolean;

  /**
   * Optional callback invoked after a successful resolution, useful for
   * logging or telemetry.
   *
   * @param federationAddress - The original federation address (e.g. "alice*example.com").
   * @param stellarAddress - The resolved G-address.
   * @param fromCache - Whether the result was served from the in-memory cache.
   */
  onResolved?: (federationAddress: string, stellarAddress: string, fromCache: boolean) => void;
}

// ── Cache entry ───────────────────────────────────────────────────────────────

interface CacheEntry {
  stellarAddress: string;
  expiresAt: number;
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Creates a {@link SoroStreamPlugin} that intercepts `createStream` calls and
 * automatically resolves Stellar federation addresses (user*domain.com) in the
 * `recipient` field to raw Stellar account IDs before the transaction is built.
 *
 * The plugin maintains its own in-memory resolution cache (keyed by federation
 * address) with a configurable TTL to avoid repeated network lookups within the
 * same session.
 *
 * @param options - Plugin configuration.
 * @returns A `SoroStreamPlugin` ready to pass to `plugins` in the client config.
 *
 * @example
 * ```ts
 * const client = new SoroStreamClient({
 *   network: "testnet",
 *   contractId: "C...",
 *   walletAdapter,
 *   plugins: [
 *     createFederationPlugin({
 *       cacheTtlMs: 60_000, // 1 minute
 *       throwOnResolutionFailure: true,
 *       onResolved: (fed, stellar, cached) =>
 *         console.log(`Resolved ${fed} → ${stellar}${cached ? " (cached)" : ""}`),
 *     }),
 *   ],
 * });
 * ```
 */
export function createFederationPlugin(options: FederationPluginOptions = {}): SoroStreamPlugin {
  const cacheTtlMs = options.cacheTtlMs ?? 300_000; // 5 minutes
  const fetchImpl: FetchAdapter = options.fetch ?? (globalThis.fetch as FetchAdapter);
  const throwOnFailure = options.throwOnResolutionFailure ?? false;
  const onResolved = options.onResolved;

  /** In-memory resolution cache: federation address → CacheEntry */
  const cache = new Map<string, CacheEntry>();

  /**
   * Returns the cached stellar address for `federationAddress` if the entry
   * is still within TTL, otherwise `undefined`.
   */
  function getCached(federationAddress: string): string | undefined {
    const entry = cache.get(federationAddress);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      cache.delete(federationAddress);
      return undefined;
    }
    return entry.stellarAddress;
  }

  /**
   * Stores a resolved stellar address in the cache.
   */
  function setCached(federationAddress: string, stellarAddress: string): void {
    cache.set(federationAddress, {
      stellarAddress,
      expiresAt: Date.now() + cacheTtlMs,
    });
  }

  /**
   * Resolves a single federation address, using the cache when available.
   * Returns `null` when resolution fails and `throwOnFailure` is `false`.
   */
  async function resolve(federationAddress: string): Promise<string | null> {
    const cached = getCached(federationAddress);
    if (cached !== undefined) {
      onResolved?.(federationAddress, cached, true);
      return cached;
    }

    try {
      const stellarAddress = await resolveFederationAddress(federationAddress, fetchImpl);
      setCached(federationAddress, stellarAddress);
      onResolved?.(federationAddress, stellarAddress, false);
      return stellarAddress;
    } catch (err) {
      if (throwOnFailure) {
        throw err instanceof FederationResolutionError
          ? err
          : new FederationResolutionError(
              federationAddress,
              err instanceof Error ? err.message : String(err),
            );
      }
      // Silent failure — let the address through unchanged; downstream
      // validation (InvalidAddressError) will catch the bad format.
      return null;
    }
  }

  const plugin: SoroStreamPlugin = {
    /**
     * Before `createStream`: resolve any federation address in `params.recipient`.
     * The params object is mutated in-place so the SDK sees the resolved address.
     */
    async before(ctx: MiddlewareContext): Promise<void> {
      // Only intercept createStream calls
      if (ctx.method !== 'createStream') return;

      const params = ctx.args[0] as Record<string, unknown> | undefined;
      if (!params || typeof params !== 'object') return;

      const recipient = params['recipient'];
      if (typeof recipient !== 'string') return;
      if (!isFederationAddress(recipient)) return;

      const resolved = await resolve(recipient);
      if (resolved !== null) {
        // Mutate in place — the client receives the G-address
        params['recipient'] = resolved;
      }
    },
  };

  return plugin;
}
