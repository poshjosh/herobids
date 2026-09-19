import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import { eq, and, inArray, sql } from 'drizzle-orm';
import type { Database, DatabaseTransaction } from '@herobids/db';
import { agentConnections, buildRuntimeDescriptor, connections, resolveRuntimeCapabilityDescriptor, agents } from '@herobids/db';
import type { PlansConfig, RuntimeBudgetPolicy, TradertonReadResult } from '@herobids/domain';
import { AGENT_STREAM_MAXLEN, readSkillPresetId } from '@herobids/domain';
import type { TradertonClient } from '@herobids/domain/traderton';
import { CreateConnectionSchema } from '../schemas.js';
import { errorPayload } from '../error-payload.js';
import { checkConnectionLimit } from '../plan-guards.js';
import {
  loadActiveTradingProfileConnections,
} from '../agents/trading-profile-reconciliation-adapter.js';
import { proposeTradingProfiles } from '../agents/trading-profile-reconciliation.js';
import type { TradingProfileReconciliationSaga } from '../agents/trading-profile-reconciliation-saga.js';
import type { TradingProfileStagedOperation } from '../agents/trading-profile-reconciliation-saga.js';
import {
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
    profile: connections.profile,
    resolvedVenueAccountId: connections.resolvedVenueAccountId,
    createdAt: connections.createdAt,
    updatedAt: connections.updatedAt,
    assignedAgentCount: sql<number>`(
      SELECT count(*)::int
      FROM agent_connections ac
      WHERE ac.connection_id = ${connections.id}
        AND ac.status = 'active'
    )`.mapWith(Number),
    // referencingBotCount + venueAccountRef are NO LONGER read from the local
    // `bots` / `venue_accounts` tables (c4.9f — those are trading-owned). They are
    // populated per-row over the Traderton boundary read tools in the GET handlers
    // (count_bots_by_venue_account / get_venue_account). The fields still exist on
    // the response contract — the web ConnectionsPage gates the Delete button on
    // referencingBotCount===0 and renders venueAccountRef as the funding address.
  };
}

/** A connection view row with the boundary-sourced display fields populated. */
type ConnectionViewRow = Record<string, unknown> & {
  resolvedVenueAccountId: string | null;
  referencingBotCount?: number;
  venueAccountRef?: string | null;
};

