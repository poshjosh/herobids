/**
 * Journey 18: Create AI agent page.
 *
 * Verifies the create page after guided chat removal:
 *   1. The agents page has a "Create AI agent" button that opens /agents/new.
 *   2. The page offers a name, an objective and a Review step.
 *   3. There is no guided chat button.
 */

import { test, expect } from '@playwright/test';
import { registerUser } from '../helpers.js';

const EMAIL = `j18-${Date.now()}@e2e.local`;
const PASSWORD = 'E2ePassword18!';

test.describe('Journey 18: Create AI agent page', () => {
  test('a new user lands on the create form', async ({ page }) => {
    await registerUser(page, EMAIL, PASSWORD, 'E2E User J18');

    await expect(page).toHaveURL(/\/agents\/new$/, { timeout: 10_000 });
    await expect(page.locator('[data-field="name"] input')).toBeVisible();
    await page.locator('details summary', { hasText: 'Advanced Settings' }).click();
    await expect(page.locator('[data-field="goal"] textarea')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Review/ }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^Use guided chat$/i })).toHaveCount(0);
  });

  test('agents page has a Create AI agent button that opens the create page', async ({ page }) => {
    await registerUser(page, `j18b-${Date.now()}@e2e.local`, PASSWORD, 'E2E User J18B');

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

    await page.getByRole('button', { name: /^Create AI agent$/i }).click();
    await expect(page).toHaveURL(/\/agents\/new/, { timeout: 5_000 });
    await expect(page.locator('[data-field="name"] input')).toBeVisible({ timeout: 10_000 });
  });
});
