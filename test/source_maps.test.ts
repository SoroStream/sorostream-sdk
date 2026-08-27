import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// ── Issue #207: Source map generation for production bundle debugging ───────
//
// Requires `npm run build` to have produced `dist/` first.

const distDir = path.resolve(__dirname, '../dist');
const distBuilt = existsSync(path.join(distDir, 'core.js.map'));

const ENTRIES = ['index', 'core', 'wallets', 'batch', 'mock', 'testing'];

describe.skipIf(!distBuilt)('production build source maps', () => {
  it.each(ENTRIES)('%s.js references an external .map file, not an inline data URI', (entry) => {
    const code = readFileSync(path.join(distDir, `${entry}.js`), 'utf8');
    expect(code).toMatch(new RegExp(`//# sourceMappingURL=${entry}\\.js\\.map$`));
    expect(code).not.toMatch(/sourceMappingURL=data:application\/json/);
  });

  it.each(ENTRIES)('%s.mjs references an external .map file, not an inline data URI', (entry) => {
    const code = readFileSync(path.join(distDir, `${entry}.mjs`), 'utf8');
    expect(code).toMatch(new RegExp(`//# sourceMappingURL=${entry}\\.mjs\\.map$`));
    expect(code).not.toMatch(/sourceMappingURL=data:application\/json/);
  });

  it.each(ENTRIES)('%s.js.map is a valid source map with non-empty mappings', (entry) => {
    const map = JSON.parse(readFileSync(path.join(distDir, `${entry}.js.map`), 'utf8'));
    expect(map.version).toBe(3);
    expect(Array.isArray(map.sources)).toBe(true);
    expect(map.sources.length).toBeGreaterThan(0);
    expect(typeof map.mappings).toBe('string');
    expect(map.mappings.length).toBeGreaterThan(0);
  });

  it("core.js.map's sources trace back to the original TypeScript files", () => {
    const map = JSON.parse(readFileSync(path.join(distDir, 'core.js.map'), 'utf8'));
    const sources: string[] = map.sources;
    expect(sources.some((s) => s.endsWith('core.ts'))).toBe(true);
    expect(sources.some((s) => s.endsWith('SoroStreamClient.ts'))).toBe(true);
    // Confirms issue #206's separation: core's map must not reference wallet.ts.
    expect(sources.some((s) => s.endsWith('wallet.ts'))).toBe(false);
  });

  it("wallets.js.map's sources trace back to wallet.ts", () => {
    const map = JSON.parse(readFileSync(path.join(distDir, 'wallets.js.map'), 'utf8'));
    const sources: string[] = map.sources;
    expect(sources.some((s) => s.endsWith('wallet.ts'))).toBe(true);
  });
});
