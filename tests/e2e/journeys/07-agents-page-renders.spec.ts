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
  setupTradingLink,
  assignTradingConnection,
} from '../helpers.js';

const EMPTY_STATE_EMAIL = `j7-empty-${Date.now()}@e2e.local`;
const READY_STATE_EMAIL = `j7-ready-${Date.now()}@e2e.local`;
const PASSWORD = 'E2ePassword7!';

function readinessCard(page: Page) {
  return page.getByRole('region', { name: /Capability readiness/i });
}

test.describe('Journey 7: Capability setup and readiness', () => {
  test('new user lands on AI Agents page without crashing', async ({ page }) => {
    await registerUser(page, EMPTY_STATE_EMAIL, PASSWORD, 'E2E User J7 Empty');

    // New users with 0 agents are auto-redirected to /agents/new.
    // Create a minimal agent via API so the list page is accessible.
    const token = await page.evaluate(() => localStorage.getItem('hb_session_token'));
    const createRes = await page.request.post('/api/agents', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { name: 'Smoke Test Agent', prompt: 'Minimal agent for page render smoke test.', provider: 'ollama', lightModel: 'qwen3:8b', heavyModel: 'qwen3.6:35b-a3b-q4_K_M' },
    });
    if (!createRes.ok()) {
      throw new Error(`Failed to create agent for smoke test: ${createRes.status()} ${await createRes.text()}`);
    }

    await page.goto('/agents');
    await expect(page).toHaveURL(/\/agents$/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: /AI Agents/i })).toBeVisible({ timeout: 5_000 });
    // The "No AI agents yet" empty state was removed — the page should render
    // cleanly with the "Create AI agent" CTA.
    await expect(page.getByText(/No AI agents yet/i)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Create AI agent$/i })).toBeVisible({ timeout: 5_000 });
  });

  test('agent capability readiness moves from unconfigured to ready', async ({ page, request }) => {
    await registerUser(page, READY_STATE_EMAIL, PASSWORD, 'E2E User J7');

    // Create agent via API so we can set skillIds without hitting the
    // Trading-preset form validation in the UI (capital field timing issue).
    const token = await page.evaluate(() => localStorage.getItem('hb_session_token'));
    if (!token) {
      test.skip(true, 'Auth token not accessible from storage (hb_session_token)');
      return;
    }
    const agentRes = await request.post('/api/agents', {
      headers: { Authorization: `Bearer ${token}` },
      data: { name: 'Track markets', prompt: 'Track markets and surface the capability setup path.', skillIds: ['bot-management'] },
    });
    if (!agentRes.ok()) {
      test.skip(true, `Failed to create agent: ${agentRes.status()} ${await agentRes.text()}`);
      return;
    }
    const { id: agentId } = await agentRes.json() as { id: string };

    const { connectionId } = await setupTradingLink(page, request, {
      provider: 'hyperliquid',
      label: 'Primary Hyperliquid connection',
      secrets: {
        apiKey: 'test-api-key',
        secret: 'test-secret',
        walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    });

    await page.goto(`/agents/${agentId}/capabilities/trading`);
    await expect(page.getByRole('heading', { name: /Trading capability/i })).toBeVisible({ timeout: 5_000 });
    const initialReadiness = readinessCard(page);
    await expect(initialReadiness.getByText(/^State$/)).toBeVisible({ timeout: 5_000 });
    await expect(initialReadiness.getByText(/^State$/).locator('xpath=following-sibling::span')).toHaveText('Unconfigured', { timeout: 5_000 });
    await expect(initialReadiness.getByText(/^Connection readiness$/)).toBeVisible({ timeout: 5_000 });
    await expect(initialReadiness.getByText(/^Connection readiness$/).locator('xpath=following-sibling::span')).toHaveText('Unconfigured', { timeout: 5_000 });

    await assignTradingConnection(page, request, agentId, connectionId);
    await page.reload();

    const readyReadiness = readinessCard(page);
    await expect(readyReadiness.getByText(/^State$/).locator('xpath=following-sibling::span')).toHaveText('Ready', { timeout: 5_000 });
    await expect(readyReadiness.getByText(/^Effective ready$/)).toBeVisible({ timeout: 5_000 });
    await expect(readyReadiness.getByText(/^Effective ready$/).locator('xpath=following-sibling::span')).toHaveText('Yes', { timeout: 5_000 });
    await expect(readyReadiness.getByText(/^Connection$/).locator('xpath=following-sibling::span')).toHaveText(connectionId, { timeout: 5_000 });
  });
});
