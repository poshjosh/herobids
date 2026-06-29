import { defineConfig } from 'vitest/config';
import { existsSync } from 'node:fs';

// Load venue testnet credentials if present (developer opt-in — never auto-loaded by pnpm test)
if (existsSync('.env.local')) {
  process.loadEnvFile('.env.local');
}

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['packages/venues/src/*.integration.test.ts'],
    testTimeout: 30000,
  },
  resolve: {
    alias: {
      '@herobids/db': new URL('./packages/db/src/index.ts', import.meta.url).pathname,
      '@herobids/domain': new URL('./packages/domain/src/index.ts', import.meta.url).pathname,
      '@herobids/engine': new URL('./packages/engine/src/index.ts', import.meta.url).pathname,
      '@herobids/venues': new URL('./packages/venues/src/index.ts', import.meta.url).pathname,
      '@herobids/strategy': new URL('./packages/strategy/src/index.ts', import.meta.url).pathname,
      '@herobids/backtesting': new URL('./packages/backtesting/src/index.ts', import.meta.url).pathname,
    },
  },
});
