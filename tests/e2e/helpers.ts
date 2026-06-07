/**
 * Shared helpers for E2E tests.
 *
 * All tests import these helpers to register/login users and navigate
 * to key pages.
 */

import crypto from 'node:crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { closeDatabase, createDatabase, tradingBindings } from '@herobids/db';

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
  await page.getByRole('tab', { name: /email/i }).click();
  await page.getByText(/sign up|register|don't have an account/i).click();
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
  await page.getByRole('tab', { name: /email/i }).click();
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
  options: { preset?: 'general' | 'trading' } = {},
): Promise<string> {
  await page.goto('/agents');
  await page.getByRole('button', { name: /new agent|create agent/i }).first().click();

  const goalField = page.locator('textarea').first();
  await goalField.fill(goal);

  if (options.preset === 'trading') {
    await page.getByRole('radio', { name: /trading-capable agent/i }).check();
  }

  await page.getByRole('button', { name: /review/i }).click();

  await page.getByRole('button', { name: /create agent/i }).click();

  await page.waitForURL(/\/(agents)\/[^/?#]+$/, { timeout: 15_000 });

  const match = page.url().match(/\/agents\/([^/?#]+)$/);
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
    data,
  });

  if (!response.ok()) {
    throw new Error(`Failed to create connection: ${response.status()} ${await response.text()}`);
  }

  return response.json() as Promise<{ id: string; provider: string; label: string }>;
}

export async function bindTradingCapability(
  page: Page,
  request: APIRequestContext,
  agentId: string,
  bindingId: string,
): Promise<{ status: string; bindingId: string }> {
  const token = await getAuthToken(page);
  const response = await request.post(`/api/agents/${agentId}/capabilities/trading/actions/bind`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { bindingId },
  });

  if (![200, 201].includes(response.status())) {
    throw new Error(`Failed to bind trading capability: ${response.status()} ${await response.text()}`);
  }

  return response.json() as Promise<{ status: string; bindingId: string }>;
}

export async function seedTradingBinding(params: {
  userId: string;
  connectionId: string;
  provider: string;
  label: string;
  bindingRef?: string | null;
  sourceVenueAccountId?: string | null;
  bindingProfile?: Record<string, unknown> | null;
}): Promise<string> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to seed trading bindings for E2E tests');
  }

  const db = createDatabase(databaseUrl);
  const bindingId = crypto.randomUUID();
  try {
    await db.insert(tradingBindings).values({
      id: bindingId,
      userId: params.userId,
      connectionId: params.connectionId,
      provider: params.provider,
      label: params.label,
      bindingRef: params.bindingRef ?? null,
      status: 'active',
      bindingProfile: params.bindingProfile ?? null,
      sourceVenueAccountId: params.sourceVenueAccountId ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return bindingId;
  } finally {
    await closeDatabase(db);
  }
}
