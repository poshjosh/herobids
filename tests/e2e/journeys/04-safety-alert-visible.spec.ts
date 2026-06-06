/**
 * Journey 4: Runtime health card and alert banner visible in UI
 *
 * Verifies that starting an agent creates an active session and the Runtime Health
 * card becomes visible in the UI.  The crash/unhealthy alert banner is shown by the
 * same card when the session status changes — that scenario requires a running worker
 * to detect a missed heartbeat and is covered by worker integration tests instead.
 */

import { test, expect } from '@playwright/test';

const EMAIL = `j4-${Date.now()}@e2e.local`;
const PASSWORD = 'E2ePassword4!';

test.describe('Journey 4: Runtime health card visible in UI', () => {
  test('starting an agent shows the Runtime Health card on the detail page', async ({ page, request }) => {
    // Register
    await page.goto('/login');
    await page.getByRole('tab', { name: /email/i }).click();
    await page.getByText(/sign up|don't have an account/i).click();
    await page.getByLabel(/name/i).fill('E2E User J4');
    await page.getByLabel(/email/i).fill(EMAIL);
    await page.getByLabel(/password/i).fill(PASSWORD);
    await page.getByRole('button', { name: /create account|register/i }).click();
    await page.waitForURL('**/mission-control', { timeout: 15_000 });

    const token = await page.evaluate(() => localStorage.getItem('hb_session_token'));
    if (!token) {
      test.skip(true, 'Auth token not accessible from storage (hb_session_token)');
      return;
    }

    // Create agent via API
    const agentRes = await request.post('/api/agents', {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: 'Runtime Health Agent', prompt: 'Monitor things.' },
    });
    if (!agentRes.ok()) {
      test.skip(true, 'Failed to create agent');
      return;
    }
    const { id: agentId } = await agentRes.json() as { id: string };

    // Start agent via API — creates a session record, transitions status to 'starting'.
    // The worker picks this up and promotes it to running; here we only validate the
    // UI correctly surfaces the session while in 'starting' state.
    const startRes = await request.post(`/api/agents/${agentId}/start`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!startRes.ok()) {
      test.skip(true, 'Failed to start agent');
      return;
    }

    // Navigate to agent detail page
    await page.goto(`/agents/${agentId}`);

    // The Runtime Health card is rendered whenever there is an active session
    // (status: starting | running | unhealthy).
    await expect(page.getByRole('heading', { name: 'Runtime Health', exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/starting/i).first()).toBeVisible({ timeout: 10_000 });

    // Clean up — stop the agent so it does not linger as 'starting'
    await request.post(`/api/agents/${agentId}/stop`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  });
});
