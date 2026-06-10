/**
 * Journey 14: Create Agent inline trading setup (escape hatch).
 *
 * Verifies that a user who selects a trading-capable skill during agent
 * creation, and has no existing trading bindings, is shown an escape hatch
 * button. After completing setup inline, the new binding is auto-selected
 * in the Create Agent form.
 */

import { test, expect } from '@playwright/test';
import { registerUser, getAuthToken } from '../helpers.js';

const EMAIL = `j14-${Date.now()}@e2e.local`;
const PASSWORD = 'E2ePassword14!';

test.describe('Journey 14: Create Agent inline trading setup', () => {
  test('user with no bindings can set up trading inline while creating an agent', async ({ page }) => {
    await registerUser(page, EMAIL, PASSWORD, 'E2E User J14');

    await page.goto('/agents');
    await page.getByRole('button', { name: /new agent|create agent/i }).first().click();

    // Fill in a trading-relevant goal
    await page.locator('textarea').first().fill('Monitor crypto prices and trade automatically.');

    // Look up the bot-management skill name from the API so we can click its checkbox
    const token = await getAuthToken(page);
    const skillsResponse = await page.request.get('/api/skills', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { skills } = await skillsResponse.json() as { skills: Array<{ id: string; name: string }> };
    const botSkill = skills.find((s) => s.id === 'bot-management');
    if (!botSkill) {
      throw new Error('bot-management skill not found in API response');
    }

    // Select the trading-capable skill
    await page.getByRole('checkbox', { name: botSkill.name }).check();

    // The trading section appears and shows the no-bindings state
    await expect(
      page.getByText(/No active trading bindings yet/i),
    ).toBeVisible({ timeout: 8_000 });

    // Click the escape hatch
    await page.getByRole('button', { name: 'Set up trading now' }).click();

    // ProviderSetupForm replaces the create agent modal content
    await expect(page.getByText('Add trading provider')).toBeVisible({ timeout: 5_000 });

    // Fill in the setup form
    await page.getByPlaceholder('e.g. hyperliquid, bybit, 1inch').fill('hyperliquid');
    await page.getByPlaceholder('e.g. My Hyperliquid account').fill('My HL Account J14');

    // Template populates 3 secret rows
    await expect(page.locator('input[placeholder="Secret value"]')).toHaveCount(3, { timeout: 3_000 });

    await page.locator('input[placeholder="Secret value"]').nth(0).fill('test-api-key-j14');
    await page.locator('input[placeholder="Secret value"]').nth(1).fill('test-secret-j14');
    await page.locator('input[placeholder="Secret value"]').nth(2).fill('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    // Submit
    await page.getByRole('button', { name: 'Set up trading provider' }).click();

    // Setup form closes; back in the create agent modal with binding auto-selected
    await expect(page.getByText('Add trading provider')).not.toBeVisible({ timeout: 15_000 });

    // The no-bindings state is gone — the new binding is now selected
    await expect(
      page.getByText(/No active trading bindings yet/i),
    ).not.toBeVisible({ timeout: 8_000 });
  });
});
