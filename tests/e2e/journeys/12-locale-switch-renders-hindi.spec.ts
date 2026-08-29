import { expect, test } from '@playwright/test';
import { registerUser } from '../helpers.js';

const EMAIL = `j12-${Date.now()}@e2e.local`;
const PASSWORD = 'E2ePassword12!';

test.describe('Journey 12: locale switch', () => {
  test('switches to Hindi and keeps localized chrome on the agents page', async ({ page }) => {
    await registerUser(page, EMAIL, PASSWORD, 'E2E User J12');

    // Create a minimal agent via API so the agents list page renders
    // instead of redirecting to /agents/new (zero-agent redirect).
    const token = await page.evaluate(() => localStorage.getItem('hb_session_token'));
    const createRes = await page.request.post('/api/agents', {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { name: 'Locale Test Agent', prompt: 'Minimal agent for locale smoke test.', provider: 'ollama', lightModel: 'qwen3:8b', heavyModel: 'qwen3.6:35b-a3b-q4_K_M' },
    });
    if (!createRes.ok()) {
      throw new Error(`Failed to create agent for locale test: ${createRes.status()} ${await createRes.text()}`);
    }

    await page.goto('/settings');
    await page.getByLabel(/display language/i).selectOption('hi');

    await expect(page.getByRole('heading', { name: 'सेटिंग्स' })).toBeVisible({ timeout: 5_000 });
    await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe('hi');

    await page.goto('/agents');

    await expect(page.getByRole('heading', { name: 'AI एजेंट' })).toBeVisible({ timeout: 5_000 });
    // The "Create AI agent" header button navigates to the create page.
    await expect(page.getByRole('button', { name: 'AI एजेंट बनाएं' })).toBeVisible({ timeout: 5_000 });
  });
});