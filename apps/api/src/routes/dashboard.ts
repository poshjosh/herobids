import type { FastifyInstance } from 'fastify';
import { eq, and, inArray, notInArray, desc } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import {
  users,
  agents,
  agentMessages,
  agentRuntimeSessions,
} from '@herobids/db';
import type { PlansConfig } from '@herobids/domain';
import type { TradertonClient, TradertonSubject } from '@herobids/domain/traderton';
import { DashboardActivityQuerySchema } from '../schemas.js';
import { errorPayload } from '../error-payload.js';
import {
  createTradertonReadBoundary,
  loadAgentEvidence,
  loadBoundaryObject,
  toJournalRow,
  toPositionRow,
  type TradertonReadBoundary,
  type JournalRow as ReadJournalRow,
  type PositionRow as ReadPositionRow,
} from './exports-traderton.js';
import {
  mapProtocolMessage,
  mapRuntimeSession,
  isSuppressedProtocolMessageType,
  SUPPRESSED_PROTOCOL_MESSAGE_TYPES,
  resolveSessionStopReasons,
} from './agent-activity-mapper.js';
import type { AgentActivityEntry } from './agent-activity-types.js';

/** Fallback read deadline when the operator boundary timeout is not supplied. */
const DEFAULT_READ_TIMEOUT_MS = 10_000;

/** Returned when the trading read boundary is not configured — mirrors analytics.ts. */
const boundaryUnconfiguredError = {
  status: 503,
  code: 'precondition.not_ready',
  message: 'Trading service is unavailable — the read could not be produced.',
} as const;

/** Row shape of `list_owner_bots` (venueAccountId/startedAt/stoppedAt are newly added). */
type OwnerBotRow = {
  id: string;
  status: string;
  strategyPreset?: string | null;
  symbol?: string | null;
  createdAt: string;
  creatorType?: string | null;
  creatorId?: string | null;
  venueAccountId?: string | null;
  startedAt?: string | null;
  stoppedAt?: string | null;
};

/** Venue account display fields resolved via `get_venue_account`. */
type VenueAccountView = { venueAccountRef: string; venue: string; label: string };

// ---------------------------------------------------------------------------
// Event categorisation helpers — maps canonical journal event types to a
// user-facing category, severity, and plain-language message template.
// ---------------------------------------------------------------------------

type EventCategory = 'decision' | 'execution' | 'risk' | 'system';
type EventSeverity = 'info' | 'warn' | 'critical';

interface EventMeta {
  category: EventCategory;
  severity: EventSeverity;
}

const EVENT_META: Record<string, EventMeta> = {
  'decision.accepted': {
    category: 'decision',
    severity: 'info',
  },
  'decision.rejected': {
    category: 'risk',
    severity: 'warn',
  },
  'risk.breach': {
    category: 'risk',
    severity: 'critical',
  },
  'risk.guardrail_triggered': {
    category: 'risk',
    severity: 'warn',
  },
  'order.submitted': {
    category: 'execution',
    severity: 'info',
  },
  'order.filled': {
    category: 'execution',
    severity: 'info',
  },
  'order.fill_confirmed_from_stream': {
    category: 'execution',
    severity: 'info',
  },
  'order.cancelled': {
    category: 'execution',
    severity: 'info',
  },
  'order.rejected': {
    category: 'execution',
    severity: 'warn',
  },
  'instance.started': {
    category: 'system',
    severity: 'info',
  },
  'instance.stopped': {
    category: 'system',
    severity: 'info',
  },
  'instance.crashed': {
    category: 'system',
    severity: 'critical',
  },
  'instance.live_armed': {
    category: 'system',
    severity: 'warn',
  },
  'instance.live_blocked': {
    category: 'system',
    severity: 'warn',
  },
  'reconciliation.drift_detected': {
    category: 'system',
    severity: 'warn',
  },
  'reconciliation.observed_variance': {
    category: 'system',
    severity: 'info',
  },
  'live.slippage_alert': {
    category: 'execution',
    severity: 'warn',
  },
};

