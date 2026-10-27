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

/** Resolves a manifest-relative file to its HTTP response. */
export type ManifestResourceResolver = (file: string) => Promise<Response>;

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

const SHA256_HEX_REGEX = /^[a-f0-9]{64}$/i;

function isValidSha256Hash(hash: unknown): hash is string {
  return typeof hash === 'string' && SHA256_HEX_REGEX.test(hash);
}

/**
 * Verifies a single file against an expected SHA-256 hash.
 *
 * @param filePath       - Absolute or resolvable path to the file to check.
 * @param expectedSha256 - Expected hex SHA-256 hash (case-insensitive).
 * @returns `true` when the computed hash matches `expectedSha256`,
 *          `false` if they differ, if `expectedSha256` is empty/malformed,
 *          or if the file cannot be read.
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
    if (!isValidSha256Hash(expectedSha256)) {
      return false;
    }
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
 * @param distDir  - Base directory for local verification, or a resolver that
 *                   fetches each manifest-relative file from a remote source.
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
 *
 * const remoteResult = await verifyManifest(manifest, (file) =>
 *   fetch(new URL(file, 'https://cdn.example.com/sdk/')),
 * );
 * ```
 */
export function verifyManifest(
  manifest: IntegrityManifest,
  distDir: string,
): { valid: boolean; failures: string[] };
export function verifyManifest(
  manifest: IntegrityManifest,
  resolveResource: ManifestResourceResolver,
): Promise<{ valid: boolean; failures: string[] }>;
export function verifyManifest(
  manifest: IntegrityManifest,
  distDirOrResolver: string | ManifestResourceResolver,
): { valid: boolean; failures: string[] } | Promise<{ valid: boolean; failures: string[] }> {
  if (typeof distDirOrResolver === 'function') {
    return verifyManifestFromResolver(manifest, distDirOrResolver);
  }

  const failures: string[] = [];

  for (const entry of manifest.files) {
    const full = join(distDirOrResolver, entry.file);
    if (!verifyFileIntegrity(full, entry.sha256) || !isValidSha256Hash(entry.sha256)) {
      failures.push(entry.file);
    }
  }

  return { valid: failures.length === 0, failures };
}

async function verifyManifestFromResolver(
  manifest: IntegrityManifest,
  resolveResource: ManifestResourceResolver,
): Promise<{ valid: boolean; failures: string[] }> {
  const failures: string[] = [];

  for (const entry of manifest.files) {
    try {
      const response = await resolveResource(entry.file);
      if (
        !response.ok ||
        !isValidSha256Hash(entry.sha256) ||
        computeSha256(Buffer.from(await response.arrayBuffer())) !== entry.sha256.toLowerCase()
      ) {
        failures.push(entry.file);
      }
    } catch {
      failures.push(entry.file);
    }
  }

  return { valid: failures.length === 0, failures };
}
