#!/usr/bin/env node
// Issue #267: generateSchemas CLI command.
//
// Regenerates the JSON Schema files under the SDK's `schemas/` directory
// from its TypeScript types (SoroStreamClientConfig, CreateStreamParams,
// StreamFilter). This is a repo-maintainer tool, not an end-user-facing SDK
// feature: it reflects `src/types.ts`, which is only present in a checkout
// of the sorostream-sdk repository (the published `@sorostream/sdk` package
// ships compiled `dist/` output and the pre-generated `schemas/` files, not
// the TypeScript source). Consumers of the SDK should import the static
// schema files from `@sorostream/sdk/schemas/*` instead of running this.
import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';

const program = new Command();

program
  .name('sorostream-generate-schemas')
  .description("Generate JSON Schema files for the SDK's config and stream parameter types")
  .version('0.1.0');

program
  .command('generate-schemas', { isDefault: true })
  .description("Regenerate schemas/*.schema.json from the SDK's TypeScript types")
  .option('--out-dir <dir>', 'Output directory (default: <sdk repo root>/schemas)')
  .action(async (opts: { outDir?: string }) => {
    const generatorPath = findGeneratorScript();
    if (!generatorPath) {
      console.error(
        'generate-schemas requires running from within a checkout of the sorostream-sdk ' +
          "repository — it reflects src/types.ts, which isn't published to npm. " +
          'Import the pre-generated schemas from @sorostream/sdk/schemas/* instead.',
      );
      process.exit(1);
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { generateSchemas } = require(generatorPath) as {
      generateSchemas: (outDir: string) => Record<string, { outputPath: string }>;
    };
    const outDir = opts.outDir
      ? path.resolve(opts.outDir)
      : path.join(path.dirname(generatorPath), '..', 'schemas');

    const results = generateSchemas(outDir);
    for (const [typeName, { outputPath }] of Object.entries(results)) {
      console.log(`Generated ${typeName} -> ${outputPath}`);
    }
  });

/**
 * Locates the SDK repo's `scripts/generate-schemas.js`, walking up from this
 * package's own directory. Works when run from within the sorostream-sdk
 * monorepo (`packages/cli` is two levels below the repo root); returns
 * `null` otherwise.
 */
function findGeneratorScript(): string | null {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'scripts', 'generate-schemas.js');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

program.parse();
