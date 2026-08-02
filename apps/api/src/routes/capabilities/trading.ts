import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import { eq, and, desc, inArray, isNull, sum, count, sql, or } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { deriveReadiness } from '@herobids/db';
import type { RuntimeAssignmentRow } from '@herobids/db';
import {
  agents,
  connections,
  agentConnectionAudit,
  agentConnections,
  bots,
  fills,
  journalEvents,
  positions,
  agentRuntimeSessions,
} from '@herobids/db';
import type { PlansConfig, RuntimeBudgetPolicy } from '@herobids/domain';
import { getProviderIdsForRuntimeFamily, getRuntimeFamiliesForProvider, validateExecutionCapability, venueTypeFromProvider } from '@herobids/domain';
import { z } from 'zod';
const SUPPORTED_ACTIONS = ['start', 'stop', 'pause', 'resume'] as const;
type TradingAction = typeof SUPPORTED_ACTIONS[number];

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

type TradingAssignmentRow = RuntimeAssignmentRow & {
  id: string;
  revokedAt: Date | null;
};

type TradingConnectionResourceRow = {
  id: string;
  userId: string;
  credentialId: string | null;
  provider: string;
  label: string;
  status: string;
  providerRef: string | null;
  profile: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
};

const SUPPORTED_TRADING_PROVIDERS = ['hyperliquid', 'jupiter', '1inch', 'bybit'] as const;

function chooseLatestAssignment(rows: TradingAssignmentRow[]): TradingAssignmentRow | undefined {
  if (rows.length === 0) {
    return undefined;
  }
  return rows.slice().sort((left, right) => {
    const grantedAtDelta = right.grantedAt.getTime() - left.grantedAt.getTime();
    if (grantedAtDelta !== 0) {
      return grantedAtDelta;
    }
    return right.id.localeCompare(left.id);
  })[0];
}

async function selectAgentTradingAssignmentRows(db: Database, agentId: string): Promise<TradingAssignmentRow[]> {
  const rows = await db
    .select({
      id: agentConnections.id,
      assignmentId: agentConnections.id,
      grantStatus: agentConnections.status,
      grantedAt: agentConnections.grantedAt,
      revokedAt: agentConnections.revokedAt,
      connectionId: connections.id,
      connectionStatus: connections.status,
      providerRef: connections.providerRef,
      profile: connections.profile,
      provider: connections.provider,
      label: connections.label,
      resolvedVenueAccountId: connections.resolvedVenueAccountId,
    })
    .from(agentConnections)
    .innerJoin(connections, eq(agentConnections.connectionId, connections.id))
    .where(and(
      eq(agentConnections.agentId, agentId),
      inArray(connections.provider, getProviderIdsForRuntimeFamily('trading')),
    ));

  return rows.map((row) => ({
    ...row,
    capabilities: getRuntimeFamiliesForProvider(row.provider),
  }));
}

function latestAssignmentPerConnection(rows: TradingAssignmentRow[]): TradingAssignmentRow[] {
  const sorted = rows.slice().sort((left, right) => {
    const grantedAtDelta = right.grantedAt.getTime() - left.grantedAt.getTime();
    if (grantedAtDelta !== 0) {
      return grantedAtDelta;
    }
    return right.id.localeCompare(left.id);
  });

  const seen = new Set<string>();
  const latest: TradingAssignmentRow[] = [];
  for (const row of sorted) {
    if (seen.has(row.connectionId)) {
      continue;
    }
    seen.add(row.connectionId);
    latest.push(row);
  }
  return latest;
}

function allConnectionIds(rows: TradingAssignmentRow[]): string[] {
  return [...new Set(rows.map((row) => row.connectionId))];
}

/**
 * Find the currently effective assignment for an agent (newest active assignment).
 * Returns the assignment row or undefined if no active assignment exists.
 */
function findEffectiveAssignment(rows: TradingAssignmentRow[]): TradingAssignmentRow | undefined {
  return rows
    .filter((r) => r.grantStatus === 'active')
    .sort((a, b) => b.grantedAt.getTime() - a.grantedAt.getTime())[0];
}

async function selectTradingConnectionResourceRows(db: Database, userId: string): Promise<TradingConnectionResourceRow[]> {
  return db
    .select()
    .from(connections)
    .where(eq(connections.userId, userId));
}

