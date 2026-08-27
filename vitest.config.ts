import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests require a running local Soroban node (see
    // docker-compose.integration.yml) and are run separately via
    // `npm run test:integration`.
    exclude: ['**/node_modules/**', 'test/integration/**'],
  },
});
