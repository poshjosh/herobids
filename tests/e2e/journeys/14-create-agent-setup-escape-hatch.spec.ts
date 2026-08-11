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

    await page.goto('/agents/new');

    // The create page defaults to form mode. If we landed in guided mode
    // (e.g. redirected via ?ui=chat), switch to form.
    const switchToFormBtn = page.getByRole('button', { name: /^Use the form$/i });
    const switchToGuidedBtn = page.getByRole('button', { name: /^Use guided chat$/i });
    if (await switchToFormBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await switchToFormBtn.click();
    } else {
      await switchToGuidedBtn.waitFor({ state: 'visible', timeout: 10_000 });
    }

    // Fill name (required field) and goal
    await page.locator('input[type="text"]').first().fill('Crypto Trading Agent J14');
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

    // Select the trading-capable skill — must switch to Custom preset first
    await page.locator('select:has(option[value="personal-assistant"])').selectOption('custom');

    // Expand the Advanced Settings section and switch to the Skills tab
    // so the skill checkboxes become visible.  The AdvancedSettingsSection
    // wraps everything in a single <details> with summary "Advanced Settings";
    // sections are tabs (AI Configuration / Skills / Trading Setup / Strategy).
    const advancedDetails = page.locator('details').filter({ hasText: 'Advanced Settings' }).first();
    const detailsCount = await advancedDetails.count();
    if (detailsCount > 0) {
      const isOpen = await advancedDetails.evaluate((el) => el.hasAttribute('open'));
      if (!isOpen) {
        await advancedDetails.locator('summary').first().click();
        await page.waitForTimeout(300);
      }

      const skillsTab = page.getByRole('tab', { name: 'Skills' });
      const tabCount = await skillsTab.count();
      if (tabCount > 0) {
        await skillsTab.first().click();
        await page.waitForTimeout(300);
      }
    }

    // Uncheck pre-selected skills so only the requested one remains.
    const allCheckboxes = page.getByRole('checkbox');
    const cbCount = await allCheckboxes.count();
    for (let i = 0; i < cbCount; i++) {
      const cb = allCheckboxes.nth(i);
      if (await cb.isChecked()) {
        await cb.uncheck();
      }
    }

    await page.getByRole('checkbox', { name: botSkill.name }).check();

    // Switch to the AI tab — the trading-setup section
    // (no-connections message + "Set up trading now" button) lives there,
    // not in the Skills tab.
    const aiConfigTab = page.getByRole('tab', { name: 'AI' });
    if (await aiConfigTab.count() > 0) {
      await aiConfigTab.first().click();
      await page.waitForTimeout(300);
    }

    // The trading section appears and shows the no-bindings state
    await expect(
      page.getByText(/No active platform links yet/i),
    ).toBeVisible({ timeout: 8_000 });

    // Click the escape hatch
    await page.getByRole('button', { name: '+ Add connection' }).click();

    // ProviderSetupForm replaces the create agent modal content
    await expect(page.locator('div').filter({ hasText: /^Connect agent to external platform$/ }).first()).toBeVisible({ timeout: 5_000 });

    // Fill in the setup form — provider is auto-selected (Hyperliquid) from catalog
    await expect(page.getByRole('dialog').getByRole('combobox')).toHaveValue('hyperliquid', { timeout: 5_000 });
    await page.getByPlaceholder('e.g. My Hyperliquid account').fill('My HL Account J14');

    // Credential fields render for the selected provider (Hyperliquid: apiKey, secret, walletAddress)
    await expect(page.getByPlaceholder('0x...')).toHaveCount(2, { timeout: 5_000 });

    await page.getByPlaceholder('0x...').first().fill('test-api-key-j14');
    await page.locator('input[type="password"]').fill('test-secret-j14');
    await page.getByPlaceholder('0x...').last().fill('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    // Submit
    await page.getByRole('button', { name: 'Connect AI agent' }).click();

    // Setup form closes; back in the create agent modal with binding auto-selected
    await expect(page.locator('div').filter({ hasText: /^Connect agent to external platform$/ }).first()).not.toBeVisible({ timeout: 15_000 });

    // The no-bindings state is gone — the new binding is now selected
    await expect(
      page.getByText(/No active platform links yet/i),
    ).not.toBeVisible({ timeout: 8_000 });
  });
});
