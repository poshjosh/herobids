/**
 * Journey 10: Bot detail page renders correct empty state for unknown bot ID.
 *
 * Regression test for bug 2026-06-09-003 — navigating to /bots/<unknown-id>
 * showed "Agent not found" (wrong terminology) with no back-navigation action.
 * After the fix the page must show "Bot not found" and a "← Back to bots"
 * button that returns the user to /bots.
 */

import { test, expect } from '@playwright/test';
import { registerUser } from '../helpers.js';

const BASE_EMAIL = `j10-${Date.now()}`;
const PASSWORD = 'E2ePassword10!';

test.describe('Journey 10: Bot detail not-found state', () => {
  test('shows "Bot not found" empty state for unknown bot ID', async ({ page }) => {
    await registerUser(page, `${BASE_EMAIL}-a@e2e.local`, PASSWORD, 'E2E User J10a');
    await page.goto('/bots/00000000-0000-0000-0000-000000000000');

    // Regression: title was "Agent not found" — must be "Bot not found"
    // Note: EmptyState renders title as a <div>, not an <h*>, so we match by text
    await expect(page.getByText('Bot not found')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("This bot does not exist or you don't have access.")).toBeVisible({ timeout: 5_000 });
  });

  test('not-found page has a back-navigation action to /bots', async ({ page }) => {
    await registerUser(page, `${BASE_EMAIL}-b@e2e.local`, PASSWORD, 'E2E User J10b');
    await page.goto('/bots/00000000-0000-0000-0000-000000000000');

    // Regression: no back button was rendered — user was stranded on the 404 page
    const backButton = page.getByRole('button', { name: /← Back to bots/i });
    await expect(backButton).toBeVisible({ timeout: 5_000 });

    await backButton.click();
    await expect(page).toHaveURL(/\/bots$/, { timeout: 5_000 });
  });
});
