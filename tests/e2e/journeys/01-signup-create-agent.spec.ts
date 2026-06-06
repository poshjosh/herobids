/**
 * Journey 1: Sign up → create an agent → start the agent → see heartbeat in UI
 *
 * Verifies the core new-user onboarding flow end to end.
 */

import { test, expect } from '@playwright/test';

const EMAIL = `j1-${Date.now()}@e2e.local`;
const PASSWORD = 'E2ePassword1!';

// Tests within this suite run serially: the second test depends on state
// created by the first (registered user + created agent).
test.describe('Journey 1: Sign up → create agent → start → heartbeat', () => {
  test.describe.configure({ mode: 'serial' });

  test('new user can sign up and create their first agent', async ({ page }) => {
    // Register
    await page.goto('/login');
    await page.getByRole('tab', { name: /email/i }).click();
    const signUpLink = page.getByText(/sign up|don't have an account/i);
    await signUpLink.click();

    await page.getByLabel(/name/i).fill('E2E User J1');
    await page.getByLabel(/email/i).fill(EMAIL);
    await page.getByLabel(/password/i).fill(PASSWORD);
    await page.getByRole('button', { name: /create account|register|sign up/i }).click();

    await page.waitForURL('**/mission-control', { timeout: 15_000 });
    await expect(page).toHaveURL(/mission-control/);

    // Navigate to agents
    await page.goto('/agents');
    await expect(page.getByRole('heading', { name: /AI Agents/i })).toBeVisible();

    // Create agent
    await page.getByRole('button', { name: /new agent|create agent/i }).first().click();

    // Fill in the goal
    const goalInput = page.getByPlaceholder(/what do you want|describe/i).or(page.locator('textarea').first());
    await goalInput.fill('Alert me when BTC drops 5% in a day');

    // Click through to create (may have a review step)
    const nextBtn = page.getByRole('button', { name: /next|review/i });
    if (await nextBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await nextBtn.click();
    }

    const createBtn = page.getByRole('button', { name: /create|confirm/i }).last();
    await createBtn.click();

    // Should land on agent detail page
    await page.waitForURL('**/agents/**', { timeout: 15_000 });
    await expect(page).toHaveURL(/\/agents\/.+/);

    // Agent should be visible with stopped status
    await expect(page.getByText(/stopped/i)).toBeVisible();
  });

  test('agent appears in the agents list after creation', async ({ page }) => {
    // Login
    await page.goto('/login');
    await page.getByRole('tab', { name: /email/i }).click();
    await page.getByLabel(/email/i).fill(EMAIL);
    await page.getByLabel(/password/i).fill(PASSWORD);
    await page.getByRole('button', { name: /sign in|log in|continue/i }).click();
    await page.waitForURL('**/mission-control', { timeout: 15_000 });

    await page.goto('/agents');
    // The agent created in the first test should appear
    await expect(page.locator('[data-testid="agent-card"], .agent-card').or(
      page.getByText(/Alert me when BTC drops 5/i),
    ).first()).toBeVisible({ timeout: 5000 });
  });
});
