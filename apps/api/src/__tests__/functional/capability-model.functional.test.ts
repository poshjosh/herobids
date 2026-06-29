/**
 * Functional tests: capability model platform primitives and lifecycle.
 *
 * These tests require DATABASE_URL and REDIS_URL. They are skipped automatically
 * when those env vars are absent.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { agentConnections } from '@herobids/db';
import { SKIP, buildApp, truncateAll, registerUser } from './helpers.js';

async function createAgent(app: Awaited<ReturnType<typeof buildApp>>['app'], token: string, name: string, prompt: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/agents',
    headers: { Authorization: `Bearer ${token}` },
    payload: { name, prompt, skillIds: [] },
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
    token = await registerUser(ctx.app, ctx.db, 'capability-functional@test.local');
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

  async function setupTradingLink(): Promise<{ connectionId: string }> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/setup/provider-link',
      headers: { Authorization: `Bearer ${token}` },
      payload: {
        provider: 'hyperliquid',
        label: 'Hyperliquid trading setup',
        secrets: {
          apiKey: 'test-api-key',
          secret: 'test-secret',
          walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        capability: 'trading',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ connection: { id: string } }>();
    return { connectionId: body.connection.id };
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

  it('covers family catalogs, connection creation, agent-connection lifecycle, readiness, and audit history', async () => {
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

    const { connectionId: grantConnectionId } = await setupTradingLink();

    const readinessBefore = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${agentId}/capabilities/trading/readiness`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(readinessBefore.statusCode).toBe(200);
    expect(readinessBefore.json<{ state: string }>().state).toBe('unconfigured');

    // Grant via declarative PATCH connectionIds
    const grantRes = await ctx.app.inject({
      method: 'PATCH',
      url: `/agents/${agentId}`,
      headers: { Authorization: `Bearer ${token}` },
      payload: { connectionIds: [grantConnectionId] },
    });
    expect(grantRes.statusCode).toBe(200);

    // Duplicate PATCH with same connectionIds is idempotent
    const duplicateGrantRes = await ctx.app.inject({
      method: 'PATCH',
      url: `/agents/${agentId}`,
      headers: { Authorization: `Bearer ${token}` },
      payload: { connectionIds: [grantConnectionId] },
    });
    expect(duplicateGrantRes.statusCode).toBe(200);

    const activeAgentConns = await ctx.db
      .select({ id: agentConnections.id })
      .from(agentConnections)
      .where(and(eq(agentConnections.agentId, agentId), eq(agentConnections.connectionId, grantConnectionId), eq(agentConnections.status, 'active')));
    expect(activeAgentConns).toHaveLength(1);

    const readinessAfter = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${agentId}/capabilities/trading/readiness`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(readinessAfter.statusCode).toBe(200);
    const readinessBody = readinessAfter.json<{ state: string; connectionId: string; effectiveReady: boolean; agentEligibility: string }>();
    expect(readinessBody.state).toBe('ready');
    expect(readinessBody.connectionId).toBe(grantConnectionId);
    expect(readinessBody.effectiveReady).toBe(true);
    expect(readinessBody.agentEligibility).toBe('eligible');

    const aggregateReadiness = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${agentId}/capabilities/readiness`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(aggregateReadiness.statusCode).toBe(200);
    const aggregateBody = aggregateReadiness.json<{ capabilities: Array<{ family: string; state: string; effectiveReady: boolean; connectionId?: string }> }>();
    const tradingCapability = aggregateBody.capabilities.find((capability) => capability.family === 'trading');
    expect(tradingCapability).toBeDefined();
    expect(tradingCapability?.state).toBe('ready');
    expect(tradingCapability?.effectiveReady).toBe(true);
    expect(tradingCapability?.connectionId).toBe(grantConnectionId);

    const connections = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${agentId}/capabilities/trading/connections`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(connections.statusCode).toBe(200);
    expect(connections.json<{ connections: Array<{ connectionId: string; grantStatus: string }> }>().connections).toEqual(
      expect.arrayContaining([expect.objectContaining({ connectionId: grantConnectionId, grantStatus: 'active' })]),
    );

    const auditBeforeRevoke = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${agentId}/capabilities/trading/connections/${grantConnectionId}/audit`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(auditBeforeRevoke.statusCode).toBe(200);
    expect(auditBeforeRevoke.json<{ audit: Array<{ action: string }> }>().audit).toHaveLength(1);

    // Revoke via declarative PATCH with empty connectionIds
    const revokeRes = await ctx.app.inject({
      method: 'PATCH',
      url: `/agents/${agentId}`,
      headers: { Authorization: `Bearer ${token}` },
      payload: { connectionIds: [] },
    });
    expect(revokeRes.statusCode).toBe(200);

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

    const auditAfterRevoke = await ctx.app.inject({
      method: 'GET',
      url: `/agents/${agentId}/capabilities/trading/connections/${grantConnectionId}/audit`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(auditAfterRevoke.statusCode).toBe(200);
    expect(auditAfterRevoke.json<{ audit: Array<{ action: string }> }>().audit.map((entry) => entry.action)).toEqual(['granted', 'revoked']);
  });

  it('marks capability readiness revoked when the underlying connection is revoked', async () => {
    const { connectionId } = await setupTradingLink();

    // Grant via declarative PATCH connectionIds
    const grantRes = await ctx.app.inject({
      method: 'PATCH',
      url: `/agents/${agentId}`,
      headers: { Authorization: `Bearer ${token}` },
      payload: { connectionIds: [connectionId] },
    });
    expect(grantRes.statusCode).toBe(200);

    const revokeConnection = await ctx.app.inject({
      method: 'DELETE',
      url: `/connections/${connectionId}`,
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

  it('rejects granting agent access to a revoked connection', async () => {
    const { connectionId } = await setupTradingLink();

    const revokeConnection = await ctx.app.inject({
      method: 'DELETE',
      url: `/connections/${connectionId}`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(revokeConnection.statusCode).toBe(204);

    const grantRes = await ctx.app.inject({
      method: 'PATCH',
      url: `/agents/${agentId}`,
      headers: { Authorization: `Bearer ${token}` },
      payload: { connectionIds: [connectionId] },
    });

    expect(grantRes.statusCode).toBe(422);
    const body = grantRes.json<{ error: string; details?: Array<{ message: string }> }>();
    expect(body.details?.[0]?.message ?? '').toContain('not active');
  });
});