import type { FastifyInstance } from 'fastify';
import { eq, and, or, isNull, inArray, desc, sql } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import {
  users,
  bots,
  positions,
  journalEvents,
  venueAccounts,
} from '@herobids/db';
import type { PlansConfig } from '@herobids/domain';
import { DashboardActivityQuerySchema } from '../schemas.js';

// ---------------------------------------------------------------------------
// Event categorisation helpers — maps canonical journal event types to a
// user-facing category, severity, and plain-language message template.
// ---------------------------------------------------------------------------

type EventCategory = 'decision' | 'execution' | 'risk' | 'system';
type EventSeverity = 'info' | 'warn' | 'critical';

interface EventMeta {
  category: EventCategory;
  severity: EventSeverity;
  message: (payload: Record<string, unknown>) => string;
}

const EVENT_META: Record<string, EventMeta> = {
  'decision.accepted': {
    category: 'decision',
    severity: 'info',
    message: (p) => `Decision accepted: ${(p['intent'] as string | undefined) ?? 'unknown'} ${(p['instrumentId'] as string | undefined) ?? ''}`.trim(),
  },
  'decision.rejected': {
    category: 'risk',
    severity: 'warn',
    message: (p) => `Decision rejected: ${(p['reason'] as string | undefined) ?? 'risk gate'}`,
  },
  'risk.breach': {
    category: 'risk',
    severity: 'critical',
    message: (p) => `Risk limit breached: ${(p['reason'] as string | undefined) ?? 'limit exceeded'}`,
  },
  'risk.guardrail_triggered': {
    category: 'risk',
    severity: 'warn',
    message: (p) => `Guardrail triggered: ${(p['reason'] as string | undefined) ?? 'safety limit'}`,
  },
  'order.submitted': {
    category: 'execution',
    severity: 'info',
    message: (p) => `Order placed: ${(p['side'] as string | undefined) ?? ''} ${(p['symbol'] as string | undefined) ?? ''}`.trim(),
  },
  'order.filled': {
    category: 'execution',
    severity: 'info',
    message: (p) => `Order filled: ${(p['side'] as string | undefined) ?? ''} ${(p['quantity'] as string | undefined) ?? ''} ${(p['symbol'] as string | undefined) ?? ''} @ ${(p['price'] as string | undefined) ?? 'market'}`.trim(),
  },
  'order.fill_confirmed_from_stream': {
    category: 'execution',
    severity: 'info',
    message: (p) => `Fill confirmed: ${(p['side'] as string | undefined) ?? ''} ${(p['quantity'] as string | undefined) ?? ''} ${(p['symbol'] as string | undefined) ?? ''}`.trim(),
  },
  'order.cancelled': {
    category: 'execution',
    severity: 'info',
    message: () => 'Order cancelled',
  },
  'order.rejected': {
    category: 'execution',
    severity: 'warn',
    message: (p) => `Order rejected by venue: ${(p['reason'] as string | undefined) ?? 'unknown reason'}`,
  },
  'instance.started': {
    category: 'system',
    severity: 'info',
    message: () => 'Agent started',
  },
  'instance.stopped': {
    category: 'system',
    severity: 'info',
    message: () => 'Agent stopped',
  },
  'instance.crashed': {
    category: 'system',
    severity: 'critical',
    message: (p) => `Agent crashed: ${(p['reason'] as string | undefined) ?? 'unexpected error'}`,
  },
  'instance.live_armed': {
    category: 'system',
    severity: 'warn',
    message: () => 'Live trading armed',
  },
  'instance.live_blocked': {
    category: 'system',
    severity: 'warn',
    message: (p) => `Live trading blocked: ${(p['reason'] as string | undefined) ?? 'checks failed'}`,
  },
  'reconciliation.drift_detected': {
    category: 'system',
    severity: 'warn',
    message: () => 'Position drift detected — reconciling',
  },
  'live.slippage_alert': {
    category: 'execution',
    severity: 'warn',
    message: (p) => `High slippage detected: ${(p['slippageBps'] as number | undefined) ?? '?'} bps`,
  },
};

