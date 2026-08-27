#!/usr/bin/env node

// Issue #267: Generates JSON Schema files for the SDK's config and stream
// parameter types, so non-TypeScript tooling (Python/Go scripts building
// stream-creation payloads, for example) can validate against a
// machine-readable schema instead of the TypeScript source.
//
// Run via `npm run generate-schemas`. `npm run check:schemas` (used in CI)
// re-runs this same generation into a temp directory and diffs the result
// against the committed `schemas/` directory to catch schemas that have
// drifted out of sync with the TypeScript types.

const fs = require('fs');
const path = require('path');
const tsj = require('ts-json-schema-generator');

const ROOT = path.resolve(__dirname, '..');
const TSCONFIG = path.join(ROOT, 'tsconfig.json');
const SOURCE = path.join(ROOT, 'src', 'types.ts');

/** Type name -> output filename. */
const SCHEMAS = {
  SoroStreamClientConfig: 'sorostream-client-config.schema.json',
  CreateStreamParams: 'create-stream-params.schema.json',
  StreamFilter: 'stream-filter.schema.json',
};

/**
 * ts-json-schema-generator maps TypeScript's `bigint` keyword to the same
 * generic NumberType as `number` (see NumberTypeNodeParser), so it can't
 * distinguish them on its own. Stroop amounts can exceed
 * Number.MAX_SAFE_INTEGER, so the generated `"type": "number"` would silently
 * lose precision for large values. Patch known bigint-backed fields, per
 * type, to the string-encoded integer representation JSON payloads should
 * actually use for large numbers.
 */
const BIGINT_FIELDS = {
  CreateStreamParams: ['amount'],
};

const BIGINT_STRING_SCHEMA = {
  type: 'string',
  pattern: '^[0-9]+$',
  description: 'Stroops, encoded as a decimal string to avoid precision loss for large values.',
};

function patchBigintFields(schema, typeName) {
  const fields = BIGINT_FIELDS[typeName];
  if (!fields) return schema;
  const definition = schema.definitions?.[typeName];
  if (!definition?.properties) return schema;
  for (const field of fields) {
    const existing = definition.properties[field];
    if (existing) {
      definition.properties[field] = {
        ...BIGINT_STRING_SCHEMA,
        description: existing.description ?? BIGINT_STRING_SCHEMA.description,
      };
    }
  }
  return schema;
}

function generateSchemas(outDir) {
  fs.mkdirSync(outDir, { recursive: true });

  const results = {};
  for (const [typeName, fileName] of Object.entries(SCHEMAS)) {
    const generator = tsj.createGenerator({
      path: SOURCE,
      tsconfig: TSCONFIG,
      type: typeName,
      skipTypeCheck: true,
      additionalProperties: false,
    });

    const schema = patchBigintFields(generator.createSchema(typeName), typeName);
    // Stamp an explicit $id so consumers (and ajv) can resolve/cache these
    // schemas by a stable URL rather than a filesystem path.
    schema.$id = `https://github.com/SoroStream/sorostream-sdk/blob/main/schemas/${fileName}`;

    const outputPath = path.join(outDir, fileName);
    const contents = JSON.stringify(schema, null, 2) + '\n';
    fs.writeFileSync(outputPath, contents);
    results[typeName] = { outputPath, contents };
  }
  return results;
}

if (require.main === module) {
  const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'schemas');
  const results = generateSchemas(outDir);
  for (const [typeName, { outputPath }] of Object.entries(results)) {
    console.log(`Generated ${typeName} -> ${path.relative(ROOT, outputPath)}`);
  }
}

module.exports = { generateSchemas, SCHEMAS, ROOT };
