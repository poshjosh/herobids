/**
 * Shared helpers for E2E tests.
 *
 * All tests import these helpers to register/login users and navigate
 * to key pages.
 */

import type { APIRequestContext, Page } from '@playwright/test';
import { expect } from '@playwright/test';
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

/**
 * Create an agent through the create form (name only), then add any skills on
 * the agent detail page. The goal argument is used as the agent name.
 */
export async function createAgent(
  page: Page,
  goal: string,
  options: { skillIds?: string[]; preset?: string } = {},
): Promise<string> {
  await page.goto('/agents/new');
  await page.locator('#create-agent-name').fill(goal.slice(0, 40));
  await page.getByRole('button', { name: /^Create AI agent$/i }).click();

  const agentUrlPattern = /\/agents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
  await page.waitForURL(agentUrlPattern, { timeout: 15_000 });

  const match = page.url().match(agentUrlPattern);
  if (!match?.[1]) {
    throw new Error(`Could not determine agent id from URL: ${page.url()}`);
  }
  const agentId = match[1];

  const skillRefs = options.skillIds ?? (options.preset ? PRESET_SKILL_SLUGS[options.preset] ?? [] : []);
  if (skillRefs.length > 0) {
    await addAgentSkills(page, agentId, skillRefs);
  }

  return agentId;
}

/** Skill slugs for the named presets the older journeys use. */
const PRESET_SKILL_SLUGS: Record<string, string[]> = {
  trading: ['system/trading', 'system/bot-management'],
  'personal-assistant': ['system/web-access', 'system/email'],
};

/** Select skills on the agent detail page's Capabilities section and wait for the save. */
async function addAgentSkills(page: Page, agentId: string, skillRefs: string[]): Promise<void> {
  const token = await getAuthToken(page);
  const response = await page.request.get('/api/skills?scope=selectable', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok()) {
    throw new Error(`Failed to load skills: ${response.status()} ${await response.text()}`);
  }
  const body = await response.json() as { skills: Array<{ id: string; slug?: string; name: string }> };

  const resolved = skillRefs.map((ref) => {
    // External skills.sh skills are addressed by slug; their internal id is opaque.
    const skill = body.skills.find((item) => item.id === ref || item.slug === ref);
    if (!skill) {
      throw new Error(`Could not find skill ${ref} in the skills API response`);
    }
    return skill;
  });

  await page.goto(`/agents/${agentId}`);
  const capabilities = page.locator('section[aria-label="Capabilities"]');
  await capabilities.locator('summary').click();

  for (const skill of resolved) {
    // Match by slug when available: a row's accessible name also includes its description.
    const label = skill.slug ?? skill.name;
    const checkbox = capabilities.locator('label').filter({ hasText: label }).getByRole('checkbox');
    // The picker is server-backed, so the box only checks after the PATCH is saved.
    await Promise.all([
      page.waitForResponse((res) => res.request().method() === 'PATCH' && res.url().includes('/api/agents/') && res.ok()),
      checkbox.click(),
    ]);
    await expect(checkbox).toBeChecked();
  }

  await expect.poll(async () => {
    const res = await page.request.get(`/api/agents/${agentId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const agent = await res.json() as { skillIds?: string[] };
    return resolved.every((skill) => agent.skillIds?.includes(skill.id) ?? false);
  }, { timeout: 10_000 }).toBe(true);
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
