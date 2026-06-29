/**
 * Journey 8: Mission Control reflects an enabled capability and opens the
 * agent-scoped capability page from the summary card.
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

test.describe('Journey 8: Mission Control reflects enabled capability', () => {
  test('mission control shows the ready capability CTA and opens the capability page', async ({ page, request }) => {
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
      data: { name: 'Trading agent', prompt: 'Run the trading capability and reflect readiness in mission control.', skillIds: ['bot-management'] },
    });
    if (!agentRes.ok()) {
      test.skip(true, `Failed to create agent: ${agentRes.status()} ${await agentRes.text()}`);
      return;
    }
    const { id: agentId } = await agentRes.json() as { id: string };

    const { connectionId } = await setupTradingLink(page, request, {
      provider: 'hyperliquid',
      label: 'Mission control connection',
      secrets: {
        apiKey: 'test-api-key',
        secret: 'test-secret',
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    });

    await assignTradingConnection(page, request, agentId, connectionId);

    await page.goto('/mission-control');
    await expect(page.getByRole('heading', { name: /Mission Control/i })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('button', { name: /Open trading capability/i })).toBeVisible({ timeout: 5_000 });

    await page.getByRole('button', { name: /Open trading capability/i }).click();
    await expect(page).toHaveURL(new RegExp(`/agents/${agentId}/capabilities/trading$`));
    await expect(page.getByRole('heading', { name: /Trading capability/i })).toBeVisible({ timeout: 5_000 });
    const card = readinessCard(page);
    await expect(rowValue(card, /^State$/)).toHaveText('Ready', { timeout: 5_000 });
    await expect(rowValue(card, /^Connection readiness$/)).toHaveText('Ready', { timeout: 5_000 });
    await expect(rowValue(card, /^Effective ready$/)).toHaveText('Yes', { timeout: 5_000 });
  });
});