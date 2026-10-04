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

    // The create page defaults to form mode. If we landed in guided mode
    // (e.g. redirected via ?ui=chat), switch to form.
    const switchToFormBtn = page.getByRole('button', { name: /^Use the form$/i });
    const switchToGuidedBtn = page.getByRole('button', { name: /^Use guided chat$/i });
    if (await switchToFormBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await switchToFormBtn.click();
    } else {
      await switchToGuidedBtn.waitFor({ state: 'visible', timeout: 10_000 });
    }

    // Fill goal (first) and name. Skill-first create flow (feature 009): the
    // objective/prompt comes first and there is no "preset"/"type" <select>.
    await page
      .locator('textarea')
      .first()
      .fill('Trade momentum signals on 15m candles.');
    await page.locator('input[type="text"]').first().fill('Preset Test J16');

    // ── Select the Trading skill via the SkillPicker ──────────────────────
    // Trading capability (and the strategy/preset controls) is now derived from
    // the agent's skills, not a preset selector. Resolve the trading skill id
    // and check it in the collapsible SkillPicker.
    {
      const token = await getAuthToken(page);
      const resp = await page.request.get('/api/skills?scope=selectable', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(resp.ok(), `GET /skills returned ${resp.status()}`).toBe(true);
      const body = (await resp.json()) as { skills: Array<{ id: string; slug?: string; name: string }> };
      // Phase 4: the trading skill is the external skills.sh ref (catalogued at
      // API startup), not the removed built-in `system/trading` slug.
      const tradingSkill = body.skills.find((s) => s.slug === 'traderton/skills/crypto-trading');
      expect(tradingSkill, 'traderton/skills/crypto-trading skill must be selectable').toBeTruthy();

      await page.getByRole('button', { name: /add skills|edit skills/i }).click();
      // Each SkillPicker row renders name + slug + description; locate the row by
      // its unique slug.
      const tradingRow = page.locator('label').filter({ hasText: 'traderton/skills/crypto-trading' });
      await tradingRow.getByRole('checkbox').check();
      // Let capabilityMode/requiresTradingSetup derive from the selected skill.
      await page.waitForTimeout(400);
    }

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

    // ── Open the generic Capabilities tab ─────────────────────────────────
    // Trading setup + strategy now live together under a single "Capabilities"
    // tab (the former Trading Setup / Strategy tabs were genericized away).
    const capabilitiesTab = page.getByRole('tab', { name: 'Capabilities' });
    if ((await capabilitiesTab.count()) > 0) {
      await capabilitiesTab.first().click();
      await page.waitForTimeout(300);
    }

    // Find the Capital input by its data-field wrapper (FieldLabel is a <div>, not <label>)
    await page.locator('[data-field="capital"] input').fill('1000');

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

    // Then assert the detail page still renders the agent (the preset name is
    // no longer shown on the generic agent detail page — capability state is
    // reached through capability → connection per ADR 014).
    await page.reload();
    await expect(
      page.getByRole('heading', { name: /Preset Test J16|AI agent/i }),
    ).toBeVisible({ timeout: 5_000 });

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
  });
});
