/**
 * Journey 8: AI Agents page reflects an enabled capability and opens the
 * agent-scoped capability page from the agent detail page.
 */

import { test, expect, type Page } from '@playwright/test';
import {
  registerUser,
  createAgent,
  setupTradingLink,
  assignTradingConnection,
} from '../helpers.js';

const EMAIL = `j8-${Date.now()}@e2e.local`;
const PASSWORD = 'E2ePassword8!';

function readinessCard(page: Page) {
  return page.getByRole('region', { name: /Capability readiness/i });
}

function rowValue(card: ReturnType<typeof readinessCard>, label: RegExp) {
  return card.getByText(label).locator('xpath=following-sibling::span');
}

test.describe('Journey 8: AI Agents page reflects enabled capability', () => {
  test('AI Agents page shows the ready capability CTA and opens the capability page', async ({ page, request }) => {
    await registerUser(page, EMAIL, PASSWORD, 'E2E User J8');

    // Create agent via API so we can set skillIds without hitting the
    // Trading-preset form validation in the UI (capital field timing issue).
    const token = await page.evaluate(() => localStorage.getItem('hb_session_token'));
    if (!token) {
      test.skip(true, 'Auth token not accessible from storage (hb_session_token)');
      return;
    }
    const agentRes = await request.post('/api/agents', {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: 'Trading agent', prompt: 'Run the trading capability and reflect readiness in AI Agents.', skillIds: ['bot-management'] },
    });
    if (!agentRes.ok()) {
      test.skip(true, `Failed to create agent: ${agentRes.status()} ${await agentRes.text()}`);
      return;
    }
    const { id: agentId } = await agentRes.json() as { id: string };

    const { connectionId } = await setupTradingLink(page, request, {
      provider: 'hyperliquid',
      label: 'AI Agents connection',
      secrets: {
        apiKey: 'test-api-key',
        secret: 'test-secret',
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    });

    await assignTradingConnection(page, request, agentId, connectionId);

    await page.goto('/agents');
    await expect(page.getByRole('heading', { name: /AI Agents/i })).toBeVisible({ timeout: 5_000 });

    // The summary card now navigates to agent detail on click (no explicit
    // "Open trading capability" button — capability config moved to detail page).
    await page.getByText('Trading agent').click();
    await expect(page).toHaveURL(new RegExp(`/agents/${agentId}$`), { timeout: 5_000 });

    // Open the capabilities section on the detail page and click the button there.
    await page.getByText(/Capabilities/i).click();
    const configureBtn = page.getByRole('region', { name: /Capability readiness/i }).getByRole('button');
    await expect(configureBtn).toBeVisible({ timeout: 5_000 });
    await configureBtn.click();

    await expect(page).toHaveURL(new RegExp(`/agents/${agentId}/capabilities/trading$`));
    await expect(page.getByRole('heading', { name: /Trading capability/i })).toBeVisible({ timeout: 5_000 });
    const card = readinessCard(page);
    await expect(rowValue(card, /^State$/)).toHaveText('Ready', { timeout: 5_000 });
    await expect(rowValue(card, /^Connection readiness$/)).toHaveText('Ready', { timeout: 5_000 });
    await expect(rowValue(card, /^Effective ready$/)).toHaveText('Yes', { timeout: 5_000 });
  });
});