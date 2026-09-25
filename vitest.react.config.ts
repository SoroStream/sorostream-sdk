import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@sorostream/sdk': resolve('./src/index.ts'),
      '@sorostream/react': resolve('./packages/react/src/index.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['packages/react/test/**/*.test.ts'],
  },
});
