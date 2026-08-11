/**
 * Journey 18: Create AI Agent flow behavior.
 *
 * Verifies the dedicated create-agent page:
 *   1. The agents page has a "Create AI agent" button that navigates to
 *      /agents/new.
 *   2. The create page defaults to the plain form.
 *   3. The header switch toggles between the plain form and guided chat.
 */

import { test, expect } from '@playwright/test';
import { registerUser } from '../helpers.js';

const EMAIL = `j18-${Date.now()}@e2e.local`;
const PASSWORD = 'E2ePassword18!';
const EMAIL_SWITCH = `j18s-${Date.now()}@e2e.local`;

test.describe('Journey 18: Create AI Agent flow', () => {
  test('agents page has a Create AI agent button that navigates to the create page', async ({ page }) => {
    await registerUser(page, EMAIL, PASSWORD, 'E2E User J18');

    // New users with 0 agents are auto-redirected to /agents/new.
    // Create a minimal agent via API so the list page is accessible.
    const token = await page.evaluate(() => localStorage.getItem('hb_session_token'));
    const createRes = await page.request.post('/api/agents', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { name: 'List View Agent', prompt: 'Minimal agent to access the list page.', provider: 'ollama', lightModel: 'qwen3:8b', heavyModel: 'qwen3.6:35b-a3b-q4_K_M' },
    });
    if (!createRes.ok()) {
      throw new Error(`Failed to create agent for list view: ${createRes.status()} ${await createRes.text()}`);
    }

    await page.goto('/agents');
    await expect(page).toHaveURL(/\/agents$/, { timeout: 15_000 });

    // The header CTA navigates to the dedicated create page.
    const createButton = page.getByRole('button', { name: /^Create AI agent$/i });
    await expect(createButton).toBeVisible({ timeout: 5_000 });
    await createButton.click();
    await expect(page).toHaveURL(/\/agents\/new/, { timeout: 5_000 });

    // The create page defaults to the plain form.
    await expect(page.locator('.create-flow-card')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/What type of AI agent\?/i)).toBeVisible({ timeout: 5_000 });
  });

  test('header switch toggles between guided chat and the plain form', async ({ page }) => {
    await registerUser(page, EMAIL_SWITCH, PASSWORD, 'E2E User J18S');

    // Navigate to the create page in guided chat mode.
    await page.goto('/agents/new?ui=chat');
    await expect(page).toHaveURL(/\/agents\/new/, { timeout: 15_000 });

    // The page is in guided chat mode — verify the switch button says "Use the form".
    await expect(page.getByRole('button', { name: /^Use the form$/i })).toBeVisible({ timeout: 10_000 });

    // Switch to the plain form.
    await page.getByRole('button', { name: /^Use the form$/i }).click();
    await expect(page.locator('.create-flow-card')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/What type of AI agent\?/i)).toBeVisible({ timeout: 5_000 });

    // Switch back to guided chat.
    await page.getByRole('button', { name: /^Use guided chat$/i }).click();
    // Guided chat panel is now visible (shows loading or thread messages).
    await expect(page.locator('.guided-setup-panel')).toBeVisible({ timeout: 10_000 });
  });
});
