/**
 * Journey 13: Mission Control guided setup card — full UI flow.
 *
 * Verifies that a new user can:
 * 1. See the quick trading setup card on Mission Control.
 * 2. Open the setup form by clicking the CTA button.
 * 3. Fill in provider details and secrets, then submit.
 * 4. See the success banner with the account label and provider.
 * 5. Dismiss the banner and return to the setup card.
 */

import { test, expect } from '@playwright/test';
import { registerUser } from '../helpers.js';

const EMAIL = `j13-${Date.now()}@e2e.local`;
const PASSWORD = 'E2ePassword13!';

test.describe('Journey 13: Mission Control setup card UI flow', () => {
  test('new user completes guided trading setup from Mission Control', async ({ page }) => {
    await registerUser(page, EMAIL, PASSWORD, 'E2E User J13');

    await page.goto('/mission-control');
    await expect(page.getByRole('heading', { name: /Mission Control/i })).toBeVisible({ timeout: 5_000 });

    // Setup card is visible with title and CTA
    await expect(page.getByText('Quick AI agent connect')).toBeVisible({ timeout: 5_000 });
    const ctaButton = page.getByRole('button', { name: 'Add provider connection' });
    await expect(ctaButton).toBeVisible({ timeout: 5_000 });

    // Open the setup form
    await ctaButton.click();
    await expect(page.getByRole('dialog').locator('div').filter({ hasText: /^Add trading connection$/ }).first()).toBeVisible({ timeout: 5_000 });

    // Provider is auto-selected (Hyperliquid) from catalog once form opens
    await expect(page.getByRole('dialog').getByRole('combobox')).toHaveValue('hyperliquid', { timeout: 5_000 });
    await page.getByPlaceholder('e.g. My Hyperliquid account').fill('My HL Account J13');

    // Credential fields render for the selected provider (Hyperliquid: apiKey, secret, walletAddress)
    await expect(page.getByPlaceholder('0x...')).toHaveCount(2, { timeout: 5_000 });

    await page.getByPlaceholder('0x...').first().fill('test-api-key-j13');
    await page.locator('input[type="password"]').fill('test-secret-j13');
    await page.getByPlaceholder('0x...').last().fill('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    // Submit the form
    await page.getByRole('dialog').getByRole('button', { name: 'Add trading connection' }).click();

    // Success banner appears with the account label and provider
    await expect(
      page.getByText(/My HL Account J13 \(hyperliquid\) is ready for your AI agents\./i),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Done' })).toBeVisible();

    // Dismiss the banner
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText(/is ready for your AI agents\./).first()).not.toBeVisible({ timeout: 3_000 });

    // Setup card is still present after dismissal
    await expect(page.getByText('Quick AI agent connect').first()).toBeVisible({ timeout: 3_000 });
  });
});