function classifyEvent(type: string, _payload: Record<string, unknown>): { category: EventCategory; severity: EventSeverity } {
  const meta = EVENT_META[type];
  if (meta) {
    return { category: meta.category, severity: meta.severity };
  }
  // Fallback: infer category from type prefix
  const prefix = type.split('.')[0] ?? '';
  const category: EventCategory =
    prefix === 'decision' ? 'decision' :
    prefix === 'risk' ? 'risk' :
    prefix === 'order' || prefix === 'fill' ? 'execution' :
    'system';
  return { category, severity: 'info' };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export async function dashboardRoutes(
  app: FastifyInstance,
  db: Database,
  plansConfig?: PlansConfig,
  tradertonReadClient?: TradertonClient,
  tradertonReadTimeoutMs?: number,
): Promise<void> {
  const readDeadlineMs = tradertonReadTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;

  /** Build a read boundary bound to the requesting user's actor subject. */
  const userBoundary = (userId: string): TradertonReadBoundary => {
    const subject: TradertonSubject = { ownerId: userId, actor: { type: 'user', id: userId } };
    return createTradertonReadBoundary(tradertonReadClient!, subject, readDeadlineMs);
  };

  /**
   * GET /dashboard/overview
   * Returns a user-scoped composite read model for the Mission Control homepage.
   * Trading evidence (bots, positions, journal, agent PnL) is sourced over the
   * Traderton read boundary; `users` + `agents` stay LOCAL (platform tables).
   */
  app.get('/dashboard/overview', async (request, reply) => {
    const userId = request.userId;

    // The overview is trading-centric: with no boundary client there is nothing
    // to assemble, so degrade to 503 rather than serve a hollow read.
    if (!tradertonReadClient) {
      return reply.status(boundaryUnconfiguredError.status).send(
        errorPayload(boundaryUnconfiguredError.code, boundaryUnconfiguredError.message),
      );
    }
    const boundary = userBoundary(userId);

    // Platform reads stay LOCAL.
    const [userRow, agentRows] = await Promise.all([
      db.select().from(users).where(eq(users.id, userId)).limit(1),
      db.select({ id: agents.id }).from(agents).where(eq(agents.userId, userId)),
    ]);

    const user = userRow[0];
    if (!user) {
      return reply.status(404).send({ error: 'not_found' });
    }

    // Owner bots over the boundary (id/status/symbol/createdAt/startedAt/venueAccountId).
    const listed = await loadAgentEvidence<OwnerBotRow>(boundary, 'list_owner_bots', {}, 'bots', (r) => r as OwnerBotRow);
    if (!listed.ok) {
      return reply.status(listed.error.status).send(errorPayload(listed.error.code, listed.error.message));
    }
    const botRows = listed.rows;

    // Resolve venue account display fields per distinct venueAccountId. A bot
    // whose account is absent/unowned (not_found) degrades to empty labels —
    // it must not fail the whole overview.
    const venueAccountIds = [...new Set(botRows.map((b) => b.venueAccountId).filter((id): id is string => Boolean(id)))];
    const venueAccountMap = new Map<string, VenueAccountView>();
    for (const vaId of venueAccountIds) {
      const vaResult = await loadBoundaryObject(boundary, 'get_venue_account', { venueAccountId: vaId });
      if (vaResult.ok) {
        venueAccountMap.set(vaId, {
          venueAccountRef: (vaResult.data['venueAccountRef'] as string | undefined) ?? '',
          venue: (vaResult.data['venue'] as string | undefined) ?? '',
          label: (vaResult.data['label'] as string | undefined) ?? '',
        });
      } else if (vaResult.error.code !== 'not_found.resource') {
        // Only a genuinely absent/unowned account (not_found) degrades to empty
        // labels — a transport/boundary FAILURE must propagate (never mask an
        // outage as blank display).
        return reply.status(vaResult.error.status).send(errorPayload(vaResult.error.code, vaResult.error.message));
      }
      // not_found.resource: leave unset → row degrades to empty labels.
    }

    // Open-position count per bot: fetch owner positions, filter open, group by actorId.
    const posLoaded = await loadAgentEvidence<ReadPositionRow>(boundary, 'get_owner_positions', {}, 'positions', toPositionRow);
    if (!posLoaded.ok) {
      return reply.status(posLoaded.error.status).send(errorPayload(posLoaded.error.code, posLoaded.error.message));
    }
    const openPositionMap = new Map<string, number>();
    for (const pos of posLoaded.rows) {
      if (pos.closedAt !== null || pos.actorId === null) continue;
      openPositionMap.set(pos.actorId, (openPositionMap.get(pos.actorId) ?? 0) + 1);
    }

    // Last-activity per bot: fetch owner journal, take max(createdAt) per actorId.
    const journalLoaded = await loadAgentEvidence<ReadJournalRow>(boundary, 'get_owner_journal', {}, 'events', toJournalRow);
    if (!journalLoaded.ok) {
      return reply.status(journalLoaded.error.status).send(errorPayload(journalLoaded.error.code, journalLoaded.error.message));
    }
    const lastActivityMap = new Map<string, string>();
    for (const ev of journalLoaded.rows) {
      if (ev.actorId === null) continue;
      const iso = ev.createdAt.toISOString();
      const existing = lastActivityMap.get(ev.actorId);
      if (!existing || iso > existing) {
        lastActivityMap.set(ev.actorId, iso);
      }
    }

    // Resolve plan limits
    const planId = request.userPlanId || user.planId || 'free';
    const planDef = plansConfig?.plans?.[planId] ?? (plansConfig ? plansConfig.plans[plansConfig.defaultPlanId] : undefined);

    const botsSummary = botRows.map((bot) => {
      const va = bot.venueAccountId ? venueAccountMap.get(bot.venueAccountId) : undefined;
      return {
        id: bot.id,
        status: bot.status,
        // Venue is sourced from the venue account; the old `config.venue` fallback
        // is dropped since `config` is no longer read (list_owner_bots is lossless
        // for `symbol` but carries no venue field).
        venue: va?.venue ?? '',
        venueLabel: va?.label ?? '',
        symbol: bot.symbol ?? '',
        openPositionsCount: openPositionMap.get(bot.id) ?? 0,
        lastActivityAt: lastActivityMap.get(bot.id) ?? null,
        startedAt: bot.startedAt ?? null,
        createdAt: bot.createdAt,
      };
    });

    const runningCount = botsSummary.filter((b) => b.status === 'running').length;
    const totalOpenPositions = botsSummary.reduce((acc, b) => acc + b.openPositionsCount, 0);

    // ── Aggregate realized PnL across all user agents ──────────────────────
    // Per agent, get_agent_positions returns BOTH agent-native positions AND
    // agent-owned-bot positions — folding the old two-part query into one read
    // per agent. Each agent's rows are that agent's, so no dedupe is needed.
    const agentIds = agentRows.map((a) => a.id);

    let combinedPnl = 0;
    for (const agentId of agentIds) {
      const agentSubject: TradertonSubject = { ownerId: userId, actor: { type: 'agent', id: agentId } };
      const agentBoundary = createTradertonReadBoundary(tradertonReadClient, agentSubject, readDeadlineMs);
      const agentPos = await loadAgentEvidence<ReadPositionRow>(agentBoundary, 'get_agent_positions', {}, 'positions', toPositionRow);
      if (!agentPos.ok) {
        return reply.status(agentPos.error.status).send(errorPayload(agentPos.error.code, agentPos.error.message));
      }
      for (const pos of agentPos.rows) {
        combinedPnl += Number(pos.realizedPnl ?? '0');
      }
    }

    return reply.send({
      user: {
        id: user.id,
        displayName: user.displayName,
        email: user.email,
        avatarUrl: user.avatarUrl,
        planId,
      },
      plan: planDef ? { entitlements: planDef.entitlements } : null,
      bots: botsSummary,
      summary: {
        totalBots: botsSummary.length,
        runningBots: runningCount,
        totalOpenPositions,
        outcomes: {
          trading: {
            totalRealizedPnl: combinedPnl.toFixed(6),
          },
        },
      },
    });
  });

  /**
   * GET /dashboard/activity
   * Returns a normalized activity feed across all the user's trading instances.
   * Events are mapped to user-friendly categories and plain-language messages.
   */
  app.get('/dashboard/activity', async (request, reply) => {
    const parsed = DashboardActivityQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const userId = request.userId;
    const { limit, before, beforeId } = parsed.data;

    // The activity feed is trading-centric: without a boundary client there is
    // no journal source, so degrade to 503.
    if (!tradertonReadClient) {
      return reply.status(boundaryUnconfiguredError.status).send(
        errorPayload(boundaryUnconfiguredError.code, boundaryUnconfiguredError.message),
      );
    }
    const boundary = userBoundary(userId);

    // Resolve the user's bots over the boundary — ownership gate + venueAccountId.
    const listed = await loadAgentEvidence<OwnerBotRow>(boundary, 'list_owner_bots', {}, 'bots', (r) => r as OwnerBotRow);
    if (!listed.ok) {
      return reply.status(listed.error.status).send(errorPayload(listed.error.code, listed.error.message));
    }
    const botRows = listed.rows;

    if (botRows.length === 0) {
      return reply.send({ events: [], hasMore: false });
    }

    const botIds = botRows.map((b) => b.id);

    // Resolve venue account display fields per distinct venueAccountId.
    const venueAccountIds = [...new Set(botRows.map((b) => b.venueAccountId).filter((id): id is string => Boolean(id)))];
    const vaMap = new Map<string, VenueAccountView>();
    for (const vaId of venueAccountIds) {
      const vaResult = await loadBoundaryObject(boundary, 'get_venue_account', { venueAccountId: vaId });
      if (vaResult.ok) {
        vaMap.set(vaId, {
          venueAccountRef: (vaResult.data['venueAccountRef'] as string | undefined) ?? '',
          venue: (vaResult.data['venue'] as string | undefined) ?? '',
          label: (vaResult.data['label'] as string | undefined) ?? '',
        });
      } else if (vaResult.error.code !== 'not_found.resource') {
        // not_found → tolerate (blank label); a transport/boundary failure propagates.
        return reply.status(vaResult.error.status).send(errorPayload(vaResult.error.code, vaResult.error.message));
      }
    }
    const botVaMap = new Map(botRows.map((b) => [b.id, b.venueAccountId ? vaMap.get(b.venueAccountId) : undefined]));

    // get_owner_journal returns the newest-first window but does NOT support the
    // (createdAt, id) keyset cursor, so we fetch a window and apply the
    // before/beforeId predicate + hasMore slice IN-APP. When no cursor is set the
    // newest `limit + 1` rows suffice; with a cursor we fetch a larger window so
    // rows AFTER the cursor can still fill a page.
    const fetchLimit = (before || beforeId) ? (limit + 1) * 4 : limit + 1;
    const journalLoaded = await loadAgentEvidence<ReadJournalRow>(
      boundary,
      'get_owner_journal',
      { botIds, limit: fetchLimit },
      'events',
      toJournalRow,
    );
    if (!journalLoaded.ok) {
      return reply.status(journalLoaded.error.status).send(errorPayload(journalLoaded.error.code, journalLoaded.error.message));
    }

    // Newest-first ordering (createdAt desc, id desc) — apply in-app to guard
    // against any ordering variance across the boundary.
    const sortedRows = [...journalLoaded.rows].sort((a, b) => {
      const at = a.createdAt.getTime();
      const bt = b.createdAt.getTime();
      if (at !== bt) return bt - at;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });

    // Apply the keyset cursor predicate: keep rows strictly older than the
    // (before, beforeId) cursor. Mirrors the old SQL keyset semantics.
    const beforeMs = before ? new Date(before).getTime() : null;
    const cursored = beforeMs === null
      ? sortedRows
      : sortedRows.filter((ev) => {
          const t = ev.createdAt.getTime();
          if (t < beforeMs) return true;
          if (t > beforeMs) return false;
          return beforeId ? ev.id < beforeId : false;
        });

    const hasMore = cursored.length > limit;
    const events = cursored.slice(0, limit);

    const normalised = events.map((ev) => {
      const payload = ev.payload as Record<string, unknown>;
      const { category, severity } = classifyEvent(ev.type, payload);
      const va = ev.actorId ? botVaMap.get(ev.actorId) : undefined;
      return {
        id: ev.id,
        botId: ev.actorId,
        instanceLabel: va ? `${va.venue} / ${va.label}` : null,
        type: ev.type,
        category,
        severity,
        // Client resolves user-visible text from this key + detail params
        messageKey: `activity.${ev.type}`,
        timestamp: ev.createdAt.toISOString(),
        detail: payload,
      };
    });

    return reply.send({ events: normalised, hasMore });
  });

  // ─── GET /dashboard/agent-activity ──────────────────────────────────────
  // Returns recent agent activity across all user's agents in the canonical
  // normalized format. Used by Mission Control and the shared Activity page.
  app.get('/dashboard/agent-activity', async (request, reply) => {
    const parsed = DashboardActivityQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const userId = request.userId;
    const { limit, before, beforeId } = parsed.data;

    // Resolve the user's agent IDs
    const agentRows = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.userId, userId));

    if (agentRows.length === 0) {
      return reply.send({ entries: [], hasMore: false });
    }

    const agentIds = agentRows.map((a) => a.id);
    const agentNameMap = new Map(agentRows.map((a) => [a.id, a.name]));
    const beforeCursor = before ? new Date(before) : null;

    // Fetch recent protocol messages + sessions in parallel
    const [protocolRows, sessionRows] = await Promise.all([
      db.select().from(agentMessages)
        .where(and(
          inArray(agentMessages.agentId, agentIds as [string, ...string[]]),
          notInArray(agentMessages.type, [...SUPPRESSED_PROTOCOL_MESSAGE_TYPES]),
        ))
        .orderBy(desc(agentMessages.createdAt))
        .limit(limit + 1),
      db.select().from(agentRuntimeSessions)
        .where(inArray(agentRuntimeSessions.agentId, agentIds as [string, ...string[]]))
        .orderBy(desc(agentRuntimeSessions.startedAt))
        .limit(limit + 1),
    ]);

    const entries: AgentActivityEntry[] = [];

    for (const row of protocolRows) {
      if (isSuppressedProtocolMessageType(String((row as { type?: unknown }).type ?? ''))) {
        continue;
      }
      entries.push(mapProtocolMessage(row as Parameters<typeof mapProtocolMessage>[0]));
    }

    const sessionStopReasons = resolveSessionStopReasons(
      protocolRows as Parameters<typeof resolveSessionStopReasons>[0],
      sessionRows as Parameters<typeof resolveSessionStopReasons>[1],
    );

    for (const session of sessionRows) {
      const sessionWithReason = {
        ...session,
        stopReason: sessionStopReasons.get(session.id) ?? null,
      } as Parameters<typeof mapRuntimeSession>[0];
      const sessionEntries = mapRuntimeSession(sessionWithReason);
      entries.push(...sessionEntries);
    }

    // Sort and paginate
    entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    const filtered = beforeCursor
      ? entries.filter((entry) => {
          if (new Date(entry.timestamp).getTime() < beforeCursor.getTime()) {
            return true;
          }
          if (new Date(entry.timestamp).getTime() > beforeCursor.getTime()) {
            return false;
          }

          return beforeId ? entry.id < beforeId : false;
        })
      : entries;
    const hasMore = filtered.length > limit;
    const trimmed = filtered.slice(0, limit);

    // Decorate with agent name for display
    const decorated = trimmed.map((entry) => ({
      ...entry,
      agentName: agentNameMap.get(entry.agentId) ?? null,
    }));

    return reply.send({ entries: decorated, hasMore });
  });
}
