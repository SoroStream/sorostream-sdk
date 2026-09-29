import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // Resolve the workspace package to its TypeScript source so tests that
      // import from '@sorostream/sdk' work without a build step.
      '@sorostream/sdk': resolve('./src/index.ts'),
    },
  },
  test: {
    // Integration tests require a running local Soroban node (see
    // docker-compose.integration.yml) and are run separately via
    // `npm run test:integration`.
    exclude: ['**/node_modules/**', 'test/integration/**'],
  },
});
