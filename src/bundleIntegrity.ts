/**
 * Bundle integrity utilities for SoroStream SDK (Issue #526).
 *
 * Generates SHA-256 checksums for published npm bundle files so consumers
 * can verify package integrity after downloading. Intended to be called from
 * the `generate-integrity` npm script after each build.
 *
 * @example Verifying a bundle after download:
 * ```ts
 * import { verifyManifest } from '@sorostream/sdk';
 * import manifest from './dist/integrity-manifest.json' assert { type: 'json' };
 *
 * const { valid, failures } = verifyManifest(manifest, './dist');
 * if (!valid) {
 *   throw new Error(`Bundle integrity check failed for: ${failures.join(', ')}`);
 * }
 * ```
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// ── Types ────────────────────────────────────────────────────────────────────

/** A single file's integrity record within an {@link IntegrityManifest}. */
export interface IntegrityEntry {
  /** Relative file path within the package (POSIX separators). */
  file: string;
  /** SHA-256 hash of the file content, hex-encoded. */
  sha256: string;
  /** File size in bytes. */
  size: number;
}

/**
 * Full integrity manifest for a published SDK bundle.
 * Written to `dist/integrity-manifest.json` after every build.
 */
export interface IntegrityManifest {
  /** npm package name (e.g. `@sorostream/sdk`). */
  package: string;
  /** Package version at the time the manifest was generated. */
  version: string;
  /** ISO-8601 timestamp when the manifest was created. */
  generatedAt: string;
  /** Per-file integrity entries, sorted by `file` path. */
  files: IntegrityEntry[];
}

// ── Core helpers ─────────────────────────────────────────────────────────────

/**
 * Computes the SHA-256 hash of a `Buffer` or UTF-8 string.
 *
 * @param data - Raw bytes or a UTF-8 string to hash.
 * @returns Hex-encoded SHA-256 digest.
 *
 * @example
 * ```ts
 * computeSha256('hello'); // '2cf24dba...'
 * computeSha256(Buffer.from([1, 2, 3]));
 * ```
 */
export function computeSha256(data: Buffer | string): string {
  return createHash('sha256')
    .update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
    .digest('hex');
}

// ── Manifest generation ──────────────────────────────────────────────────────

/**
 * Recursively walks `distDir` and generates an {@link IntegrityManifest}
 * containing SHA-256 checksums and file sizes for every file found.
 *
 * Files are sorted alphabetically by their relative path so that the manifest
 * is deterministic across platforms.
 *
 * @param distDir     - Absolute path to the directory to scan (e.g. `./dist`).
 * @param packageName - npm package name (e.g. `@sorostream/sdk`).
 * @param version     - Package semver version string (e.g. `1.2.3`).
 * @returns A populated {@link IntegrityManifest}.
 *
 * @example
 * ```ts
 * const manifest = generateIntegrityManifest('./dist', '@sorostream/sdk', '1.0.0');
 * fs.writeFileSync('./dist/integrity-manifest.json', JSON.stringify(manifest, null, 2));
 * ```
 */
export function generateIntegrityManifest(
  distDir: string,
  packageName: string,
  version: string,
): IntegrityManifest {
  const files: IntegrityEntry[] = [];

  function walk(dir: string): void {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else {
        const content = readFileSync(full);
        files.push({
          file: relative(distDir, full).replace(/\\/g, '/'),
          sha256: computeSha256(content),
          size: stat.size,
        });
      }
    }
  }

  walk(distDir);

  return {
    package: packageName,
    version,
    generatedAt: new Date().toISOString(),
    files: files.sort((a, b) => a.file.localeCompare(b.file)),
  };
}

// ── Manifest verification ────────────────────────────────────────────────────

/**
 * Verifies a single file against an expected SHA-256 hash.
 *
 * @param filePath       - Absolute or resolvable path to the file to check.
 * @param expectedSha256 - Expected hex SHA-256 hash (case-insensitive).
 * @returns `true` when the computed hash matches `expectedSha256`,
 *          `false` if they differ or if the file cannot be read.
 *
 * @example
 * ```ts
 * const ok = verifyFileIntegrity('./dist/index.js', 'abc123...');
 * if (!ok) throw new Error('Tampered file detected');
 * ```
 */
export function verifyFileIntegrity(filePath: string, expectedSha256: string): boolean {
  try {
    const content = readFileSync(filePath);
    const actual = computeSha256(content);
    return actual === expectedSha256.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Verifies **every** file listed in an {@link IntegrityManifest} against its
 * recorded hash.
 *
 * @param manifest - The manifest to verify against.
 * @param distDir  - Base directory where the dist files live. Each
 *                   `manifest.files[*].file` path is resolved relative to this.
 * @returns An object with:
 *   - `valid` — `true` if all files matched their recorded hashes.
 *   - `failures` — Relative paths of any files that failed verification.
 *
 * @example
 * ```ts
 * const { valid, failures } = verifyManifest(manifest, './dist');
 * if (!valid) {
 *   console.error('Integrity failures:', failures);
 * }
 * ```
 */
export function verifyManifest(
  manifest: IntegrityManifest,
  distDir: string,
): { valid: boolean; failures: string[] } {
  const failures: string[] = [];

  for (const entry of manifest.files) {
    const full = join(distDir, entry.file);
    if (!verifyFileIntegrity(full, entry.sha256)) {
      failures.push(entry.file);
    }
  }

  return { valid: failures.length === 0, failures };
}
