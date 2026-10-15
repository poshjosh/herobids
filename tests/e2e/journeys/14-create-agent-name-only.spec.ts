/**
 * Journey 14: Create an agent with a name only.
 *
 * The create form takes an optional name and a channel. The new agent is
 * stopped, the app opens its page, and Start brings it up.
 */

import { test, expect } from '@playwright/test';
import { registerUser, ensureUserAiModelSettings } from '../helpers.js';

const EMAIL = `j14-${Date.now()}@e2e.local`;
const PASSWORD = 'E2ePassword14!';

test.describe('Journey 14: create agent with a name only', () => {
  test('a named agent is created stopped and can be started', async ({ page }) => {
    await registerUser(page, EMAIL, PASSWORD, 'E2E User J14');
    await ensureUserAiModelSettings(page);

    await page.goto('/agents/new');
    await page.locator('#create-agent-name').fill('Name only agent J14');
    await page.getByRole('button', { name: /^Create AI agent$/i }).click();

    await expect(page).toHaveURL(/\/agents\/[0-9a-f-]{36}$/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Name only agent J14' })).toBeVisible({ timeout: 10_000 });

    const startButton = page.getByRole('button', { name: /^Start$/ });
    await expect(startButton).toBeVisible({ timeout: 10_000 });
    await startButton.click();
    await expect(page.getByRole('button', { name: /^Stop$/ })).toBeVisible({ timeout: 15_000 });
  });
});
