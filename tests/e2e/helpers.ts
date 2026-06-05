/**
 * Shared helpers for E2E tests.
 *
 * All tests import these helpers to register/login users and navigate
 * to key pages.
 */

import type { Page } from '@playwright/test';

export const TEST_EMAIL = `e2e-${Date.now()}@test.local`;
export const TEST_PASSWORD = 'TestPassword123!';
export const TEST_DISPLAY_NAME = 'E2E Test User';

/** Register a new user via the login/register form. */
export async function registerUser(
  page: Page,
  email = TEST_EMAIL,
  password = TEST_PASSWORD,
  displayName = TEST_DISPLAY_NAME,
) {
  await page.goto('/login');
  await page.getByRole('tab', { name: /email/i }).click();
  await page.getByText(/sign up|register|don't have an account/i).click();
  await page.getByLabel(/name/i).fill(displayName);
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole('button', { name: /create account|register|sign up/i }).click();
  // Should redirect to mission control
  await page.waitForURL('**/mission-control', { timeout: 15_000 });
}

/** Log in with existing credentials. */
export async function loginUser(
  page: Page,
  email = TEST_EMAIL,
  password = TEST_PASSWORD,
) {
  await page.goto('/login');
  await page.getByRole('tab', { name: /email/i }).click();
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole('button', { name: /sign in|log in|continue/i }).click();
  await page.waitForURL('**/mission-control', { timeout: 15_000 });
}

/** Create an agent and return its name. */
export async function createAgent(
  page: Page,
  name: string,
  goal: string,
  skipVenueStep = true,
): Promise<string> {
  await page.goto('/agents');
  await page.getByRole('button', { name: /new agent|create agent/i }).click();

  await page.getByPlaceholder(/what do you want/i).fill(goal);

  if (!skipVenueStep) {
    // The intent step may show venue account selection — skip it if optional
    const venueSelect = page.locator('select, [role="combobox"]').first();
    if (await venueSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Leave default
    }
  }

  // Click Next / Review
  const nextBtn = page.getByRole('button', { name: /next|review/i });
  if (await nextBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await nextBtn.click();
  }

  // Confirm / Create
  await page.getByRole('button', { name: /create|confirm|start agent/i }).click();

  // Should navigate to agent detail page
  await page.waitForURL('**/agents/**', { timeout: 15_000 });

  return name;
}
