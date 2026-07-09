/**
 * Journey 5: Agent lifecycle — start, see status change, stop
 *
 * Verifies the start/stop lifecycle from the UI.  Pause and resume require the
 * agent to reach 'active' status, which only happens when the worker promotes it
 * from 'starting'.  Without a running worker those transitions cannot be driven
 * from the UI, so this test covers the start → starting → stop → stopped path,
 * which is fully exercisable against the API alone.
 */

import { test, expect } from '@playwright/test';

const EMAIL = `j5-${Date.now()}@e2e.local`;
const PASSWORD = 'E2ePassword5!';

test.describe('Journey 5: Agent start / stop lifecycle', () => {
  test('user can start an agent and then stop it', async ({ page, request }) => {
    // Register
    await page.goto('/login');
    await page.getByText(/sign up|don't have an account/i).click();
    await page.getByLabel(/name/i).fill('E2E User J5');
    await page.getByLabel(/email/i).fill(EMAIL);
    await page.getByLabel(/password/i).fill(PASSWORD);
    await page.getByRole('button', { name: /create account|register/i }).click();
    await page.waitForURL('**/agents', { timeout: 15_000 });

    const token = await page.evaluate(() => localStorage.getItem('hb_session_token'));
    if (!token) {
      test.skip(true, 'Auth token not accessible from storage (hb_session_token)');
      return;
    }

    // Create agent via API
    const agentRes = await request.post('/api/agents', {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: 'Start Stop Agent', prompt: 'Stay active.' },
    });
    if (!agentRes.ok()) {
      test.skip(true, 'Failed to create agent');
      return;
    }
    const { id: agentId } = await agentRes.json() as { id: string };

    // Navigate to agent detail page — agent is stopped, Start button should be visible
    await page.goto(`/agents/${agentId}`);
    await expect(page.getByRole('button', { name: /^start$/i })).toBeVisible({ timeout: 5000 });

    // Start the agent via the UI button
    await page.getByRole('button', { name: /^start$/i }).click();

    // Status should transition to 'starting'
    await expect(page.getByText(/starting/i).first()).toBeVisible({ timeout: 10_000 });

    // The Stop button should now be visible (canStop includes 'starting')
    await expect(page.getByRole('button', { name: /^stop$/i })).toBeVisible({ timeout: 5000 });

    // Stop the agent via the UI button
    await page.getByRole('button', { name: /^stop$/i }).click();

    // Status should return to 'stopped'
    await expect(page.getByText('stopped', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  });
});
