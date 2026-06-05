import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { PgJournal, ReconciliationEventRepository, OrderRepository, FillRepository } from '@herobids/db';
import { bots } from '@herobids/db';
import { LiveStatusQuerySchema } from '../schemas.js';

/** Live event types for the general timeline query (excludes slippage_alert which has its own field) */
const LIVE_EVENT_TYPES = [
  'instance.live_blocked',
  'instance.live_armed',
  'order.submitted_to_venue',
  'order.acknowledged',
  'order.fill_confirmed_from_stream',
  'order.completion_recovered',
] as const;

export async function liveStatusRoutes(app: FastifyInstance, db: Database): Promise<void> {
  const journal = new PgJournal(db);
  const reconRepo = new ReconciliationEventRepository(db);
  const orderRepo = new OrderRepository(db);
  const fillRepo = new FillRepository(db);

  /**
   * GET /instances/:id/live-status
   * Thin operator monitoring surface summarizing current live state:
   * - execution mode
   * - last reconciliation result and timestamp
   * - open live orders
   * - recent fills
   * - recent slippage alerts
   * - recent live events
   */
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/instances/:id/live-status',
    async (request, reply) => {
      const { id } = request.params;
      const parsed = LiveStatusQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
      }

      // Verify bot exists and belongs to user
      const [bot] = await db.select().from(bots).where(and(eq(bots.id, id), eq(bots.userId, request.userId)));
      if (!bot) {
        return reply.status(404).send({ error: 'not_found' });
      }

      const config = bot.config as Record<string, unknown>;
      const executionConfig = config['execution'] as Record<string, unknown> | undefined;
      const executionMode = executionConfig?.['mode'] ?? 'paper';

      const since = parsed.data.since ? new Date(parsed.data.since) : undefined;
      const limit = parsed.data.limit;

      // Parallel queries for live status data
      const [
        recentRecon,
        openOrders,
        recentFills,
        slippageAlerts,
        liveEvents,
      ] = await Promise.all([
        reconRepo.getByInstance(id, { limit: 1 }),
        orderRepo.getOpenByInstance(id),
        fillRepo.getRecentByInstance(id, since, limit),
        journal.queryByTypes({
          tradingInstanceId: id,
          types: ['live.slippage_alert'],
          since,
          limit,
        }),
        journal.queryByTypes({
          tradingInstanceId: id,
          types: [...LIVE_EVENT_TYPES],
          since,
          limit,
        }),
      ]);

      const lastRecon = recentRecon[0];

      return reply.send({
        tradingInstanceId: id,
        executionMode,
        status: bot.status,
        startedAt: bot.startedAt?.toISOString() ?? null,
        lastReconciliation: lastRecon
          ? {
              result: lastRecon.result,
              timestamp: lastRecon.createdAt.toISOString(),
              diffCount: Array.isArray(lastRecon.diff) ? lastRecon.diff.length : 0,
            }
          : null,
        openOrders: openOrders.map((o) => ({
          id: o.id,
          venueRefId: o.venueRefId,
          clientOrderId: o.clientOrderId,
          venue: o.venue,
          symbol: o.symbol,
          side: o.side,
          type: o.type,
          status: o.status,
          quantity: o.quantity,
          price: o.price,
          filledQuantity: o.filledQuantity,
          createdAt: o.createdAt?.toISOString(),
        })),
        recentFills: recentFills.map((f) => ({
          id: f.id,
          orderId: f.orderId,
          venueRefId: f.venueRefId,
          venue: f.venue,
          symbol: f.symbol,
          side: f.side,
          quantity: f.quantity,
          price: f.price,
          fee: f.fee,
          filledAt: f.filledAt?.toISOString(),
        })),
        slippageAlerts: slippageAlerts.map((e) => ({
          id: e.id,
          payload: e.payload,
          createdAt: e.createdAt.toISOString(),
        })),
        recentLiveEvents: liveEvents.map((e) => ({
          id: e.id,
          type: e.type,
          payload: e.payload,
          createdAt: e.createdAt.toISOString(),
        })),
      });
    },
  );

  /**
   * GET /instances/:id/live-readiness
   * Reports the last known readiness verdict for live trading.
   * Derives state from the most recent live_blocked/live_armed journal events
   * plus the instance's current DB status. Does NOT re-evaluate prerequisites
   * (operator config, credential linkage, stream health) — those are checked
   * at actor startup time and journaled as blocked/armed events.
   *
   * NOTE: Private-stream health is not yet exposed here because it is ephemeral
   * worker-process state with no durable read model. A stream disconnect pauses
   * the scan loop but does not update DB status until max-reconnect is exhausted
   * (at which point the actor crashes and status becomes 'crashed').
   */
  app.get<{ Params: { id: string } }>(
    '/instances/:id/live-readiness',
    async (request, reply) => {
      const { id } = request.params;

      const [bot] = await db.select().from(bots).where(and(eq(bots.id, id), eq(bots.userId, request.userId)));
      if (!bot) {
        return reply.status(404).send({ error: 'not_found' });
      }

      const config = bot.config as Record<string, unknown>;
      const executionConfig = config['execution'] as Record<string, unknown> | undefined;
      const executionMode = executionConfig?.['mode'] ?? 'paper';

      // Check for recent live_blocked or live_armed events
      const [blockedEvents, armedEvents] = await Promise.all([
        journal.queryByTypes({
          tradingInstanceId: id,
          types: ['instance.live_blocked'],
          limit: 1,
        }),
        journal.queryByTypes({
          tradingInstanceId: id,
          types: ['instance.live_armed'],
          limit: 1,
        }),
      ]);

      const lastBlocked = blockedEvents[0];
      const lastArmed = armedEvents[0];

      let readinessState: 'unknown' | 'armed' | 'blocked' = 'unknown';
      if (bot.status !== 'running') {
        readinessState = 'blocked';
      } else if (lastArmed && lastBlocked) {
        readinessState = lastArmed.createdAt > lastBlocked.createdAt ? 'armed' : 'blocked';
      } else if (lastArmed) {
        readinessState = 'armed';
      } else if (lastBlocked) {
        readinessState = 'blocked';
      }

      return reply.send({
        tradingInstanceId: id,
        executionMode,
        status: bot.status,
        readinessState,
        lastBlocked: lastBlocked
          ? { reason: (lastBlocked.payload as Record<string, unknown>)['reason'], code: (lastBlocked.payload as Record<string, unknown>)['code'], timestamp: lastBlocked.createdAt.toISOString() }
          : null,
        lastArmed: lastArmed
          ? { timestamp: lastArmed.createdAt.toISOString(), payload: lastArmed.payload }
          : null,
      });
    },
  );
}
