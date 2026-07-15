/**
 * Journey 1: Sign up → create an agent → land on the agent detail page
 *
 * Verifies the new agent-first onboarding flow and the default capability
 * readiness surface on the detail page.
 */

import { test, expect } from '@playwright/test';
import { registerUser, createAgent, openAgentDetail } from '../helpers.js';

const EMAIL = `j1-${Date.now()}@e2e.local`;
const PASSWORD = 'E2ePassword1!';

test.describe('Journey 1: Sign up → create agent → land on detail', () => {
  test('new user can sign up and create their first agent', async ({ page }) => {
    await registerUser(page, EMAIL, PASSWORD, 'E2E User J1');

    const agentId = await createAgent(
      page,
      'Alert me when BTC drops 5% in a day.',
      { preset: 'general' },
    );

    await openAgentDetail(page, agentId);
    await expect(page.getByRole('heading', { name: /Capability Agent|Alert me when BTC drops/i })).toBeVisible({ timeout: 5_000 });
    // Capabilities section is collapsed by default — expand it before asserting on its content.
    await page.locator('summary', { hasText: /capabilities/i }).click();
    await expect(page.getByText(/No capability setup required/i)).toBeVisible({ timeout: 5_000 });
    // Verify the status badge is visible — for a newly created (stopped) agent.
    await expect(page.getByText(/status/i).first()).toBeVisible({ timeout: 5_000 });
  });
});