export async function connectionRoutes(
  app: FastifyInstance,
  db: Database,
  budgets: RuntimeBudgetPolicy,
  redisClient?: Redis,
  plansConfig?: PlansConfig,
  tradertonClient?: TradertonClient,
  profileReconciliationSaga?: TradingProfileReconciliationSaga,
): Promise<void> {
  // Owner-scoped boundary READ helper (c4.9f). Mirrors the invoke+unwrap shape in
  // bots.ts: subject = {ownerId:userId, actor:{type:'user',id:userId}}; the
  // dispatcher maps a tool's fault:false errorCode onto the closed wire code
  // `validation.invalid_payload` and carries the original under
  // `details.errorCode`, so unwrap it here to surface the tool errorCode as `code`.
  const readBoundary = async (
    toolName: 'count_bots_by_venue_account' | 'get_venue_account',
    payload: Record<string, unknown>,
    userId: string,
  ): Promise<TradertonReadResult> => {
    if (!tradertonClient) {
      return { kind: 'transport_error', message: 'trading boundary not configured', retryable: true };
    }
    const result = await tradertonClient.invoke({
      toolName,
      payload,
      subject: { ownerId: userId, actor: { type: 'user', id: userId } },
      deadlineMs: 30_000,
    });
    switch (result.kind) {
      case 'success':
        return { kind: 'success', data: result.payload };
      case 'failure': {
        const toolCode = result.details?.['errorCode'];
        const code = result.code === 'validation.invalid_payload' && typeof toolCode === 'string'
          ? toolCode
          : result.code;
        return { kind: 'failure', code, message: result.message, retryable: result.retryable };
      }
      case 'in_progress':
        return { kind: 'in_progress' };
      case 'transport_error':
        return { kind: 'transport_error', message: result.message, retryable: true };
    }
  };

  // Batch-populate `referencingBotCount` + `venueAccountRef` over the boundary for
  // a page of connection view rows (c4.9f). ONE count_bots_by_venue_account call
  // covers every non-null resolvedVenueAccountId; get_venue_account is single-id,
  // called once per non-null-account row (few connections per user).
  //
  // DISPLAY DEGRADES GRACEFULLY when the boundary is absent/unavailable: the list
  // read must not hard-fail on a display count/ref. referencingBotCount degrades
  // to 0 (the hard-delete still fails closed at the delete-time 409 boundary
  // check) and venueAccountRef degrades to null. Rows with a null account are
  // vacuously { referencingBotCount: 0, venueAccountRef: null }.
  const enrichConnectionViews = async (
    rows: ConnectionViewRow[],
    userId: string,
  ): Promise<ConnectionViewRow[]> => {
    const accountIds = [
      ...new Set(rows.map((r) => r.resolvedVenueAccountId).filter((id): id is string => id != null)),
    ];

    // Default the display fields (degraded / null-account values).
    for (const row of rows) {
      row.referencingBotCount = 0;
      row.venueAccountRef = null;
    }
    if (accountIds.length === 0) {
      return rows;
    }

    // Bot counts — ONE batched call.
    const countResult = await readBoundary('count_bots_by_venue_account', { venueAccountIds: accountIds }, userId);
    if (countResult.kind === 'success') {
      const data = (countResult.data ?? {}) as { byVenueAccount?: Record<string, string[]> };
      const byVenueAccount = data.byVenueAccount ?? {};
      for (const row of rows) {
        if (row.resolvedVenueAccountId != null) {
          row.referencingBotCount = (byVenueAccount[row.resolvedVenueAccountId] ?? []).length;
        }
      }
    }

    // Funding address (venueAccountRef) — single-id per non-null-account row.
    for (const accountId of accountIds) {
      const refResult = await readBoundary('get_venue_account', { venueAccountId: accountId }, userId);
      if (refResult.kind === 'success') {
        const data = (refResult.data ?? {}) as { venueAccountRef?: string | null };
        const ref = data.venueAccountRef ?? null;
        for (const row of rows) {
          if (row.resolvedVenueAccountId === accountId) {
            row.venueAccountRef = ref;
          }
        }
      }
    }

    return rows;
  };

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
        maxBots: agents.maxBots,
        unifiedConfig: agents.unifiedConfig,
      })
      .from(agents)
      .where(eq(agents.id, agentId));

    if (!agentRow) {
      return;
    }

    const capabilityDescriptor = await resolveRuntimeCapabilityDescriptor(db, agentId);
    const runtimeDescriptor = buildRuntimeDescriptor({
      agentId,
      name: agentRow.name,
      skillPresetId: readSkillPresetId(agentRow.unifiedConfig),
      goal: agentRow.prompt,
      executionMode: undefined,
      toolPolicy: (agentRow.toolPolicy as Record<string, unknown> | null) ?? {},
      dailyMaxLossPct: null,
      maxDrawdownPct: null,
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

    // credentialId existence/provider-match validation removed (c4.4): it read
    // the trading-owned `user_credentials` table (isolation) and was structurally
    // dead post-Q4 — nothing writes `user_credentials` from herobids, and a real
    // `connections.credentialId` names a `platform_credentials` row, so the lookup
    // could only ever 400. The provider-requires/allows policy checks above stay
    // (platform provider policy, not a trading-table read). credentialId has no FK
    // (see schema), so no insert-time FK remap is needed.

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

        return { kind: 'ok' as const };
      });

      if (result.kind === 'limit') {
        return reply.status(403).send(errorPayload(result.error.code, result.error.message, result.error.params));
      }
    } else {
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
    }

    const [conn] = await db
      .select(selectConnectionView())
      .from(connections)
      .where(eq(connections.id, id));

    // A newly created connection has resolvedVenueAccountId === null, so the
    // display fields resolve vacuously (no boundary call); enrich for a uniform
    // response shape.
    const [enriched] = await enrichConnectionViews([conn as ConnectionViewRow], request.userId);
    return reply.status(201).send(enriched);
  });

  // GET /connections — list all connections for the authenticated user
  app.get('/connections', async (request, reply) => {
    const rows = await db
      .select(selectConnectionView())
      .from(connections)
      .where(eq(connections.userId, request.userId));
    // Populate referencingBotCount + venueAccountRef over the boundary
    // (batched). Display degrades gracefully when the boundary is down.
    const enriched = await enrichConnectionViews(rows as ConnectionViewRow[], request.userId);
    return reply.send({ connections: enriched });
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
    const [enriched] = await enrichConnectionViews([conn as ConnectionViewRow], request.userId);
    return reply.send(enriched);
  });

  // DELETE /connections/:id — revoke (soft-delete) a connection, or hard-delete when ?permanent=true
  app.delete<{ Params: { id: string }; Querystring: { permanent?: string } }>('/connections/:id', async (request, reply) => {
    const { id } = request.params;
    const permanent = request.query.permanent === 'true';

    const [conn] = await db
      .select({ id: connections.id, status: connections.status, resolvedVenueAccountId: connections.resolvedVenueAccountId })
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

      // Block deletion if any trading bots reference the linked venue account
      // (c4.9f). Traderton owns the bots — the authoritative "any bot referencing
      // the account" predicate is exposed over count_bots_by_venue_account. A
      // connection with a null resolvedVenueAccountId is non-trading → no bots can
      // reference it, so the bot guard is vacuously skipped. The boundary is
      // MANDATORY when there IS an account to check: absent/transport/in_progress
      // → 503 precondition.not_ready (fail closed, never delete without the guard).
      const resolvedVenueAccountId = conn.resolvedVenueAccountId;
      if (resolvedVenueAccountId != null) {
        const countResult = await readBoundary(
          'count_bots_by_venue_account',
          { venueAccountIds: [resolvedVenueAccountId] },
          request.userId,
        );
        if (countResult.kind === 'transport_error' || countResult.kind === 'in_progress') {
          return reply.status(503).send(errorPayload('precondition.not_ready', 'Trading service is unavailable — the connection was not deleted.', {}));
        }
        if (countResult.kind === 'failure') {
          return reply.status(502).send(errorPayload(countResult.code, countResult.message, {}));
        }
        const data = (countResult.data ?? {}) as { byVenueAccount?: Record<string, string[]> };
        const blockingBotIds = data.byVenueAccount?.[resolvedVenueAccountId] ?? [];
        if (blockingBotIds.length > 0) {
          return reply.status(409).send({
            error: 'connection.in_use',
            params: {
              connectionId: id,
              blockingBotIds,
              hint: 'Delete the bots referencing this connection first.',
            },
          });
        }
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
          // FK violation — a concurrent active agent grant was created between the
          // check and the delete. agent_connections is the only local FK on
          // connections now (bots are Traderton-owned; the local bots FK drops at
          // c4.9f, and pre-drop the boundary count above is the authoritative bot
          // guard). Re-check the grant and surface the 409; otherwise re-throw.
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
      .select({
        agentId: agentConnections.agentId,
      })
      .from(agentConnections)
      .innerJoin(agents, eq(agentConnections.agentId, agents.id))
      .where(and(eq(agentConnections.connectionId, id), eq(agentConnections.status, 'active')));

    if (affectedAgents.length > 0 && !profileReconciliationSaga) {
      return reply.status(503).send(errorPayload('precondition.not_ready', 'Trading service is unavailable — the connection was not revoked.', {}));
    }

    const now = new Date();
    const stagedOperations: TradingProfileStagedOperation[] = [];
    const completedAgentIds: string[] = [];
    let finalizationStarted = false;
    try {
    for (const [index, agent] of affectedAgents.entries()) {
      let preparedPriorConnections: Awaited<ReturnType<typeof loadActiveTradingProfileConnections>> | undefined;
      let stagedOperation: TradingProfileStagedOperation | undefined;
      await profileReconciliationSaga!.executeStaged({
        ownerId: request.userId,
        actorId: agent.agentId,
        localMutationId: crypto.randomUUID(),
        preparePlannerInput: async () => {
          const priorConnections = await loadActiveTradingProfileConnections(db, agent.agentId);
          preparedPriorConnections = priorConnections;
          const profiles = await profileReconciliationSaga!.readCurrentProfiles(request.userId, agent.agentId, priorConnections);
          const proposedConnections = priorConnections.filter((connection) => connection.connectionId !== id);
          return {
            prior: { profiles, connections: priorConnections },
            proposed: { profiles: proposeTradingProfiles({ actorId: agent.agentId, priorProfiles: profiles, priorConnections, proposedConnections, changes: {} }), connections: proposedConnections },
          };
        },
        commitLocal: async (tx: DatabaseTransaction, markLocalCommitted) => {
          const [currentConnection] = await tx.select({ status: connections.status, userId: connections.userId })
            .from(connections).where(eq(connections.id, id));
          if (!currentConnection || currentConnection.userId !== request.userId || currentConnection.status !== 'active') {
            throw new Error('connection changed before revoke could be committed');
          }
          const [activeGrant] = await tx.select({ id: agentConnections.id }).from(agentConnections).where(and(
            eq(agentConnections.agentId, agent.agentId),
            eq(agentConnections.connectionId, id),
            eq(agentConnections.status, 'active'),
          ));
          if (!activeGrant) throw new Error('agent connection changed before revoke could be committed');
          const currentProfileConnections = await loadActiveTradingProfileConnections(tx, agent.agentId);
          if (JSON.stringify(currentProfileConnections) !== JSON.stringify(preparedPriorConnections)) {
            throw new Error('agent connections changed before revoke could be committed');
          }

          await tx.update(agentConnections).set({ status: 'revoked', revokedAt: now, updatedAt: now })
            .where(eq(agentConnections.id, activeGrant.id));
          if (index === affectedAgents.length - 1) {
            await tx.update(connections).set({ status: 'revoked', updatedAt: now }).where(eq(connections.id, id));
          }
          await markLocalCommitted();
        },
        onOperationStaged: (operation) => {
          stagedOperation = operation;
        },
        deferFinalization: true,
      });
      if (stagedOperation) stagedOperations.push(stagedOperation);
      completedAgentIds.push(agent.agentId);
    }
    finalizationStarted = true;
    for (const operation of stagedOperations) {
      await profileReconciliationSaga!.finalize(operation);
    }
    } catch (error) {
      if (finalizationStarted) {
        // Finalization only removes remote rollback preimages. The local and remote revokes
        // are already committed, so recovery must finish finalization rather than compensate.
        throw error;
      }
      const compensationResults = await Promise.allSettled(
        stagedOperations.reverse().map((operation) => profileReconciliationSaga!.compensate(operation)),
      );
      if (compensationResults.some((result) => result.status === 'rejected')) {
        throw new Error('connection revoke fanout failed and profile compensation did not complete');
      }
      if (completedAgentIds.length > 0) {
        await db.transaction(async (tx) => {
          await tx.update(agentConnections).set({ status: 'active', revokedAt: null, updatedAt: new Date() })
            .where(and(inArray(agentConnections.agentId, completedAgentIds), eq(agentConnections.connectionId, id)));
        });
      }
      throw error;
    }

    if (affectedAgents.length === 0) {
      await db.transaction(async (tx) => {
        await tx.update(agentConnections).set({ status: 'revoked', revokedAt: now, updatedAt: now })
          .where(and(eq(agentConnections.connectionId, id), eq(agentConnections.status, 'active')));
        await tx.update(connections).set({ status: 'revoked', updatedAt: now }).where(eq(connections.id, id));
      });
    }

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
