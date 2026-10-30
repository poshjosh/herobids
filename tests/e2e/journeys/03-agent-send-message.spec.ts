/**
 * Journey 3: Chat with an agent on the agent detail page
 *
 * The user opens an agent's detail page, finds the "Chat with {name}" composer,
 * sends a message, sees it appear in the thread, and then sees an agent reply.
 *
 * E2E has no real agent runtime or LLM, so the agent's reply is stored in the
 * conversation by the seedAgentChatReply helper (what the worker does when an
 * agent calls send_message). The web chat picks it up on its next poll.
 * Worker delivery of the message to the agent is covered by worker tests.
 */

import { ensureUserAiModelSettings, getAuthenticatedUserId, registerUser, seedAgentChatReply } from '../helpers.js';
import { test, expect } from '@playwright/test';

const EMAIL = `j3-${Date.now()}@e2e.local`;
const PASSWORD = 'E2ePassword3!';
const AGENT_NAME = 'Message Test Agent';

test.describe('Journey 3: Chat with an agent on the agent detail page', () => {
  test('user sends a message in the Chat card and sees it and an agent reply in the thread', async ({ page, request }) => {
    await registerUser(page, EMAIL, PASSWORD, 'E2E User J3');

    const token = await page.evaluate(() => localStorage.getItem('hb_session_token'));
    if (!token) {
      test.skip(true, 'Auth token not accessible from storage (hb_session_token)');
      return;
    }

    // The agent needs AI model settings to start
    await ensureUserAiModelSettings(page);

    const agentRes = await request.post('/api/agents', {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: AGENT_NAME, prompt: 'Send status updates.' },
    });
    if (!agentRes.ok()) {
      test.skip(true, 'Failed to create agent');
      return;
    }
    const { id: agentId } = await agentRes.json() as { id: string };
    const userId = await getAuthenticatedUserId(page, request);

    // Start lives on the details page; the chat is on /agents/:id.
    await page.goto(`/agents/${agentId}/details`);

    // A stopped agent cannot be chatted with; start it. While it is starting
    // the composer is enabled and the message is queued for delivery.
    await page.getByRole('button', { name: /^start$/i }).click();

    await page.goto(`/agents/${agentId}`);

    // The composer is labelled "Chat with <agent>" once the agent runs.
    const composer = page.getByLabel(`Chat with ${AGENT_NAME}`, { exact: true });
    await expect(composer).toBeEnabled({ timeout: 10_000 });

    const userMessage = `Hello from journey 3 ${Date.now()}`;
    await composer.fill(userMessage);
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    // The message shows in the thread and the composer is cleared
    await expect(page.getByText(userMessage, { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(composer).toHaveValue('');

    // The agent's reply appears in the thread without a reload (the chat polls)
    const agentReply = `Status update from the agent ${Date.now()}`;
    await seedAgentChatReply({ userId, agentId, body: agentReply });
    await expect(page.locator('[data-author="agent"]').getByText(agentReply, { exact: true })).toBeVisible({ timeout: 20_000 });

    // Both messages are still there after a reload
    await page.reload();
    await expect(page.getByText(userMessage, { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-author="agent"]').getByText(agentReply, { exact: true })).toBeVisible({ timeout: 10_000 });
  });
});
