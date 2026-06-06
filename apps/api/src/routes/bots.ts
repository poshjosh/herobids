import type { FastifyInstance } from 'fastify';
import { Queue } from 'bullmq';
import crypto from 'node:crypto';
import { eq, and, ne, sql, sum, asc, inArray } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { bots, venueAccounts, PgJournal, fills, journalEvents } from '@herobids/db';
import type { PlansConfig } from '@herobids/domain';
import {
  CreateInstanceSchema,
  UpdateInstanceConfigSchema,
} from '../schemas.js';
import { checkBotLimit, checkLiveEnabled } from '../plan-guards.js';
import type { LifecycleJob } from '../types.js';

export async function botRoutes(app: FastifyInstance, queue: Queue<LifecycleJob>, db: Database, plansConfig?: PlansConfig): Promise<void> {
  // Create bot
  app.post('/bots', async (request, reply) => {
    const parsed = CreateInstanceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const id = crypto.randomUUID();
    const now = new Date();

    if (plansConfig) {
      const planId = request.userPlanId || 'free';
      const result = await db.transaction(async (tx) => {
        // Advisory lock: serialise concurrent bot creates for the same user.
        // hashtext() returns int4; the two-argument form takes (int4, int4).
        await tx.execute(sql`SELECT pg_advisory_xact_lock(1, hashtext(${request.userId}))`);

        // Verify venue account ownership inside the transaction.
        const [venueAccount] = await tx.select({ id: venueAccounts.id }).from(venueAccounts)
          .where(and(eq(venueAccounts.id, parsed.data.venueAccountId), eq(venueAccounts.userId, request.userId)));
        if (!venueAccount) return { kind: 'not_found' as const };

        // Atomic count-and-insert: re-check the limit inside the lock.
        const planCheck = await checkBotLimit(tx as unknown as Database, plansConfig, request.userId, planId);
        if (!planCheck.ok) return { kind: 'limit' as const, error: planCheck.error };

        await tx.insert(bots).values({
          id,
          userId: request.userId,
          venueAccountId: parsed.data.venueAccountId,
          config: parsed.data.config,
          status: 'stopped',
          creatorType: 'user',
          creatorId: request.userId,
          createdAt: now,
          updatedAt: now,
        });
        return { kind: 'ok' as const };
      });

      if (result.kind === 'not_found') {
        return reply.status(404).send({ error: 'not_found', message: 'Venue account not found' });
      }
      if (result.kind === 'limit') {
        return reply.status(403).send({ error: result.error.code, message: result.error.message });
      }
    } else {
      // No plan config — verify venue account ownership then insert directly.
      const [venueAccount] = await db.select({ id: venueAccounts.id }).from(venueAccounts)
        .where(and(eq(venueAccounts.id, parsed.data.venueAccountId), eq(venueAccounts.userId, request.userId)));
      if (!venueAccount) {
        return reply.status(404).send({ error: 'not_found', message: 'Venue account not found' });
      }

      await db.insert(bots).values({
        id,
        userId: request.userId,
        venueAccountId: parsed.data.venueAccountId,
        config: parsed.data.config,
        status: 'stopped',
        creatorType: 'user',
        creatorId: request.userId,
        createdAt: now,
        updatedAt: now,
      });
    }

    const [bot] = await db.select().from(bots).where(eq(bots.id, id));
    return reply.status(201).send(bot);
  });

  // Start a bot
  app.post<{ Params: { id: string } }>('/bots/:id/start', async (request, reply) => {
    const { id } = request.params;

    const [bot] = await db.select().from(bots).where(and(eq(bots.id, id), eq(bots.userId, request.userId)));
    if (!bot) {
      return reply.status(404).send({ error: 'not_found' });
    }

    if (bot.status === 'running') {
      return reply.status(409).send({ error: 'already_running', botId: id });
    }

    // Live-mode plan gate
    if (plansConfig) {
      const botConfig = bot.config as Record<string, unknown> | undefined;
      const executionMode = (botConfig?.['execution'] as Record<string, unknown> | undefined)?.['mode'];
      if (executionMode === 'live') {
        const liveCheck = checkLiveEnabled(plansConfig, request.userPlanId || 'free');
        if (!liveCheck.ok) {
          return reply.status(403).send({ error: liveCheck.error.code, message: liveCheck.error.message });
        }
      }
    }

    const botConfig = bot.config as Record<string, unknown> | undefined;
    const venueType = (botConfig?.['venueType'] as string | undefined) ?? 'orderbook';
    const executionMode = (botConfig?.['execution'] as Record<string, unknown> | undefined)?.['mode'];

    if (venueType !== 'swap' && executionMode !== 'paper') {
      const [venueAccount] = await db.select({ credentialId: venueAccounts.credentialId })
        .from(venueAccounts)
        .where(and(eq(venueAccounts.id, bot.venueAccountId), eq(venueAccounts.userId, request.userId)));

      if (!venueAccount) {
        return reply.status(404).send({ error: 'not_found', message: 'Venue account not found' });
      }

      if (!venueAccount.credentialId) {
        return reply.status(409).send({ error: 'no_credential', message: 'Linked venue account has no credential' });
      }
    }

    try {
      const [updated] = await db.update(bots)
        .set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(bots.id, id), ne(bots.status, 'running')))
        .returning({ id: bots.id });

      if (!updated) {
        return reply.status(409).send({ error: 'already_running', botId: id });
      }
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr.code === '23505') {
        return reply.status(409).send({ error: 'venue_account_conflict', message: 'Another bot is already running on this venue account' });
      }
      throw err;
    }

    await queue.add('start-instance', {
      command: 'start',
      botId: id,
      config: { ...bot.config, venueAccountId: bot.venueAccountId, userId: bot.userId },
    });
    return reply.send({ status: 'starting', botId: id });
  });

  // Stop a bot
  app.post<{ Params: { id: string } }>('/bots/:id/stop', async (request, reply) => {
    const { id } = request.params;

    const [bot] = await db.select().from(bots).where(and(eq(bots.id, id), eq(bots.userId, request.userId)));
    if (!bot) {
      return reply.status(404).send({ error: 'not_found' });
    }

    await db.update(bots)
      .set({ status: 'stopped', stoppedAt: new Date(), updatedAt: new Date() })
      .where(eq(bots.id, id));

    await queue.add('stop-instance', {
      command: 'stop',
      botId: id,
    });
    return reply.send({ status: 'stopping', botId: id });
  });

  // Update bot config
  app.patch<{ Params: { id: string } }>('/bots/:id/config', async (request, reply) => {
    const { id } = request.params;
    const parsed = UpdateInstanceConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const [existing] = await db.select().from(bots).where(and(eq(bots.id, id), eq(bots.userId, request.userId)));
    if (!existing) {
      return reply.status(404).send({ error: 'not_found' });
    }

    // Live-mode plan gate
    if (plansConfig) {
      const newExecutionMode = (parsed.data.config['execution'] as Record<string, unknown> | undefined)?.['mode'];
      if (newExecutionMode === 'live') {
        const liveCheck = checkLiveEnabled(plansConfig, request.userPlanId || 'free');
        if (!liveCheck.ok) {
          return reply.status(403).send({ error: liveCheck.error.code, message: liveCheck.error.message });
        }
      }
    }

    await db.update(bots)
      .set({ config: parsed.data.config, updatedAt: new Date() })
      .where(eq(bots.id, id));

    // Restart if running to pick up new config
    if (existing.status === 'running') {
      await queue.add('restart-instance', {
        command: 'restart',
        botId: id,
        config: { ...parsed.data.config, venueAccountId: existing.venueAccountId, userId: existing.userId },
      });
    }

    return reply.send({ status: 'updated', botId: id });
  });

  // List bots
  app.get('/bots', async (request, reply) => {
    const botList = await db.select().from(bots).where(eq(bots.userId, request.userId));
    return reply.send({ bots: botList });
  });

  // Get single bot
  app.get<{ Params: { id: string } }>('/bots/:id', async (request, reply) => {
    const { id } = request.params;
    const [bot] = await db.select().from(bots).where(and(eq(bots.id, id), eq(bots.userId, request.userId)));
    if (!bot) {
      return reply.status(404).send({ error: 'not_found' });
    }
    return reply.send(bot);
  });

  // GET /bots/:id/costs — total fees from fills for this bot
  app.get<{ Params: { id: string } }>('/bots/:id/costs', async (request, reply) => {
    const { id } = request.params;
    const [bot] = await db.select({ id: bots.id }).from(bots)
      .where(and(eq(bots.id, id), eq(bots.userId, request.userId)));
    if (!bot) return reply.status(404).send({ error: 'not_found' });

    // Group by feeCurrency to avoid summing across heterogeneous assets.
    const feeRows = await db
      .select({ feeCurrency: fills.feeCurrency, total: sum(fills.fee) })
      .from(fills)
      .where(and(eq(fills.actorType, 'bot'), eq(fills.actorId, id)))
      .groupBy(fills.feeCurrency);

    const feesByCurrency: Record<string, string> = {};
    for (const row of feeRows) {
      feesByCurrency[row.feeCurrency ?? 'unknown'] = row.total ?? '0';
    }

    return reply.send({
      botId: id,
      feesByCurrency,
    });
  });

  // GET /bots/:id/sessions — lifecycle sessions derived by pairing instance.started / instance.stopped events
  app.get<{ Params: { id: string }; Querystring: { limit?: string; offset?: string } }>('/bots/:id/sessions', async (request, reply) => {
    const { id } = request.params;
    const limit = Math.min(parseInt(request.query.limit ?? '20', 10), 100);
    const offset = parseInt(request.query.offset ?? '0', 10);

    const [bot] = await db.select({ id: bots.id }).from(bots)
      .where(and(eq(bots.id, id), eq(bots.userId, request.userId)));
    if (!bot) return reply.status(404).send({ error: 'not_found' });

    // Derive sessions by pairing instance.started / instance.stopped events.
    // Fetch ascending so pairs can be built left-to-right, then reverse for newest-first output.
    // (limit + offset) * 2 + 2 bounds the fetch to what's needed for a single page.
    const maxEvents = (limit + offset) * 2 + 2;
    const rawEvents = await db.select()
      .from(journalEvents)
      .where(and(
        eq(journalEvents.actorId, id),
        inArray(journalEvents.type, ['instance.started', 'instance.stopped']),
      ))
      .orderBy(asc(journalEvents.createdAt))
      .limit(maxEvents);

    type Session = {
      startedAt: Date;
      endedAt: Date | null;
      durationMs: number | null;
      startEventId: string;
      endEventId: string | null;
    };
    const sessions: Session[] = [];
    let pendingStart: (typeof journalEvents.$inferSelect) | null = null;
    for (const event of rawEvents) {
      if (event.type === 'instance.started') {
        pendingStart = event;
      } else if (event.type === 'instance.stopped' && pendingStart) {
        const startedAt = pendingStart.createdAt;
        const endedAt = event.createdAt;
        sessions.push({
          startedAt,
          endedAt,
          durationMs: endedAt.getTime() - startedAt.getTime(),
          startEventId: pendingStart.id,
          endEventId: event.id,
        });
        pendingStart = null;
      }
    }
    // Include the currently-running session (started but not yet stopped).
    if (pendingStart) {
      sessions.push({
        startedAt: pendingStart.createdAt,
        endedAt: null,
        durationMs: null,
        startEventId: pendingStart.id,
        endEventId: null,
      });
    }
    sessions.reverse(); // newest first
    const page = sessions.slice(offset, offset + limit);

    return reply.send({ botId: id, sessions: page, limit, offset });
  });

  // GET /bots/:id/events — recent journal events for this bot
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/bots/:id/events', async (request, reply) => {
    const { id } = request.params;
    const limit = Math.min(parseInt(request.query.limit ?? '50', 10), 500);

    const [bot] = await db.select({ id: bots.id }).from(bots)
      .where(and(eq(bots.id, id), eq(bots.userId, request.userId)));
    if (!bot) return reply.status(404).send({ error: 'not_found' });

    const journal = new PgJournal(db);
    const events = await journal.query({ actorId: id, limit });

    return reply.send({ botId: id, events });
  });

  // GET /bots/:id/journal — paginated journal events with optional type filter
  app.get<{ Params: { id: string }; Querystring: { limit?: string; offset?: string; type?: string } }>('/bots/:id/journal', async (request, reply) => {
    const { id } = request.params;
    const limit = Math.min(parseInt(request.query.limit ?? '50', 10), 200);
    const offset = parseInt(request.query.offset ?? '0', 10);

    const [bot] = await db.select({ id: bots.id }).from(bots)
      .where(and(eq(bots.id, id), eq(bots.userId, request.userId)));
    if (!bot) return reply.status(404).send({ error: 'not_found' });

    const journal = new PgJournal(db);
    const events = await journal.query({ actorId: id, type: request.query.type, limit, offset });

    return reply.send({ botId: id, events, limit, offset });
  });

  // GET /bots/:id/journal/summary — aggregate stats from fills for this bot
  app.get<{ Params: { id: string } }>('/bots/:id/journal/summary', async (request, reply) => {
    const { id } = request.params;
    const [bot] = await db.select({ id: bots.id }).from(bots)
      .where(and(eq(bots.id, id), eq(bots.userId, request.userId)));
    if (!bot) return reply.status(404).send({ error: 'not_found' });

    const [countResult] = await db
      .select({ tradeCount: sql<number>`count(*)::int` })
      .from(fills)
      .where(and(eq(fills.actorType, 'bot'), eq(fills.actorId, id)));

    // Group by feeCurrency — consistent with /costs; avoids summing across heterogeneous assets.
    const feeRows = await db
      .select({ feeCurrency: fills.feeCurrency, total: sum(fills.fee) })
      .from(fills)
      .where(and(eq(fills.actorType, 'bot'), eq(fills.actorId, id)))
      .groupBy(fills.feeCurrency);

    const feesByCurrency: Record<string, string> = {};
    for (const row of feeRows) {
      feesByCurrency[row.feeCurrency ?? 'unknown'] = row.total ?? '0';
    }

    return reply.send({
      botId: id,
      tradeCount: countResult?.tradeCount ?? 0,
      feesByCurrency,
    });
  });
}
