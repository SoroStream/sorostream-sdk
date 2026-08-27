#!/usr/bin/env node
// Issue #206: enforces a gzipped size ceiling per published entry point so a
// regression that accidentally pulls a heavy dependency into a lightweight
// entry point (e.g. a wallet adapter into `core`) fails CI instead of
// silently inflating consumer bundles.
//
// Each entry is re-bundled with esbuild so the measurement reflects what a
// consumer's bundler actually ships, not the size of the internal tsup
// chunk-splitting stub. `@stellar/stellar-sdk` is marked external: every
// consumer of this SDK already depends on it directly, so counting it here
// would drown out the (much smaller, and more interesting) difference
// between entry points.

const path = require('path');
const zlib = require('zlib');
const esbuild = require('esbuild');

// Limits are gzipped KB, set with headroom above the current measured size.
const LIMITS_KB = {
  'index.mjs': 30,
  'core.mjs': 24,
  'wallets.mjs': 8,
  'batch.mjs': 6,
  'mock.mjs': 6,
  'testing.mjs': 6,
};

// `core` must stay meaningfully smaller than the default entry point —
// this is the concrete regression guard for issue #206's tree-shaking goal.
const CORE_MUST_BE_SMALLER_THAN_INDEX_RATIO = 0.9;

const distDir = path.resolve(process.cwd(), 'dist');

async function measure(file) {
  const result = await esbuild.build({
    entryPoints: [path.join(distDir, file)],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    minify: true,
    external: ['@stellar/stellar-sdk'],
    logLevel: 'silent',
  });
  const gzipped = zlib.gzipSync(Buffer.from(result.outputFiles[0].text));
  return gzipped.length / 1024;
}

async function main() {
  let hasError = false;
  const sizes = {};

  for (const file of Object.keys(LIMITS_KB)) {
    let sizeKb;
    try {
      sizeKb = await measure(file);
    } catch (err) {
      console.error(
        `Bundle size check failed: could not bundle "${file}". Run "npm run build" first.`,
      );
      console.error(err.message);
      hasError = true;
      continue;
    }
    sizes[file] = sizeKb;
    const limitKb = LIMITS_KB[file];
    const withinLimit = sizeKb <= limitKb;
    console.log(
      `${file}: ${sizeKb.toFixed(2)} KB gzipped (limit ${limitKb} KB) [${withinLimit ? 'OK' : 'FAIL'}]`,
    );
    if (!withinLimit) hasError = true;
  }

  if (sizes['core.mjs'] !== undefined && sizes['index.mjs'] !== undefined) {
    const ratio = sizes['core.mjs'] / sizes['index.mjs'];
    const ok = ratio <= CORE_MUST_BE_SMALLER_THAN_INDEX_RATIO;
    console.log(
      `core.mjs / index.mjs size ratio: ${ratio.toFixed(3)} (must be <= ${CORE_MUST_BE_SMALLER_THAN_INDEX_RATIO}) [${ok ? 'OK' : 'FAIL'}]`,
    );
    if (!ok) hasError = true;
  }

  if (hasError) {
    console.error('One or more entry points exceeded their bundle size limit.');
    process.exit(1);
  }

  console.log('All entry points are within their bundle size limits.');
}

main();
