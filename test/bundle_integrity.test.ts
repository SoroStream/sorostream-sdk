import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeSha256, verifyFileIntegrity, verifyManifest } from '../src/bundleIntegrity.js';
import type { IntegrityManifest } from '../src/bundleIntegrity.js';

describe('verifyManifest', () => {
  const tempDirs: string[] = [];

  function createTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'sorostream-integrity-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

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

  it('reports failure for an empty-hash entry paired with a missing file on disk', () => {
    const distDir = createTempDir();
    const manifest: IntegrityManifest = {
      package: '@sorostream/sdk',
      version: '0.1.0',
      generatedAt: '2026-01-01T00:00:00.000Z',
      files: [{ file: 'missing.js', sha256: '', size: 0 }],
    };

    expect(verifyManifest(manifest, distDir)).toEqual({
      valid: false,
      failures: ['missing.js'],
    });
  });

  it('always includes missing files in failures regardless of manifest hash value', () => {
    const distDir = createTempDir();
    const manifest: IntegrityManifest = {
      package: '@sorostream/sdk',
      version: '0.1.0',
      generatedAt: '2026-01-01T00:00:00.000Z',
      files: [
        { file: 'missing-empty.js', sha256: '', size: 0 },
        { file: 'missing-malformed.js', sha256: 'not-a-sha256-digest', size: 12 },
        { file: 'missing-valid.js', sha256: computeSha256('expected'), size: 8 },
      ],
    };

    expect(verifyManifest(manifest, distDir)).toEqual({
      valid: false,
      failures: ['missing-empty.js', 'missing-malformed.js', 'missing-valid.js'],
    });
  });

  it('treats existing files with empty or malformed manifest hashes as invalid rather than skipping them', () => {
    const distDir = createTempDir();
    writeFileSync(join(distDir, 'valid.js'), 'export const ok = true;\n', 'utf8');
    writeFileSync(join(distDir, 'empty-hash.js'), 'export const bad = 1;\n', 'utf8');
    writeFileSync(join(distDir, 'malformed-hash.js'), 'export const bad = 2;\n', 'utf8');

    const manifest: IntegrityManifest = {
      package: '@sorostream/sdk',
      version: '0.1.0',
      generatedAt: '2026-01-01T00:00:00.000Z',
      files: [
        {
          file: 'valid.js',
          sha256: computeSha256('export const ok = true;\n'),
          size: 24,
        },
        { file: 'empty-hash.js', sha256: '', size: 22 },
        { file: 'malformed-hash.js', sha256: 'zzzz-invalid-hex', size: 22 },
      ],
    };

    expect(verifyFileIntegrity(join(distDir, 'empty-hash.js'), '')).toBe(false);
    expect(verifyFileIntegrity(join(distDir, 'malformed-hash.js'), 'zzzz-invalid-hex')).toBe(false);
    expect(verifyManifest(manifest, distDir)).toEqual({
      valid: false,
      failures: ['empty-hash.js', 'malformed-hash.js'],
    });
  });

  it('treats empty or malformed hashes as invalid when verifying through a resource resolver', async () => {
    const manifest: IntegrityManifest = {
      package: '@sorostream/sdk',
      version: '0.1.0',
      generatedAt: '2026-01-01T00:00:00.000Z',
      files: [
        { file: 'empty.js', sha256: '', size: 0 },
        { file: 'malformed.js', sha256: '1234', size: 4 },
      ],
    };
    const resolver = vi.fn().mockImplementation(async () => new Response('content'));

    await expect(verifyManifest(manifest, resolver)).resolves.toEqual({
      valid: false,
      failures: ['empty.js', 'malformed.js'],
    });
  });
});
