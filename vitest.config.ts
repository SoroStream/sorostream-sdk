import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // Resolve the workspace package to its TypeScript source so tests that
      // import from '@sorostream/sdk' work without a build step.
      '@sorostream/sdk': resolve('./src/index.ts'),
      // Force a single React instance: packages/react has its own nested
      // node_modules/react (same version, separate copy), which breaks hook
      // dispatch ("Invalid hook call") since @testing-library/react resolves
      // the root copy while the hook under test would otherwise resolve the
      // nested one.
      react: resolve('./node_modules/react'),
      'react-dom': resolve('./node_modules/react-dom'),
    },
  },
  test: {
    // Integration tests require a running local Soroban node (see
    // docker-compose.integration.yml) and are run separately via
    // `npm run test:integration`.
    exclude: ['**/node_modules/**', 'test/integration/**'],
    // React hook tests use @testing-library/react's `renderHook`, which
    // needs a DOM; every other test file runs under the default `node`
    // environment.
    environmentMatchGlobs: [['packages/react/test/**', 'jsdom']],
  },
});
