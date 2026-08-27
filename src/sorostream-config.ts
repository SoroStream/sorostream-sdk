/**
 * @module sorostream-config
 *
 * Project-level configuration file support for \`@sorostream/sdk\`.
 *
 * When a \`sorostream.config.ts\` (or \`sorostream.config.js\`) file is present
 * at the project root (\`process.cwd()\`), {@link loadSorostreamConfig} reads
 * and merges it with the runtime options passed to \`SoroStreamClient\`.
 *
 * Runtime constructor options always take precedence over file config.
 *
 * ## Supported config fields
 *
 * | Field | Type | Maps to |
 * |---|---|---|
 * | \`rpcUrl\` | \`string\` | \`SoroStreamClientOptions.rpcUrl\` |
 * | \`networkPassphrase\` | \`string\` | informational only (passed through) |
 * | \`network\` | \`"mainnet" \\| "testnet" \\| "futurenet"\` | \`SoroStreamClientOptions.network\` |
 * | \`contractId\` | \`string\` | \`SoroStreamClientOptions.contractId\` |
 * | \`timeoutMs\` | \`number\` | \`SoroStreamClientOptions.txTimeoutMs\` |
 * | \`logLevel\` | \`"silent" \\| "error" \\| "warn" \\| "info" \\| "debug"\` | informational only |
 *
 * @example sorostream.config.ts
 * \`\`\`ts
 * import type { SorostreamConfig } from "@sorostream/sdk";
 *
 * const config: SorostreamConfig = {
 *   contractId: "CAABC...XYZ",
 *   rpcUrl: "https://soroban-testnet.stellar.org",
 *   network: "testnet",
 *   timeoutMs: 60_000,
 *   logLevel: "warn",
 * };
 *
 * export default config;
 * \`\`\`
 */

import path from 'node:path';
import type { Network } from './types.js';

// ── Config type ───────────────────────────────────────────────────────────────

/**
 * Shape of the \`sorostream.config.ts\` / \`sorostream.config.js\` project-level
 * defaults file.
 *
 * All fields are optional. Only the values you specify will override SDK
 * defaults. Fields left out fall back to their built-in defaults or to the
 * values you pass directly to \`new SoroStreamClient(options)\`.
 *
 * Export this as the \`default\` export from your config file.
 *
 * @example
 * \`\`\`ts
 * // sorostream.config.ts
 * import type { SorostreamConfig } from "@sorostream/sdk";
 *
 * export default {
 *   network: "mainnet",
 *   contractId: process.env.SOROSTREAM_CONTRACT_ID,
 *   rpcUrl: process.env.SOROSTREAM_RPC_URL,
 *   timeoutMs: 90_000,
 *   logLevel: "warn",
 * } satisfies SorostreamConfig;
 * \`\`\`
 */
export interface SorostreamConfig {
  /**
   * Custom Stellar Soroban RPC URL.
   * Overrides the built-in per-network default.
   * Also used for automatic network detection when \`network\` is omitted.
   *
   * @example "https://soroban-testnet.stellar.org"
   */
  rpcUrl?: string;

  /**
   * Override the Stellar network passphrase.
   * Only set this when connecting to a custom or private network.
   * For public networks leave this unset and use the \`network\` field instead.
   *
   * @example "Test SDF Network ; September 2015"
   */
  networkPassphrase?: string;

  /**
   * Stellar network to use (\`"mainnet"\`, \`"testnet"\`, or \`"futurenet"\`).
   * May be auto-detected from \`rpcUrl\` when omitted.
   */
  network?: Network;

  /**
   * Deployed SoroStream contract address.
   * Runtime constructor \`contractId\` takes precedence when both are set.
   *
   * @example "CAABC123...XYZ"
   */
  contractId?: string;

  /**
   * Maximum time in milliseconds to wait for a transaction to be confirmed.
   * Maps to \`txTimeoutMs\` in \`SoroStreamClientOptions\`.
   * @default 120000
   */
  timeoutMs?: number;

  /**
   * Log verbosity level for SDK-internal messages.
   *
   * - \`"silent"\` — no output
   * - \`"error"\`  — errors only
   * - \`"warn"\`   — errors + warnings (recommended for production)
   * - \`"info"\`   — general informational messages
   * - \`"debug"\`  — verbose debugging output
   *
   * @default "warn"
   */
  logLevel?: 'silent' | 'error' | 'warn' | 'info' | 'debug';
}

// ── Config loader ─────────────────────────────────────────────────────────────

/** Candidate file names the loader searches for, in priority order. */
const CONFIG_FILE_NAMES = [
  'sorostream.config.ts',
  'sorostream.config.js',
  'sorostream.config.mjs',
  'sorostream.config.cjs',
] as const;

