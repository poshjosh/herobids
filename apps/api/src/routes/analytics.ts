import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, inArray, gte, lte, desc } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { journalEvents, positions, bots, agents, agentRuntimeSessions } from '@herobids/db';

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

// --- Analytics computation ---

async function computeAnalytics(db: Database, userId: string, query: AnalyticsQuery) {
  // 1. Fetch user bots with config to extract executionMode and strategyPreset
  const userBotRows = await db.select({ id: bots.id, config: bots.config })
    .from(bots).where(eq(bots.userId, userId));

  const botMeta: BotMeta[] = userBotRows.map((b) => {
    const config = b.config as Record<string, unknown>;
    const execution = config['execution'] as Record<string, unknown> | undefined;
    const strategy = config['strategy'] as Record<string, unknown> | undefined;
    return {
      id: b.id,
      executionMode: (execution?.['mode'] as string | undefined) ?? null,
      decisionMode: (strategy?.['decisionMode'] as string | undefined) ?? null,
      strategyType: (strategy?.['type'] as string | undefined) ?? null,
    };
  });

  // 2. Filter by botIds/agentIds. With no filters, include all user bots.
  const hasExplicitFilter = (query.botIds?.length ?? 0) > 0 || (query.agentIds?.length ?? 0) > 0;
  let targetMeta: BotMeta[] = hasExplicitFilter ? [] : botMeta;
  if (query.botIds && query.botIds.length > 0) {
    const requestedSet = new Set(query.botIds);
    targetMeta.push(...botMeta.filter((b) => requestedSet.has(b.id)));
  }

  // 3. Expand by agentIds — add bots managed by those agents (still user-scoped)
  if (query.agentIds && query.agentIds.length > 0) {
    const userAgentRows = await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.userId, userId), inArray(agents.id, query.agentIds)));
    const agentIdList = userAgentRows.map((a) => a.id);
    if (agentIdList.length > 0) {
      const agentBotRows = await db.select({ id: bots.id }).from(bots)
        .where(and(eq(bots.creatorType, 'agent'), inArray(bots.creatorId, agentIdList)));
      const agentBotIdSet = new Set(agentBotRows.map((b) => b.id));
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
  if (targetBotIds.length === 0) return { groupBy: query.groupBy, groups: [] };

  // 5. Resolve session ranges for filter / groupBy=session
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

  // 6. Fetch journal events
  const timeConditions = [];
  if (query.from) timeConditions.push(gte(journalEvents.createdAt, new Date(query.from)));
  if (query.to) timeConditions.push(lte(journalEvents.createdAt, new Date(query.to)));

  const rawEvents = await db.select().from(journalEvents)
    .where(and(inArray(journalEvents.actorId, targetBotIds), ...timeConditions))
    .orderBy(desc(journalEvents.createdAt))
    .limit(10_000);

  // Apply sessions filter if specific sessions were requested
  const filteredEvents = query.sessions && query.sessions.length > 0
    ? rawEvents.filter((e) => sessionRanges.some((sr) => {
        const t = e.createdAt.getTime();
        return t >= sr.start && (sr.end === null || t <= sr.end);
      }))
    : rawEvents;

  // 7. Fetch positions for PnL aggregation.
  // Filter by closedAt (same field used for grouping) so the time window is consistent.
  const rawPosRows = await db.select().from(positions)
    .where(and(
      eq(positions.actorType, 'bot'),
      inArray(positions.actorId, targetBotIds),
      ...(query.from ? [gte(positions.closedAt, new Date(query.from))] : []),
      ...(query.to ? [lte(positions.closedAt, new Date(query.to))] : []),
    ))
    .limit(10_000);

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

  // Journal events lack a symbol or exitReason column.
  // Skip the event loop for groupBy modes that rely on position-only columns:
  //   - 'symbol': events don't carry symbol
  //   - 'exitReason': events don't carry exit reason; running the loop would bucket
  //     every event into 'unknown', producing a misleading synthetic bucket.
  // For these modes, fillCount is derived from closed positions instead.
  const eventModes = new Set(['day', 'week', 'session', 'strategy']);
  if (eventModes.has(query.groupBy)) {
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
    // Each closed position implies at least one fill — use this for fillCount
    // when the event loop is skipped (symbol / exitReason modes).
    if (!eventModes.has(query.groupBy)) {
      groups[period].fillCount++;
    }
    groups[period].realizedPnl += parseFloat(p.realizedPnl ?? '0');
  }

  const sortedGroups = Object.values(groups).sort((a, b) => a.period.localeCompare(b.period));
  return { groupBy: query.groupBy, groups: sortedGroups };
}

// --- Route module ---

export async function analyticsRoutes(app: FastifyInstance, db: Database): Promise<void> {
  // GET /analytics — query analytics via URL params
  app.get<{ Querystring: unknown }>('/analytics', async (request, reply) => {
    const parsed = AnalyticsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const result = await computeAnalytics(db, request.userId, parsed.data);
    return reply.send(result);
  });

  // POST /analytics/query — same as GET but via JSON body for complex queries
  app.post<{ Body: unknown }>('/analytics/query', async (request, reply) => {
    const parsed = AnalyticsBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const result = await computeAnalytics(db, request.userId, parsed.data);
    return reply.send(result);
  });
}
