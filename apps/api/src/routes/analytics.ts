import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, inArray } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { agents, agentRuntimeSessions } from '@herobids/db';
import type { TradertonClient, TradertonSubject } from '@herobids/domain/traderton';
import { errorPayload } from '../error-payload.js';
import {
  createTradertonReadBoundary,
  loadAgentEvidence,
  loadBoundaryObject,
  toJournalRow,
  toPositionRow,
  type TradertonReadBoundary,
  type ReadBoundaryError,
  type JournalRow as ReadJournalRow,
  type PositionRow as ReadPositionRow,
} from './exports-traderton.js';

/** Fallback read deadline when the operator boundary timeout is not supplied. */
const DEFAULT_READ_TIMEOUT_MS = 10_000;

const boundaryUnconfiguredError = {
  status: 503,
  code: 'precondition.not_ready',
  message: 'Trading service is unavailable — the read could not be produced.',
} as const;

// --- Schemas ---

const AnalyticsQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  botIds: z.union([z.string(), z.array(z.string())]).optional().transform((v) =>
    v === undefined ? undefined : Array.isArray(v) ? v : [v],
  ),
  agentIds: z.union([z.string(), z.array(z.string())]).optional().transform((v) =>
    v === undefined ? undefined : Array.isArray(v) ? v : [v],
  ),
  decisionModes: z.preprocess(
    (v) => v === undefined ? undefined : (Array.isArray(v) ? v : [v]),
    z.array(z.enum(['mechanical', 'llm', 'hybrid'])).optional(),
  ),
  executionModes: z.preprocess(
    (v) => v === undefined ? undefined : (Array.isArray(v) ? v : [v]),
    z.array(z.enum(['paper', 'shadow', 'live'])).optional(),
  ),
  sessions: z.union([z.string(), z.array(z.string())]).optional().transform((v) =>
    v === undefined ? undefined : Array.isArray(v) ? v : [v],
  ),
  symbols: z.union([z.string(), z.array(z.string())]).optional().transform((v) =>
    v === undefined ? undefined : Array.isArray(v) ? v : [v],
  ),
  exitReasons: z.union([z.string(), z.array(z.string())]).optional().transform((v) =>
    v === undefined ? undefined : Array.isArray(v) ? v : [v],
  ),
  groupBy: z.enum(['day', 'week', 'session', 'strategy', 'symbol', 'exitReason']).optional().default('day'),
});

const AnalyticsBodySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  botIds: z.array(z.string()).optional(),
  agentIds: z.array(z.string()).optional(),
  decisionModes: z.array(z.enum(['mechanical', 'llm', 'hybrid'])).optional(),
  executionModes: z.array(z.enum(['paper', 'shadow', 'live'])).optional(),
  sessions: z.array(z.string()).optional(),
  symbols: z.array(z.string()).optional(),
  exitReasons: z.array(z.string()).optional(),
  groupBy: z.enum(['day', 'week', 'session', 'strategy', 'symbol', 'exitReason']).optional().default('day'),
});

type AnalyticsQuery = z.infer<typeof AnalyticsQuerySchema>;

type BotMeta = { id: string; executionMode: string | null; decisionMode: string | null; strategyType: string | null };
type SessionRange = { sessionId: string; start: number; end: number | null };
type GroupData = { period: string; eventCount: number; decisionCount: number; fillCount: number; realizedPnl: number };

type AnalyticsResult = { groupBy: AnalyticsQuery['groupBy']; groups: GroupData[] };

/** Row shape of `list_owner_bots` — the owner's bots with their creator provenance. */
type OwnerBotSummary = { id: string; creatorType?: string | null; creatorId?: string | null };

// --- Analytics computation ---
//
// Re-pointed for c4.2-analytics: the THREE trading reads (bot metadata, journal
// events, positions) now source over the Traderton read boundary instead of the
// local `bots`/`journalEvents`/`positions` tables. The `agents` +
// `agentRuntimeSessions` reads stay LOCAL (platform tables). The aggregation
// logic (filtering, grouping, PnL summation) is preserved VERBATIM — only the
// data source changed.

