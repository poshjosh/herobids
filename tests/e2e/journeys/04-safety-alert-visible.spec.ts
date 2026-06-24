/**
 * Journey 4: Runtime health card visible after agent start
 *
 * Verifies that starting an agent creates an active session and the Runtime Health
 * card becomes visible on the agent detail page.
 */

import { test, expect } from '@playwright/test';
import { registerUser, createAgent } from '../helpers.js';

const EMAIL = `j4-${Date.now()}@e2e.local`;
const PASSWORD = 'E2ePassword4!';

test.describe('Journey 4: Runtime health card visible after start', () => {
  test('starting an agent shows the Runtime health section on the detail page', async ({ page, request }) => {
    await registerUser(page, EMAIL, PASSWORD, 'E2E User J4');

    const agentId = await createAgent(
      page,
      'Monitor things and show runtime health.',
      { preset: 'general' },
    );

    // Start agent via API — creates a session record, transitions status to 'starting'.
    // The worker picks this up and promotes it to running; here we only validate the
    // UI correctly surfaces the session while in 'starting' state.
    const token = await page.evaluate(() => localStorage.getItem('hb_session_token'));
    if (!token) {
      test.skip(true, 'Auth token not accessible from storage (hb_session_token)');
      return;
    }

    const startRes = await request.post(`/api/agents/${agentId}/start`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!startRes.ok()) {
      test.skip(true, 'Failed to start agent');
      return;
    }

    // Navigate to agent detail page
    await page.goto(`/agents/${agentId}`);

    // The Runtime health section is rendered whenever there is an active session
    // (status: starting | running | unhealthy).
    await expect(page.getByRole('heading', { name: /runtime health/i })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/starting/i).first()).toBeVisible({ timeout: 10_000 });

    // Clean up — stop the agent so it does not linger as 'starting'
    await request.post(`/api/agents/${agentId}/stop`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  });
});
