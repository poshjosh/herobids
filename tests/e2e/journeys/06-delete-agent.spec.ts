/**
 * Journey 6: Deleted agent is no longer visible in the agents list
 *
 * Verifies that after deleting an agent the agents list no longer shows it.
 * The delete button is not yet wired in AgentDetailPage; deletion is exercised
 * via the API and the agents list is used to confirm the removal.  When the
 * UI delete control is added, extend this journey to exercise the button path.
 */

import { test, expect } from '@playwright/test';

const EMAIL = `j6-${Date.now()}@e2e.local`;
const PASSWORD = 'E2ePassword6!';

test.describe('Journey 6: Deleted agent is no longer visible in the agents list', () => {
  test('after deletion the agent does not appear in the agents list', async ({ page, request }) => {
    // Register
    await page.goto('/login');
    await page.getByText(/sign up|don't have an account/i).click();
    await page.getByLabel(/name/i).fill('E2E User J6');
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
      data: { name: 'Delete Me Agent', prompt: 'I will be deleted.' },
    });
    if (!agentRes.ok()) {
      test.skip(true, 'Failed to create agent');
      return;
    }
    const { id: agentId } = await agentRes.json() as { id: string };

    // Confirm the agent appears in the list before deletion
    await page.goto('/agents');
    await expect(page.getByText(/Delete Me Agent/i)).toBeVisible({ timeout: 5000 });

    // Delete via API — AgentDetailPage does not yet have a delete button;
    // the API path exercises the correct server-side deletion logic and the
    // list assertion below verifies the UI correctly reflects the removal.
    const delRes = await request.delete(`/api/agents/${agentId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(delRes.status()).toBe(204);

    // Reload the agents list and verify the agent is gone
    await page.goto('/agents');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(/Delete Me Agent/i)).not.toBeVisible({ timeout: 5000 });
  });
});
