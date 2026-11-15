/**
 * Journey 20: the agents page is the single home of the agent chat.
 *
 *   1. Clicking an agent card opens that agent's chat on /agents.
 *   2. The card's Settings (gear) button opens /agents/:id, titled "{name} · Settings".
 *   3. "Back to chat" returns to /agents with that agent's chat open.
 *   4. The marketplace has its own sidebar entry and page; the agents page has no marketplace tab.
 */

import { test, expect, type Page } from '@playwright/test';
import { registerUser, getAuthToken } from '../helpers.js';

const PASSWORD = 'E2ePassword20!';

async function createAgentViaApi(page: Page, name: string): Promise<string> {
  const token = await getAuthToken(page);
  const res = await page.request.post('/api/agents', {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: { name, prompt: 'Minimal agent for the chat home journey.' },
  });
  if (!res.ok()) {
    throw new Error(`Failed to create agent ${name}: ${res.status()} ${await res.text()}`);
  }
  const body = await res.json() as { id: string };
  return body.id;
}

const selectedChatAgent = (page: Page) => page.locator('#agents-chat-select option:checked');

test.describe('Journey 20: agent chat home', () => {
  test('cards open the chat, the gear opens settings, and Back to chat returns to it', async ({ page }) => {
    await registerUser(page, `j20-${Date.now()}@e2e.local`, PASSWORD, 'E2E User J20');
    await createAgentViaApi(page, 'Chat home first');
    const secondId = await createAgentViaApi(page, 'Chat home second');

    await page.goto('/agents');
    await expect(page.getByRole('heading', { level: 1, name: 'AI Agents' })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.agent-summary-card')).toHaveCount(2, { timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Marketplace' })).toHaveCount(0);

    const secondCard = page.locator('.agent-summary-card', { hasText: 'Chat home second' });
    await secondCard.getByText('Chat home second').click();
    await expect(page).toHaveURL(/\/agents$/);
    await expect(selectedChatAgent(page)).toHaveText('Chat home second');

    await page.locator('.agent-summary-card', { hasText: 'Chat home first' }).getByRole('button', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/\/agents\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Chat home first · Settings' })).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: 'Back to chat' }).click();
    await expect(page).toHaveURL(/\/agents$/);
    await expect(selectedChatAgent(page)).toHaveText('Chat home first');

    // A direct link selects the agent and the parameter is removed from the address bar.
    await page.goto(`/agents?agent=${secondId}`);
    await expect(selectedChatAgent(page)).toHaveText('Chat home second', { timeout: 10_000 });
    await expect(page).toHaveURL(/\/agents$/);
  });

  test('the marketplace has its own sidebar entry and page', async ({ page }) => {
    await registerUser(page, `j20b-${Date.now()}@e2e.local`, PASSWORD, 'E2E User J20B');
    await page.getByRole('link', { name: 'Marketplace' }).click();
    await expect(page).toHaveURL(/\/marketplace$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Marketplace' })).toBeVisible({ timeout: 10_000 });
  });
});