async function computeAnalytics(
  db: Database,
  boundary: TradertonReadBoundary,
  userId: string,
  query: AnalyticsQuery,
): Promise<{ ok: true; result: AnalyticsResult } | { ok: false; error: ReadBoundaryError }> {
  // 1. Fetch owner bots with config to extract executionMode and strategyPreset.
  //    Sourced over the boundary: list_owner_bots resolves the owner's bot ids +
  //    creator provenance; get_owner_bot_status fetches each bot's RAW config.
  //    (N+1 per the ruling — greenfield has few bots; strategyPreset from
  //    list_owner_bots is a lossy label, so the RAW config fields are required.)
  const listed = await loadAgentEvidence<OwnerBotSummary>(
    boundary, 'list_owner_bots', {}, 'bots', (r) => r as OwnerBotSummary,
  );
  if (!listed.ok) return { ok: false, error: listed.error };
  const ownerBotSummaries = listed.rows;

  const botMeta: BotMeta[] = [];
  for (const summary of ownerBotSummaries) {
    const statusResult = await loadBoundaryObject(boundary, 'get_owner_bot_status', { botId: summary.id });
    if (!statusResult.ok) return { ok: false, error: statusResult.error };
    const config = (statusResult.data['config'] as Record<string, unknown> | undefined) ?? {};
    const execution = config['execution'] as Record<string, unknown> | undefined;
    const strategy = config['strategy'] as Record<string, unknown> | undefined;
    botMeta.push({
      id: summary.id,
      executionMode: (execution?.['mode'] as string | undefined) ?? null,
      decisionMode: (strategy?.['decisionMode'] as string | undefined) ?? null,
      strategyType: (strategy?.['type'] as string | undefined) ?? null,
    });
  }

  // 2. Filter by botIds/agentIds. With no filters, include all user bots.
  const hasExplicitFilter = (query.botIds?.length ?? 0) > 0 || (query.agentIds?.length ?? 0) > 0;
  let targetMeta: BotMeta[] = hasExplicitFilter ? [] : botMeta;
  if (query.botIds && query.botIds.length > 0) {
    const requestedSet = new Set(query.botIds);
    targetMeta.push(...botMeta.filter((b) => requestedSet.has(b.id)));
  }

  // 3. Expand by agentIds — add bots managed by those agents (still user-scoped).
  //    The agents read stays LOCAL (platform table). The agent-managed bots are a
  //    subset of the owner's already-fetched bots, so they derive from the
  //    ownerBotSummaries' creatorType='agent' / creatorId provenance — no extra
  //    boundary call needed.
  if (query.agentIds && query.agentIds.length > 0) {
    const userAgentRows = await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.userId, userId), inArray(agents.id, query.agentIds)));
    const agentIdList = userAgentRows.map((a) => a.id);
    if (agentIdList.length > 0) {
      const agentIdSet = new Set(agentIdList);
      const agentBotIdSet = new Set(
        ownerBotSummaries
          .filter((b) => b.creatorType === 'agent' && b.creatorId !== null && b.creatorId !== undefined && agentIdSet.has(b.creatorId))
          .map((b) => b.id),
      );
      const existing = new Set(targetMeta.map((b) => b.id));
      for (const b of botMeta) {
        if (agentBotIdSet.has(b.id) && !existing.has(b.id)) {
          targetMeta.push(b);
          existing.add(b.id);
        }
      }
    }
  }

  // 4. Apply decisionModes filter — keep bots with matching strategy.decisionMode (mechanical|llm|hybrid)
  if (query.decisionModes && query.decisionModes.length > 0) {
    const modeSet = new Set(query.decisionModes);
    targetMeta = targetMeta.filter((b) =>
      b.decisionMode !== null && modeSet.has(b.decisionMode as 'mechanical' | 'llm' | 'hybrid')
    );
  }

  // 4b. Apply executionModes filter — keep bots with matching execution.mode (paper|shadow|live)
  if (query.executionModes && query.executionModes.length > 0) {
    const modeSet = new Set(query.executionModes);
    targetMeta = targetMeta.filter((b) =>
      b.executionMode !== null && modeSet.has(b.executionMode as 'paper' | 'shadow' | 'live')
    );
  }

  const targetBotIds = targetMeta.map((b) => b.id);
  if (targetBotIds.length === 0) return { ok: true, result: { groupBy: query.groupBy, groups: [] } };

  // 5. Resolve session ranges for filter / groupBy=session (LOCAL platform reads).
  let sessionRanges: SessionRange[] = [];
  const needsSessions = query.groupBy === 'session' || (query.sessions && query.sessions.length > 0);
  if (needsSessions) {
    if (query.sessions && query.sessions.length > 0) {
      // Scope to the user's own agents so arbitrary session IDs cannot affect another user's results.
      const ownedAgentIds = (await db.select({ id: agents.id }).from(agents)
        .where(eq(agents.userId, userId))).map((a) => a.id);
      const rows = ownedAgentIds.length > 0
        ? await db.select().from(agentRuntimeSessions)
            .where(and(
              inArray(agentRuntimeSessions.id, query.sessions),
              inArray(agentRuntimeSessions.agentId, ownedAgentIds),
            ))
        : [];
      sessionRanges = rows.map((s) => ({
        sessionId: s.id,
        start: s.startedAt.getTime(),
        end: s.stoppedAt ? s.stoppedAt.getTime() : null,
      }));
    } else {
      // groupBy=session — load all sessions for user's agents
      const userAgentIds = (await db.select({ id: agents.id }).from(agents)
        .where(eq(agents.userId, userId))).map((a) => a.id);
      if (userAgentIds.length > 0) {
        const rows = await db.select().from(agentRuntimeSessions)
          .where(inArray(agentRuntimeSessions.agentId, userAgentIds))
          .orderBy(agentRuntimeSessions.startedAt);
        sessionRanges = rows.map((s) => ({
          sessionId: s.id,
          start: s.startedAt.getTime(),
          end: s.stoppedAt ? s.stoppedAt.getTime() : null,
        }));
      }
    }
  }

  // 6. Fetch journal events over the boundary. The tool applies the botIds
  //    intersection + createdAt window + limit + desc order server-side —
  //    equivalent to the old local `.where(inArray + time).orderBy(desc).limit`.
  const journalLoaded = await loadAgentEvidence<ReadJournalRow>(
    boundary,
    'get_owner_journal',
    { botIds: targetBotIds, from: query.from, to: query.to, limit: 10_000 },
    'events',
    toJournalRow,
  );
  if (!journalLoaded.ok) return { ok: false, error: journalLoaded.error };
  const rawEvents = journalLoaded.rows;

  // Apply sessions filter if specific sessions were requested
  const filteredEvents = query.sessions && query.sessions.length > 0
    ? rawEvents.filter((e) => sessionRanges.some((sr) => {
        const t = e.createdAt.getTime();
        return t >= sr.start && (sr.end === null || t <= sr.end);
      }))
    : rawEvents;

  // 7. Fetch positions for PnL aggregation over the boundary. The tool applies
  //    the botIds intersection + closedAt window + limit server-side —
  //    equivalent to the old local positions query (actorType='bot' is applied
  //    inside the tool). closedAt is the field used for both time filter + grouping.
  const posLoaded = await loadAgentEvidence<ReadPositionRow>(
    boundary,
    'get_owner_positions',
    { botIds: targetBotIds, from: query.from, to: query.to, limit: 10_000 },
    'positions',
    toPositionRow,
  );
  if (!posLoaded.ok) return { ok: false, error: posLoaded.error };
  const rawPosRows = posLoaded.rows;

  // Apply the same session-range filter to positions that was applied to events.
  // Without this, a sessions=[...] query returns scoped event counts but unscoped PnL.
  const sessionFilteredPosRows = query.sessions && query.sessions.length > 0
    ? rawPosRows.filter((p) => p.closedAt && sessionRanges.some((sr) => {
        const t = p.closedAt!.getTime();
        return t >= sr.start && (sr.end === null || t <= sr.end);
      }))
    : rawPosRows;

  // Apply symbols filter — restrict to positions where symbol is in the requested set.
  const symbolFilteredPosRows = query.symbols && query.symbols.length > 0
    ? sessionFilteredPosRows.filter((p) => query.symbols!.includes(p.symbol))
    : sessionFilteredPosRows;

  // Apply exitReasons filter — restrict to positions whose exitReason matches.
  // Open positions (exitReason = null) never match an exitReasons filter.
  const posRows = query.exitReasons && query.exitReasons.length > 0
    ? symbolFilteredPosRows.filter((p) => p.exitReason && query.exitReasons!.includes(p.exitReason))
    : symbolFilteredPosRows;

  // 8. groupKey function covering all four modes
  const botStrategyMap = new Map(targetMeta.map((b) => [b.id, b.strategyType ?? 'unknown']));

  const groupKey = (createdAt: Date, actorId: string | null, symbol?: string | null, exitReason?: string | null): string => {
    switch (query.groupBy) {
      case 'week': {
        const d = new Date(createdAt);
        const day = d.getUTCDay();
        const diff = (day === 0 ? -6 : 1) - day;
        d.setUTCDate(d.getUTCDate() + diff);
        return d.toISOString().slice(0, 10);
      }
      case 'strategy':
        return botStrategyMap.get(actorId ?? '') ?? 'unknown';
      case 'symbol':
        return symbol ?? 'unknown';
      case 'exitReason':
        return exitReason ?? 'unknown';
      case 'session': {
        const t = createdAt.getTime();
        const match = sessionRanges.find((sr) =>
          t >= sr.start && (sr.end === null || t <= sr.end),
        );
        return match?.sessionId ?? 'no_session';
      }
      default: // day
        return createdAt.toISOString().slice(0, 10);
    }
  };

  // 9. Aggregate events and positions into groups
  const groups: Record<string, GroupData> = {};

  // Journal events lack symbol and exitReason columns.
  // Skip the event loop when:
  //   - groupBy is 'symbol' or 'exitReason' (events can't be grouped by these)
  //   - symbols or exitReasons filters are active (events can't be filtered by these)
  // In both cases, event/decision/fill counts are left at 0 and only position P&L
  // is aggregated. This avoids mixing filtered P&L with unfiltered activity counts.
  const positionOnlyGroupBy = query.groupBy === 'symbol' || query.groupBy === 'exitReason';
  const hasPositionOnlyFilter = (query.symbols?.length ?? 0) > 0 || (query.exitReasons?.length ?? 0) > 0;
  const shouldSkipEvents = positionOnlyGroupBy || hasPositionOnlyFilter;

  if (!shouldSkipEvents) {
    for (const e of filteredEvents) {
      const period = groupKey(e.createdAt, e.actorId);
      if (!groups[period]) {
        groups[period] = { period, eventCount: 0, decisionCount: 0, fillCount: 0, realizedPnl: 0 };
      }
      groups[period].eventCount++;
      if (e.type.startsWith('decision.')) groups[period].decisionCount++;
      if (e.type.startsWith('order.fill') || e.type === 'fill.recorded') groups[period].fillCount++;
    }
  }

  for (const p of posRows) {
    if (!p.closedAt) continue;
    const period = groupKey(p.closedAt, p.actorId, p.symbol, p.exitReason);
    if (!groups[period]) {
      groups[period] = { period, eventCount: 0, decisionCount: 0, fillCount: 0, realizedPnl: 0 };
    }
    groups[period].realizedPnl += parseFloat(p.realizedPnl ?? '0');
  }

  const sortedGroups = Object.values(groups).sort((a, b) => a.period.localeCompare(b.period));
  return { ok: true, result: { groupBy: query.groupBy, groups: sortedGroups } };
}

