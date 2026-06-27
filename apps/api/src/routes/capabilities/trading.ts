import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import { eq, and, desc, inArray, isNull, notInArray, sum, count, sql, or } from 'drizzle-orm';
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
  orders,
  agentRuntimeSessions,
} from '@herobids/db';
import type { CapabilityReadiness, ReadinessState, PlansConfig, RuntimeBudgetPolicy } from '@herobids/domain';
import { validateExecutionCapability, venueTypeFromProvider } from '@herobids/domain';
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

const TradingPositionsQuerySchema = z.object({
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

type TradingBindingResourceRow = {
  binding: typeof tradingBindings.$inferSelect;
  connection: {
    id: string;
    provider: string;
    label: string;
    status: string;
  };
};

const SUPPORTED_TRADING_PROVIDERS = ['hyperliquid', 'jupiter', '1inch', 'bybit'] as const;

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

/**
 * Fail-closed guard: returns open position symbols for an agent on the given
 * venue account. If non-empty, binding switches must be blocked.
 */
async function getOpenPositionSymbols(db: Database, agentId: string, venueAccountId: string): Promise<string[]> {
  const rows = await db
    .select({ symbol: positions.symbol })
    .from(positions)
    .where(
      and(
        eq(positions.actorType, 'agent'),
        eq(positions.actorId, agentId),
        eq(positions.venueAccountId, venueAccountId),
        sql`${positions.side} != 'flat'`,
        isNull(positions.closedAt),
      ),
    );
  return rows.map((r) => r.symbol);
}

const TERMINAL_ORDER_STATUSES = ['filled', 'cancelled', 'rejected'];

/**
 * Fail-closed guard: returns count of open (non-terminal) orders for an agent
 * on the given venue account. If > 0, binding switches must be blocked because
 * resting orders can fill after the switch and create untracked exposure.
 */
async function getOpenOrderCount(db: Database, agentId: string, venueAccountId: string): Promise<number> {
  const [result] = await db
    .select({ cnt: count() })
    .from(orders)
    .where(
      and(
        eq(orders.actorType, 'agent'),
        eq(orders.actorId, agentId),
        eq(orders.venueAccountId, venueAccountId),
        notInArray(orders.status, TERMINAL_ORDER_STATUSES),
      ),
    );
  return result?.cnt ?? 0;
}

/**
 * Find the currently effective binding for an agent (newest active grant).
 * Returns the grant row or undefined if no active binding exists.
 */
function findEffectiveGrant(grantRows: TradingGrantRow[]): TradingGrantRow | undefined {
  return grantRows
    .filter((r) => r.grantStatus === 'active')
    .sort((a, b) => b.grantedAt.getTime() - a.grantedAt.getTime())[0];
}

async function selectTradingBindingResourceRows(db: Database, userId: string): Promise<TradingBindingResourceRow[]> {
  return db
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
    .where(eq(tradingBindings.userId, userId));
}

export async function tradingCapabilityRoutes(
  app: FastifyInstance,
  db: Database,
  _plansConfig: PlansConfig | undefined,
  budgets: RuntimeBudgetPolicy,
  redisClient?: Redis,
): Promise<void> {
  async function publishRuntimeRefresh(agentId: string, userId: string, reason: 'grant_changed' | 'binding_changed' | 'readiness_changed'): Promise<void> {
    if (!redisClient) {
      return;
    }

    const [agentRow] = await db
      .select({
        id: agents.id,
        name: agents.name,
        prompt: agents.prompt,
        toolPolicy: agents.toolPolicy,
        executionMode: agents.executionMode,
        dailyLossLimit: agents.dailyLossLimit,
        maxBots: agents.maxBots,
        maxSlippageBps: agents.maxSlippageBps,
      })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.userId, userId)));

    if (!agentRow) {
      return;
    }

    const capabilityDescriptor = await resolveRuntimeCapabilityDescriptor(db, agentId);
    const runtimeDescriptor = buildRuntimeDescriptor({
      agentId,
      name: agentRow.name,
      goal: agentRow.prompt,
      executionMode: agentRow.executionMode,
      toolPolicy: (agentRow.toolPolicy as Record<string, unknown> | null) ?? {},
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
      providers: [...SUPPORTED_TRADING_PROVIDERS],
      readinessStates: ['unconfigured', 'provisioning', 'ready', 'degraded', 'revoked'],
    });
  });

  app.get('/capabilities/trading/providers', async (_request, reply) => {
    return reply.send({
      providers: [
        { provider: 'hyperliquid', type: 'perpetuals', status: 'available' },
        { provider: 'jupiter', type: 'swap', status: 'available' },
        { provider: '1inch', type: 'swap', status: 'available' },
        { provider: 'bybit', type: 'perpetuals', status: 'available' },
      ],
    });
  });

  app.get('/capabilities/trading/bindings', async (request, reply) => {
    const rows = await selectTradingBindingResourceRows(db, request.userId);

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

      const positionOwners = [
        and(eq(positions.actorType, 'agent'), eq(positions.actorId, agentId)),
      ];
      if (botIds.length > 0) {
        positionOwners.push(and(eq(positions.actorType, 'bot'), inArray(positions.actorId, botIds)));
      }

      const [pnlResult] = await db
        .select({ totalPnl: sum(positions.realizedPnl) })
        .from(positions)
        .where(or(...positionOwners));

      const [openResult] = await db
        .select({ openCount: count(positions.id) })
        .from(positions)
        .where(and(or(...positionOwners), isNull(positions.closedAt)));

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

      const fillOwners = [
        and(eq(fills.actorType, 'agent'), eq(fills.actorId, agentId)),
      ];
      const eventOwners = [
        and(eq(journalEvents.actorType, 'agent'), eq(journalEvents.actorId, agentId)),
      ];
      if (botIds.length > 0) {
        fillOwners.push(and(eq(fills.actorType, 'bot'), inArray(fills.actorId, botIds)));
        eventOwners.push(and(eq(journalEvents.actorType, 'bot'), inArray(journalEvents.actorId, botIds)));
      }

      const [recentFills, recentEvents] = await Promise.all([
        db
          .select()
          .from(fills)
          .where(or(...fillOwners))
          .orderBy(desc(fills.filledAt))
          .limit(fetchCount),
        db
          .select()
          .from(journalEvents)
          .where(or(...eventOwners))
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

      const fillOwners = [
        and(eq(fills.actorType, 'agent'), eq(fills.actorId, agentId)),
      ];
      const positionOwners = [
        and(eq(positions.actorType, 'agent'), eq(positions.actorId, agentId)),
      ];
      if (botIds.length > 0) {
        fillOwners.push(and(eq(fills.actorType, 'bot'), inArray(fills.actorId, botIds)));
        positionOwners.push(and(eq(positions.actorType, 'bot'), inArray(positions.actorId, botIds)));
      }

      const [fillCountResult, feeRows, pnlResult, openResult, allPositions] = await Promise.all([
        db
          .select({ tradeCount: count(fills.id) })
          .from(fills)
          .where(or(...fillOwners)),
        db
          .select({ feeCurrency: fills.feeCurrency, total: sum(fills.fee) })
          .from(fills)
          .where(or(...fillOwners))
          .groupBy(fills.feeCurrency),
        db
          .select({ totalPnl: sum(positions.realizedPnl) })
          .from(positions)
          .where(or(...positionOwners)),
        db
          .select({ openCount: count(positions.id) })
          .from(positions)
          .where(and(or(...positionOwners), isNull(positions.closedAt))),
        db
          .select({ realizedPnl: positions.realizedPnl, closedAt: positions.closedAt })
          .from(positions)
          .where(or(...positionOwners)),
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

  app.get<{
    Params: { agentId: string };
    Querystring: { limit?: string; offset?: string };
  }>(
    '/agents/:agentId/capabilities/trading/positions',
    async (request, reply) => {
      const { agentId } = request.params;
      const queryResult = TradingPositionsQuerySchema.safeParse(request.query);
      if (!queryResult.success) {
        return reply.status(400).send({ error: 'validation_error', details: queryResult.error.issues });
      }
      const { limit, offset } = queryResult.data;

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

      const positionOwners = [
        and(eq(positions.actorType, 'agent'), eq(positions.actorId, agentId)),
      ];
      if (botIds.length > 0) {
        positionOwners.push(and(eq(positions.actorType, 'bot'), inArray(positions.actorId, botIds)));
      }

      const positionRows = await db
        .select({
          id: positions.id,
          actorType: positions.actorType,
          actorId: positions.actorId,
          venue: positions.venue,
          symbol: positions.symbol,
          side: positions.side,
          size: positions.size,
          entryPrice: positions.entryPrice,
          realizedPnl: positions.realizedPnl,
          openedAt: positions.openedAt,
          closedAt: positions.closedAt,
          exitPrice: sql<string | null>`(
            SELECT ${fills.price}
            FROM ${fills}
            WHERE ${fills.actorType} = ${positions.actorType}
              AND ${fills.actorId} = ${positions.actorId}
              AND ${fills.venueAccountId} = ${positions.venueAccountId}
              AND ${fills.venue} = ${positions.venue}
              AND ${fills.symbol} = ${positions.symbol}
              AND ${fills.filledAt} <= ${positions.closedAt}
            ORDER BY ${fills.filledAt} DESC
            LIMIT 1
          )`,
        })
        .from(positions)
        .where(or(...positionOwners))
        .orderBy(desc(positions.openedAt))
        .limit(limit)
        .offset(offset);

      const items = positionRows.map((row) => {
        const isClosed = row.closedAt !== null;
        const holdMs = isClosed
          ? row.closedAt!.getTime() - row.openedAt.getTime()
          : null;
        return {
          id: row.id,
          symbol: row.symbol,
          venue: row.venue,
          side: row.side,
          size: row.size,
          entryPrice: row.entryPrice,
          exitPrice: isClosed ? (row.exitPrice ?? null) : null,
          realizedPnl: parseFloat(row.realizedPnl).toFixed(6),
          status: isClosed ? 'closed' : 'open',
          openedAt: row.openedAt.toISOString(),
          closedAt: row.closedAt?.toISOString() ?? null,
          holdMs,
        };
      });

      return reply.send({ agentId, family: 'trading', items, limit, offset });
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
        // Validate execution capability before starting
        if (agent.executionMode) {
          const grantRows = await selectAgentTradingGrantRows(db, agentId);
          const effectiveGrant = findEffectiveGrant(grantRows);
          if (effectiveGrant?.provider) {
            const startVenueType = venueTypeFromProvider(effectiveGrant.provider);
            if (startVenueType) {
              const capResult = validateExecutionCapability({
                actorType: 'agent',
                executionMode: agent.executionMode as 'paper' | 'shadow' | 'live',
                venueType: startVenueType,
              });
              if (!capResult.ok) {
                return reply.status(400).send({
                  error: `execution_capability.${capResult.error.code}`,
                  message: capResult.error.message,
                });
              }
            }
          }
        }

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

        // Validate execution capability: reject binding if agent mode + venue type is unsupported
        const bindingVenueType = venueTypeFromProvider(binding.provider);
        if (bindingVenueType && agent.executionMode) {
          const capResult = validateExecutionCapability({
            actorType: 'agent',
            executionMode: agent.executionMode as 'paper' | 'shadow' | 'live',
            venueType: bindingVenueType,
          });
          if (!capResult.ok) {
            return reply.status(400).send({
              error: `execution_capability.${capResult.error.code}`,
              message: capResult.error.message,
            });
          }
        }

        const allGrants = await selectAgentTradingGrantRows(db, agentId);
        const existingGrant = allGrants.find(
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

        // Fail-closed: reject binding switch when the effective venue account
        // would change while open positions or resting orders still exist on the
        // current account. Resting orders can fill after the switch and create
        // untracked exposure on an account the runtime no longer monitors.
        const effectiveGrant = findEffectiveGrant(allGrants);
        if (
          effectiveGrant
          && effectiveGrant.bindingId !== parsed.data.bindingId
          && effectiveGrant.sourceVenueAccountId
          && effectiveGrant.sourceVenueAccountId !== binding.sourceVenueAccountId
        ) {
          const openSymbols = await getOpenPositionSymbols(db, agentId, effectiveGrant.sourceVenueAccountId);
          if (openSymbols.length > 0) {
            return reply.status(409).send({
              error: 'binding.open_positions',
              message: 'Cannot switch binding while agent has open positions',
              symbols: openSymbols,
            });
          }
          const openOrderCnt = await getOpenOrderCount(db, agentId, effectiveGrant.sourceVenueAccountId);
          if (openOrderCnt > 0) {
            return reply.status(409).send({
              error: 'binding.open_orders',
              message: 'Cannot switch binding while agent has resting orders on the current venue account',
              openOrderCount: openOrderCnt,
            });
          }
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

        // Fail-closed: reject unbinding the effective binding when open positions
        // or resting orders exist. Orders can fill after unbind and create
        // exposure on an account the runtime no longer treats as effective.
        const effectiveGrant = findEffectiveGrant(grantRows);
        if (effectiveGrant && effectiveGrant.grantId === matchingGrant.grantId && matchingGrant.sourceVenueAccountId) {
          const openSymbols = await getOpenPositionSymbols(db, agentId, matchingGrant.sourceVenueAccountId);
          if (openSymbols.length > 0) {
            return reply.status(409).send({
              error: 'binding.open_positions',
              message: 'Cannot unbind while agent has open positions on this binding',
              symbols: openSymbols,
            });
          }
          const openOrderCnt = await getOpenOrderCount(db, agentId, matchingGrant.sourceVenueAccountId);
          if (openOrderCnt > 0) {
            return reply.status(409).send({
              error: 'binding.open_orders',
              message: 'Cannot unbind while agent has resting orders on this venue account',
              openOrderCount: openOrderCnt,
            });
          }
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
