import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

// ── Issue #206: Tree-shaking annotations ─────────────────────────────────────
//
// Verifies that bundling an app which only imports from `@sorostream/sdk/core`
// does not pull in the wallet adapters (and their heavy browser/hardware
// dependencies) into the output bundle. Requires `npm run build` to have
// produced `dist/` first.

const distDir = path.resolve(__dirname, '../dist');
const distBuilt = existsSync(path.join(distDir, 'core.mjs'));

describe.skipIf(!distBuilt)('tree-shaking: @sorostream/sdk/core excludes wallet code', () => {
  let bundle: string;

  beforeAll(async () => {
    const result = await esbuild.build({
      stdin: {
        contents: `import { SoroStreamClient } from ${JSON.stringify(path.join(distDir, 'core.mjs'))};\nconsole.log(SoroStreamClient);`,
        resolveDir: distDir,
      },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
    });
    bundle = result.outputFiles[0]!.text;
  });

  it('does not include wallet adapter source', () => {
    expect(bundle).not.toMatch(
      /createFreighterAdapter|createPasskeyAdapter|createMultisigAdapter|createClaimDelegateAdapter/,
    );
  });

  it('does not reference the freighter or ledger packages', () => {
    expect(bundle).not.toMatch(/@stellar\/freighter-api|@ledgerhq/);
  });

  it('does include the core client', () => {
    expect(bundle).toMatch(/SoroStreamClient/);
  });
});

describe.skipIf(!distBuilt)('sub-path exports resolve in both module formats', () => {
  const entries = ['index', 'core', 'wallets', 'wallet', 'batch', 'mock', 'testing'];

  it.each(entries)('%s has ESM, CJS, and type declaration outputs', (entry) => {
    // "wallet" and "wallets" share the same built output (aliased in package.json).
    const base = entry === 'wallet' ? 'wallets' : entry;
    expect(existsSync(path.join(distDir, `${base}.mjs`))).toBe(true);
    expect(existsSync(path.join(distDir, `${base}.js`))).toBe(true);
    expect(existsSync(path.join(distDir, `${base}.d.ts`))).toBe(true);
  });
});

// ── Issue #223: Lazy-loading wallet adapter code ────────────────────────────────
//
// Verifies that importing from the main @sorostream/sdk entry point does not
// pull in wallet adapter code, enabling read-only applications to avoid the
// initialization cost of wallet dependencies.

describe.skipIf(!distBuilt)('lazy-loading: main index excludes wallet code', () => {
  let bundle: string;

  beforeAll(async () => {
    const result = await esbuild.build({
      stdin: {
        contents: `import { SoroStreamClient } from ${JSON.stringify(path.join(distDir, 'index.mjs'))};\nconsole.log(SoroStreamClient);`,
        resolveDir: distDir,
      },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
    });
    bundle = result.outputFiles[0]!.text;
  });

  it('does not include wallet adapter source', () => {
    expect(bundle).not.toMatch(
      /createFreighterAdapter|createPasskeyAdapter|createMultisigAdapter|createClaimDelegateAdapter|createKeypairAdapter/,
    );
  });

  it('does not reference the freighter or ledger packages', () => {
    expect(bundle).not.toMatch(/@stellar\/freighter-api|@ledgerhq/);
  });

  it('does include the core client', () => {
    expect(bundle).toMatch(/SoroStreamClient/);
  });

  it('does include read-only utilities', () => {
    expect(bundle).toMatch(/getStream|getClaimable/);
  });
});