// --- Route module ---

export async function analyticsRoutes(
  app: FastifyInstance,
  db: Database,
  tradertonReadClient?: TradertonClient,
  tradertonReadTimeoutMs?: number,
): Promise<void> {
  const readDeadlineMs = tradertonReadTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;

  // GET /analytics — query analytics via URL params
  app.get<{ Querystring: unknown }>('/analytics', async (request, reply) => {
    const parsed = AnalyticsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    if (!tradertonReadClient) {
      return reply.status(boundaryUnconfiguredError.status).send(
        errorPayload(boundaryUnconfiguredError.code, boundaryUnconfiguredError.message),
      );
    }
    const subject: TradertonSubject = { ownerId: request.userId, actor: { type: 'user', id: request.userId } };
    const boundary = createTradertonReadBoundary(tradertonReadClient, subject, readDeadlineMs);

    const computed = await computeAnalytics(db, boundary, request.userId, parsed.data);
    if (!computed.ok) {
      return reply.status(computed.error.status).send(errorPayload(computed.error.code, computed.error.message));
    }
    return reply.send(computed.result);
  });

  // POST /analytics/query — same as GET but via JSON body for complex queries
  app.post<{ Body: unknown }>('/analytics/query', async (request, reply) => {
    const parsed = AnalyticsBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    if (!tradertonReadClient) {
      return reply.status(boundaryUnconfiguredError.status).send(
        errorPayload(boundaryUnconfiguredError.code, boundaryUnconfiguredError.message),
      );
    }
    const subject: TradertonSubject = { ownerId: request.userId, actor: { type: 'user', id: request.userId } };
    const boundary = createTradertonReadBoundary(tradertonReadClient, subject, readDeadlineMs);

    const computed = await computeAnalytics(db, boundary, request.userId, parsed.data);
    if (!computed.ok) {
      return reply.status(computed.error.status).send(errorPayload(computed.error.code, computed.error.message));
    }
    return reply.send(computed.result);
  });
}
