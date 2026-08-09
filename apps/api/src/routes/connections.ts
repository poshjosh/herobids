import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import { eq, and, sql } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { agentConnections, bots, buildRuntimeDescriptor, connections, resolveRuntimeCapabilityDescriptor, userCredentials, agents } from '@herobids/db';
import type { PlansConfig, RuntimeBudgetPolicy } from '@herobids/domain';
import { AGENT_STREAM_MAXLEN } from '@herobids/domain';
import { CreateConnectionSchema } from '../schemas.js';
import { errorPayload } from '../error-payload.js';
import { checkConnectionLimit } from '../plan-guards.js';
import {
  credentialMatchesConnectionProvider,
  providerAllowsCredential,
  providerRequiresCredential,
  providerSupportsConnections,
} from '../providers/registry.js';

function selectConnectionView() {
  return {
    id: connections.id,
    userId: connections.userId,
    credentialId: connections.credentialId,
    provider: connections.provider,
    label: connections.label,
    status: connections.status,
    meta: connections.meta,
    resolvedVenueAccountId: connections.resolvedVenueAccountId,
    createdAt: connections.createdAt,
    updatedAt: connections.updatedAt,
    assignedAgentCount: sql<number>`(
      SELECT count(*)::int
      FROM agent_connections ac
      WHERE ac.connection_id = ${connections.id}
        AND ac.status = 'active'
    )`.mapWith(Number),
    referencingBotCount: sql<number>`(
      SELECT count(*)::int
      FROM bots b
      WHERE b.connection_id = ${connections.id}
    )`.mapWith(Number),
  };
}

