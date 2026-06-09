/**
 * Journey 9: Connections page renders with correct heading and subtitle.
 *
 * Regression test for bug 2026-06-09-001 — the Connections page subtitle read
 * "Platform connections to reusable providers" instead of the specified
 * "Platform connections to external providers".
 */

import { test, expect } from '@playwright/test';
import { registerUser } from '../helpers.js';

const EMAIL = `j9-${Date.now()}@e2e.local`;
const PASSWORD = 'E2ePassword9!';

test.describe('Journey 9: Connections page renders', () => {
  test('shows correct heading, subtitle, and empty state', async ({ page }) => {
    await registerUser(page, EMAIL, PASSWORD, 'E2E User J9');

    await page.goto('/connections');

    await expect(page.getByRole('heading', { name: /^Connections$/i })).toBeVisible({ timeout: 5_000 });
    // Regression: subtitle was "reusable providers" — must be "external providers"
    await expect(page.getByText('Platform connections to external providers')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/No connections yet/i)).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/Create one to enable capability families for your agents/i)).toBeVisible({ timeout: 5_000 });
  });
});
