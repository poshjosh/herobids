import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**', '.ignore/**', 'tests/e2e/**'],
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      '@herobids/domain/config/presets-loader': new URL('./packages/domain/src/config/presets-loader.ts', import.meta.url).pathname,
      '@herobids/domain/config/load-providers': new URL('./packages/domain/src/config/load-providers.ts', import.meta.url).pathname,
      '@herobids/domain': new URL('./packages/domain/src/index.ts', import.meta.url).pathname,
      '@herobids/db/schema': new URL('./packages/db/src/schema/index.ts', import.meta.url).pathname,
      '@herobids/db': new URL('./packages/db/src/index.ts', import.meta.url).pathname,
      '@herobids/llm': new URL('./packages/llm/src/index.ts', import.meta.url).pathname,
      '@herobids/tests': new URL('./tests', import.meta.url).pathname,
    },
  },
});
