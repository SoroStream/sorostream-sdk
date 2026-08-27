/**
 * Issue #468: snapshot tests for the public SDK's TypeScript type shapes.
 *
 * Compiles each public entry point's declaration output and compares it
 * against a committed baseline under test/type-shapes/, so an accidental
 * breaking type change (renamed/removed export, widened or narrowed member
 * type, etc.) fails CI instead of shipping silently.
 *
 * This repo's vitest snapshots (test/__snapshots__/*.snap) are gitignored,
 * so toMatchSnapshot() can't provide that guarantee here — a fresh CI
 * checkout would just regenerate and always pass. Plain tracked baseline
 * files are used instead.
 *
 * After a deliberate public API change, regenerate the baselines with:
 *   UPDATE_TYPE_SHAPES=1 npm test -- test/type-snapshots.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_ENTRY_POINTS = ['index', 'wallets', 'mock', 'testing', 'simulator'];
const BASELINE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'type-shapes');

describe('public API type shapes', () => {
  let outDir: string;

  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), 'sorostream-type-snapshots-'));
    // `tsc` still emits declaration files for unrelated pre-existing type
    // errors elsewhere in the project, so its exit code is intentionally
    // ignored here — the per-entry existsSync check below is what actually
    // guards this test.
    spawnSync(
      'npx',
      ['tsc', '--project', 'tsconfig.json', '--declaration', '--emitDeclarationOnly', '--outDir', outDir],
      { stdio: 'pipe' },
    );
    const missing = PUBLIC_ENTRY_POINTS.filter((entry) => !existsSync(join(outDir, `${entry}.d.ts`)));
    if (missing.length > 0) {
      throw new Error(`tsc did not emit declaration files for: ${missing.join(', ')}`);
    }
  }, 60_000);

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  for (const entry of PUBLIC_ENTRY_POINTS) {
    it(`${entry}.d.ts matches its committed type-shape baseline`, () => {
      const declaration = readFileSync(join(outDir, `${entry}.d.ts`), 'utf-8');
      const baselinePath = join(BASELINE_DIR, `${entry}.d.ts`);

      if (process.env.UPDATE_TYPE_SHAPES) {
        mkdirSync(BASELINE_DIR, { recursive: true });
        writeFileSync(baselinePath, declaration);
        return;
      }

      if (!existsSync(baselinePath)) {
        throw new Error(
          `No type-shape baseline for "${entry}". Run with UPDATE_TYPE_SHAPES=1 to create one.`,
        );
      }
      const baseline = readFileSync(baselinePath, 'utf-8');
      expect(declaration).toBe(baseline);
    });
  }
});