function classifyEvent(type: string, payload: Record<string, unknown>): { category: EventCategory; severity: EventSeverity; message: string } {
  const meta = EVENT_META[type];
  if (meta) {
    return { category: meta.category, severity: meta.severity, message: meta.message(payload) };
  }
  // Fallback: infer from type prefix
  const prefix = type.split('.')[0] ?? '';
  const category: EventCategory =
    prefix === 'decision' ? 'decision' :
    prefix === 'risk' ? 'risk' :
    prefix === 'order' || prefix === 'fill' ? 'execution' :
    'system';
  return { category, severity: 'info', message: type };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export async function dashboardRoutes(app: FastifyInstance, db: Database, plansConfig?: PlansConfig): Promise<void> {
  /**
   * GET /dashboard/overview
   * Returns a user-scoped composite read model for the Mission Control homepage.
   * One query: instances with open-position counts and last-activity timestamps.
   */
  app.get('/dashboard/overview', async (request, reply) => {
    const userId = request.userId;

    // Fetch user + instances + venue account labels in parallel
    const [userRow, botRows] = await Promise.all([
      db.select().from(users).where(eq(users.id, userId)).limit(1),
      db.select().from(bots).where(eq(bots.userId, userId)),
    ]);

    const user = userRow[0];
    if (!user) {
      return reply.status(404).send({ error: 'not_found' });
    }

    // Look up venue account labels for all bots at once
    const venueAccountIds = [...new Set(botRows.map((b) => b.venueAccountId))];
    const venueAccountRows = venueAccountIds.length > 0
      ? await db.select({ id: venueAccounts.id, label: venueAccounts.label, venue: venueAccounts.venue })
          .from(venueAccounts)
          .where(inArray(venueAccounts.id, venueAccountIds))
      : [];
    const venueAccountMap = new Map(venueAccountRows.map((va) => [va.id, va]));

    // Count open positions per bot (actorType='bot', actorId=botId)
    const botIds = botRows.map((b) => b.id);
    const openPositionRows = botIds.length > 0
      ? await db.select({ actorId: positions.actorId, count: sql<number>`count(*)::int` })
          .from(positions)
          .where(and(eq(positions.actorType, 'bot'), inArray(positions.actorId, botIds as [string, ...string[]]), isNull(positions.closedAt)))
          .groupBy(positions.actorId)
      : [];
    const openPositionMap = new Map(openPositionRows.map((r) => [r.actorId, r.count]));

    // Get last journal event timestamp per bot
    const lastActivityRows = botIds.length > 0
      ? await db.select({ actorId: journalEvents.actorId, lastAt: sql<string>`max(${journalEvents.createdAt})` })
          .from(journalEvents)
          .where(inArray(journalEvents.actorId, botIds as [string, ...string[]]))
          .groupBy(journalEvents.actorId)
      : [];
    const lastActivityMap = new Map(lastActivityRows.map((r) => [r.actorId, r.lastAt]));

    // Resolve plan limits
    const planId = request.userPlanId || user.planId || 'free';
    const planDef = plansConfig?.plans?.[planId];

    const botsSummary = botRows.map((bot) => {
      const va = venueAccountMap.get(bot.venueAccountId);
      const config = bot.config as Record<string, unknown>;
      const symbol = (config['symbol'] as string | undefined)
        ?? (config['strategyParams'] as Record<string, unknown> | undefined)?.['symbol'] as string | undefined
        ?? '';
      return {
        id: bot.id,
        status: bot.status,
        venue: va?.venue ?? (config['venue'] as string | undefined) ?? '',
        venueLabel: va?.label ?? '',
        symbol,
        openPositionsCount: openPositionMap.get(bot.id) ?? 0,
        lastActivityAt: lastActivityMap.get(bot.id) ?? null,
        startedAt: bot.startedAt?.toISOString() ?? null,
        createdAt: bot.createdAt.toISOString(),
      };
    });

    const runningCount = botsSummary.filter((b) => b.status === 'running').length;
    const totalOpenPositions = botsSummary.reduce((sum, b) => sum + b.openPositionsCount, 0);

    return reply.send({
      user: {
        id: user.id,
        displayName: user.displayName,
        email: user.email,
        avatarUrl: user.avatarUrl,
        planId,
      },
      plan: planDef ?? null,
      bots: botsSummary,
      summary: {
        totalBots: botsSummary.length,
        runningBots: runningCount,
        totalOpenPositions,
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

    // Resolve the user's bot IDs — ownership gate
    const botRows = await db
      .select({ id: bots.id, venueAccountId: bots.venueAccountId })
      .from(bots)
      .where(eq(bots.userId, userId));

    if (botRows.length === 0) {
      return reply.send({ events: [], hasMore: false });
    }

    const botIds = botRows.map((b) => b.id);

    // Fetch venue account labels for display
    const venueAccountIds = [...new Set(botRows.map((b) => b.venueAccountId))];
    const vaRows = await db
      .select({ id: venueAccounts.id, label: venueAccounts.label, venue: venueAccounts.venue })
      .from(venueAccounts)
      .where(inArray(venueAccounts.id, venueAccountIds));
    const vaMap = new Map(vaRows.map((va) => [va.id, va]));
    const botVaMap = new Map(botRows.map((b) => [b.id, vaMap.get(b.venueAccountId)]));

    // Fetch events by actorId — fetch one extra to determine hasMore
    const fetchLimit = limit + 1;
    const query = db
      .select()
      .from(journalEvents)
      .where(
        before
          ? and(
              inArray(journalEvents.actorId, botIds as [string, ...string[]]),
              or(
                sql`${journalEvents.createdAt} < ${before}::timestamptz`,
                beforeId
                  ? and(
                      sql`${journalEvents.createdAt} = ${before}::timestamptz`,
                      sql`${journalEvents.id} < ${beforeId}`,
                    )
                  : sql`false`,
              ),
            )
          : inArray(journalEvents.actorId, botIds as [string, ...string[]]),
      )
      .orderBy(desc(journalEvents.createdAt), desc(journalEvents.id))
      .limit(fetchLimit);

    const rawEvents = await query;
    const hasMore = rawEvents.length > limit;
    const events = rawEvents.slice(0, limit);

    const normalised = events.map((ev) => {
      const payload = ev.payload as Record<string, unknown>;
      const { category, severity, message } = classifyEvent(ev.type, payload);
      const va = ev.actorId ? botVaMap.get(ev.actorId) : undefined;
      return {
        id: ev.id,
        botId: ev.actorId,
        instanceLabel: va ? `${va.venue} / ${va.label}` : null,
        type: ev.type,
        category,
        severity,
        message,
        timestamp: ev.createdAt.toISOString(),
        detail: payload,
      };
    });

    return reply.send({ events: normalised, hasMore });
  });
}