export async function tradingCapabilityRoutes(
  app: FastifyInstance,
  db: Database,
  _plansConfig: PlansConfig | undefined,
  _budgets: RuntimeBudgetPolicy,
  _redisClient?: Redis,
): Promise<void> {
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

  app.get('/capabilities/trading/connections', async (request, reply) => {
    const rows = await selectTradingConnectionResourceRows(db, request.userId);

    return reply.send({
      family: 'trading',
      connections: rows.map((row) => ({
        connectionId: row.id,
        provider: row.provider,
        label: row.label,
        providerRef: row.providerRef,
        profile: row.profile ?? null,
        status: row.status,
        family: 'trading',
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
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

      const rows = await selectAgentTradingAssignmentRows(db, agentId);
      const effectiveReady = rows.some((row) =>
        row.grantStatus === 'active' &&
        row.connectionStatus === 'active' &&
        row.resolvedVenueAccountId !== null,
      );

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

      const rows = await selectAgentTradingAssignmentRows(db, agentId);
      const connectionIds = allConnectionIds(rows);
      if (connectionIds.length === 0) {
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
        .where(inArray(bots.connectionId, connectionIds));
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

      const rows = await selectAgentTradingAssignmentRows(db, agentId);
      // Active assignments take precedence.
      const activeRows = rows.filter((r) => r.grantStatus === 'active');
      if (activeRows.length > 0) {
        const latest = chooseLatestAssignment(activeRows)!;
        return reply.send(deriveReadiness(latest, 'trading'));
      }
      // Surface 'revoked' only when the connection itself was revoked. If only
      // the agent grant was removed (PATCH connectionIds: []), return 'unconfigured'.
      const connectionRevokedRows = rows.filter((r) => r.connectionStatus === 'revoked');
      const latest = chooseLatestAssignment(connectionRevokedRows);
      return reply.send(deriveReadiness(latest, 'trading'));
    },
  );

  app.get<{ Params: { agentId: string } }>(
    '/agents/:agentId/capabilities/trading/connections',
    async (request, reply) => {
      const { agentId } = request.params;

      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      const rows = await selectAgentTradingAssignmentRows(db, agentId);
      return reply.send({
        agentId,
        family: 'trading',
        connections: latestAssignmentPerConnection(rows).map((row) => ({
          connectionId: row.connectionId,
          provider: row.provider,
          label: row.label,
          providerRef: row.providerRef,
          profile: row.profile,
          connectionStatus: row.connectionStatus,
          grantStatus: row.grantStatus,
          readiness: deriveReadiness(row, 'trading'),
          grantedAt: row.grantedAt.toISOString(),
          revokedAt: row.revokedAt?.toISOString() ?? null,
          family: 'trading',
        })),
      });
    },
  );

  app.get<{ Params: { agentId: string; connectionId: string } }>(
    '/agents/:agentId/capabilities/trading/connections/:connectionId',
    async (request, reply) => {
      const { agentId, connectionId } = request.params;

      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      const [conn] = await db
        .select()
        .from(connections)
        .where(and(eq(connections.id, connectionId), eq(connections.userId, request.userId)));
      if (!conn) {
        return reply.status(404).send({ error: 'connection.not_found' });
      }

      const rows = (await selectAgentTradingAssignmentRows(db, agentId)).filter((row) => row.connectionId === connectionId);
      if (rows.length === 0) {
        return reply.status(404).send({ error: 'connection.not_found' });
      }

      const latestAssignment = chooseLatestAssignment(rows)!;
      return reply.send({
        connectionId: conn.id,
        provider: conn.provider,
        label: conn.label,
        providerRef: conn.providerRef,
        profile: conn.profile ?? null,
        connectionStatus: conn.status,
        status: latestAssignment.grantStatus,
        readiness: deriveReadiness(latestAssignment, 'trading'),
        grantedAt: latestAssignment.grantedAt.toISOString(),
        revokedAt: latestAssignment.revokedAt?.toISOString() ?? null,
        family: 'trading',
      });
    },
  );

  app.get<{ Params: { agentId: string; connectionId: string } }>(
    '/agents/:agentId/capabilities/trading/connections/:connectionId/audit',
    async (request, reply) => {
      const { agentId, connectionId } = request.params;

      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.userId, request.userId)));
      if (!agent) {
        return reply.status(404).send({ error: 'agent.not_found' });
      }

      const rows = (await selectAgentTradingAssignmentRows(db, agentId)).filter((row) => row.connectionId === connectionId);
      if (rows.length === 0) {
        return reply.status(404).send({ error: 'connection.not_found' });
      }

      const acIds = rows.map((row) => row.id);

      let auditEntries: typeof agentConnectionAudit.$inferSelect[] = [];
      if (acIds.length > 0) {
        auditEntries = await db
          .select()
          .from(agentConnectionAudit)
          .where(inArray(agentConnectionAudit.agentConnectionId, acIds))
          .orderBy(agentConnectionAudit.createdAt);
      }

      return reply.send({ connectionId, audit: auditEntries });
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

      const connectionIds = allConnectionIds(await selectAgentTradingAssignmentRows(db, agentId));
      if (connectionIds.length === 0) {
        return reply.send({ agentId, family: 'trading', items: [], limit, offset });
      }

      const botRows = await db
        .select({ id: bots.id })
        .from(bots)
        .where(inArray(bots.connectionId, connectionIds));
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

      const connectionIds = allConnectionIds(await selectAgentTradingAssignmentRows(db, agentId));
      if (connectionIds.length === 0) {
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
        .where(inArray(bots.connectionId, connectionIds));
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

      const connectionIds = allConnectionIds(await selectAgentTradingAssignmentRows(db, agentId));
      if (connectionIds.length === 0) {
        return reply.send({ agentId, family: 'trading', items: [], limit, offset });
      }

      const botRows = await db
        .select({ id: bots.id })
        .from(bots)
        .where(inArray(bots.connectionId, connectionIds));
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
        const agentExecMode = (agent.executionDefaults as Record<string, unknown> | null)?.['mode'] as string | undefined;
        if (agentExecMode) {
          const assignmentRows = await selectAgentTradingAssignmentRows(db, agentId);
          const effectiveAssignment = findEffectiveAssignment(assignmentRows);
          if (effectiveAssignment?.provider) {
            const startVenueType = venueTypeFromProvider(effectiveAssignment.provider);
            if (startVenueType) {
              const capResult = validateExecutionCapability({
                actorType: 'agent',
                executionMode: agentExecMode as 'paper' | 'shadow' | 'live',
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

      return reply.status(500).send({ error: 'internal.unhandled_action' });
    },
  );
}
