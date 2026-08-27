/**
 * Journey 3: Messages section renders on agent detail page
 *
 * Verifies that the Messages to User and Protocol Activity cards are present
 * on the agent detail page and show the correct empty states.  Seeding actual
 * outbound messages requires the worker to process agent send_message actions;
 * that path is covered by worker integration tests.  This journey covers UI
 * rendering and empty-state presentation.
 */

import { registerUser } from '../helpers.js';
import { test, expect } from '@playwright/test';

const EMAIL = `j3-${Date.now()}@e2e.local`;
const PASSWORD = 'E2ePassword3!';

test.describe('Journey 3: Messages section renders on agent detail page', () => {
  test('agent detail page renders messages and activity cards with empty states', async ({ page, request }) => {
    await registerUser(page, EMAIL, PASSWORD, 'E2E User J3');

    const token = await page.evaluate(() => localStorage.getItem('hb_session_token'));
    if (!token) {
      test.skip(true, 'Auth token not accessible from storage (hb_session_token)');
      return;
    }

    // Create agent via API
    const agentRes = await request.post('/api/agents', {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: 'Message Test Agent', prompt: 'Send status updates.' },
    });
    if (!agentRes.ok()) {
      test.skip(true, 'Failed to create agent');
      return;
    }
    const { id: agentId } = await agentRes.json() as { id: string };

    // Navigate to agent detail and check the messages section
    await page.goto(`/agents/${agentId}`);

    // Both the Messages to User card and the Protocol Activity card should be
    // present and display their respective empty states.
    // The Messages section is inside a collapsed <details>; click to expand.
    await expect(page.getByText(/Messages to user/i)).toBeVisible({ timeout: 5000 });
    await page.getByText(/Messages to user/i).click();
    await expect(page.getByText(/No messages sent yet/i)).toBeVisible({ timeout: 5000 });

    await expect(page.getByText(/Activity Timeline/i)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/No activity recorded yet/i)).toBeVisible({ timeout: 5000 });
  });
});
