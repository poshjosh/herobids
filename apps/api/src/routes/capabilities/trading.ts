import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import { eq, and, desc, inArray, isNull, sum, count } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { buildRuntimeDescriptor, resolveRuntimeCapabilityDescriptor } from '@herobids/db';
import {
  agents,
  connections,
  tradingBindings,
  capabilityGrants,
  bots,
  fills,
  journalEvents,
  positions,
  agentRuntimeSessions,
} from '@herobids/db';
import type { CapabilityReadiness, ReadinessState, PlansConfig } from '@herobids/domain';
import { z } from 'zod';
import {
  createGrant,
  revokeGrant,
  getBindingAudit,
  assertBindingOwnership,
} from '../../grant-service.js';

const SUPPORTED_ACTIONS = ['start', 'stop', 'pause', 'resume', 'bind', 'unbind'] as const;
type TradingAction = typeof SUPPORTED_ACTIONS[number];

const BindActionSchema = z.object({
  bindingId: z.string().min(1),
});

const UnbindActionSchema = z.object({
  bindingId: z.string().min(1),
});

const PauseActionSchema = z.object({
  reason: z.string().min(1).max(500),
});

const MAX_ACTIVITY_LIMIT = 200;
const MAX_ACTIVITY_OFFSET = 500;
const MAX_ACTIVITY_WINDOW = 700;

const TradingActivityQuerySchema = z.object({
  limit: z.coerce.number().int().min(0).max(MAX_ACTIVITY_LIMIT).default(50),
  offset: z.coerce.number().int().min(0).max(MAX_ACTIVITY_OFFSET).default(0),
});

type TradingGrantRow = {
  grantId: string;
  grantStatus: string;
  grantedAt: Date;
  revokedAt: Date | null;
  bindingId: string;
  bindingStatus: string;
  bindingRef: string | null;
  bindingProfile: Record<string, unknown> | null;
  sourceVenueAccountId: string | null;
  provider: string;
  label: string;
  connectionId: string;
  connectionStatus: string;
};

function deriveTradingReadiness(
  grantStatus: string,
  bindingStatus: string,
  connectionStatus: string,
): { state: ReadinessState; reasons: string[] } {
  if (connectionStatus === 'revoked') {
    return { state: 'revoked', reasons: ['underlying connection has been revoked'] };
  }
  if (bindingStatus === 'revoked') {
    return { state: 'revoked', reasons: ['binding has been revoked'] };
  }
  if (grantStatus === 'revoked') {
    return { state: 'revoked', reasons: ['grant has been revoked'] };
  }
  return { state: 'ready', reasons: [] };
}

function chooseLatestGrant(rows: TradingGrantRow[]): TradingGrantRow {
  return rows.slice().sort((left, right) => {
    const grantedAtDelta = right.grantedAt.getTime() - left.grantedAt.getTime();
    if (grantedAtDelta !== 0) {
      return grantedAtDelta;
    }
    return right.grantId.localeCompare(left.grantId);
  })[0]!;
}

async function selectAgentTradingGrantRows(db: Database, agentId: string): Promise<TradingGrantRow[]> {
  return db
    .select({
      grantId: capabilityGrants.id,
      grantStatus: capabilityGrants.status,
      grantedAt: capabilityGrants.grantedAt,
      revokedAt: capabilityGrants.revokedAt,
      bindingId: tradingBindings.id,
      bindingStatus: tradingBindings.status,
      bindingRef: tradingBindings.bindingRef,
      bindingProfile: tradingBindings.bindingProfile,
      sourceVenueAccountId: tradingBindings.sourceVenueAccountId,
      provider: tradingBindings.provider,
      label: tradingBindings.label,
      connectionId: connections.id,
      connectionStatus: connections.status,
    })
    .from(capabilityGrants)
    .innerJoin(tradingBindings, eq(capabilityGrants.bindingId, tradingBindings.id))
    .innerJoin(connections, eq(tradingBindings.connectionId, connections.id))
    .where(and(eq(capabilityGrants.agentId, agentId), eq(capabilityGrants.capabilityFamily, 'trading')));
}

