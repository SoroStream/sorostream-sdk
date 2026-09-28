/**
 * Tree-shaking compatibility test suite (#643).
 * Verifies that package exports allow proper dead code elimination when bundled.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('Tree-shaking compatibility (#643)', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sorostream-treeshake-test-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('eliminates dead code when importing pure utility functions', async () => {
    const entryFile = path.join(tmpDir, 'entry_pure.js');
    fs.writeFileSync(
      entryFile,
      `import { toStroops, formatUSDC } from '${path.resolve('./src/utils.ts')}';
       console.log(formatUSDC(toStroops('100.50')));`,
    );

    const result = await esbuild.build({
      entryPoints: [entryFile],
      bundle: true,
      write: false,
      minify: false,
      treeShaking: true,
      format: 'esm',
      platform: 'node',
      target: 'es2022',
      external: ['@stellar/stellar-sdk'],
    });

    const outputCode = result.outputFiles[0].text;
    expect(outputCode).toBeDefined();

    // Verify dead code elimination: pure utilities entry should NOT contain SoroStreamClient
    expect(outputCode).not.toContain('class SoroStreamClient');
    expect(outputCode.length).toBeLessThan(15_000);
  });

  it('eliminates dead code when importing calculation utilities', async () => {
    const entryFile = path.join(tmpDir, 'entry_calc.js');
    fs.writeFileSync(
      entryFile,
      `import { claimableNow, isExpired } from '${path.resolve('./src/utils.ts')}';
       console.log(isExpired(1000, 2000, 1500));`,
    );

    const result = await esbuild.build({
      entryPoints: [entryFile],
      bundle: true,
      write: false,
      minify: false,
      treeShaking: true,
      format: 'esm',
      platform: 'node',
      target: 'es2022',
      external: ['@stellar/stellar-sdk'],
    });

    const outputCode = result.outputFiles[0].text;
    expect(outputCode).toBeDefined();
    expect(outputCode).not.toContain('class SoroStreamClient');
  });
});
