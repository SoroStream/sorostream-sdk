#!/usr/bin/env node

// Issue #267: CI check that keeps the committed `schemas/` JSON Schema files
// in sync with the TypeScript types they're generated from. Regenerates the
// schemas into a temp directory and diffs the result against what's
// committed — mirrors the pattern of scripts/check-changeset.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { generateSchemas, SCHEMAS, ROOT } = require('./generate-schemas.js');

const committedDir = path.join(ROOT, 'schemas');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sorostream-schemas-'));

try {
  const fresh = generateSchemas(tmpDir);

  let outOfDate = false;
  for (const [typeName, fileName] of Object.entries(SCHEMAS)) {
    const committedPath = path.join(committedDir, fileName);
    const freshContents = fresh[typeName].contents;

    if (!fs.existsSync(committedPath)) {
      console.error(`❌ Missing committed schema: schemas/${fileName}`);
      outOfDate = true;
      continue;
    }

    const committedContents = fs.readFileSync(committedPath, 'utf8');
    if (committedContents !== freshContents) {
      console.error(
        `❌ schemas/${fileName} is out of date with its TypeScript type (${typeName}).`,
      );
      outOfDate = true;
    }
  }

  if (outOfDate) {
    console.error('\nRun "npm run generate-schemas" and commit the result.');
    process.exit(1);
  }

  console.log('✅ Schema check passed: all schemas are up to date with their TypeScript types.');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
