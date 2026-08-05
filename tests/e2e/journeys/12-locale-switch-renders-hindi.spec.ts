import { expect, test } from '@playwright/test';
import { registerUser } from '../helpers.js';

const EMAIL = `j12-${Date.now()}@e2e.local`;
const PASSWORD = 'E2ePassword12!';

test.describe('Journey 12: locale switch', () => {
  test('switches to Hindi and keeps localized chrome on the agents page', async ({ page }) => {
    await registerUser(page, EMAIL, PASSWORD, 'E2E User J12');

    await page.goto('/settings');
    await page.getByLabel(/display language/i).selectOption('hi');

    await expect(page.getByRole('heading', { name: 'सेटिंग्स' })).toBeVisible({ timeout: 5_000 });
    await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('hi');

    await page.goto('/agents');

    await expect(page.getByRole('heading', { name: 'AI एजेंट' })).toBeVisible({ timeout: 5_000 });
    // The "Create AI agent" header button navigates to the create page.
    await expect(page.getByRole('button', { name: 'AI एजेंट बनाएं' })).toBeVisible({ timeout: 5_000 });
  });
});