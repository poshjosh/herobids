/**
 * Journey 11: Unknown routes show the branded 404 page, not the React Router
 * developer error page.
 *
 * Regression test for bug 2026-06-04-009 — navigating to any undefined route
 * (e.g. /does-not-exist) showed the React Router default ErrorBoundary with
 * "Unexpected Application Error! 404 Not Found — Hey developer 👋 …". After
 * the fix a catch-all route renders NotFoundPage, which shows a branded
 * "Page not found" empty state with a "← Back to AI Agents" CTA that
 * returns the user to /agents.
 */

import { test, expect } from '@playwright/test';
import { registerUser } from '../helpers.js';

const BASE_EMAIL = `j11-${Date.now()}`;
const PASSWORD = 'E2ePassword11!';

test.describe('Journey 11: Unknown route shows branded 404 page', () => {
  test('unknown route shows "Page not found" instead of React Router dev error', async ({ page }) => {
    await registerUser(page, `${BASE_EMAIL}-a@e2e.local`, PASSWORD, 'E2E User J11a');
    await page.goto('/does-not-exist');

    // Regression: previously showed "Unexpected Application Error!" and
    // "Hey developer 👋" — these must NOT appear.
    await expect(page.getByText(/unexpected application error/i)).not.toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/hey developer/i)).not.toBeVisible({ timeout: 5_000 });

    // The branded empty-state title must be visible.
    await expect(page.getByText('Page not found')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("The page you're looking for doesn't exist or has been moved.")).toBeVisible({ timeout: 5_000 });
  });

  test('unknown route has a "Back to AI Agents" CTA that navigates correctly', async ({ page }) => {
    await registerUser(page, `${BASE_EMAIL}-b@e2e.local`, PASSWORD, 'E2E User J11b');
    await page.goto('/does-not-exist');

    const backButton = page.getByRole('button', { name: /← Back to AI Agents/i });
    await expect(backButton).toBeVisible({ timeout: 5_000 });

    await backButton.click();
    await expect(page).toHaveURL(/\/agents$/, { timeout: 5_000 });
  });

  test('deeply nested unknown route also shows 404 page', async ({ page }) => {
    await registerUser(page, `${BASE_EMAIL}-c@e2e.local`, PASSWORD, 'E2E User J11c');
    await page.goto('/some/deeply/nested/path/that/does/not/exist');

    await expect(page.getByText('Page not found')).toBeVisible({ timeout: 5_000 });
  });
});
