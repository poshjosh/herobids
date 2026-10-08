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
    const { skills } = await skillsResponse.json() as { skills: Array<{ id: string; slug?: string; name: string }> };
    // Phase 4: trading skills are the external skills.sh refs (approved refs are
    // catalogued at API startup), not the removed built-in `bot-management` id.
    const botSkill = skills.find((s) => s.slug === 'traderton/skills/crypto-bot-management');
    if (!botSkill) {
      throw new Error('crypto-bot-management skill not found in API response');
    }

    // The "Suggested skills" dropdown was removed (change 009); skills are
    // selected directly via the SkillPicker — no preset switch needed.
    // Skills are behind the "▸ Add skills (Optional)" expandable section.
    // Click it to reveal skill checkboxes.
    const addSkillsBtn = page.getByRole('button', { name: /Add skills/i });
    if (await addSkillsBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await addSkillsBtn.click();
      await page.waitForTimeout(300);
    }

    // If the Advanced Settings section exists (with a Skills tab), open it
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

    // The generic Add-connection entry point no longer pre-lists trading
    // providers in the dropdown — it defaults to Custom provider. Trading
    // venues (e.g. Hyperliquid) are still reachable here: the connection's
    // display Name doubles as the provider id (lowercased), and typing a
    // known trading provider id is inferred as a trading capability from
    // the provider catalog, same as picking it from a dropdown would be.
    await expect(page.getByRole('dialog').getByRole('combobox')).toHaveValue('__custom__', { timeout: 5_000 });
    await page.getByPlaceholder('e.g. My Gmail account').fill('hyperliquid');

    // Custom mode renders freeform secret key/value rows (no structured
    // field hints) — fill the Hyperliquid credential shape by hand.
    await page.getByPlaceholder('Secret name').nth(0).fill('apiKey');
    await page.getByPlaceholder('Secret value').nth(0).fill('test-api-key-j14');

    await page.getByRole('button', { name: 'Add secret' }).click();
    await page.getByPlaceholder('Secret name').nth(1).fill('secret');
    await page.getByPlaceholder('Secret value').nth(1).fill('test-secret-j14');

    await page.getByRole('button', { name: 'Add secret' }).click();
    await page.getByPlaceholder('Secret name').nth(2).fill('walletAddress');
    await page.getByPlaceholder('Secret value').nth(2).fill('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

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
