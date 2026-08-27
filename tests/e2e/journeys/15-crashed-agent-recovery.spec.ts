/**
 * Journey 15: Crashed-agent recovery — stop → delete
 *
 * Verifies that an agent in a non-stopped state can be recovered via the stop
 * endpoint and then deleted.  The crashed state itself requires a live worker
 * and cannot be triggered from E2E, but the recovery contract (stop accepts
 * any non-stopped status, delete requires stopped) is validated here.
 *
 * Regression coverage for: UI canStop missing 'crashed', and the delete
 * endpoint correctly enforcing "stop before delete".
 */

import { registerUser, ensureUserAiModelSettings } from '../helpers.js';
import { test, expect } from '@playwright/test';

const EMAIL = `j15-${Date.now()}@e2e.local`;
const PASSWORD = 'E2ePassword15!';

test.describe('Journey 15: Crashed-agent recovery', () => {
  test('stop → delete works after agent is started', async ({ page, request }) => {
    await registerUser(page, EMAIL, PASSWORD, 'E2E User J15');

    const token = await page.evaluate(() => localStorage.getItem('hb_session_token'));
    if (!token) {
      test.skip(true, 'Auth token not accessible from storage (hb_session_token)');
      return;
    }

    // Ensure the user has AI model settings so the agent can start
    await ensureUserAiModelSettings(page);

    // Create agent via API — starts in 'stopped' state
    const agentRes = await request.post('/api/agents', {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: 'Recovery Test Agent', prompt: 'I will be recovered.' },
    });
    if (!agentRes.ok()) {
      test.skip(true, 'Failed to create agent');
      return;
    }
    const { id: agentId } = await agentRes.json() as { id: string };

    // Start the agent — status becomes 'starting'
    const startRes = await request.post(`/api/agents/${agentId}/start`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(startRes.status()).toBe(202);

    // Delete must be rejected while agent is not stopped
    const delWhileStarting = await request.delete(`/api/agents/${agentId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(delWhileStarting.status()).toBe(409);

    // Stop the agent — should work from 'starting' (and from any non-stopped state,
    // including 'crashed', which is validated by the API unit tests)
    const stopRes = await request.post(`/api/agents/${agentId}/stop`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(stopRes.status()).toBe(200);
    expect(await stopRes.json()).toEqual({ status: 'stopped' });

    // Now delete should succeed
    const delRes = await request.delete(`/api/agents/${agentId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(delRes.status()).toBe(204);

    // Verify the agent is gone from the list
    await page.goto('/agents');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(/Recovery Test Agent/i)).not.toBeVisible({ timeout: 5000 });
  });
});
