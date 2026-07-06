/**
 * Journey 17: Bot creation modal interactions.
 *
 * Covers UAT cases I-01, I-02, I-04:
 *  - Bots page renders with correct title/subtitle and "Create Bot" CTA.
 *  - Empty state is shown when no bots exist.
 *  - "Create Bot" button inside the modal is disabled when required fields
 *    (connection, symbol) are empty.
 *  - The modal can be dismissed via "Cancel".
 *
 * Note: the full happy-path (I-03) requires an active trading connection and
 * is covered by manual UAT or integration tests with provisioned test credentials.
 */

import { test, expect } from '@playwright/test';
import { registerUser } from '../helpers.js';

const BASE_EMAIL = `j17-${Date.now()}`;
const PASSWORD = 'E2ePassword17!';

test.describe('Journey 17: Create bot modal', () => {
  test('bots page renders title and "Create Bot" CTA', async ({ page }) => {
    await registerUser(page, `${BASE_EMAIL}-a@e2e.local`, PASSWORD, 'E2E User J17a');
    await page.goto('/bots');

    await expect(page.getByText('Bots')).toBeVisible({ timeout: 5_000 });
    await expect(
      page.getByRole('button', { name: /create bot/i }).first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('empty state shown when no bots exist', async ({ page }) => {
    await registerUser(page, `${BASE_EMAIL}-b@e2e.local`, PASSWORD, 'E2E User J17b');
    await page.goto('/bots');

    await expect(page.getByText('No bots yet')).toBeVisible({ timeout: 5_000 });
    // CTA inside empty state
    await expect(
      page.getByRole('button', { name: /create bot/i }).last(),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('Create Bot button in modal is disabled without a connection selected', async ({ page }) => {
    await registerUser(page, `${BASE_EMAIL}-c@e2e.local`, PASSWORD, 'E2E User J17c');
    await page.goto('/bots');

    // Open the modal via the header CTA
    await page.getByRole('button', { name: /create bot/i }).first().click();
    await expect(page.getByText('Create Bot')).toBeVisible({ timeout: 5_000 });

    // Strategy preset and connection are empty by default — submit must be disabled
    const createBtn = page.getByRole('button', { name: /^creating…$|^create bot$/i }).last();
    await expect(createBtn).toBeDisabled({ timeout: 3_000 });
  });

  test('modal can be closed via Cancel', async ({ page }) => {
    await registerUser(page, `${BASE_EMAIL}-d@e2e.local`, PASSWORD, 'E2E User J17d');
    await page.goto('/bots');

    await page.getByRole('button', { name: /create bot/i }).first().click();
    await expect(page.getByText('Create Bot')).toBeVisible({ timeout: 5_000 });

    await page.getByRole('button', { name: /^cancel$/i }).click();
    // Modal must be gone; bots page must still be present
    await expect(page.getByText('No bots yet')).toBeVisible({ timeout: 5_000 });
    // After closing the modal, only the header and empty-state CTAs remain;
    // there should no longer be a modal title visually present.
    await expect(page.locator('[role="dialog"]')).toHaveCount(0, { timeout: 5_000 });
  });
});
