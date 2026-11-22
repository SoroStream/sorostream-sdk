import { describe, expect, it, vi } from 'vitest';
import { computeSha256, verifyManifest } from '../src/bundleIntegrity.js';
import type { IntegrityManifest } from '../src/bundleIntegrity.js';

describe('verifyManifest', () => {
  it('reports a failing hash from a fetched resource resolver', async () => {
    const manifest: IntegrityManifest = {
      package: '@sorostream/sdk',
      version: '0.1.0',
      generatedAt: '2026-01-01T00:00:00.000Z',
      files: [{ file: 'index.js', sha256: computeSha256('expected'), size: 8 }],
    };
    const resolver = vi.fn().mockResolvedValue(new Response('tampered'));

    await expect(verifyManifest(manifest, resolver)).resolves.toEqual({
      valid: false,
      failures: ['index.js'],
    });
    expect(resolver).toHaveBeenCalledWith('index.js');
  });

  it('reports a passing hash from a fetched resource resolver', async () => {
    const content = 'expected';
    const manifest: IntegrityManifest = {
      package: '@sorostream/sdk',
      version: '0.1.0',
      generatedAt: '2026-01-01T00:00:00.000Z',
      files: [{ file: 'index.js', sha256: computeSha256(content), size: content.length }],
    };
    const resolver = vi.fn().mockResolvedValue(new Response(content));

    await expect(verifyManifest(manifest, resolver)).resolves.toEqual({
      valid: true,
      failures: [],
    });
    expect(resolver).toHaveBeenCalledWith('index.js');
  });
});

import { describe as describeGen, expect as expectGen, it as itGen } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { tmpdir } from 'node:os';
import { generateIntegrityManifest } from '../src/bundleIntegrity.js';

/**
 * Try to create a directory symlink. On Windows without Developer Mode or
 * elevated privileges, `symlinkSync` throws EPERM. Returns `true` on success,
 * `false` when the platform silently forbids it (so the test can be skipped).
 */
function trySymlink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, 'dir');
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw err;
  }
}

describeGen('generateIntegrityManifest – symlink cycle detection', () => {
  itGen('does not stack-overflow on a symlinked directory that creates a cycle', () => {
    // Build a temporary dist tree:
    //   <root>/
    //     a.js          (real file)
    //     sub/
    //       b.js        (real file)
    //       loop -> ../ (symlink pointing back to the root → cycle)
    const root = mkdtempSync(joinPath(tmpdir(), 'sorostream-integrity-cycle-'));
    const sub = joinPath(root, 'sub');
    mkdirSync(sub);
    writeFileSync(joinPath(root, 'a.js'), 'console.log("a");', 'utf-8');
    writeFileSync(joinPath(sub, 'b.js'), 'console.log("b");', 'utf-8');

    // On Windows without elevated privileges, directory symlinks are not
    // permitted (EPERM). Skip the symlink-specific assertions in that case,
    // but still verify the base tree is walked correctly.
    const symlinkCreated = trySymlink(root, joinPath(sub, 'loop'));

    try {
      // Must complete without throwing a RangeError (stack overflow) or any
      // other error, and must enumerate exactly the two real files.
      const manifest = generateIntegrityManifest(root, '@sorostream/sdk', '1.0.0');

      const filePaths = manifest.files.map((f) => f.file).sort();
      expectGen(filePaths).toContain('a.js');
      expectGen(filePaths).toContain('sub/b.js');

      if (symlinkCreated) {
        // The cycle (sub/loop) must NOT produce duplicate entries or cause
        // infinite recursion. 'a.js' must appear exactly once.
        const aCount = manifest.files.filter((f) => f.file === 'a.js').length;
        expectGen(aCount).toBe(1);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itGen('handles a dangling symlink without throwing', () => {
    const root = mkdtempSync(joinPath(tmpdir(), 'sorostream-integrity-dangling-'));
    writeFileSync(joinPath(root, 'real.js'), 'export {};', 'utf-8');

    // Symlink to a path that does not exist. Skip on Windows without privilege.
    const symlinkCreated = trySymlink(
      joinPath(root, 'does-not-exist'),
      joinPath(root, 'dangling'),
    );

    try {
      // Should not throw; the dangling symlink is silently skipped.
      const manifest = generateIntegrityManifest(root, '@sorostream/sdk', '1.0.0');
      const filePaths = manifest.files.map((f) => f.file);
      expectGen(filePaths).toContain('real.js');

      if (symlinkCreated) {
        // dangling entry must not appear in the manifest
        expectGen(filePaths.some((p) => p.includes('dangling'))).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itGen('processes a normal directory tree without symlinks correctly', () => {
    const root = mkdtempSync(joinPath(tmpdir(), 'sorostream-integrity-normal-'));
    const esm = joinPath(root, 'esm');
    const cjs = joinPath(root, 'cjs');
    mkdirSync(esm);
    mkdirSync(cjs);
    writeFileSync(joinPath(esm, 'index.js'), 'export const x = 1;', 'utf-8');
    writeFileSync(joinPath(cjs, 'index.cjs'), 'module.exports = 1;', 'utf-8');

    try {
      const manifest = generateIntegrityManifest(root, '@sorostream/sdk', '2.0.0');

      expectGen(manifest.package).toBe('@sorostream/sdk');
      expectGen(manifest.version).toBe('2.0.0');
      const paths = manifest.files.map((f) => f.file).sort();
      expectGen(paths).toEqual(['cjs/index.cjs', 'esm/index.js']);
      // Every entry must have a valid 64-hex sha256
      for (const entry of manifest.files) {
        expectGen(/^[0-9a-f]{64}$/.test(entry.sha256)).toBe(true);
        expectGen(entry.size).toBeGreaterThan(0);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
