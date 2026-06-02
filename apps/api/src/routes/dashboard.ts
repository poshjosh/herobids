import type { FastifyInstance } from 'fastify';
import { eq, and, or, isNull, inArray, desc, sql } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import {
  users,
  tradingInstances,
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
    const [userRow, instanceRows] = await Promise.all([
      db.select().from(users).where(eq(users.id, userId)).limit(1),
      db.select().from(tradingInstances).where(eq(tradingInstances.userId, userId)),
    ]);

    const user = userRow[0];
    if (!user) {
      return reply.status(404).send({ error: 'not_found' });
    }

    // Look up venue account labels for all instances at once
    const venueAccountIds = [...new Set(instanceRows.map((i) => i.venueAccountId))];
    const venueAccountRows = venueAccountIds.length > 0
      ? await db.select({ id: venueAccounts.id, label: venueAccounts.label, venue: venueAccounts.venue })
          .from(venueAccounts)
          .where(inArray(venueAccounts.id, venueAccountIds))
      : [];
    const venueAccountMap = new Map(venueAccountRows.map((va) => [va.id, va]));

    // Count open positions per instance
    const instanceIds = instanceRows.map((i) => i.id);
    const openPositionRows = instanceIds.length > 0
      ? await db.select({ tradingInstanceId: positions.tradingInstanceId, count: sql<number>`count(*)::int` })
          .from(positions)
          .where(and(inArray(positions.tradingInstanceId, instanceIds), isNull(positions.closedAt)))
          .groupBy(positions.tradingInstanceId)
      : [];
    const openPositionMap = new Map(openPositionRows.map((r) => [r.tradingInstanceId, r.count]));

    // Get last journal event timestamp per instance
    const lastActivityRows = instanceIds.length > 0
      ? await db.select({ tradingInstanceId: journalEvents.tradingInstanceId, lastAt: sql<string>`max(${journalEvents.createdAt})` })
          .from(journalEvents)
          .where(and(inArray(journalEvents.tradingInstanceId, instanceIds)))
          .groupBy(journalEvents.tradingInstanceId)
      : [];
    const lastActivityMap = new Map(lastActivityRows.map((r) => [r.tradingInstanceId, r.lastAt]));

    // Resolve plan limits
    const planId = request.userPlanId || user.planId || 'free';
    const planDef = plansConfig?.plans?.[planId];

    const instancesSummary = instanceRows.map((inst) => {
      const va = venueAccountMap.get(inst.venueAccountId);
      const config = inst.config as Record<string, unknown>;
      // Symbol is often in config.symbol or config.instruments[0]
      const symbol = (config['symbol'] as string | undefined)
        ?? (config['strategyParams'] as Record<string, unknown> | undefined)?.['symbol'] as string | undefined
        ?? '';
      return {
        id: inst.id,
        status: inst.status,
        strategyId: inst.strategyId,
        venue: va?.venue ?? (config['venue'] as string | undefined) ?? '',
        venueLabel: va?.label ?? '',
        symbol,
        openPositionsCount: openPositionMap.get(inst.id) ?? 0,
        lastActivityAt: lastActivityMap.get(inst.id) ?? null,
        startedAt: inst.startedAt?.toISOString() ?? null,
        createdAt: inst.createdAt.toISOString(),
      };
    });

    const runningCount = instancesSummary.filter((i) => i.status === 'running').length;
    const totalOpenPositions = instancesSummary.reduce((sum, i) => sum + i.openPositionsCount, 0);

    return reply.send({
      user: {
        id: user.id,
        displayName: user.displayName,
        email: user.email,
        avatarUrl: user.avatarUrl,
        planId,
      },
      plan: planDef ?? null,
      instances: instancesSummary,
      summary: {
        totalInstances: instancesSummary.length,
        runningInstances: runningCount,
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

    // Resolve the user's instance IDs — ownership gate
    const instanceRows = await db
      .select({ id: tradingInstances.id, strategyId: tradingInstances.strategyId, venueAccountId: tradingInstances.venueAccountId })
      .from(tradingInstances)
      .where(eq(tradingInstances.userId, userId));

    if (instanceRows.length === 0) {
      return reply.send({ events: [], hasMore: false });
    }

    const instanceIds = instanceRows.map((i) => i.id);

    // Fetch venue account labels for display
    const venueAccountIds = [...new Set(instanceRows.map((i) => i.venueAccountId))];
    const vaRows = await db
      .select({ id: venueAccounts.id, label: venueAccounts.label, venue: venueAccounts.venue })
      .from(venueAccounts)
      .where(inArray(venueAccounts.id, venueAccountIds));
    const vaMap = new Map(vaRows.map((va) => [va.id, va]));
    const instanceVaMap = new Map(instanceRows.map((i) => [i.id, vaMap.get(i.venueAccountId)]));

    // Fetch events — fetch one extra to determine hasMore
    const fetchLimit = limit + 1;
    let query = db
      .select()
      .from(journalEvents)
      .where(
        before
          ? and(
              inArray(journalEvents.tradingInstanceId, instanceIds),
              or(
                sql`${journalEvents.createdAt} < ${new Date(before)}`,
                // Tie-break: same timestamp, lower ID comes later when sorted desc
                beforeId
                  ? and(
                      sql`${journalEvents.createdAt} = ${new Date(before)}`,
                      sql`${journalEvents.id} < ${beforeId}`,
                    )
                  : sql`false`,
              ),
            )
          : inArray(journalEvents.tradingInstanceId, instanceIds),
      )
      .orderBy(desc(journalEvents.createdAt), desc(journalEvents.id))
      .limit(fetchLimit);

    const rawEvents = await query;
    const hasMore = rawEvents.length > limit;
    const events = rawEvents.slice(0, limit);

    const normalised = events.map((ev) => {
      const payload = ev.payload as Record<string, unknown>;
      const { category, severity, message } = classifyEvent(ev.type, payload);
      const va = ev.tradingInstanceId ? instanceVaMap.get(ev.tradingInstanceId) : undefined;
      return {
        id: ev.id,
        tradingInstanceId: ev.tradingInstanceId,
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
