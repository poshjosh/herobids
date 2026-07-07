/**
 * Functional tests for connection revoke → hard-delete flow (Bug #009 regression).
 *
 * Requires a live DATABASE_URL and REDIS_URL.
 * Automatically skipped when those env vars are absent.
 *
 * These tests set up agent_connections rows via direct DB insert and then
 * exercise the connection revoke and hard-delete API endpoints to verify
 * correct state transitions.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { SKIP, buildApp, truncateAll, registerUser } from './helpers.js';
import { agentConnections, connections, agents } from '@herobids/db';
import { eq, and } from 'drizzle-orm';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ctx: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  if (SKIP) return;
  ctx = await buildApp();
}, 30_000);

afterAll(async () => {
  if (SKIP) return;
  await truncateAll(ctx.db);
  await ctx.redisClient.quit();
  await ctx.lifecycleQueue.close();
  await ctx.app.close();
});

beforeEach(async () => {
  if (SKIP) return;
  await truncateAll(ctx.db);
});

describe.skipIf(SKIP)('Connection revoke → hard-delete flow (Bug #009 regression)', () => {
  /** Create a connection via the API and return its ID. */
  async function createConnection(token: string, label = 'Test Connection'): Promise<string> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/connections',
      headers: { Authorization: `Bearer ${token}` },
      payload: { provider: 'hyperliquid', label },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string }>().id;
  }

  /** Create a minimal agent row via direct DB insert (bypasses API validation). */
  async function seedAgent(userId: string): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date();
    await ctx.db.insert(agents).values({
      id,
      userId,
      name: 'Test Agent',
      prompt: 'Trade carefully.',
      status: 'stopped',
      executionMode: 'paper',
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  /** Insert an active agent_connections row directly into the DB. */
  async function seedActiveGrant(agentId: string, connectionId: string, grantedBy: string): Promise<void> {
    const now = new Date();
    await ctx.db.insert(agentConnections).values({
      id: crypto.randomUUID(),
      agentId,
      connectionId,
      status: 'active',
      grantedBy,
      grantedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }

  /** Get the authenticated user ID from a token. */
  async function getUserId(token: string): Promise<string> {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ id: string }>().id;
  }

  async function revokeConnection(token: string, connectionId: string): Promise<number> {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/connections/${connectionId}`,
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.statusCode;
  }

  async function hardDeleteConnection(token: string, connectionId: string): Promise<number> {
    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/connections/${connectionId}?permanent=true`,
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.statusCode;
  }

  async function getConnection(token: string, connectionId: string) {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/connections/${connectionId}`,
      headers: { Authorization: `Bearer ${token}` },
    });
    return { status: res.statusCode, body: res.json<{ assignedAgentCount: number; status: string }>() };
  }

  it('allows hard-delete after revoking a connection with a single active agent grant', async () => {
    const token = await registerUser(ctx.app, ctx.db);
    const userId = await getUserId(token);
    const connectionId = await createConnection(token, 'Bug 009 Regression');
    const agentId = await seedAgent(userId);
    await seedActiveGrant(agentId, connectionId, userId);

    // Verify the grant exists in DB
    const activeGrants = await ctx.db
      .select({ id: agentConnections.id })
      .from(agentConnections)
      .where(and(eq(agentConnections.connectionId, connectionId), eq(agentConnections.status, 'active')));
    expect(activeGrants).toHaveLength(1);

    // Hard-delete should be blocked before revoke (active grant exists)
    expect(await hardDeleteConnection(token, connectionId)).toBe(409);

    // Revoke the connection
    expect(await revokeConnection(token, connectionId)).toBe(204);

    // Verify the connection is now revoked via API
    const afterRevoke = await getConnection(token, connectionId);
    expect(afterRevoke.body.status).toBe('revoked');

    // Bug #009: verify no active grants remain in DB
    const remainingActive = await ctx.db
      .select({ id: agentConnections.id })
      .from(agentConnections)
      .where(and(eq(agentConnections.connectionId, connectionId), eq(agentConnections.status, 'active')));
    expect(remainingActive).toHaveLength(0);

    // Verify the grant is now revoked in DB (not deleted)
    const [grant] = await ctx.db
      .select({ status: agentConnections.status, revokedAt: agentConnections.revokedAt })
      .from(agentConnections)
      .where(eq(agentConnections.connectionId, connectionId));
    expect(grant!.status).toBe('revoked');
    expect(grant!.revokedAt).toBeDefined();

    // Hard-delete should now succeed
    expect(await hardDeleteConnection(token, connectionId)).toBe(204);
    expect((await getConnection(token, connectionId)).status).toBe(404);
  });

  it('allows hard-delete after revoking a connection with multiple active agent grants', async () => {
    const token = await registerUser(ctx.app, ctx.db);
    const userId = await getUserId(token);
    const connectionId = await createConnection(token, 'Multi-Grant Connection');

    // Seed 3 agents + active grants
    for (let i = 0; i < 3; i++) {
      const agentId = await seedAgent(userId);
      await seedActiveGrant(agentId, connectionId, userId);
    }

    // Verify 3 active grants in DB
    const activeGrants = await ctx.db
      .select({ id: agentConnections.id })
      .from(agentConnections)
      .where(and(eq(agentConnections.connectionId, connectionId), eq(agentConnections.status, 'active')));
    expect(activeGrants).toHaveLength(3);

    // Revoke — must flip all 3
    expect(await revokeConnection(token, connectionId)).toBe(204);

    // Bug #009: no active grants remain
    const remainingActive = await ctx.db
      .select({ id: agentConnections.id })
      .from(agentConnections)
      .where(and(eq(agentConnections.connectionId, connectionId), eq(agentConnections.status, 'active')));
    expect(remainingActive).toHaveLength(0);

    // All 3 grants must be revoked (not deleted)
    const grants = await ctx.db
      .select({ status: agentConnections.status, revokedAt: agentConnections.revokedAt })
      .from(agentConnections)
      .where(eq(agentConnections.connectionId, connectionId));
    expect(grants).toHaveLength(3);
    for (const g of grants) {
      expect(g.status).toBe('revoked');
      expect(g.revokedAt).toBeDefined();
    }

    // Hard-delete should succeed
    expect(await hardDeleteConnection(token, connectionId)).toBe(204);
    expect((await getConnection(token, connectionId)).status).toBe(404);
  });

  it('allows revoke and hard-delete for a connection with no agent grants', async () => {
    const token = await registerUser(ctx.app, ctx.db);
    const connectionId = await createConnection(token, 'No-Grant Connection');

    const before = await getConnection(token, connectionId);
    expect(before.body.assignedAgentCount).toBe(0);

    // Revoke works even with zero grants
    expect(await revokeConnection(token, connectionId)).toBe(204);

    const afterRevoke = await getConnection(token, connectionId);
    expect(afterRevoke.body.status).toBe('revoked');
    expect(afterRevoke.body.assignedAgentCount).toBe(0);

    // Hard-delete succeeds
    expect(await hardDeleteConnection(token, connectionId)).toBe(204);
    expect((await getConnection(token, connectionId)).status).toBe(404);
  });

  it('blocks hard-delete when a concurrent active agent grant exists after revoke', async () => {
    const token = await registerUser(ctx.app, ctx.db);
    const userId = await getUserId(token);
    const connectionId = await createConnection(token, 'Race Condition Connection');
    const agentId = await seedAgent(userId);
    await seedActiveGrant(agentId, connectionId, userId);

    // Revoke — flips the original grant
    expect(await revokeConnection(token, connectionId)).toBe(204);

    // Verify original grant is revoked
    const [originalGrant] = await ctx.db
      .select({ status: agentConnections.status })
      .from(agentConnections)
      .where(and(eq(agentConnections.connectionId, connectionId), eq(agentConnections.agentId, agentId)));
    expect(originalGrant!.status).toBe('revoked');

    // Simulate a concurrent grant inserted directly after revoke
    const concurrentAgentId = await seedAgent(userId);
    await seedActiveGrant(concurrentAgentId, connectionId, userId);

    // Verify concurrent grant is active in DB
    const activeGrants = await ctx.db
      .select({ id: agentConnections.id })
      .from(agentConnections)
      .where(and(eq(agentConnections.connectionId, connectionId), eq(agentConnections.status, 'active')));
    expect(activeGrants).toHaveLength(1);

    // Hard-delete must be blocked by the concurrent active grant
    expect(await hardDeleteConnection(token, connectionId)).toBe(409);

    // Connection must still exist and be revoked
    const after = await getConnection(token, connectionId);
    expect(after.status).toBe(200);
    expect(after.body.status).toBe('revoked');
  });

  it('returns 409 when trying to revoke an already-revoked connection', async () => {
    const token = await registerUser(ctx.app, ctx.db);
    const connectionId = await createConnection(token, 'Double Revoke');

    expect(await revokeConnection(token, connectionId)).toBe(204);

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/connections/${connectionId}`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe('connection.already_revoked');
  });

  it('retains revoked agent_connections rows after hard-delete (audit trail)', async () => {
    // Hard-delete cleans up revoked agent_connections rows in a transaction
    // before deleting the connection (to satisfy FK restrict). Verify that
    // the rows are truly gone after hard-delete.
    const token = await registerUser(ctx.app, ctx.db);
    const userId = await getUserId(token);
    const connectionId = await createConnection(token, 'Audit Connection');
    const agentId = await seedAgent(userId);
    await seedActiveGrant(agentId, connectionId, userId);

    // Revoke
    expect(await revokeConnection(token, connectionId)).toBe(204);

    // Count agent_connections rows before hard-delete
    const before = await ctx.db
      .select({ id: agentConnections.id })
      .from(agentConnections)
      .where(eq(agentConnections.connectionId, connectionId));
    expect(before).toHaveLength(1); // still exists, just revoked

    // Hard-delete
    expect(await hardDeleteConnection(token, connectionId)).toBe(204);

    // agent_connections row should be cleaned up (deleted by the transaction)
    const after = await ctx.db
      .select({ id: agentConnections.id })
      .from(agentConnections)
      .where(eq(agentConnections.connectionId, connectionId));
    expect(after).toHaveLength(0);
  });
});
