/**
 * Issue #762: `src/sorostream-config.ts` (loadSorostreamConfig, supporting a
 * project-level `sorostream.config.ts/.js` file) was not wired into
 * `SoroStreamClient`'s construction path, so the config-file feature did not
 * take effect for any real client instance.
 *
 * This test confirms:
 * 1. `loadSorostreamConfig` and `mergeSorostreamConfig` are reachable via the
 *    public entry point (`@sorostream/sdk`).
 * 2. The `createClient` async factory correctly reads a fixture
 *    `sorostream.config.js` file and applies its values as defaults for the
 *    constructed `SoroStreamClient`.
 * 3. Runtime options passed directly to `createClient` always take precedence
 *    over values from the config file.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Import via the public barrel ─────────────────────────────────────────────
import {
  loadSorostreamConfig,
  mergeSorostreamConfig,
  createClient,
  SoroStreamClient,
} from '../src/index.js';
import type { SorostreamConfig } from '../src/index.js';

const VALID_CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const ALT_CONTRACT = 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBZXOIIU';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Creates a temporary directory containing a `sorostream.config.js` with the
 * given config object (CJS `module.exports`), and returns the directory path.
 */
function makeTempConfigDir(config: SorostreamConfig): string {
  const dir = mkdtempSync(join(tmpdir(), 'sorostream-config-test-'));
  const src = `module.exports = ${JSON.stringify(config)};`;
  writeFileSync(join(dir, 'sorostream.config.js'), src, 'utf-8');
  return dir;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Issue #762: sorostream-config exported from public entry point', () => {
  it('loadSorostreamConfig is callable from the public entry point', async () => {
    expect(typeof loadSorostreamConfig).toBe('function');
    // No config file in cwd → returns null silently.
    const result = await loadSorostreamConfig('/tmp/definitely-not-a-real-sorostream-project');
    expect(result).toBeNull();
  });

  it('mergeSorostreamConfig is callable from the public entry point', () => {
    expect(typeof mergeSorostreamConfig).toBe('function');
    const merged = mergeSorostreamConfig(
      { network: 'testnet', contractId: VALID_CONTRACT },
      { contractId: 'RUNTIME_WINS', network: 'mainnet' },
    );
    // Runtime options take precedence.
    expect(merged.contractId).toBe('RUNTIME_WINS');
    expect(merged.network).toBe('mainnet');
  });

  it('SorostreamConfig type is importable from the public entry point', () => {
    const config: SorostreamConfig = {
      network: 'testnet',
      contractId: VALID_CONTRACT,
      timeoutMs: 30_000,
      logLevel: 'warn',
    };
    expect(config.network).toBe('testnet');
  });
});

