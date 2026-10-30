/**
 * Journey 14: Create an agent with a name and an objective.
 *
 * The create form takes a name and an objective, then Review and Create. The
 * new agent is stopped, the app opens its page, and Start brings it up.
 */

import { test, expect } from '@playwright/test';
import { registerUser, ensureUserAiModelSettings } from '../helpers.js';

const EMAIL = `j14-${Date.now()}@e2e.local`;
const PASSWORD = 'E2ePassword14!';

test.describe('Journey 14: create agent with a name only', () => {
  test('a named agent is created and starts automatically', async ({ page }) => {
    await registerUser(page, EMAIL, PASSWORD, 'E2E User J14');
    await ensureUserAiModelSettings(page);

    await page.goto('/agents/new');
    await page.locator('[data-field="name"] input').fill('Name only agent J14');
    await page.locator('details summary', { hasText: 'Advanced Settings' }).click();
    await page.locator('[data-field="goal"] textarea').fill('Watch BTC and report daily.');
    await page.getByRole('button', { name: /^Review/ }).first().click();
    await page.getByRole('button', { name: /^Create$/ }).click();

    await expect(page).toHaveURL(/\/agents\/[0-9a-f-]{36}$/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Name only agent J14' })).toBeVisible({ timeout: 10_000 });

    // Creating an agent auto-starts it, so Stop is shown instead of Start. Stop lives on the details page.
    await page.goto(`${new URL(page.url()).pathname}/details`);
    await expect(page.getByRole('button', { name: /^Stop$/ })).toBeVisible({ timeout: 15_000 });
  });
});
