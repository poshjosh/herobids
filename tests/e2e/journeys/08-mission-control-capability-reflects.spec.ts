/**
 * Journey 8: Mission Control reflects an enabled capability and opens the
 * agent-scoped capability page from the summary card.
 */

import { test, expect, type Page } from '@playwright/test';
import {
  registerUser,
  createAgent,
  getAuthenticatedUserId,
  createConnection,
  seedTradingBinding,
  bindTradingCapability,
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

    const agentId = await createAgent(
      page,
      'Run the trading capability and reflect readiness in mission control.',
      { skillIds: ['bot-management'] },
    );

    const userId = await getAuthenticatedUserId(page, request);
    const connection = await createConnection(page, request, {
      provider: 'hyperliquid',
      label: 'Mission control connection',
    });
    const bindingId = await seedTradingBinding({
      userId,
      connectionId: connection.id,
      provider: 'hyperliquid',
      label: 'Mission control binding',
      bindingRef: 'acct-2',
      bindingProfile: { venue: 'hyperliquid' },
    });

    await bindTradingCapability(page, request, agentId, bindingId);

    await page.goto('/mission-control');
    await expect(page.getByRole('heading', { name: /Mission Control/i })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('button', { name: /Open trading capability/i })).toBeVisible({ timeout: 5_000 });

    await page.getByRole('button', { name: /Open trading capability/i }).click();
    await expect(page).toHaveURL(new RegExp(`/agents/${agentId}/capabilities/trading$`));
    await expect(page.getByRole('heading', { name: /Trading capability/i })).toBeVisible({ timeout: 5_000 });
    const card = readinessCard(page);
    await expect(rowValue(card, /^State$/)).toHaveText('Ready', { timeout: 5_000 });
    await expect(rowValue(card, /^Binding readiness$/)).toHaveText('Ready', { timeout: 5_000 });
    await expect(rowValue(card, /^Effective ready$/)).toHaveText('Yes', { timeout: 5_000 });
  });
});