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

/** Register a new user via the API (the login page no longer has a register form). */
export async function registerUser(
  page: Page,
  email = TEST_EMAIL,
  password = TEST_PASSWORD,
  displayName = TEST_DISPLAY_NAME,
) {
  // Use the API directly since the login page now defaults to email-link auth
  const response = await page.request.post('/api/auth/register', {
    data: { email, password, displayName },
  });

  if (!response.ok()) {
    throw new Error(`Failed to register user via API: ${response.status()} ${await response.text()}`);
  }

  const body = await response.json() as { token: string };

  // Navigate to a page on the app origin first — localStorage is not
  // accessible on about:blank in Chromium.
  await page.goto('/login');

  // Store the token in localStorage so the page is authenticated
  await page.evaluate((token: string) => {
    localStorage.setItem('hb_session_token', token);
  }, body.token);

  await page.goto('/agents');
  await page.waitForURL('**/agents', { timeout: 15_000 });
}

/** Log in with existing credentials. */
export async function loginUser(
  page: Page,
  email = TEST_EMAIL,
  password = TEST_PASSWORD,
) {
  await page.goto('/login');
  // Click "Sign in with password" to expand the password field
  await page.getByText(/sign in with password/i).click();
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL('**/agents', { timeout: 15_000 });
}

export async function getAuthToken(page: Page): Promise<string> {
  const token = await page.evaluate(() => localStorage.getItem('hb_session_token'));
  if (!token) {
    throw new Error('Expected hb_session_token to be present after authentication');
  }

  return token;
}

/**
 * Set user AI model preferences via PATCH /settings/ai-model.
 * Uses operator-default models (ollama) which are available in the E2E env.
 */
export async function ensureUserAiModelSettings(page: Page): Promise<void> {
  const token = await getAuthToken(page);
  const res = await page.request.patch('/api/settings/ai-model', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      provider: 'ollama',
      lightModel: 'qwen3:8b',
      heavyModel: 'qwen3.6:35b-a3b-q4_K_M',
    },
  });
  if (!res.ok()) {
    throw new Error(`Failed to set AI model settings: ${res.status()} ${await res.text()}`);
  }
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
  await page.goto('/agents/new');

  // The create page defaults to form mode. If we landed in guided mode
  // (e.g. redirected via ?ui=chat), switch to form so the form-based
  // selectors below work.
  const switchToForm = page.getByRole('button', { name: /^Use the form$/i });
  const switchToGuided = page.getByRole('button', { name: /^Use guided chat$/i });
  if (await switchToForm.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await switchToForm.click();
  } else {
    await switchToGuided.waitFor({ state: 'visible', timeout: 10_000 });
  }

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

  // The SkillPicker is rendered inline (not inside Advanced Settings tabs)
  // when the custom preset is selected, so checkboxes are directly accessible.

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

  // Wait for React effects (capabilityMode derivation) to commit after
  // preset/skill changes. Without this, the form may submit with an empty
  // prompt because capabilityMode hasn't been updated from 'technical'
  // to 'intelligence' yet, causing the API to reject the payload.
  await page.waitForTimeout(300);

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

  // Match only UUID-style agent IDs, not /agents/new.
  const agentUrlPattern = /\/agents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
  await page.waitForURL(agentUrlPattern, { timeout: 15_000 });

  const match = page.url().match(agentUrlPattern);
  if (!match?.[1]) {
    throw new Error(`Could not determine agent id from URL: ${page.url()}`);
  }

  return match[1];
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
