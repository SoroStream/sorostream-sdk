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
});
