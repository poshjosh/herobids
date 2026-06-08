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
      '@herobids/db': new URL('./packages/db/src/index.ts', import.meta.url).pathname,
      '@herobids/domain': new URL('./packages/domain/src/index.ts', import.meta.url).pathname,
      '@herobids/engine': new URL('./packages/engine/src/index.ts', import.meta.url).pathname,
      '@herobids/venues': new URL('./packages/venues/src/index.ts', import.meta.url).pathname,
      '@herobids/strategy': new URL('./packages/strategy/src/index.ts', import.meta.url).pathname,
      '@herobids/backtesting': new URL('./packages/backtesting/src/index.ts', import.meta.url).pathname,
      '@herobids/llm': new URL('./packages/llm/src/index.ts', import.meta.url).pathname,
      '@herobids/market-data': new URL('./packages/market-data/src/index.ts', import.meta.url).pathname,
    },
  },
});