describe('Issue #762: loadSorostreamConfig reads a fixture config file', () => {
  it('loads a CJS sorostream.config.js and returns its exported object', async () => {
    const dir = makeTempConfigDir({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      timeoutMs: 45_000,
      logLevel: 'debug',
    });

    try {
      const config = await loadSorostreamConfig(dir);
      expect(config).not.toBeNull();
      expect(config!.network).toBe('testnet');
      expect(config!.contractId).toBe(VALID_CONTRACT);
      expect(config!.timeoutMs).toBe(45_000);
      expect(config!.logLevel).toBe('debug');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a directory with no config file (silent, not an error)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sorostream-empty-'));
    try {
      const config = await loadSorostreamConfig(dir);
      expect(config).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Issue #762: mergeSorostreamConfig applies file defaults, runtime options win', () => {
  it('applies file config fields when runtime options omit them', () => {
    const fileConfig: SorostreamConfig = {
      network: 'testnet',
      contractId: VALID_CONTRACT,
      rpcUrl: 'https://soroban-testnet.stellar.org',
      timeoutMs: 60_000,
    };
    const merged = mergeSorostreamConfig(fileConfig, { contractId: VALID_CONTRACT });
    expect(merged.network).toBe('testnet');
    expect(merged.rpcUrl).toBe('https://soroban-testnet.stellar.org');
    // timeoutMs → txTimeoutMs mapping
    expect((merged as any).txTimeoutMs).toBe(60_000);
  });

  it('runtime contractId wins over file config contractId', () => {
    const fileConfig: SorostreamConfig = { contractId: VALID_CONTRACT };
    const merged = mergeSorostreamConfig(fileConfig, { contractId: ALT_CONTRACT });
    expect(merged.contractId).toBe(ALT_CONTRACT);
  });

  it('null fileConfig is a no-op — returns runtimeOptions unchanged', () => {
    const opts = { network: 'mainnet' as const, contractId: VALID_CONTRACT };
    const merged = mergeSorostreamConfig(null, opts);
    expect(merged).toBe(opts); // exact same reference
  });
});

describe('Issue #762: createClient wires config file into SoroStreamClient construction', () => {
  it('createClient returns a SoroStreamClient and respects skipConfigFile', async () => {
    // skipConfigFile: true → no file search, construct directly.
    const client = await createClient({
      network: 'testnet',
      contractId: VALID_CONTRACT,
      skipConfigFile: true,
    });
    expect(client).toBeInstanceOf(SoroStreamClient);
  });

  it('createClient reads a fixture config file and the client reflects its values', async () => {
    // The fixture sets network + contractId. The runtime call supplies the
    // same contractId (required field) and no network override, so the client
    // must pick up the network from the file.
    const dir = makeTempConfigDir({
      network: 'testnet',
      rpcUrl: 'https://soroban-testnet.stellar.org',
    });

    try {
      const client = await createClient({
        contractId: VALID_CONTRACT,
        configFileCwd: dir,
      });
      expect(client).toBeInstanceOf(SoroStreamClient);
      // The network 'testnet' was supplied only by the config file — if the
      // client constructed successfully (SoroStreamClient throws when it
      // cannot determine the network), the config file was read and applied.
      expect(client.getNetwork()).toBe('testnet');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runtime option always overrides the config file value', async () => {
    // Config file says testnet, runtime says mainnet — mainnet must win.
    const dir = makeTempConfigDir({ network: 'testnet', contractId: VALID_CONTRACT });

    try {
      const client = await createClient({
        network: 'mainnet',
        contractId: VALID_CONTRACT,
        configFileCwd: dir,
      });
      expect(client.getNetwork()).toBe('mainnet');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Issue (contractId empty-string asymmetry documentation) ─────────────────

describe('mergeSorostreamConfig – contractId empty-string fallback asymmetry', () => {
  const FILE_CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
  const FILE_RPC = 'https://file-config-rpc.stellar.org';

  it('applies file contractId when runtime contractId is an empty string (env-var-unset pattern)', () => {
    // contractId treats '' the same as undefined so that callers who write
    //   contractId: process.env.SOROSTREAM_CONTRACT_ID
    // still get the file default when the env var is not set.
    const merged = mergeSorostreamConfig({ contractId: FILE_CONTRACT }, { contractId: '' });
    expect(merged.contractId).toBe(FILE_CONTRACT);
  });

  it('does NOT apply file rpcUrl when runtime rpcUrl is an empty string (deliberate asymmetry)', () => {
    // rpcUrl: '' is treated as a deliberate caller choice (e.g. a custom
    // transport adapter is in use), so the file default is NOT applied.
    const merged = mergeSorostreamConfig({ rpcUrl: FILE_RPC }, { rpcUrl: '' });
    // The runtime empty string wins — the file value is NOT substituted.
    expect(merged.rpcUrl).toBe('');
  });

  it('applies file rpcUrl when runtime rpcUrl is undefined', () => {
    const merged = mergeSorostreamConfig({ rpcUrl: FILE_RPC }, { rpcUrl: undefined });
    expect(merged.rpcUrl).toBe(FILE_RPC);
  });

  it('does NOT apply file network when runtime network is undefined-equivalent string', () => {
    // Only undefined (omitted) triggers the fallback for network; any string value wins.
    const merged = mergeSorostreamConfig({ network: 'testnet' }, { network: 'mainnet' as const });
    expect(merged.network).toBe('mainnet');
  });

  it('a non-empty runtime contractId always takes precedence over file contractId', () => {
    const merged = mergeSorostreamConfig(
      { contractId: FILE_CONTRACT },
      { contractId: 'CRUNTIMEWINS1234567890123456789012345678901234567890' },
    );
    expect(merged.contractId).toBe('CRUNTIMEWINS1234567890123456789012345678901234567890');
  });
});
