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
  return page.locator('div').filter({ has: page.getByText(/^Readiness$/) }).filter({ has: page.getByText(/^Binding readiness$/) }).first();
}

test.describe('Journey 8: Mission Control reflects enabled capability', () => {
  test('mission control shows the ready capability CTA and opens the capability page', async ({ page, request }) => {
    await registerUser(page, EMAIL, PASSWORD, 'E2E User J8');

    const agentId = await createAgent(
      page,
      'Run the trading capability and reflect readiness in mission control.',
      { preset: 'trading' },
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
    await expect(page.getByText(/Trading: Ready/i)).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('button', { name: /Open trading/i })).toBeVisible({ timeout: 5_000 });

    await page.getByRole('button', { name: /Open trading/i }).click();
    await expect(page).toHaveURL(new RegExp(`/agents/${agentId}/capabilities/trading$`));
    await expect(page.getByRole('heading', { name: /Trading capability/i })).toBeVisible({ timeout: 5_000 });
    await expect(readinessCard(page).getByText('Ready', { exact: true })).toBeVisible({ timeout: 5_000 });
  });
});