/**
 * Journey 14: Create an agent with a name and an objective.
 *
 * The create form takes a name and an objective, then Review and Create. The
 * new agent starts automatically and the app opens its chat on the agents page.
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
    const [createResponse] = await Promise.all([
      page.waitForResponse((res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/agents', { timeout: 15_000 }),
      page.getByRole('button', { name: /^Create$/ }).click(),
    ]);
    const { id: agentId } = await createResponse.json() as { id: string };

    // The app opens the new agent's chat on the agents page.
    await expect(page).toHaveURL(/\/agents$/, { timeout: 15_000 });
    await expect(page.locator('#agents-chat-select option:checked')).toHaveText('Name only agent J14', { timeout: 10_000 });

    // Creating an agent auto-starts it, so Stop is shown instead of Start. Stop lives on the settings page.
    await page.goto(`/agents/${agentId}`);
    await expect(page.getByRole('button', { name: /^Stop$/ })).toBeVisible({ timeout: 15_000 });
  });
});
