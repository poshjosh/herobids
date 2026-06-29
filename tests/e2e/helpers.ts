/**
 * Shared helpers for E2E tests.
 *
 * All tests import these helpers to register/login users and navigate
 * to key pages.
 */

import type { APIRequestContext, Page } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { closeDatabase, createDatabase, connections } from '@herobids/db';

export const TEST_EMAIL = `e2e-${Date.now()}@test.local`;
export const TEST_PASSWORD = 'TestPassword123!';
export const TEST_DISPLAY_NAME = 'E2E Test User';

/** Register a new user via the login/register form. */
export async function registerUser(
  page: Page,
  email = TEST_EMAIL,
  password = TEST_PASSWORD,
  displayName = TEST_DISPLAY_NAME,
) {
  await page.goto('/login');
  // Login page defaults to login mode — click the toggle to switch to register
  await page.getByText(/sign up|don't have an account/i).click();
  await page.getByLabel(/name/i).fill(displayName);
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole('button', { name: /create account|register|sign up/i }).click();
  // Should redirect to mission control
  await page.waitForURL('**/mission-control', { timeout: 15_000 });
}

/** Log in with existing credentials. */
export async function loginUser(
  page: Page,
  email = TEST_EMAIL,
  password = TEST_PASSWORD,
) {
  await page.goto('/login');
  // Login page defaults to login mode — fill and submit
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole('button', { name: /sign in|log in|continue/i }).click();
  await page.waitForURL('**/mission-control', { timeout: 15_000 });
}

export async function getAuthToken(page: Page): Promise<string> {
  const token = await page.evaluate(() => localStorage.getItem('hb_session_token'));
  if (!token) {
    throw new Error('Expected hb_session_token to be present after authentication');
  }

  return token;
}

export async function getAuthenticatedUserId(page: Page, request: APIRequestContext): Promise<string> {
  const token = await getAuthToken(page);
  const response = await request.get('/api/auth/me', {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok()) {
    throw new Error(`Failed to load authenticated user: ${response.status()} ${await response.text()}`);
  }

  const body = await response.json() as { id: string };
  return body.id;
}

/** Create an agent from the agent-first flow and return its id. */
export async function createAgent(
  page: Page,
  goal: string,
  options: { skillIds?: string[]; preset?: string } = {},
): Promise<string> {
  await page.goto('/agents');
  await page.getByRole('button', { name: /new.*agent|create agent/i }).first().click();

  // Fill name (required) — derive a short name from the goal
  const nameField = page.locator('input[type="text"]').first();
  await nameField.fill(goal.slice(0, 40));

  const goalField = page.locator('textarea').first();
  await goalField.fill(goal);

  // The preset combobox is the select that has a "personal-assistant" option value
  // (unique to the skill preset select — other selects use different option values).
  const presetSelect = page.locator('select:has(option[value="personal-assistant"])');

  const needsCustomPreset = (options.skillIds ?? []).length > 0 || options.preset === 'general';

  if (needsCustomPreset) {
    // Switch to Custom so individual skill checkboxes are rendered
    await presetSelect.selectOption('custom');
  } else if (options.preset) {
    const presetValueMap: Record<string, string> = {
      trading: 'trading',
      'personal-assistant': 'personal-assistant',
      custom: 'custom',
      general: 'custom', // 'general' → Custom with no skills
    };
    const presetValue = presetValueMap[options.preset];
    if (presetValue) {
      await presetSelect.selectOption(presetValue);
    }
  }

  // Expand the Skills accordion section so checkboxes become visible.
  // The AdvancedSettingsSection wraps each section in a <details> element;
  // only the first non-empty section is open by default, and Skills is
  // typically the second section (after AI Configuration).
  if (needsCustomPreset) {
    await expandSkillsAccordion(page);
  }

  if (needsCustomPreset && (options.skillIds ?? []).length === 0) {
    // Uncheck any skills that were pre-selected by the previous preset (e.g. trading).
    const allCheckboxes = page.getByRole('checkbox');
    const count = await allCheckboxes.count();
    for (let i = 0; i < count; i++) {
      const cb = allCheckboxes.nth(i);
      if (await cb.isChecked()) {
        await cb.uncheck();
      }
    }
  }

  if ((options.skillIds ?? []).length > 0) {
    // Uncheck any pre-selected skills first so only the requested ones remain.
    const allCheckboxes = page.getByRole('checkbox');
    const count = await allCheckboxes.count();
    for (let i = 0; i < count; i++) {
      const cb = allCheckboxes.nth(i);
      if (await cb.isChecked()) {
        await cb.uncheck();
      }
    }

    const token = await getAuthToken(page);
    const response = await page.request.get('/api/skills', {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok()) {
      throw new Error(`Failed to load skills: ${response.status()} ${await response.text()}`);
    }

    const body = await response.json() as { skills: Array<{ id: string; name: string }> };
    for (const skillId of options.skillIds) {
      const skill = body.skills.find((item) => item.id === skillId);
      if (!skill) {
        throw new Error(`Could not find skill ${skillId} in the skills API response`);
      }

      await page.getByRole('checkbox', { name: skill.name }).check();
    }
  }

  await page.getByRole('button', { name: /review/i }).click();

  // The review-step "Create AI agent" button may be overlapped by residual
  // layout from the tall intent form. Use force:true to bypass pointer-event
  // interception checks from the modal overlay.
  await page.getByRole('button', { name: /^Create AI agent$/i }).last().click({ force: true });

  await page.waitForURL(/\/(agents)\/[^/?#]+$/, { timeout: 15_000 });

  const match = page.url().match(/\/agents\/([^/?#]+)$/);
  if (!match?.[1]) {
    throw new Error(`Could not determine agent id from URL: ${page.url()}`);
  }

  return match[1];
}

/**
 * Expand the "Skills" accordion section inside the Advanced Settings area.
 *
 * The Advanced Settings section is a single <details> element with summary
 * "Advanced Settings".  Inside, sections are arranged as tabs: AI Configuration,
 * Skills, Trading Setup, Strategy.  We must open the <details> (if closed) and
 * then click the "Skills" tab so that skill checkboxes become visible.
 */
async function expandSkillsAccordion(page: Page): Promise<void> {
  // 1. Open the Advanced Settings <details> if it's closed
  const advancedDetails = page.locator('details').filter({ hasText: 'Advanced Settings' }).first();
  const detailsCount = await advancedDetails.count();
  if (detailsCount === 0) return; // Advanced Settings not rendered

  const isOpen = await advancedDetails.evaluate((el) => el.hasAttribute('open'));
  if (!isOpen) {
    await advancedDetails.locator('summary').first().click();
    await page.waitForTimeout(300);
  }

  // 2. Click the "Skills" tab so the SkillPicker checkboxes are in the DOM
  const skillsTab = page.getByRole('tab', { name: 'Skills' });
  const tabCount = await skillsTab.count();
  if (tabCount > 0) {
    await skillsTab.first().click();
    await page.waitForTimeout(300);
  }
}

/** Open the agent detail page directly. */
export async function openAgentDetail(page: Page, agentId: string): Promise<void> {
  await page.goto(`/agents/${agentId}`);
  await page.waitForURL(new RegExp(`/agents/${agentId}$`), { timeout: 15_000 });
}

export async function createConnection(
  page: Page,
  request: APIRequestContext,
  data: { provider: string; label: string; credentialId?: string },
): Promise<{ id: string; provider: string; label: string }> {
  const token = await getAuthToken(page);
  const response = await request.post('/api/connections', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      provider: data.provider,
      label: data.label,
      ...(data.credentialId ? { credentialId: data.credentialId } : {}),
    },
  });

  if (!response.ok()) {
    throw new Error(`Failed to create connection: ${response.status()} ${await response.text()}`);
  }

  const body = await response.json() as { id: string; provider: string; label: string };
  return { id: body.id, provider: body.provider, label: body.label };
}

export async function assignTradingConnection(
  page: Page,
  request: APIRequestContext,
  agentId: string,
  connectionId: string,
): Promise<void> {
  const token = await getAuthToken(page);
  const response = await request.patch(`/api/agents/${agentId}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { connectionIds: [connectionId] },
  });

  if (!response.ok()) {
    throw new Error(`Failed to assign trading connection: ${response.status()} ${await response.text()}`);
  }
}

export async function mockTradingReadiness(page: Page, agentId: string) {
  type TradingReadinessResponse = {
    agentId: string;
    family: 'trading';
    state: 'unconfigured' | 'provisioning' | 'ready' | 'degraded' | 'revoked';
    connectionReadiness: 'unconfigured' | 'provisioning' | 'ready' | 'degraded' | 'revoked';
    agentEligibility: 'eligible' | 'ineligible';
    effectiveReady: boolean;
    connectionId?: string;
    reasons: string[];
  };

  let readiness: TradingReadinessResponse = {
    agentId,
    family: 'trading',
    state: 'unconfigured',
    connectionReadiness: 'unconfigured',
    agentEligibility: 'ineligible',
    effectiveReady: false,
    reasons: ['no grants have been created for this capability family'],
  };

  await page.route(new RegExp(`/api/agents/${agentId}/capabilities/trading/readiness$`), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(readiness),
    });
  });

  return {
    setReady(connectionId: string) {
      readiness = {
        agentId,
        family: 'trading',
        state: 'ready',
        connectionReadiness: 'ready',
        agentEligibility: 'eligible',
        effectiveReady: true,
        connectionId,
        reasons: [],
      };
    },
  };
}

export async function seedTradingConnection(params: {
  userId: string;
  connectionId: string;
  provider: string;
  label: string;
  resolvedVenueAccountId?: string | null;
  providerRef?: string | null;
  profile?: Record<string, unknown> | null;
}): Promise<string> {
  const databaseUrl = process.env['DATABASE_URL'] ?? 'postgres://herobids:herobids@localhost:5432/herobids';
  const db = createDatabase(databaseUrl);
  try {
    await db.insert(connections).values({
      id: params.connectionId,
      userId: params.userId,
      provider: params.provider,
      label: params.label,
      status: 'active',
      resolvedVenueAccountId: params.resolvedVenueAccountId ?? null,
      providerRef: params.providerRef ?? null,
      profile: params.profile ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return params.connectionId;
  } finally {
    await closeDatabase(db);
  }
}

/**
 * Retrieve the resolved venue account ID for a connection by querying the DB directly.
 */
export async function getConnectionVenueAccount(connectionId: string): Promise<string | null> {
  const databaseUrl = process.env['DATABASE_URL'] ?? 'postgres://herobids:herobids@localhost:5432/herobids';
  const db = createDatabase(databaseUrl);
  try {
    const [conn] = await db
      .select({ resolvedVenueAccountId: connections.resolvedVenueAccountId })
      .from(connections)
      .where(eq(connections.id, connectionId));
    return conn?.resolvedVenueAccountId ?? null;
  } finally {
    await closeDatabase(db);
  }
}

/**
 * Call POST /setup/provider-link to create a credential, connection, and venue account
 * in one transaction. Returns the connection ID.
 */
export async function setupTradingLink(
  page: Page,
  request: APIRequestContext,
  data: { provider: string; label: string; secrets: Record<string, string> },
): Promise<{ connectionId: string }> {
  const token = await getAuthToken(page);
  const response = await request.post('/api/setup/provider-link', {
    headers: { Authorization: `Bearer ${token}` },
    data: { ...data, capability: 'trading' },
  });

  if (!response.ok()) {
    throw new Error(`Failed to setup trading link: ${response.status()} ${await response.text()}`);
  }

  const body = await response.json() as { connection: { id: string; resolvedVenueAccountId?: string } };
  return { connectionId: body.connection.id };
}
