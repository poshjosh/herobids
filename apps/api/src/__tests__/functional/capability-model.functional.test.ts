/**
 * Functional tests: capability model platform primitives and lifecycle.
 *
 * These tests require DATABASE_URL and REDIS_URL. They are skipped automatically
 * when those env vars are absent.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { capabilityGrants, tradingBindings } from '@herobids/db';
import { SKIP, buildApp, truncateAll, registerUser } from './helpers.js';

async function createAgent(app: Awaited<ReturnType<typeof buildApp>>['app'], token: string, name: string, prompt: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/agents',
    headers: { Authorization: `Bearer ${token}` },
    payload: { name, prompt, skillIds: [], executionMode: 'paper' },
  });

  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>().id;
}

async function getAuthedUserId(app: Awaited<ReturnType<typeof buildApp>>['app'], token: string): Promise<string> {
  const res = await app.inject({
    method: 'GET',
    url: '/auth/me',
    headers: { Authorization: `Bearer ${token}` },
  });

  expect(res.statusCode).toBe(200);
  return res.json<{ id: string }>().id;
}

describe.skipIf(SKIP)('Capability model functional', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;
  let token: string;
  let userId: string;
  let agentId: string;

  beforeAll(async () => {
    ctx = await buildApp();
  }, 30_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.redisClient.quit();
    await ctx.lifecycleQueue.close();
  });

  beforeEach(async () => {
    await truncateAll(ctx.db);
    token = await registerUser(ctx.app, 'capability-functional@test.local');
    userId = await getAuthedUserId(ctx.app, token);
    agentId = await createAgent(
      ctx.app,
      token,
      'Capability Agent',
      'Observe readiness and capability lifecycle through the redesigned API.',
    );
  });

  async function createConnection() {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/connections',
      headers: { Authorization: `Bearer ${token}` },
      payload: { provider: 'hyperliquid', label: 'Primary Hyperliquid connection' },
    });

    expect(res.statusCode).toBe(201);
    return res.json<{ id: string; provider: string; label: string }>();
  }

  async function createCredential() {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/credentials',
      headers: { Authorization: `Bearer ${token}` },
      payload: {
        venue: 'hyperliquid',
        label: 'Primary Hyperliquid credential',
        secrets: {
          apiKey: 'test-api-key',
          secret: 'test-secret',
          walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      },
    });

    expect(res.statusCode).toBe(201);
    return res.json<{ id: string; venue: string; label: string }>();
  }

  async function seedTradingBinding(connectionId: string) {
    const bindingId = crypto.randomUUID();
    await ctx.db.insert(tradingBindings).values({
      id: bindingId,
      userId,
      connectionId,
      provider: 'hyperliquid',
      label: 'Primary Hyperliquid binding',
      bindingRef: 'acct-1',
      status: 'active',
      bindingProfile: { venue: 'hyperliquid' },
      sourceVenueAccountId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return bindingId;
  }

  it('covers family catalogs, connection creation, grant lifecycle, readiness, and audit history', async () => {
    const familyCatalog = await ctx.app.inject({ method: 'GET', url: '/capabilities/trading', headers: { Authorization: `Bearer ${token}` } });
    expect(familyCatalog.statusCode).toBe(200);
    expect(familyCatalog.json<{ family: string; supportedActions: string[] }>().family).toBe('trading');

    const catalog = await ctx.app.inject({ method: 'GET', url: '/capabilities', headers: { Authorization: `Bearer ${token}` } });
    expect(catalog.statusCode).toBe(200);

    const credential = await createCredential();
    const credentialList = await ctx.app.inject({ method: 'GET', url: '/credentials', headers: { Authorization: `Bearer ${token}` } });
    expect(credentialList.statusCode).toBe(200);
    expect(credentialList.json<{ credentials: Array<{ id: string; venue: string }> }>().credentials).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: credential.id, venue: 'hyperliquid' })]),
    );

    const connection = await createConnection();
    const connectionList = await ctx.app.inject({ method: 'GET', url: '/connections', headers: { Authorization: `Bearer ${token}` } });
    expect(connectionList.statusCode).toBe(200);
    expect(connectionList.json<{ connections: Array<{ id: string }> }>().connections.map((item) => item.id)).toContain(connection.id);

    const connectionDetail = await ctx.app.inject({ method: 'GET', url: `/connections/${connection.id}`, headers: { Authorization: `Bearer ${token}` } });
    expect(connectionDetail.statusCode).toBe(200);
    expect(connectionDetail.json<{ id: string; status: string }>().status).toBe('active');

    const bindingId = await seedTradingBinding(connection.id);

    const readinessBefore = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${agentId}/capabilities/trading/readiness`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(readinessBefore.statusCode).toBe(200);
    expect(readinessBefore.json<{ state: string }>().state).toBe('unconfigured');

    const bindRes = await ctx.app.inject({
      method: 'POST',
      url: `/agents/${agentId}/capabilities/trading/actions/bind`,
      headers: { Authorization: `Bearer ${token}` },
      payload: { bindingId },
    });
    expect(bindRes.statusCode).toBe(201);

    const duplicateBind = await ctx.app.inject({
      method: 'POST',
      url: `/agents/${agentId}/capabilities/trading/actions/bind`,
      headers: { Authorization: `Bearer ${token}` },
      payload: { bindingId },
    });
    expect(duplicateBind.statusCode).toBe(200);

    const activeGrants = await ctx.db
      .select({ id: capabilityGrants.id })
      .from(capabilityGrants)
      .where(and(eq(capabilityGrants.agentId, agentId), eq(capabilityGrants.bindingId, bindingId), eq(capabilityGrants.status, 'active')));
    expect(activeGrants).toHaveLength(1);

    const readinessAfter = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${agentId}/capabilities/trading/readiness`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(readinessAfter.statusCode).toBe(200);
    const readinessBody = readinessAfter.json<{ state: string; bindingId: string; effectiveReady: boolean; agentEligibility: string }>();
    expect(readinessBody.state).toBe('ready');
    expect(readinessBody.bindingId).toBe(bindingId);
    expect(readinessBody.effectiveReady).toBe(true);
    expect(readinessBody.agentEligibility).toBe('eligible');

    const aggregateReadiness = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${agentId}/capabilities/readiness`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(aggregateReadiness.statusCode).toBe(200);
    const aggregateBody = aggregateReadiness.json<{ capabilities: Array<{ family: string; state: string; effectiveReady: boolean; bindingId?: string }> }>();
    const tradingCapability = aggregateBody.capabilities.find((capability) => capability.family === 'trading');
    expect(tradingCapability).toBeDefined();
    expect(tradingCapability?.state).toBe('ready');
    expect(tradingCapability?.effectiveReady).toBe(true);
    expect(tradingCapability?.bindingId).toBe(bindingId);

    const bindings = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${agentId}/capabilities/trading/bindings`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(bindings.statusCode).toBe(200);
    expect(bindings.json<{ bindings: Array<{ bindingId: string; status: string }> }>().bindings).toEqual(
      expect.arrayContaining([expect.objectContaining({ bindingId, status: 'active' })]),
    );

    const auditBeforeUnbind = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${agentId}/capabilities/trading/bindings/${bindingId}/audit`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(auditBeforeUnbind.statusCode).toBe(200);
    expect(auditBeforeUnbind.json<{ audit: Array<{ action: string }> }>().audit).toHaveLength(1);

    const unbindRes = await ctx.app.inject({
      method: 'POST',
      url: `/agents/${agentId}/capabilities/trading/actions/unbind`,
      headers: { Authorization: `Bearer ${token}` },
      payload: { bindingId },
    });
    expect(unbindRes.statusCode).toBe(200);

    const revokedReadiness = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${agentId}/capabilities/trading/readiness`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(revokedReadiness.statusCode).toBe(200);
    const revokedBody = revokedReadiness.json<{ state: string; effectiveReady: boolean; reasons: string[] }>();
    expect(revokedBody.state).toBe('revoked');
    expect(revokedBody.effectiveReady).toBe(false);
    expect(revokedBody.reasons.join(' ')).toContain('revoked');
    const revokedAggregate = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${agentId}/capabilities/readiness`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(revokedAggregate.statusCode).toBe(200);
    const revokedAggregateBody = revokedAggregate.json<{ capabilities: Array<{ family: string; state: string; agentEligibility: string; effectiveReady: boolean }> }>();
    expect(revokedAggregateBody.capabilities.find((capability) => capability.family === 'trading')).toMatchObject({
      state: 'revoked',
      agentEligibility: 'ineligible',
      effectiveReady: false,
    });

    const auditAfterUnbind = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${agentId}/capabilities/trading/bindings/${bindingId}/audit`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(auditAfterUnbind.statusCode).toBe(200);
    expect(auditAfterUnbind.json<{ audit: Array<{ action: string }> }>().audit.map((entry) => entry.action)).toEqual(['granted', 'revoked']);
  });

  it('marks capability readiness revoked when the underlying connection is revoked', async () => {
    const connection = await createConnection();
    const bindingId = await seedTradingBinding(connection.id);

    const bindRes = await ctx.app.inject({
      method: 'POST',
      url: `/agents/${agentId}/capabilities/trading/actions/bind`,
      headers: { Authorization: `Bearer ${token}` },
      payload: { bindingId },
    });
    expect(bindRes.statusCode).toBe(201);

    const revokeConnection = await ctx.app.inject({
      method: 'DELETE',
      url: `/connections/${connection.id}`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(revokeConnection.statusCode).toBe(204);

    const readinessAfterRevoke = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${agentId}/capabilities/trading/readiness`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(readinessAfterRevoke.statusCode).toBe(200);
    const body = readinessAfterRevoke.json<{ state: string; effectiveReady: boolean; reasons: string[] }>();
    expect(body.state).toBe('revoked');
    expect(body.effectiveReady).toBe(false);
    expect(body.reasons.join(' ')).toContain('connection');

    const aggregate = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${agentId}/capabilities/readiness`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(aggregate.statusCode).toBe(200);
    const aggregateBody = aggregate.json<{ capabilities: Array<{ family: string; state: string; agentEligibility: string; effectiveReady: boolean }> }>();
    expect(aggregateBody.capabilities.find((capability) => capability.family === 'trading')).toMatchObject({
      state: 'revoked',
      agentEligibility: 'ineligible',
      effectiveReady: false,
    });
  });

  it('rejects binding a trading capability when the underlying connection is no longer ready', async () => {
    const connection = await createConnection();
    const bindingId = await seedTradingBinding(connection.id);

    const revokeConnection = await ctx.app.inject({
      method: 'DELETE',
      url: `/connections/${connection.id}`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(revokeConnection.statusCode).toBe(204);

    const bindRes = await ctx.app.inject({
      method: 'POST',
      url: `/agents/${agentId}/capabilities/trading/actions/bind`,
      headers: { Authorization: `Bearer ${token}` },
      payload: { bindingId },
    });

    expect(bindRes.statusCode).toBe(409);
    expect(bindRes.json<{ error: string }>().error).toBe('binding.not_ready');
  });
});