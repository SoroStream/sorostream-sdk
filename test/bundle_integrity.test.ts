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

  it('reports a failure for an empty-hash entry paired with a missing file', async () => {
    const manifest: IntegrityManifest = {
      package: '@sorostream/sdk',
      version: '0.1.0',
      generatedAt: '2026-01-01T00:00:00.000Z',
      files: [{ file: 'missing.js', sha256: '', size: 0 }],
    };
    const resolver = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));

    const result = await verifyManifest(manifest, resolver);

    expect(result.valid).toBe(false);
    expect(result.failures).toContain('missing.js');
  });

  it('reports a failure for a malformed-hash entry paired with a missing file', async () => {
    const manifest: IntegrityManifest = {
      package: '@sorostream/sdk',
      version: '0.1.0',
      generatedAt: '2026-01-01T00:00:00.000Z',
      files: [{ file: 'missing.js', sha256: 'not-a-valid-hash', size: 0 }],
    };
    const resolver = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));

    const result = await verifyManifest(manifest, resolver);

    expect(result.valid).toBe(false);
    expect(result.failures).toContain('missing.js');
  });
});