#!/usr/bin/env node
// Guards against CJS import regressions (issue #198): fails the build if
// `require("@sorostream/sdk")` stops working in a plain Node.js CJS script.

const assert = require('assert');
const sdk = require('../dist/index.js');

assert.strictEqual(
  typeof sdk.SoroStreamClient,
  'function',
  'SoroStreamClient should be a constructor',
);
assert.strictEqual(
  typeof sdk.MockSoroStreamClient,
  'function',
  'MockSoroStreamClient should be a constructor',
);
assert.strictEqual(typeof sdk.encodeMemo, 'function', 'encodeMemo should be exported');
assert.strictEqual(typeof sdk.SoroStreamError, 'function', 'SoroStreamError should be exported');

console.log('✅ CJS smoke test passed: require("@sorostream/sdk") resolves the expected exports.');
