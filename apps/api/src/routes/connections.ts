import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import { eq, and } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { buildRuntimeDescriptor, capabilityGrants, connections, resolveRuntimeCapabilityDescriptor, tradingBindings, userCredentials, agents } from '@herobids/db';
import type { RuntimeBudgetPolicy } from '@herobids/domain';
import { CreateConnectionSchema } from '../schemas.js';
import { errorPayload } from '../error-payload.js';

export async function connectionRoutes(app: FastifyInstance, db: Database, budgets: RuntimeBudgetPolicy, redisClient?: Redis): Promise<void> {
  async function publishRuntimeRefresh(agentId: string): Promise<void> {
    if (!redisClient) {
      return;
    }

    const [agentRow] = await db
      .select({
        id: agents.id,
        name: agents.name,
        prompt: agents.prompt,
        skillIds: agents.skillIds,
        toolPolicy: agents.toolPolicy,
        executionMode: agents.executionMode,
        dailyTokenBudget: agents.dailyTokenBudget,
        dailyLossLimit: agents.dailyLossLimit,
        maxBots: agents.maxBots,
        maxSlippageBps: agents.maxSlippageBps,
      })
      .from(agents)
      .where(eq(agents.id, agentId));

    if (!agentRow) {
      return;
    }

    const capabilityDescriptor = await resolveRuntimeCapabilityDescriptor(db, agentId, agentRow.skillIds ?? []);
    const runtimeDescriptor = buildRuntimeDescriptor({
      agentId,
      name: agentRow.name,
      goal: agentRow.prompt,
      executionMode: agentRow.executionMode,
      toolPolicy: (agentRow.toolPolicy as Record<string, unknown> | null) ?? {},
      dailyTokenBudget: agentRow.dailyTokenBudget,
      dailyLossLimit: agentRow.dailyLossLimit,
      maxBots: agentRow.maxBots,
      maxSlippageBps: agentRow.maxSlippageBps,
      budgets,
      capabilityDescriptor,
    });

    await redisClient.xadd(
      `agent:outbound:${agentId}`,
      '*',
      'envelope',
      JSON.stringify({
        schemaVersion: 'v1',
        messageId: crypto.randomUUID(),
        correlationId: agentId,
        initiatorType: 'system',
        initiatorId: agentId,
        agentId,
        type: 'agent.runtime.config_update',
        createdAt: new Date().toISOString(),
        payload: { reason: 'readiness_changed', runtimeDescriptor },
      }),
    );
  }

  // POST /connections — create a platform connection
  app.post('/connections', async (request, reply) => {
    const parsed = CreateConnectionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    // If a credentialId is provided, verify it exists, belongs to this user,
    // and its venue matches the connection provider — prevents a Bybit credential
    // from being attached to a Hyperliquid connection, etc.
    if (parsed.data.credentialId) {
      const [cred] = await db
        .select({ id: userCredentials.id, venue: userCredentials.venue })
        .from(userCredentials)
        .where(
          and(
            eq(userCredentials.id, parsed.data.credentialId),
            eq(userCredentials.userId, request.userId),
          ),
        );
      if (!cred) {
        return reply.status(400).send(
          errorPayload('credential.not_found', `Credential ${parsed.data.credentialId} does not exist`, {
            credentialId: parsed.data.credentialId,
          }),
        );
      }
      if (cred.venue !== parsed.data.provider) {
        return reply.status(400).send(
          errorPayload('credential.provider_mismatch', `Credential is for venue "${cred.venue}", not provider "${parsed.data.provider}"`, {
            credentialVenue: cred.venue,
            provider: parsed.data.provider,
          }),
        );
      }
    }

    const id = crypto.randomUUID();
    const now = new Date();

    try {
      await db.insert(connections).values({
        id,
        userId: request.userId,
        credentialId: parsed.data.credentialId ?? null,
        provider: parsed.data.provider,
        label: parsed.data.label,
        status: 'active',
        meta: null,
        createdAt: now,
        updatedAt: now,
      });
    } catch (err: unknown) {
      // FK violation — credential deleted between validation and insert
      const pgErr = err as { code?: string };
      if (pgErr.code === '23503') {
        return reply.status(400).send(
          errorPayload(
            'credential.not_found',
            `Credential ${parsed.data.credentialId} was removed before the connection could be created`,
            { credentialId: parsed.data.credentialId },
          ),
        );
      }
      throw err;
    }

    const [conn] = await db
      .select()
      .from(connections)
      .where(eq(connections.id, id));

    return reply.status(201).send(conn);
  });

  // GET /connections — list all connections for the authenticated user
  app.get('/connections', async (request, reply) => {
    const rows = await db
      .select()
      .from(connections)
      .where(eq(connections.userId, request.userId));
    return reply.send({ connections: rows });
  });

  // GET /connections/:id — get a single connection
  app.get<{ Params: { id: string } }>('/connections/:id', async (request, reply) => {
    const { id } = request.params;
    const [conn] = await db
      .select()
      .from(connections)
      .where(and(eq(connections.id, id), eq(connections.userId, request.userId)));
    if (!conn) {
      return reply.status(404).send({ error: 'not_found' });
    }
    return reply.send(conn);
  });

  // DELETE /connections/:id — revoke (soft-delete) a connection
  app.delete<{ Params: { id: string } }>('/connections/:id', async (request, reply) => {
    const { id } = request.params;
    const [conn] = await db
      .select({ id: connections.id, status: connections.status })
      .from(connections)
      .where(and(eq(connections.id, id), eq(connections.userId, request.userId)));
    if (!conn) {
      return reply.status(404).send({ error: 'not_found' });
    }
    if (conn.status === 'revoked') {
      return reply.status(409).send({ error: 'connection.already_revoked' });
    }

    await db
      .update(connections)
      .set({ status: 'revoked', updatedAt: new Date() })
      .where(eq(connections.id, id));

    await db
      .update(tradingBindings)
      .set({ status: 'revoked', updatedAt: new Date() })
      .where(eq(tradingBindings.connectionId, id));

    if (redisClient) {
      const affectedAgents = await db
        .select({ agentId: capabilityGrants.agentId })
        .from(capabilityGrants)
        .innerJoin(tradingBindings, eq(capabilityGrants.bindingId, tradingBindings.id))
        .where(and(eq(tradingBindings.connectionId, id), eq(capabilityGrants.status, 'active')));

      for (const row of affectedAgents) {
        await publishRuntimeRefresh(row.agentId).catch((err: unknown) => {
          app.log.warn({ err, agentId: row.agentId, connectionId: id }, 'Failed to publish runtime refresh after connection revoke');
        });
      }
    }

    // TODO(21.3): cascade-revoke active grants that reference this connection and write
    // audit entries for each. For now, readiness.ts derives the correct "revoked" state
    // from connection status, so active grants on a revoked connection are effectively
    // blocked even though their status still reads "active".

    return reply.status(204).send();
  });
}
