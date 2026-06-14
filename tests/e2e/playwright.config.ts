import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration for HeroBids E2E tests.
 *
 * Tests run against the full stack.  Set BASE_URL to override the default.
 * Individual tests call `test.skip` when API setup fails (e.g. token not
 * available).  There is no global setup guard — if the BASE_URL is unreachable
 * the tests will fail rather than skip; run against a live stack.
 *
 * To run:
 *   BASE_URL=http://localhost:5173 pnpm -F @herobids/e2e test
 *
 * Or against the docker stack:
 *   BASE_URL=http://localhost:5173 playwright test
 */
export default defineConfig({
  testDir: './journeys',
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  workers: 1,
  reporter: [['html', { outputFolder: '../../docs/test-reports/e2e-report', open: 'never' }], ['list']],
  use: {
    baseURL: process.env['BASE_URL'] ?? 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  timeout: 60_000,
});
