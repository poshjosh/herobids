/**
 * Journey 9: Connections page renders with correct heading and subtitle.
 *
 * Verifies the Connections page shows the advanced-use framing and directs
 * users to AI Agents for guided setup.
 */

import { test, expect } from '@playwright/test';
import { registerUser } from '../helpers.js';

const EMAIL = `j9-${Date.now()}@e2e.local`;
const PASSWORD = 'E2ePassword9!';

test.describe('Journey 9: Connections page renders', () => {
  test('shows correct heading, subtitle, and empty state', async ({ page }) => {
    await registerUser(page, EMAIL, PASSWORD, 'E2E User J9');

    await page.goto('/connections');

    await expect(page.getByRole('heading', { name: /^Connections$/i })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/Platform accounts your AI agents can use/i)).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/Connect a platform so your AI agents can start working/i)).toBeVisible({ timeout: 5_000 });
  });
});
