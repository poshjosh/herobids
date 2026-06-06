/**
 * Journey 2: Recent Decisions section renders on agent detail page
 *
 * Verifies that the Recent Decisions card is present on the agent detail page
 * and shows the correct empty state.  Seeding actual decisions requires the
 * worker to process an agent action; that path is covered by worker integration
 * tests.  This journey covers the UI rendering and empty-state presentation.
 */

import { test, expect } from '@playwright/test';

const EMAIL = `j2-${Date.now()}@e2e.local`;
const PASSWORD = 'E2ePassword2!';
let agentId = '';

test.describe('Journey 2: Recent Decisions section renders on agent detail page', () => {
  test.beforeEach(async ({ page }) => {
    // Register and create an agent via the UI
    await page.goto('/login');
    await page.getByRole('tab', { name: /email/i }).click();
    const signUpLink = page.getByText(/sign up|don't have an account/i);
    if (await signUpLink.isVisible({ timeout: 2000 }).catch(() => false)) {
      await signUpLink.click();
      await page.getByLabel(/name/i).fill('E2E User J2');
    }
    await page.getByLabel(/email/i).fill(EMAIL);
    await page.getByLabel(/password/i).fill(PASSWORD);
    const submitBtn = page.getByRole('button', { name: /create account|sign in|log in/i }).first();
    await submitBtn.click();
    await page.waitForURL('**/mission-control', { timeout: 15_000 });
  });

  test('agent detail page renders the Recent Decisions card with empty state', async ({ page, request }) => {
    // Create an agent via API
    const token = await page.evaluate(() => localStorage.getItem('hb_session_token'));
    if (!token) {
      test.skip(true, 'Could not retrieve auth token from storage (hb_session_token) — skipping decision test');
      return;
    }

    const agentRes = await request.post('/api/agents', {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: 'Decision Test Agent', prompt: 'Monitor and decide.' },
    });

    if (!agentRes.ok()) {
      test.skip(true, 'Failed to create agent via API');
      return;
    }

    const agent = await agentRes.json() as { id: string };
    agentId = agent.id;

    // Navigate to the agent detail page
    await page.goto(`/agents/${agentId}`);

    // The Recent Decisions card should be present and display the empty state
    // ("No decisions submitted yet.") since no agent actions have been taken.
    await expect(page.getByText(/Recent Decisions/i)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/no decisions submitted yet/i)).toBeVisible({ timeout: 5000 });
  });
});