export async function connectionRoutes(
  app: FastifyInstance,
  db: Database,
  budgets: RuntimeBudgetPolicy,
  redisClient?: Redis,
  plansConfig?: PlansConfig,
): Promise<void> {
  async function publishRuntimeRefresh(agentId: string): Promise<void> {
    if (!redisClient) {
      return;
    }

    const [agentRow] = await db
      .select({
        id: agents.id,
        name: agents.name,
        prompt: agents.prompt,
        toolPolicy: agents.toolPolicy,
        risk: agents.risk,
        executionDefaults: agents.executionDefaults,
        maxBots: agents.maxBots,
      })
      .from(agents)
      .where(eq(agents.id, agentId));

    if (!agentRow) {
      return;
    }

    const risk = (agentRow.risk ?? {}) as Record<string, unknown>;
    const executionDefaults = (agentRow.executionDefaults ?? {}) as Record<string, unknown>;

    const capabilityDescriptor = await resolveRuntimeCapabilityDescriptor(db, agentId);
    const runtimeDescriptor = buildRuntimeDescriptor({
      agentId,
      name: agentRow.name,
      goal: agentRow.prompt,
      executionMode: executionDefaults['mode'] as string | undefined,
      toolPolicy: (agentRow.toolPolicy as Record<string, unknown> | null) ?? {},
      dailyMaxLossPct: risk['dailyMaxLossPct'] != null ? String(risk['dailyMaxLossPct']) : null,
      maxDrawdownPct: risk['maxDrawdownPct'] != null ? Number(risk['maxDrawdownPct']) : null,
      maxBots: agentRow.maxBots,
      budgets,
      capabilityDescriptor,
    });

    await redisClient.xadd(
      `agent:outbound:${agentId}`,
      'MAXLEN',
      '~',
      AGENT_STREAM_MAXLEN,
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

    if (!providerSupportsConnections(parsed.data.provider) && parsed.data.provider === parsed.data.provider.trim().toLowerCase()) {
      // Unknown lowercase provider IDs are treated as custom-mode providers and remain allowed.
    } else if (!providerSupportsConnections(parsed.data.provider) && parsed.data.provider !== parsed.data.provider.trim()) {
      return reply.status(400).send(
        errorPayload('provider.invalid_id', 'Provider identifiers must not contain leading or trailing whitespace', {
          provider: parsed.data.provider,
        }),
      );
    }

    if (providerRequiresCredential(parsed.data.provider) && !parsed.data.credentialId) {
      return reply.status(400).send(
        errorPayload('credential.required_for_provider', `Provider "${parsed.data.provider}" requires a credential`, {
          provider: parsed.data.provider,
        }),
      );
    }

    if (!providerAllowsCredential(parsed.data.provider) && parsed.data.credentialId) {
      return reply.status(400).send(
        errorPayload('credential.not_allowed_for_provider', `Provider "${parsed.data.provider}" does not accept credentials`, {
          provider: parsed.data.provider,
        }),
      );
    }

    // If a credentialId is provided, verify it exists, belongs to this user,
    // and its provider matches the connection provider — prevents a Bybit credential
    // from being attached to a Hyperliquid connection, etc.
    if (parsed.data.credentialId) {
      const [cred] = await db
        .select({ id: userCredentials.id, provider: userCredentials.provider })
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
      if (!credentialMatchesConnectionProvider(parsed.data.provider, cred.provider)) {
        return reply.status(400).send(
          errorPayload('credential.provider_mismatch', `Credential is for provider "${cred.provider}", not provider "${parsed.data.provider}"`, {
            credentialProvider: cred.provider,
            provider: parsed.data.provider,
          }),
        );
      }
    }

    const id = crypto.randomUUID();
    const now = new Date();

    if (plansConfig) {
      const result = await db.transaction(async (tx) => {
        // Serialise connection create checks per user to avoid over-limit races.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(12, hashtext(${request.userId}))`);

        const planCheck = await checkConnectionLimit(tx as unknown as Database, plansConfig, request.userId, request.userPlanId || 'free', request.isAdmin);
        if (!planCheck.ok) {
          return { kind: 'limit' as const, error: planCheck.error };
        }

        try {
          await tx.insert(connections).values({
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
          if ((err as { code?: string }).code === '23503') {
            return { kind: 'fk' as const };
          }
          throw err;
        }

        return { kind: 'ok' as const };
      });

      if (result.kind === 'limit') {
        return reply.status(403).send(errorPayload(result.error.code, result.error.message, result.error.params));
      }

      if (result.kind === 'fk') {
        return reply.status(400).send(
          errorPayload(
            'credential.not_found',
            `Credential ${parsed.data.credentialId} was removed before the connection could be created`,
            { credentialId: parsed.data.credentialId },
          ),
        );
      }
    } else {
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
    }

    const [conn] = await db
      .select(selectConnectionView())
      .from(connections)
      .where(eq(connections.id, id));

    return reply.status(201).send(conn);
  });

  // GET /connections — list all connections for the authenticated user
  app.get('/connections', async (request, reply) => {
    const rows = await db
      .select(selectConnectionView())
      .from(connections)
      .where(eq(connections.userId, request.userId));
    return reply.send({ connections: rows });
  });

  // GET /connections/:id — get a single connection
  app.get<{ Params: { id: string } }>('/connections/:id', async (request, reply) => {
    const { id } = request.params;
    const [conn] = await db
      .select(selectConnectionView())
      .from(connections)
      .where(and(eq(connections.id, id), eq(connections.userId, request.userId)));
    if (!conn) {
      return reply.status(404).send({ error: 'not_found' });
    }
    return reply.send(conn);
  });

  // DELETE /connections/:id — revoke (soft-delete) a connection, or hard-delete when ?permanent=true
  app.delete<{ Params: { id: string }; Querystring: { permanent?: string } }>('/connections/:id', async (request, reply) => {
    const { id } = request.params;
    const permanent = request.query.permanent === 'true';

    const [conn] = await db
      .select({ id: connections.id, status: connections.status })
      .from(connections)
      .where(and(eq(connections.id, id), eq(connections.userId, request.userId)));
    if (!conn) {
      return reply.status(404).send({ error: 'not_found' });
    }

    // Hard-delete path
    if (permanent) {
      // Block deletion if any *active* agent grants reference this connection.
      const activeGrants = await db
        .select({ agentId: agentConnections.agentId })
        .from(agentConnections)
        .where(and(eq(agentConnections.connectionId, id), eq(agentConnections.status, 'active')))
        .limit(1);

      if (activeGrants.length > 0) {
        return reply.status(409).send({
          error: 'connection.in_use',
          params: { connectionId: id, hint: 'Revoke the connection instead, or remove it from all agents first.' },
        });
      }

      // Block deletion if any bots reference this connection.
      // bots.connectionId has ON DELETE RESTRICT — must check before attempting delete.
      const blockingBots = await db
        .select({ id: bots.id })
        .from(bots)
        .where(eq(bots.connectionId, id));

      if (blockingBots.length > 0) {
        return reply.status(409).send({
          error: 'connection.in_use',
          params: {
            connectionId: id,
            blockingBotIds: blockingBots.map((b) => b.id),
            hint: 'Delete the bots referencing this connection first.',
          },
        });
      }

      try {
        await db.transaction(async (tx) => {
          // Clean up only revoked agent_connections rows so the FK restrict
          // doesn't block. Active grants are left untouched — if one was
          // created concurrently the FK will fire 23503, which is caught below.
          await tx
            .delete(agentConnections)
            .where(and(eq(agentConnections.connectionId, id), eq(agentConnections.status, 'revoked')));
          await tx.delete(connections).where(eq(connections.id, id));
        });
      } catch (err: unknown) {
        const pgErr = err as { code?: string };
        if (pgErr.code === '23503') {
          // FK violation — a concurrent grant or bot was created between check and delete
          const concurrentGrants = await db
            .select({ agentId: agentConnections.agentId })
            .from(agentConnections)
            .where(and(eq(agentConnections.connectionId, id), eq(agentConnections.status, 'active')))
            .limit(1);
          if (concurrentGrants.length > 0) {
            return reply.status(409).send({
              error: 'connection.in_use',
              params: { connectionId: id, hint: 'Revoke the connection instead, or remove it from all agents first.' },
            });
          }

          const concurrentBots = await db
            .select({ id: bots.id })
            .from(bots)
            .where(eq(bots.connectionId, id));
          if (concurrentBots.length > 0) {
            return reply.status(409).send({
              error: 'connection.in_use',
              params: {
                connectionId: id,
                blockingBotIds: concurrentBots.map((b) => b.id),
                hint: 'Delete the bots referencing this connection first.',
              },
            });
          }
        }
        throw err;
      }

      return reply.status(204).send();
    }

    // Soft-delete (revoke) path
    if (conn.status === 'revoked') {
      return reply.status(409).send({ error: 'connection.already_revoked' });
    }

    // Capture affected agents before we flip agent_connections to revoked.
    const affectedAgents = await db
      .select({ agentId: agentConnections.agentId })
      .from(agentConnections)
      .where(and(eq(agentConnections.connectionId, id), eq(agentConnections.status, 'active')));

    const now = new Date();

    // Mark all agent grants for this connection as revoked so that a
    // subsequent hard-delete is not blocked by still-active grants.
    await db
      .update(agentConnections)
      .set({ status: 'revoked', revokedAt: now, updatedAt: now })
      .where(and(eq(agentConnections.connectionId, id), eq(agentConnections.status, 'active')));

    await db
      .update(connections)
      .set({ status: 'revoked', updatedAt: now })
      .where(eq(connections.id, id));

    if (redisClient) {
      for (const row of affectedAgents) {
        await publishRuntimeRefresh(row.agentId).catch((err: unknown) => {
          app.log.warn({ err, agentId: row.agentId, connectionId: id }, 'Failed to publish runtime refresh after connection revoke');
        });
      }
    }

    return reply.status(204).send();
  });
}
