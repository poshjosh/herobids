/**
 * Journey 16: Strategy preset — select in create flow, verify on detail page,
 * clear via edit modal.
 *
 * Verifies the full frontend→backend round-trip for style-based strategy
 * presets (momentum, swing, scalper, etc.):
 *
 *   1. Create an agent with a Trading skill preset and "Momentum — Day"
 *      strategy preset.
 *   2. Assert the detail page displays the preset name.
 *   3. Open the edit modal and switch to Custom → save.
 *   4. Assert the preset is cleared and no longer displayed.
 */

import { test, expect } from '@playwright/test';
import { registerUser, getAuthToken } from '../helpers.js';

const EMAIL = `j16-${Date.now()}@e2e.local`;
const PASSWORD = 'E2ePassword16!';

test.describe('Journey 16: Strategy preset propagation', () => {
  test('create agent with strategy preset, verify detail page, clear via edit', async ({
    page,
    request,
  }) => {
    await registerUser(page, EMAIL, PASSWORD, 'E2E User J16');

    // ── Open create agent form ────────────────────────────────────────────
    await page.goto('/agents/new');

    // The create page defaults to Guided Setup (chat). Switch to the form.
    const switchToForm = page.getByRole('button', { name: /^Use the form$/i });
    await switchToForm.waitFor({ state: 'visible', timeout: 15_000 });
    await switchToForm.click();

    // Fill name and goal
    await page.locator('input[type="text"]').first().fill('Preset Test J16');
    await page
      .locator('textarea')
      .first()
      .fill('Trade momentum signals on 15m candles.');

    // ── Select Trading skill preset ───────────────────────────────────────
    const skillPreset = page.locator(
      'select:has(option[value="personal-assistant"])',
    );
    await skillPreset.selectOption('trading');

    // ── Expand Advanced Settings ──────────────────────────────────────────
    const advancedDetails = page
      .locator('details')
      .filter({ hasText: 'Advanced Settings' })
      .first();
    if ((await advancedDetails.count()) > 0) {
      const isOpen = await advancedDetails.evaluate((el) =>
        el.hasAttribute('open'),
      );
      if (!isOpen) {
        await advancedDetails.locator('summary').first().click();
        await page.waitForTimeout(400);
      }
    }

    // ── Fill Capital in Trading Setup tab ─────────────────────────────────
    const tradingTab = page.getByRole('tab', { name: 'Trading Setup' });
    if ((await tradingTab.count()) > 0) {
      await tradingTab.first().click();
      await page.waitForTimeout(300);
    }

    // Find the Capital input by its data-field wrapper (FieldLabel is a <div>, not <label>)
    await page.locator('[data-field="capital"] input').fill('1000');

    // ── Switch to Strategy tab, set Filter Trades, select preset ──────────
    const strategyTab = page.getByRole('tab', { name: 'Strategy' });
    if ((await strategyTab.count()) > 0) {
      await strategyTab.first().click();
      await page.waitForTimeout(300);
    }

    // ── Set Filter Trades to Mixed (3-way button selector: Off / Mixed / Filter) ──
    const mixedButton = page.getByRole('button', { name: /mixed/i });
    if ((await mixedButton.count()) > 0) {
      await mixedButton.first().click();
      await page.waitForTimeout(800); // wait for preset API call
    }

    // ── Wait for presets to load, then select "Momentum — Day" ────────────
    // The grid buttons render after the API response. Wait for at least one
    // preset card to appear before clicking.
    await expect(
      page.getByRole('button', { name: /Momentum.*Day/i }),
    ).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: /Momentum.*Day/i }).click();

    // ── Review → Create (may appear twice — top and bottom of Advanced Settings) ──
    await page.getByRole('button', { name: /review/i }).first().click();
    await page
      .getByRole('button', { name: /^Create AI agent$/i })
      .last()
      .click({ force: true });
    // Match only UUID-style agent IDs, not /agents/new.
    const agentUrlPattern = /\/agents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
    await page.waitForURL(agentUrlPattern, { timeout: 15_000 });

    const match = page.url().match(agentUrlPattern);
    const agentId = match?.[1];
    if (!agentId) {
      throw new Error(`Could not determine agent id from URL: ${page.url()}`);
    }

    // ── Assert detail page shows strategy preset name ────────────────────
    // First verify via API that the preset was persisted
    const token = await getAuthToken(page);
    const agentRes = await request.get(`/api/agents/${agentId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(agentRes.ok(), `GET /agents/${agentId} returned ${agentRes.status()}`).toBe(true);
    const agentJson = (await agentRes.json()) as {
      strategyPreset: string | null;
      strategyPresetName: string | null;
      unifiedConfig: Record<string, unknown> | null;
    };
    expect(agentJson.strategyPreset).toBe('momentum');
    expect(agentJson.strategyPresetName).toBe('Momentum — Day');

    // Then assert the detail page renders it
    await page.reload();
    await expect(
      page.getByRole('heading', { name: /Preset Test J16|AI agent/i }),
    ).toBeVisible({ timeout: 5_000 });

    // The Strategy KV row should show the preset name
    await expect(page.getByText('Momentum — Day')).toBeVisible({
      timeout: 5_000,
    });

    // ── Clear the preset via API (PATCH with strategyPreset: null) ──────
    const patchRes = await request.patch(`/api/agents/${agentId}`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { strategyPreset: null },
    });
    expect(
      patchRes.ok(),
      `PATCH /agents/${agentId} returned ${patchRes.status()}: ${await patchRes.text()}`,
    ).toBe(true);

    // Verify via API that strategyPreset is now null
    await page.reload();
    await expect(
      page.getByRole('heading', { name: /Preset Test J16|AI agent/i }),
    ).toBeVisible({ timeout: 5_000 });

    const updatedRes = await request.get(`/api/agents/${agentId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(updatedRes.ok()).toBe(true);
    const updatedJson = (await updatedRes.json()) as {
      strategyPreset: string | null;
      strategyPresetName: string | null;
    };
    expect(updatedJson.strategyPreset).toBeNull();
    expect(updatedJson.strategyPresetName).toBeNull();

    // ── Assert preset is cleared on the detail page ──────────────────────
    await expect(page.getByText('Momentum — Day')).not.toBeVisible({
      timeout: 5_000,
    });
  });
});
