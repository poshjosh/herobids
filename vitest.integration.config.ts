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
    testTimeout: 30000,
    // Venue integration tests were removed with the venues package (Slice 4
    // Plan B). No explicit include keeps this config from falling back to
    // vitest's default repo-wide include pattern, which would run the entire
    // repo suite (DB-env-dependent) under `pnpm test:venues`.
    include: [],
    passWithNoTests: true,
  },
  resolve: {
    alias: {
      '@herobids/db': new URL('./packages/db/src/index.ts', import.meta.url).pathname,
      '@herobids/domain': new URL('./packages/domain/src/index.ts', import.meta.url).pathname,
    },
  },
});
