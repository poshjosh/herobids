import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import { eq, and, inArray } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { deriveReadiness } from '@herobids/db';
import type { RuntimeAssignmentRow } from '@herobids/db';
import {
  agents,
  connections,
  agentConnectionAudit,
  agentConnections,
  agentRuntimeSessions,
} from '@herobids/db';
import type { PlansConfig, RuntimeBudgetPolicy } from '@herobids/domain';
import { getProviderIdsForRuntimeFamily, getRuntimeFamiliesForProvider, validateExecutionCapability, venueTypeFromProvider } from '@herobids/domain';
import type { TradertonClient, TradertonSubject } from '@herobids/domain/traderton';
import { z } from 'zod';
import { errorPayload } from '../../error-payload.js';
import {
  createTradertonReadBoundary,
  loadAgentEvidence,
  toFillRow,
  toJournalRow,
  toPositionRow,
  type FillRow as ReadFillRow,
  type JournalRow as ReadJournalRow,
  type PositionRow as ReadPositionRow,
  type ReadBoundaryError,
} from '../exports-traderton.js';
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

/** Fallback read deadline when the operator boundary timeout is not supplied. */
const DEFAULT_READ_TIMEOUT_MS = 10_000;

export async function tradingCapabilityRoutes(
  app: FastifyInstance,
  db: Database,
  _plansConfig: PlansConfig | undefined,
  _budgets: RuntimeBudgetPolicy,
  _redisClient?: Redis,
  tradertonReadClient?: TradertonClient,
  tradertonReadTimeoutMs?: number,
): Promise<void> {
  const readDeadlineMs = tradertonReadTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;

  /**
   * Build a read boundary bound to the requesting user's subject for an agent's
   * trading evidence. Returns null when the boundary is unconfigured so the
   * endpoint can surface a typed precondition (mandatory-boundary posture — no
   * local trading read). Mirrors `agentReadBoundary` in exports.ts.
   */
  const agentReadBoundary = (userId: string, agentId: string) => {
    if (!tradertonReadClient) return null;
    const subject: TradertonSubject = { ownerId: userId, actor: { type: 'agent', id: agentId } };
    return createTradertonReadBoundary(tradertonReadClient, subject, readDeadlineMs);
  };

  const boundaryUnconfiguredError: ReadBoundaryError = {
    status: 503,
    code: 'precondition.not_ready',
    message: 'Trading service is unavailable — the request could not be produced.',
  };

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

      const boundary = agentReadBoundary(request.userId, agentId);
      if (!boundary) {
        return reply.status(boundaryUnconfiguredError.status).send(
          errorPayload(boundaryUnconfiguredError.code, boundaryUnconfiguredError.message),
        );
      }
      const loaded = await loadAgentEvidence<ReadPositionRow>(
        boundary,
        'get_agent_positions',
        {},
        'positions',
        toPositionRow,
      );
      if (!loaded.ok) {
        return reply.status(loaded.error.status).send(
          errorPayload(loaded.error.code, loaded.error.message),
        );
      }
      const positionRows = loaded.rows;

      if (positionRows.length === 0) {
        return reply.send({
          agentId,
          family: 'trading',
          agentStatus: agent.status,
          totalPnl: '0',
          openPositionCount: 0,
          updatedAt: new Date().toISOString(),
        });
      }

      const totalPnl = positionRows.reduce((acc, p) => acc + parseFloat(p.realizedPnl), 0);
      const openPositionCount = positionRows.filter((p) => p.closedAt === null).length;

      return reply.send({
        agentId,
        family: 'trading',
        agentStatus: agent.status,
        totalPnl: totalPnl.toFixed(6),
        openPositionCount,
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

      const boundary = agentReadBoundary(request.userId, agentId);
      if (!boundary) {
        return reply.status(boundaryUnconfiguredError.status).send(
          errorPayload(boundaryUnconfiguredError.code, boundaryUnconfiguredError.message),
        );
      }
      const fillsLoaded = await loadAgentEvidence<ReadFillRow>(
        boundary,
        'get_agent_fills',
        {},
        'fills',
        toFillRow,
      );
      if (!fillsLoaded.ok) {
        return reply.status(fillsLoaded.error.status).send(
          errorPayload(fillsLoaded.error.code, fillsLoaded.error.message),
        );
      }
      const eventsLoaded = await loadAgentEvidence<ReadJournalRow>(
        boundary,
        'get_agent_journal_events',
        {},
        'events',
        toJournalRow,
      );
      if (!eventsLoaded.ok) {
        return reply.status(eventsLoaded.error.status).send(
          errorPayload(eventsLoaded.error.code, eventsLoaded.error.message),
        );
      }

      // The boundary returns ALL agent-scoped rows unordered. Reproduce the
      // previous per-source ordering (fills by filledAt desc, events by
      // createdAt desc) and the per-source fetch cap before the merge.
      const recentFills = fillsLoaded.rows
        .slice()
        .sort((a, b) => b.filledAt.getTime() - a.filledAt.getTime())
        .slice(0, fetchCount);
      const recentEvents = eventsLoaded.rows
        .slice()
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, fetchCount);

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

      const boundary = agentReadBoundary(request.userId, agentId);
      if (!boundary) {
        return reply.status(boundaryUnconfiguredError.status).send(
          errorPayload(boundaryUnconfiguredError.code, boundaryUnconfiguredError.message),
        );
      }
      const fillsLoaded = await loadAgentEvidence<ReadFillRow>(
        boundary,
        'get_agent_fills',
        {},
        'fills',
        toFillRow,
      );
      if (!fillsLoaded.ok) {
        return reply.status(fillsLoaded.error.status).send(
          errorPayload(fillsLoaded.error.code, fillsLoaded.error.message),
        );
      }
      const positionsLoaded = await loadAgentEvidence<ReadPositionRow>(
        boundary,
        'get_agent_positions',
        {},
        'positions',
        toPositionRow,
      );
      if (!positionsLoaded.ok) {
        return reply.status(positionsLoaded.error.status).send(
          errorPayload(positionsLoaded.error.code, positionsLoaded.error.message),
        );
      }
      const fillRows = fillsLoaded.rows;
      const positionRows = positionsLoaded.rows;

      if (fillRows.length === 0 && positionRows.length === 0) {
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

      // Group fills by fee currency, summing the fee decimals in-app (previously
      // a DB `sum(fee)` grouped by `feeCurrency`). Null currency → 'unknown'.
      const feeTotals: Record<string, number> = {};
      for (const row of fillRows) {
        const currency = row.feeCurrency ?? 'unknown';
        feeTotals[currency] = (feeTotals[currency] ?? 0) + parseFloat(row.fee ?? '0');
      }
      const feesByCurrency: Record<string, string> = {};
      for (const [currency, total] of Object.entries(feeTotals)) {
        feesByCurrency[currency] = String(total);
      }

      const totalPnl = positionRows.reduce((acc, p) => acc + parseFloat(p.realizedPnl), 0);
      const openPositionCount = positionRows.filter((p) => p.closedAt === null).length;

      const closed = positionRows.filter((p) => p.closedAt !== null);
      const winRate =
        closed.length >= 2
          ? closed.filter((p) => parseFloat(p.realizedPnl) > 0).length / closed.length
          : null;

      return reply.send({
        agentId,
        family: 'trading',
        tradeCount: fillRows.length,
        totalPnl: totalPnl.toFixed(6),
        winRate,
        feesByCurrency,
        openPositionCount,
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

      const boundary = agentReadBoundary(request.userId, agentId);
      if (!boundary) {
        return reply.status(boundaryUnconfiguredError.status).send(
          errorPayload(boundaryUnconfiguredError.code, boundaryUnconfiguredError.message),
        );
      }
      const positionsLoaded = await loadAgentEvidence<ReadPositionRow>(
        boundary,
        'get_agent_positions',
        {},
        'positions',
        toPositionRow,
      );
      if (!positionsLoaded.ok) {
        return reply.status(positionsLoaded.error.status).send(
          errorPayload(positionsLoaded.error.code, positionsLoaded.error.message),
        );
      }

      // No positions → no exitPrice reconstruction needed; skip the fills fetch.
      if (positionsLoaded.rows.length === 0) {
        return reply.send({ agentId, family: 'trading', items: [], limit, offset });
      }

      const fillsLoaded = await loadAgentEvidence<ReadFillRow>(
        boundary,
        'get_agent_fills',
        {},
        'fills',
        toFillRow,
      );
      if (!fillsLoaded.ok) {
        return reply.status(fillsLoaded.error.status).send(
          errorPayload(fillsLoaded.error.code, fillsLoaded.error.message),
        );
      }

      const allFills = fillsLoaded.rows;

      // Reproduce the previous `ORDER BY openedAt DESC` + limit/offset at the DB.
      const pagedPositions = positionsLoaded.rows
        .slice()
        .sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime())
        .slice(offset, offset + limit);

      /**
       * Reconstruct the correlated-subquery exitPrice in-app: the latest fill
       * (by filledAt) matching the position's actor/venueAccount/venue/symbol
       * with `filledAt <= closedAt`. Only closed positions carry an exitPrice.
       */
      const exitPriceFor = (position: ReadPositionRow): string | null => {
        if (position.closedAt === null) return null;
        const closedAtMs = position.closedAt.getTime();
        let latest: ReadFillRow | null = null;
        for (const fill of allFills) {
          if (
            fill.actorType === position.actorType &&
            fill.actorId === position.actorId &&
            fill.venueAccountId === position.venueAccountId &&
            fill.venue === position.venue &&
            fill.symbol === position.symbol &&
            fill.filledAt.getTime() <= closedAtMs
          ) {
            if (latest === null || fill.filledAt.getTime() > latest.filledAt.getTime()) {
              latest = fill;
            }
          }
        }
        return latest?.price ?? null;
      };

      const items = pagedPositions.map((row) => {
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
          exitPrice: isClosed ? exitPriceFor(row) : null,
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
        const agentExecMode: string | undefined = undefined;
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
