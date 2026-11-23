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
 * Default filename excluded from the integrity walk.
 *
 * When the manifest is written back into `distDir` (the conventional pattern),
 * the walk must skip the manifest file itself — otherwise the recorded hash
 * becomes stale the moment the file is written to disk.  This constant is the
 * default value of `generateIntegrityManifest`'s `excludeFile` option.
 */
export const DEFAULT_MANIFEST_FILENAME = 'integrity-manifest.json';

/**
 * Recursively walks `distDir` and generates an {@link IntegrityManifest}
 * containing SHA-256 checksums and file sizes for every file found.
 *
 * Files are sorted alphabetically by their relative path so that the manifest
 * is deterministic across platforms.
 *
 * ### Self-exclusion (issue #XXX)
 * If `distDir` already contains a manifest from a previous build, naively
 * including it in the new manifest would record a hash that becomes stale the
 * instant the new manifest is written to disk.  `excludeFile` names the
 * basename to skip during the walk; it defaults to
 * `'integrity-manifest.json'` — the conventional output filename.
 *
 * To write the manifest to a **different** path you can either:
 * - pass `excludeFile: ''` (empty string) to disable the exclusion, or
 * - pass the actual target basename if it differs from the default.
 *
 * @param distDir     - Absolute path to the directory to scan (e.g. `./dist`).
 * @param packageName - npm package name (e.g. `@sorostream/sdk`).
 * @param version     - Package semver version string (e.g. `1.2.3`).
 * @param excludeFile - Basename of the file to exclude from the walk.
 *                      Defaults to `'integrity-manifest.json'`.
 * @returns A populated {@link IntegrityManifest}.
 *
 * @example
 * ```ts
 * // Write manifest into the same dist directory — the default exclusion
 * // ensures the manifest itself is never hashed.
 * const manifest = generateIntegrityManifest('./dist', '@sorostream/sdk', '1.0.0');
 * fs.writeFileSync('./dist/integrity-manifest.json', JSON.stringify(manifest, null, 2));
 *
 * // Custom manifest filename — pass the same name to excludeFile.
 * const manifest2 = generateIntegrityManifest('./dist', '@sorostream/sdk', '1.0.0', 'checksums.json');
 * fs.writeFileSync('./dist/checksums.json', JSON.stringify(manifest2, null, 2));
 * ```
 */
export function generateIntegrityManifest(
  distDir: string,
  packageName: string,
  version: string,
  excludeFile: string = DEFAULT_MANIFEST_FILENAME,
): IntegrityManifest {
  const files: IntegrityEntry[] = [];

  function walk(dir: string): void {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      // Skip the manifest's own output file so a stale hash is never recorded.
      if (excludeFile && entry === excludeFile) continue;
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
  if (!isValidSha256(expectedSha256)) {
    return false;
  }
  try {
    const content = readFileSync(filePath);
    const actual = computeSha256(content);
    return actual === expectedSha256.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Returns `true` when `hash` is a well-formed hex-encoded SHA-256 digest
 * (64 hexadecimal characters). Empty or malformed hashes are rejected so that
 * broken manifest entries are treated as invalid rather than skipped.
 */
function isValidSha256(hash: unknown): hash is string {
  return typeof hash === 'string' && /^[0-9a-fA-F]{64}$/.test(hash);
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
    // A malformed/empty hash is always a failure, regardless of file presence.
    if (!isValidSha256(entry.sha256)) {
      failures.push(entry.file);
      continue;
    }
    // File existence/content is checked independently of the hash value, so a
    // missing file always appears in failures.
    const full = join(distDirOrResolver, entry.file);
    if (!verifyFileIntegrity(full, entry.sha256)) {
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
    // A malformed/empty hash is always a failure, regardless of fetch result.
    if (!isValidSha256(entry.sha256)) {
      failures.push(entry.file);
      continue;
    }
    try {
      const response = await resolveResource(entry.file);
      if (
        !response.ok ||
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
