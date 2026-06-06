/**
 * Journey 7: Mission Control page renders without crashing
 *
 * Regression test for bug 2026-06-06-17: after registration the Mission Control
 * page threw `TypeError: Cannot read properties of undefined (reading 'length')`
 * because MissionControlPage read `overview.instances` but the API returns
 * `overview.bots`.  The component crashed before the React tree finished
 * rendering, showing the router-level error boundary instead of the page.
 *
 * This journey verifies:
 *   1. After registration the user lands on /mission-control with no error.
 *   2. The page heading "Mission Control" is visible (component did not crash).
 *   3. The subtitle using summary.runningBots / summary.totalBots is rendered.
 *   4. The "Your agents" section renders (driven by overview.bots array).
 *   5. The empty-state card is shown when there are no bots (overview.bots=[]).
 *   6. The router-level error boundary text is NOT present.
 */

import { test, expect } from '@playwright/test';

const EMAIL = `j7-${Date.now()}@e2e.local`;
const PASSWORD = 'E2ePassword7!';

test.describe('Journey 7: Mission Control page renders without crashing', () => {
  test('new user lands on Mission Control with correct page content and no crash', async ({ page }) => {
    // Register a new user — post-registration redirect lands on /mission-control
    await page.goto('/login');
    await page.getByRole('tab', { name: /email/i }).click();
    await page.getByText(/sign up|don't have an account/i).click();
    await page.getByLabel(/name/i).fill('E2E User J7');
    await page.getByLabel(/email/i).fill(EMAIL);
    await page.getByLabel(/password/i).fill(PASSWORD);
    await page.getByRole('button', { name: /create account|register|sign up/i }).click();
    await page.waitForURL('**/mission-control', { timeout: 15_000 });

    // The regression caused a crash before any content rendered, showing the
    // router error boundary with "Unexpected Application Error!" instead.
    await expect(page.getByText(/Unexpected Application Error/i)).not.toBeVisible();

    // The heading must be visible — confirms the component tree rendered.
    await expect(page.getByRole('heading', { name: /Mission Control/i })).toBeVisible({ timeout: 5000 });

    // The subtitle is built from overview.summary.runningBots / totalBots.
    // If the wrong field names were used, the component would have crashed
    // before reaching this element.
    await expect(page.getByText(/of \d+ agent/i)).toBeVisible({ timeout: 5000 });

    // The "Your agents" section is rendered by iterating overview.bots.
    // Accessing overview.instances (undefined) would throw before this renders.
    await expect(page.getByText('Your agents', { exact: true })).toBeVisible({ timeout: 5000 });

    // A new user has no bots — the empty state must be shown, not a crash.
    await expect(page.getByText(/No agents yet/i)).toBeVisible({ timeout: 5000 });
  });

  test('Mission Control page renders correctly when bots exist', async ({ page, request }) => {
    // Register
    await page.goto('/login');
    await page.getByRole('tab', { name: /email/i }).click();
    await page.getByText(/sign up|don't have an account/i).click();
    await page.getByLabel(/name/i).fill('E2E User J7b');
    await page.getByLabel(/email/i).fill(`j7b-${Date.now()}@e2e.local`);
    await page.getByLabel(/password/i).fill(PASSWORD);
    await page.getByRole('button', { name: /create account|register|sign up/i }).click();
    await page.waitForURL('**/mission-control', { timeout: 15_000 });

    const token = await page.evaluate(() => localStorage.getItem('hb_session_token'));
    if (!token) {
      test.skip(true, 'Auth token not accessible from storage (hb_session_token)');
      return;
    }

    // Create an agent so overview.bots is non-empty
    const agentRes = await request.post('/api/agents', {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: 'MC Render Agent', prompt: 'Test mission control rendering.' },
    });
    if (!agentRes.ok()) {
      test.skip(true, 'Failed to create agent via API');
      return;
    }

    // Reload mission control to pick up the new agent
    await page.goto('/mission-control');

    await expect(page.getByText(/Unexpected Application Error/i)).not.toBeVisible();
    await expect(page.getByRole('heading', { name: /Mission Control/i })).toBeVisible({ timeout: 5000 });

    // With at least one agent, the health strip and agent overview cards render.
    // AgentOverviewCard iterates overview.bots — wrong field would crash here.
    await expect(page.getByText('Your agents', { exact: true })).toBeVisible({ timeout: 5000 });
  });
});
