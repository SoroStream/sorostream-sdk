import { SoroStreamDependencyError } from './errors.js';

/** The `@stellar/stellar-sdk` semver range this SDK is built against (see package.json). */
const REQUIRED_STELLAR_SDK_RANGE = '^13.3.0';
const PEER_PACKAGE_NAME = '@stellar/stellar-sdk';

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

function parseVersion(version: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function parseCaretRange(range: string): ParsedVersion | null {
  const match = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/**
 * Detects the installed version of `@stellar/stellar-sdk` by resolving its
 * package.json from disk, bypassing the package's `exports` map (which does
 * not expose `./package.json` as a public subpath).
 *
 * Returns `null` when the version cannot be determined — e.g. in a browser
 * bundle without Node's module resolution APIs — so callers can skip
 * validation rather than fail for consumers where the check isn't possible.
 */
export function getInstalledStellarSdkVersion(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const entry = require.resolve(PEER_PACKAGE_NAME);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs');

    let dir = path.dirname(entry);
    for (let i = 0; i < 8; i++) {
      const pkgPath = path.join(dir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.name === PEER_PACKAGE_NAME && typeof pkg.version === 'string') {
          return pkg.version;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Not resolvable (e.g. browser bundle) — validation is skipped.
  }
  return null;
}

/**
 * Validates that the consumer's installed `@stellar/stellar-sdk` version is
 * compatible with the range this SDK was built against. Called once from the
 * `SoroStreamClient` constructor unless `{ skipPeerCheck: true }` is passed.
 *
 * - Throws {@link SoroStreamDependencyError} when the installed major version
 *   differs from the required major version.
 * - Logs a `console.warn` when the installed version is a newer, still
 *   compatible minor version.
 * - Silent when the version satisfies the required range, or when the
 *   installed version cannot be determined.
 *
 * @param installedVersion - Overrides the auto-detected version (mainly for
 *   testing). Defaults to {@link getInstalledStellarSdkVersion}.
 * Issue #213.
 */
export function checkPeerDependencies(
  installedVersion: string | null = getInstalledStellarSdkVersion(),
): void {
  if (!installedVersion) return;

  const required = parseCaretRange(REQUIRED_STELLAR_SDK_RANGE);
  const installed = parseVersion(installedVersion);
  if (!required || !installed) return;

  if (installed.major !== required.major) {
    throw new SoroStreamDependencyError(
      PEER_PACKAGE_NAME,
      REQUIRED_STELLAR_SDK_RANGE,
      installedVersion,
    );
  }

  if (installed.minor > required.minor) {
    console.warn(
      `[SoroStream SDK] ${PEER_PACKAGE_NAME}@${installedVersion} is newer than the tested range ` +
        `${REQUIRED_STELLAR_SDK_RANGE}. Newer minor versions are usually compatible but have not ` +
        `been tested against this SDK release.`,
    );
  }
}