function latestGrantPerBinding(rows: TradingGrantRow[]): TradingGrantRow[] {
  const sorted = rows.slice().sort((left, right) => {
    const grantedAtDelta = right.grantedAt.getTime() - left.grantedAt.getTime();
    if (grantedAtDelta !== 0) {
      return grantedAtDelta;
    }
    return right.grantId.localeCompare(left.grantId);
  });

  const seen = new Set<string>();
  const latest: TradingGrantRow[] = [];
  for (const row of sorted) {
    if (seen.has(row.bindingId)) {
      continue;
    }
    seen.add(row.bindingId);
    latest.push(row);
  }
  return latest;
}

function allBindingIds(rows: TradingGrantRow[]): string[] {
  return [...new Set(rows.map((row) => row.bindingId))];
}

export async function tradingCapabilityRoutes(
  app: FastifyInstance,
  db: Database,
  _plansConfig?: PlansConfig,
  redisClient?: Redis,
): Promise<void> {
  async function publishRuntimeRefresh(agentId: string, userId: string, reason: 'grant_changed' | 'binding_changed' | 'readiness_changed'): Promise<void> {
    if (!redisClient) {
      return;
    }

    const [agentRow] = await db
      .select({
        id: agents.id,
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
      .where(and(eq(agents.id, agentId), eq(agents.userId, userId)));

    if (!agentRow) {
      return;
    }

    const capabilityDescriptor = await resolveRuntimeCapabilityDescriptor(db, agentId, agentRow.skillIds ?? []);
    const runtimeDescriptor = buildRuntimeDescriptor({
      agentId,
      goal: agentRow.prompt,
      executionMode: agentRow.executionMode,
      toolPolicy: (agentRow.toolPolicy as Record<string, unknown> | null) ?? {},
      dailyTokenBudget: agentRow.dailyTokenBudget,
      dailyLossLimit: agentRow.dailyLossLimit,
      maxBots: agentRow.maxBots,
      maxSlippageBps: agentRow.maxSlippageBps,
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
        payload: { reason, runtimeDescriptor },
      }),
    );
  }

  app.get('/capabilities/trading', async (_request, reply) => {
    return reply.send({
      family: 'trading',
      description: 'Algorithmic trading across multiple venues',
      status: 'available',
      supportedActions: [...SUPPORTED_ACTIONS],
      providers: ['hyperliquid', 'jupiter', '1inch'],
      readinessStates: ['unconfigured', 'provisioning', 'ready', 'degraded', 'revoked'],
    });
  });

  app.get('/capabilities/trading/providers', async (_request, reply) => {
    return reply.send({
      providers: [
        { provider: 'hyperliquid', type: 'perpetuals', status: 'available' },
        { provider: 'jupiter', type: 'swap', status: 'available' },
        { provider: '1inch', type: 'swap', status: 'available' },
      ],
    });
  });

  app.get('/capabilities/trading/bindings', async (request, reply) => {
    const rows = await db
      .select({
        binding: tradingBindings,
        connection: {
          id: connections.id,
          provider: connections.provider,
          label: connections.label,
          status: connections.status,
        },
      })
      .from(tradingBindings)
      .innerJoin(connections, eq(tradingBindings.connectionId, connections.id))
      .where(eq(tradingBindings.userId, request.userId));

    return reply.send({
      family: 'trading',
      bindings: rows.map((row) => ({
        bindingId: row.binding.id,
        connectionId: row.connection.id,
        provider: row.binding.provider,
        label: row.binding.label,
        bindingRef: row.binding.bindingRef,
        bindingProfile: row.binding.bindingProfile ?? null,
        sourceVenueAccountId: row.binding.sourceVenueAccountId ?? null,
        connectionStatus: row.connection.status,
        status: row.binding.status,
        family: 'trading',
        createdAt: row.binding.createdAt.toISOString(),
        updatedAt: row.binding.updatedAt.toISOString(),
      })),
    });
  });

  app.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/capabilities/trading',
    async (request, reply) => {
      const { agentId } = request.params;

      const [agent] = await db
        .select({ id: agents.id, status: agents.status })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      const rows = await selectAgentTradingGrantRows(db, agentId);
      const effectiveReady = rows.some((row) => row.grantStatus === 'active' && row.bindingStatus === 'active' && row.connectionStatus === 'active');

      return reply.send({
        agentId,
        family: 'trading',
        agentStatus: agent.status,
        effectiveReady,
        supportedActions: [...SUPPORTED_ACTIONS],
      });
    },
  );

  app.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/capabilities/trading/state',
    async (request, reply) => {
      const { agentId } = request.params;

      const [agent] = await db
        .select({ id: agents.id, status: agents.status })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      const rows = await selectAgentTradingGrantRows(db, agentId);
      const bindingIds = allBindingIds(rows);
      if (bindingIds.length === 0) {
        return reply.send({
          agentId,
          family: 'trading',
          agentStatus: agent.status,
          totalPnl: '0',
          openPositionCount: 0,
          updatedAt: new Date().toISOString(),
        });
      }

      const botRows = await db
        .select({ id: bots.id })
        .from(bots)
        .where(inArray(bots.tradingBindingId, bindingIds));
      const botIds = botRows.map((bot) => bot.id);

      if (botIds.length === 0) {
        return reply.send({
          agentId,
          family: 'trading',
          agentStatus: agent.status,
          totalPnl: '0',
          openPositionCount: 0,
          updatedAt: new Date().toISOString(),
        });
      }

      const [pnlResult] = await db
        .select({ totalPnl: sum(positions.realizedPnl) })
        .from(positions)
        .where(and(eq(positions.actorType, 'bot'), inArray(positions.actorId, botIds)));

      const [openResult] = await db
        .select({ openCount: count(positions.id) })
        .from(positions)
        .where(and(eq(positions.actorType, 'bot'), inArray(positions.actorId, botIds), isNull(positions.closedAt)));

      return reply.send({
        agentId,
        family: 'trading',
        agentStatus: agent.status,
        totalPnl: parseFloat(pnlResult?.totalPnl ?? '0').toFixed(6),
        openPositionCount: openResult?.openCount ?? 0,
        updatedAt: new Date().toISOString(),
      });
    },
  );

  app.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/capabilities/trading/readiness',
    async (request, reply) => {
      const { agentId } = request.params;

      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      const rows = await selectAgentTradingGrantRows(db, agentId);
      if (rows.length === 0) {
        const readiness: CapabilityReadiness = {
          family: 'trading',
          state: 'unconfigured',
          bindingReadiness: 'unconfigured',
          agentEligibility: 'ineligible',
          effectiveReady: false,
          reasons: ['no grants have been created for this capability family'],
        };
        return reply.send(readiness);
      }

      const activeGrant = rows.find((row) => row.grantStatus === 'active' && row.bindingStatus === 'active' && row.connectionStatus === 'active');
      if (activeGrant) {
        const readiness: CapabilityReadiness = {
          family: 'trading',
          state: 'ready',
          bindingReadiness: 'ready',
          agentEligibility: 'eligible',
          effectiveReady: true,
          bindingId: activeGrant.bindingId,
          reasons: [],
        };
        return reply.send(readiness);
      }

      const first = chooseLatestGrant(rows);
      const { state, reasons } = deriveTradingReadiness(first.grantStatus, first.bindingStatus, first.connectionStatus);
      const readiness: CapabilityReadiness = {
        family: 'trading',
        state,
        bindingReadiness: state,
        agentEligibility: 'ineligible',
        effectiveReady: false,
        bindingId: first.bindingId,
        reasons,
      };
      return reply.send(readiness);
    },
  );

  app.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/capabilities/trading/bindings',
    async (request, reply) => {
      const { agentId } = request.params;

      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      const rows = await selectAgentTradingGrantRows(db, agentId);
      return reply.send({
        agentId,
        family: 'trading',
        bindings: latestGrantPerBinding(rows).map((row) => ({
          bindingId: row.bindingId,
          connectionId: row.connectionId,
          provider: row.provider,
          label: row.label,
          bindingRef: row.bindingRef,
          bindingProfile: row.bindingProfile,
          sourceVenueAccountId: row.sourceVenueAccountId,
          connectionStatus: row.connectionStatus,
          grantStatus: row.grantStatus,
          readiness: deriveTradingReadiness(row.grantStatus, row.bindingStatus, row.connectionStatus),
          grantedAt: row.grantedAt.toISOString(),
          revokedAt: row.revokedAt?.toISOString() ?? null,
          family: 'trading',
        })),
      });
    },
  );

  app.get<{ Params: { agentId: string; bindingId: string } }>(
    '/agents/:agentId/capabilities/trading/bindings/:bindingId',
    async (request, reply) => {
      const { agentId, bindingId } = request.params;

      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      const binding = await assertBindingOwnership(db, bindingId, request.userId);
      if (!binding) {
        return reply.status(404).send({ error: 'binding.not_found' });
      }

      const rows = (await selectAgentTradingGrantRows(db, agentId)).filter((row) => row.bindingId === bindingId);
      if (rows.length === 0) {
        return reply.status(404).send({ error: 'binding.not_found' });
      }

      const latestGrant = chooseLatestGrant(rows);
      return reply.send({
        bindingId: binding.id,
        connectionId: binding.connection.id,
        provider: binding.provider,
        label: binding.label,
        bindingRef: binding.bindingRef,
        bindingProfile: binding.bindingProfile ?? null,
        sourceVenueAccountId: binding.sourceVenueAccountId ?? null,
        connectionStatus: binding.connection.status,
        status: latestGrant.grantStatus,
        readiness: deriveTradingReadiness(latestGrant.grantStatus, latestGrant.bindingStatus, latestGrant.connectionStatus),
        grantedAt: latestGrant.grantedAt.toISOString(),
        revokedAt: latestGrant.revokedAt?.toISOString() ?? null,
        family: 'trading',
      });
    },
  );

  app.get<{ Params: { agentId: string; bindingId: string } }>(
    '/agents/:agentId/capabilities/trading/bindings/:bindingId/audit',
    async (request, reply) => {
      const { agentId, bindingId } = request.params;

      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      const rows = (await selectAgentTradingGrantRows(db, agentId)).filter((row) => row.bindingId === bindingId);
      if (rows.length === 0) {
        return reply.status(404).send({ error: 'binding.not_found' });
      }

      const auditEntries = await getBindingAudit(db, bindingId, agentId);
      return reply.send({ bindingId, audit: auditEntries });
    },
  );

  app.get<{
    Params: { agentId: string };
    Querystring: { limit?: string; offset?: string };
  }>(
    '/agents/:agentId/capabilities/trading/activity',
    async (request, reply) => {
      const { agentId } = request.params;
      const queryResult = TradingActivityQuerySchema.safeParse(request.query);
      if (!queryResult.success) {
        return reply.status(400).send({ error: 'validation_error', details: queryResult.error.issues });
      }
      const { limit, offset } = queryResult.data;
      const fetchCount = Math.min(limit + offset, MAX_ACTIVITY_WINDOW);

      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      const bindingIds = allBindingIds(await selectAgentTradingGrantRows(db, agentId));
      if (bindingIds.length === 0) {
        return reply.send({ agentId, family: 'trading', items: [], limit, offset });
      }

      const botRows = await db
        .select({ id: bots.id })
        .from(bots)
        .where(inArray(bots.tradingBindingId, bindingIds));
      const botIds = botRows.map((bot) => bot.id);

      if (botIds.length === 0) {
        return reply.send({ agentId, family: 'trading', items: [], limit, offset });
      }

      const [recentFills, recentEvents] = await Promise.all([
        db
          .select()
          .from(fills)
          .where(and(eq(fills.actorType, 'bot'), inArray(fills.actorId, botIds)))
          .orderBy(desc(fills.filledAt))
          .limit(fetchCount),
        db
          .select()
          .from(journalEvents)
          .where(inArray(journalEvents.actorId, botIds))
          .orderBy(desc(journalEvents.createdAt))
          .limit(fetchCount),
      ]);

      const fillItems = recentFills.map((f) => ({
        type: 'fill' as const,
        id: f.id,
        symbol: f.symbol,
        side: f.side,
        quantity: f.quantity,
        price: f.price,
        fee: f.fee ?? null,
        feeCurrency: f.feeCurrency ?? null,
        venueRefId: f.venueRefId ?? null,
        timestamp: f.filledAt.toISOString(),
      }));

      const eventItems = recentEvents.map((e) => ({
        type: 'event' as const,
        id: e.id,
        eventType: e.type,
        payload: e.payload,
        timestamp: e.createdAt.toISOString(),
      }));

      const items = [...fillItems, ...eventItems]
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(offset, offset + limit);

      return reply.send({ agentId, family: 'trading', items, limit, offset });
    },
  );

  app.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/capabilities/trading/outcomes',
    async (request, reply) => {
      const { agentId } = request.params;

      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      const bindingIds = allBindingIds(await selectAgentTradingGrantRows(db, agentId));
      if (bindingIds.length === 0) {
        return reply.send({
          agentId,
          family: 'trading',
          tradeCount: 0,
          totalPnl: '0',
          winRate: null,
          feesByCurrency: {},
          openPositionCount: 0,
        });
      }

      const botRows = await db
        .select({ id: bots.id })
        .from(bots)
        .where(inArray(bots.tradingBindingId, bindingIds));
      const botIds = botRows.map((bot) => bot.id);

      if (botIds.length === 0) {
        return reply.send({
          agentId,
          family: 'trading',
          tradeCount: 0,
          totalPnl: '0',
          winRate: null,
          feesByCurrency: {},
          openPositionCount: 0,
        });
      }

      const [fillCountResult, feeRows, pnlResult, openResult, allPositions] = await Promise.all([
        db
          .select({ tradeCount: count(fills.id) })
          .from(fills)
          .where(and(eq(fills.actorType, 'bot'), inArray(fills.actorId, botIds))),
        db
          .select({ feeCurrency: fills.feeCurrency, total: sum(fills.fee) })
          .from(fills)
          .where(and(eq(fills.actorType, 'bot'), inArray(fills.actorId, botIds)))
          .groupBy(fills.feeCurrency),
        db
          .select({ totalPnl: sum(positions.realizedPnl) })
          .from(positions)
          .where(and(eq(positions.actorType, 'bot'), inArray(positions.actorId, botIds))),
        db
          .select({ openCount: count(positions.id) })
          .from(positions)
          .where(and(eq(positions.actorType, 'bot'), inArray(positions.actorId, botIds), isNull(positions.closedAt))),
        db
          .select({ realizedPnl: positions.realizedPnl, closedAt: positions.closedAt })
          .from(positions)
          .where(and(eq(positions.actorType, 'bot'), inArray(positions.actorId, botIds))),
      ]);

      const feesByCurrency: Record<string, string> = {};
      for (const row of feeRows) {
        feesByCurrency[row.feeCurrency ?? 'unknown'] = row.total ?? '0';
      }

      const closed = allPositions.filter((p) => p.closedAt !== null);
      const winRate =
        closed.length >= 2
          ? closed.filter((p) => parseFloat(p.realizedPnl) > 0).length / closed.length
          : null;

      return reply.send({
        agentId,
        family: 'trading',
        tradeCount: fillCountResult[0]?.tradeCount ?? 0,
        totalPnl: parseFloat(pnlResult[0]?.totalPnl ?? '0').toFixed(6),
        winRate,
        feesByCurrency,
        openPositionCount: openResult[0]?.openCount ?? 0,
      });
    },
  );

  app.post<{ Params: { agentId: string; action: string } }>(
    '/agents/:agentId/capabilities/trading/actions/:action',
    async (request, reply) => {
      const { agentId, action } = request.params;

      if (!SUPPORTED_ACTIONS.includes(action as TradingAction)) {
        return reply.status(400).send({
          error: 'action.unsupported',
          message: `Unsupported action "${action}". Supported: ${SUPPORTED_ACTIONS.join(', ')}`,
        });
      }

      const [agent] = await db
        .select()
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      if (action === 'start') {
        const sessionId = crypto.randomUUID();
        const now = new Date();

        const result = await db.transaction(async (tx) => {
          if (agent.status !== 'stopped') {
            return { kind: 'not_stopped' as const };
          }

          const [claimed] = await tx
            .update(agents)
            .set({ status: 'starting', pauseState: null, updatedAt: now })
            .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId), eq(agents.status, 'stopped')))
            .returning({ id: agents.id });

          if (!claimed) {
            return { kind: 'not_stopped' as const };
          }

          await tx
            .update(agentRuntimeSessions)
            .set({ status: 'stopped', stoppedAt: now })
            .where(
              and(
                eq(agentRuntimeSessions.agentId, agentId),
                inArray(agentRuntimeSessions.status, ['starting', 'launching', 'running', 'unhealthy']),
              ),
            );

          await tx.insert(agentRuntimeSessions).values({
            id: sessionId,
            agentId,
            status: 'starting',
          });

          return { kind: 'started' as const };
        });

        if (result.kind === 'not_stopped') {
          return reply.status(409).send({ error: 'agent.not_stopped', message: 'Agent is not stopped' });
        }

        return reply.status(202).send({ action: 'start', agentId, status: 'starting', sessionId });
      }

      if (action === 'stop') {
        const now = new Date();
        await db.transaction(async (tx) => {
          await tx.update(agents).set({ status: 'stopped', pauseState: null, updatedAt: now }).where(eq(agents.id, agentId));
          await tx
            .update(agentRuntimeSessions)
            .set({ status: 'stopped', stoppedAt: now })
            .where(
              and(
                eq(agentRuntimeSessions.agentId, agentId),
                inArray(agentRuntimeSessions.status, ['starting', 'launching', 'running', 'unhealthy']),
              ),
            );
        });

        return reply.send({ action: 'stop', agentId, status: 'stopped' });
      }

      if (action === 'pause') {
        const parsed = PauseActionSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
        }

        if (agent.status === 'paused') {
          return reply.send({ action: 'pause', agentId, status: 'paused' });
        }

        await db
          .update(agents)
          .set({
            status: 'paused',
            pauseState: { reason: parsed.data.reason, requestedBy: 'user', pausedAt: new Date().toISOString() },
            updatedAt: new Date(),
          })
          .where(eq(agents.id, agentId));

        return reply.send({ action: 'pause', agentId, status: 'paused' });
      }

      if (action === 'resume') {
        if (agent.status !== 'paused') {
          return reply.status(409).send({ error: 'agent.not_paused', message: 'Agent is not paused' });
        }

        await db.update(agents).set({ status: 'active', pauseState: null, updatedAt: new Date() }).where(eq(agents.id, agentId));
        return reply.send({ action: 'resume', agentId, status: 'active' });
      }

      if (action === 'bind') {
        const parsed = BindActionSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
        }

        const binding = await assertBindingOwnership(db, parsed.data.bindingId, request.userId);
        if (!binding) {
          return reply.status(404).send({ error: 'binding.not_found' });
        }

        if (binding.status !== 'active' || binding.connection.status !== 'active') {
          return reply.status(409).send({
            error: 'binding.not_ready',
            message: 'Binding is not effectively ready',
          });
        }

        const existingGrant = (await selectAgentTradingGrantRows(db, agentId)).find(
          (row) => row.bindingId === parsed.data.bindingId && row.grantStatus === 'active',
        );
        if (existingGrant) {
          return reply.status(200).send({
            action: 'bind',
            agentId,
            family: 'trading',
            bindingId: parsed.data.bindingId,
            status: 'active',
          });
        }

        await createGrant(db, {
          agentId,
          bindingId: parsed.data.bindingId,
          capabilityFamily: 'trading',
          grantedBy: request.userId,
        });

        await publishRuntimeRefresh(agentId, request.userId, 'grant_changed').catch((err: unknown) => {
          app.log.warn({ err, agentId }, 'Failed to publish runtime refresh after bind');
        });

        return reply.status(201).send({
          action: 'bind',
          agentId,
          family: 'trading',
          bindingId: parsed.data.bindingId,
          status: 'active',
        });
      }

      if (action === 'unbind') {
        const parsed = UnbindActionSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
        }

        const grantRows = await selectAgentTradingGrantRows(db, agentId);
        const matchingGrant = grantRows.find((row) => row.bindingId === parsed.data.bindingId && row.grantStatus === 'active');
        if (!matchingGrant) {
          return reply.status(404).send({ error: 'binding.not_found' });
        }

        const revoked = await revokeGrant(db, {
          grantId: matchingGrant.grantId,
          actorType: 'user',
          actorId: request.userId,
        });

        if (!revoked) {
          return reply.status(409).send({ error: 'binding.already_revoked' });
        }

        await publishRuntimeRefresh(agentId, request.userId, 'grant_changed').catch((err: unknown) => {
          app.log.warn({ err, agentId }, 'Failed to publish runtime refresh after unbind');
        });

        return reply.send({
          action: 'unbind',
          bindingId: parsed.data.bindingId,
          agentId,
          status: 'revoked',
        });
      }

      return reply.status(500).send({ error: 'internal.unhandled_action' });
    },
  );
}
