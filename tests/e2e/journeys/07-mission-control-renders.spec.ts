/**
 * Journey 7: Capability setup and readiness page
 *
 * Verifies the agent-scoped capability page shows the unconfigured state first
 * and transitions to ready after a real binding is granted.
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

const EMPTY_STATE_EMAIL = `j7-empty-${Date.now()}@e2e.local`;
const READY_STATE_EMAIL = `j7-ready-${Date.now()}@e2e.local`;
const PASSWORD = 'E2ePassword7!';

function readinessCard(page: Page) {
  return page.locator('div').filter({ has: page.getByText(/^Readiness$/) }).filter({ has: page.getByText(/^Binding readiness$/) }).first();
}

test.describe('Journey 7: Capability setup and readiness', () => {
  test('new user lands on Mission Control with the empty state instead of a crash', async ({ page }) => {
    await registerUser(page, EMPTY_STATE_EMAIL, PASSWORD, 'E2E User J7 Empty');

    await expect(page).toHaveURL(/\/mission-control/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: /Mission Control/i })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/Your agents/i)).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/No agents yet/i)).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/Create an agent from a goal, then attach capabilities only when you need them\./i)).toBeVisible({ timeout: 5_000 });
  });

  test('agent capability readiness moves from unconfigured to ready', async ({ page, request }) => {
    await registerUser(page, READY_STATE_EMAIL, PASSWORD, 'E2E User J7');

    const agentId = await createAgent(
      page,
      'Track markets and surface the capability setup path.',
      { preset: 'trading' },
    );

    const userId = await getAuthenticatedUserId(page, request);
    const connection = await createConnection(page, request, {
      provider: 'hyperliquid',
      label: 'Primary Hyperliquid connection',
    });
    const bindingId = await seedTradingBinding({
      userId,
      connectionId: connection.id,
      provider: 'hyperliquid',
      label: 'Primary Hyperliquid binding',
      bindingRef: 'acct-1',
      bindingProfile: { venue: 'hyperliquid' },
    });

    await page.goto(`/agents/${agentId}/capabilities/trading`);
    await expect(page.getByRole('heading', { name: /Trading capability/i })).toBeVisible({ timeout: 5_000 });
    const initialReadiness = readinessCard(page);
    await expect(initialReadiness.getByText(/^State$/)).toBeVisible({ timeout: 5_000 });
    await expect(initialReadiness.getByText('Unconfigured', { exact: true })).toBeVisible({ timeout: 5_000 });
    await expect(initialReadiness.getByText(/^Binding readiness$/)).toBeVisible({ timeout: 5_000 });
    await expect(initialReadiness.getByText('Not assigned', { exact: true })).toBeVisible({ timeout: 5_000 });

    await bindTradingCapability(page, request, agentId, bindingId);
    await page.reload();

    const readyReadiness = readinessCard(page);
    await expect(readyReadiness.getByText('Ready', { exact: true })).toBeVisible({ timeout: 5_000 });
    await expect(readyReadiness.getByText(/^Effective ready$/)).toBeVisible({ timeout: 5_000 });
    await expect(readyReadiness.getByText('Yes', { exact: true })).toBeVisible({ timeout: 5_000 });
    await expect(readyReadiness.getByText(bindingId, { exact: true })).toBeVisible({ timeout: 5_000 });
  });
});
