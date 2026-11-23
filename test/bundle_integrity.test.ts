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

// ── generateIntegrityManifest self-exclusion (issue #XXX) ────────────────────

import { afterEach as afterEachSuite, beforeEach as beforeEachSuite } from 'vitest';
import { generateIntegrityManifest, DEFAULT_MANIFEST_FILENAME } from '../src/bundleIntegrity.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { tmpdir } from 'node:os';

describe('generateIntegrityManifest – manifest self-exclusion', () => {
  let distDir: string;

  beforeEachSuite(() => {
    // Create a real temp directory with three files:
    //   index.js, index.js.map, integrity-manifest.json
    distDir = mkdtempSync(pathJoin(tmpdir(), 'sorostream-test-'));
    writeFileSync(pathJoin(distDir, 'index.js'), "console.log('hello')");
    writeFileSync(pathJoin(distDir, 'index.js.map'), '{}');
    writeFileSync(pathJoin(distDir, 'integrity-manifest.json'), '{"stale":true}');
  });

  afterEachSuite(() => {
    rmSync(distDir, { recursive: true, force: true });
  });

  it('excludes the default manifest filename from the walk', () => {
    const manifest = generateIntegrityManifest(distDir, '@sorostream/sdk', '1.0.0');

    const filenames = manifest.files.map((f) => f.file);
    expect(filenames).not.toContain('integrity-manifest.json');
    expect(filenames).toContain('index.js');
    expect(filenames).toContain('index.js.map');
    expect(manifest.files).toHaveLength(2);
  });

  it('DEFAULT_MANIFEST_FILENAME matches the conventional output name', () => {
    expect(DEFAULT_MANIFEST_FILENAME).toBe('integrity-manifest.json');
  });

  it('allows a custom excludeFile name', () => {
    // Exclude 'index.js.map' instead of the manifest.
    const manifest = generateIntegrityManifest(distDir, '@sorostream/sdk', '1.0.0', 'index.js.map');

    const filenames = manifest.files.map((f) => f.file);
    expect(filenames).not.toContain('index.js.map');
    expect(filenames).toContain('integrity-manifest.json');
    expect(filenames).toContain('index.js');
  });

  it('includes all files when excludeFile is an empty string', () => {
    const manifest = generateIntegrityManifest(distDir, '@sorostream/sdk', '1.0.0', '');

    const filenames = manifest.files.map((f) => f.file);
    expect(filenames).toContain('integrity-manifest.json');
    expect(filenames).toContain('index.js');
    expect(filenames).toContain('index.js.map');
    expect(manifest.files).toHaveLength(3);
  });

  it('records correct hashes for the included files', () => {
    const manifest = generateIntegrityManifest(distDir, '@sorostream/sdk', '1.0.0');

    const jsEntry = manifest.files.find((f) => f.file === 'index.js')!;
    expect(jsEntry.sha256).toBe(computeSha256("console.log('hello')"));
    expect(jsEntry.size).toBe("console.log('hello')".length);
  });

  it('works with subdirectories and excludes manifest only by basename', () => {
    // Add a subdirectory with another file.
    mkdirSync(pathJoin(distDir, 'sub'));
    writeFileSync(pathJoin(distDir, 'sub', 'chunk.js'), 'chunk');

    const manifest = generateIntegrityManifest(distDir, '@sorostream/sdk', '1.0.0');

    const filenames = manifest.files.map((f) => f.file);
    expect(filenames).toContain('sub/chunk.js');
    expect(filenames).not.toContain('integrity-manifest.json');
  });
});
