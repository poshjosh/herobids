/**
 * Journey 13: AI Agents guided setup card — full UI flow.
 *
 * Verifies that a new user can:
 * 1. See the quick trading setup card on AI Agents.
 * 2. Open the setup form by clicking the CTA button.
 * 3. Fill in provider details and secrets, then submit.
 * 4. See the success banner with the account label and provider.
 * 5. Dismiss the banner and return to the setup card.
 */

import { test, expect } from '@playwright/test';
import { createAgent, registerUser } from '../helpers.js';

const EMAIL = `j13-${Date.now()}@e2e.local`;
const PASSWORD = 'E2ePassword13!';

test.describe('Journey 13: AI Agents setup card UI flow', () => {
  test('new user completes guided trading setup from AI Agents', async ({ page }) => {
    await registerUser(page, EMAIL, PASSWORD, 'E2E User J13');

    await createAgent(page, 'Track markets and surface the setup card.', { preset: 'general' });

    await page.goto('/agents');
    await expect(page.getByRole('heading', { name: /AI Agents/i })).toBeVisible({ timeout: 5_000 });

    // Setup card is visible with title and CTA
    await expect(page.getByText('Connect AI agent to external platform')).toBeVisible({ timeout: 5_000 });
    const ctaButton = page.getByRole('button', { name: 'Connect AI agent' });
    await expect(ctaButton).toBeVisible({ timeout: 5_000 });

    // Open the setup form
    await ctaButton.click();
    await expect(page.getByRole('dialog').locator('div').filter({ hasText: /^Connect agent to external platform$/ }).first()).toBeVisible({ timeout: 5_000 });

    // Provider is auto-selected (Hyperliquid) from catalog once form opens
    await expect(page.getByRole('dialog').getByRole('combobox')).toHaveValue('hyperliquid', { timeout: 5_000 });
    await page.getByPlaceholder('e.g. My Hyperliquid account').fill('My HL Account J13');

    // Credential fields render for the selected provider (Hyperliquid: apiKey, secret, walletAddress)
    await expect(page.getByPlaceholder('0x...')).toHaveCount(2, { timeout: 5_000 });

    await page.getByPlaceholder('0x...').first().fill('test-api-key-j13');
    await page.locator('input[type="password"]').fill('test-secret-j13');
    await page.getByPlaceholder('0x...').last().fill('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    // Submit the form
    await page.getByRole('dialog').getByRole('button', { name: 'Connect AI agent' }).click();

    // Assignment step appears — skip to keep the setup flow focused on the connection UX.
    await expect(page.getByText(/Which agents should use this connection/i)).toBeVisible({ timeout: 5_000 });
    await page.getByRole('button', { name: 'Skip' }).click();

    // Success banner appears with the account label and provider
    await expect(
      page.getByText(/My HL Account J13 \(hyperliquid\) is ready for your AI agents\./i),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Done' })).toBeVisible();

    // Dismiss the banner
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText(/is ready for your AI agents\./).first()).not.toBeVisible({ timeout: 3_000 });

    // Setup card is still present after dismissal
    await expect(page.getByText('Connect AI agent to external platform').first()).toBeVisible({ timeout: 3_000 });
  });
});