/**
 * Attempts to load a \`sorostream.config.*\` file from \`process.cwd()\` (or a
 * custom \`cwd\` argument).
 *
 * Resolution order:
 * 1. \`sorostream.config.ts\`
 * 2. \`sorostream.config.js\`
 * 3. \`sorostream.config.mjs\`
 * 4. \`sorostream.config.cjs\`
 *
 * The first file found is loaded via a dynamic \`import()\`. The module must
 * export a {@link SorostreamConfig} object as its \`default\` export (ESM) or
 * as \`module.exports\` (CJS).
 *
 * Returns \`null\` when no config file is present — a missing file is
 * **silently ignored** and is never an error.
 *
 * @param cwd - Directory to search in. Defaults to \`process.cwd()\`.
 * @returns The loaded config object, or \`null\` if no config file was found.
 *
 * @example
 * \`\`\`ts
 * import { loadSorostreamConfig, mergeSorostreamConfig, SoroStreamClient } from "@sorostream/sdk";
 *
 * const fileConfig = await loadSorostreamConfig();
 * const options = mergeSorostreamConfig(fileConfig, {
 *   walletAdapter,
 *   contractId: "RUNTIME_OVERRIDE",   // overrides file config
 * });
 * const client = new SoroStreamClient(options);
 * \`\`\`
 */
export async function loadSorostreamConfig(cwd?: string): Promise<SorostreamConfig | null> {
  const root = cwd ?? (typeof process !== 'undefined' ? process.cwd() : '.');

  for (const fileName of CONFIG_FILE_NAMES) {
    const filePath = path.join(root, fileName);
    try {
      // Dynamic import works for both CJS (require-compatible) and ESM.
      // The file:// prefix is required on Windows for absolute paths.
      const url =
        typeof process !== 'undefined' && process.platform === 'win32'
          ? `file:///${filePath.replace(/\\/g, '/')}`
          : filePath;

      const mod = (await import(url)) as { default?: SorostreamConfig } | SorostreamConfig;

      // Accept both `export default config` and `module.exports = config`.
      const config: SorostreamConfig =
        (mod as { default?: SorostreamConfig }).default ?? (mod as SorostreamConfig);

      if (config && typeof config === 'object') {
        return config;
      }
    } catch {
      // Module not found or failed to load — silently try the next candidate.
      continue;
    }
  }

  return null;
}

// ── Merge helper ──────────────────────────────────────────────────────────────

/**
 * Merges a {@link SorostreamConfig} loaded from disk with the runtime options
 * passed to \`SoroStreamClient\`.
 *
 * **Runtime options always win.** File config provides defaults for any field
 * that the caller omits from the runtime options.
 *
 * \`timeoutMs\` from the file config is mapped to \`txTimeoutMs\` because that is
 * the name \`SoroStreamClientOptions\` uses.
 *
 * @param fileConfig - Config loaded by {@link loadSorostreamConfig}, or \`null\`.
 * @param runtimeOptions - Options the caller is passing to \`SoroStreamClient\`.
 * @returns A new options object with file defaults applied where needed.
 *
 * @example
 * \`\`\`ts
 * const fileConfig = await loadSorostreamConfig();
 * const merged = mergeSorostreamConfig(fileConfig, { walletAdapter, contractId });
 * const client = new SoroStreamClient(merged);
 * \`\`\`
 */
export function mergeSorostreamConfig<
  T extends {
    network?: Network;
    contractId?: string;
    rpcUrl?: string;
    txTimeoutMs?: number;
  },
>(fileConfig: SorostreamConfig | null, runtimeOptions: T): T {
  if (!fileConfig) return runtimeOptions;

  return {
    // Apply file-config defaults only when the runtime option is absent.
    ...(fileConfig.network !== undefined && runtimeOptions.network === undefined
      ? { network: fileConfig.network }
      : {}),
    ...(fileConfig.contractId !== undefined &&
    (runtimeOptions.contractId === undefined || runtimeOptions.contractId === '')
      ? { contractId: fileConfig.contractId }
      : {}),
    ...(fileConfig.rpcUrl !== undefined && runtimeOptions.rpcUrl === undefined
      ? { rpcUrl: fileConfig.rpcUrl }
      : {}),
    ...(fileConfig.timeoutMs !== undefined && runtimeOptions.txTimeoutMs === undefined
      ? { txTimeoutMs: fileConfig.timeoutMs }
      : {}),
    // Runtime options spread last — always take precedence.
    ...runtimeOptions,
  };
}
