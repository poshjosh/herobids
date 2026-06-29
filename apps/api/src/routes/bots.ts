import type { FastifyInstance } from 'fastify';
import { Queue } from 'bullmq';
import crypto from 'node:crypto';
import { eq, and, sql, sum, asc, inArray, or } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { bots, connections, blueprints, PgJournal, fills, journalEvents } from '@herobids/db';
import type { PlansConfig } from '@herobids/domain';
import {
  CreateInstanceSchema,
  UpdateInstanceConfigSchema,
} from '../schemas.js';
import { checkBotLimit, checkLiveEnabled } from '../plan-guards.js';
import { errorPayload } from '../error-payload.js';
import { validateExecutionCapability, venueTypeFromProvider } from '@herobids/domain';
import type { LifecycleJob } from '../types.js';

export async function botRoutes(app: FastifyInstance, queue: Queue<LifecycleJob>, db: Database, plansConfig?: PlansConfig): Promise<void> {
  // Create bot
  app.post('/bots', async (request, reply) => {
    const parsed = CreateInstanceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    // Resolve config source: blueprint reference takes precedence over inline config.
    let resolvedConfig: Record<string, unknown>;
    let blueprintId: string | null = null;
    let configSnapshot: Record<string, unknown> | null = null;
    const usingDeprecatedInlineConfig = !parsed.data.blueprintId;
    const connectionId = parsed.data.connectionId;

    if (parsed.data.blueprintId) {
      // Look up the blueprint; accepts owner's private or any public blueprint.
      const [bp] = await db
        .select({ id: blueprints.id, configData: blueprints.configData })
        .from(blueprints)
        .where(and(
          eq(blueprints.id, parsed.data.blueprintId),
          or(eq(blueprints.userId, request.userId), eq(blueprints.visibility, 'public')),
        ));
      if (!bp) {
        return reply.status(404).send({ error: 'not_found', message: 'Blueprint not found' });
      }
      const base = bp.configData as Record<string, unknown>;
      const overrides = (parsed.data.configOverrides ?? {}) as Record<string, unknown>;
      // Section-level merge: for each top-level key, if both sides are plain objects,
      // merge them one level deep so that e.g. { strategy: { lookbackPeriod: 21 } }
      // adds/overrides that one field without discarding sibling fields like type.
      resolvedConfig = { ...base };
      for (const [k, v] of Object.entries(overrides)) {
        const existing = resolvedConfig[k];
        resolvedConfig[k] = (
          existing !== null && typeof existing === 'object' && !Array.isArray(existing) &&
          v !== null && typeof v === 'object' && !Array.isArray(v)
        ) ? { ...(existing as Record<string, unknown>), ...(v as Record<string, unknown>) } : v;
      }
      configSnapshot = resolvedConfig;
      blueprintId = parsed.data.blueprintId;
    } else {
      resolvedConfig = parsed.data.config as Record<string, unknown>;
    }

    const id = crypto.randomUUID();
    const now = new Date();

    // Validate execution capability for the bot's venue + mode combination
    const botVenueType = venueTypeFromProvider(parsed.data.venue);
    const botExecutionMode = (resolvedConfig['execution'] as Record<string, unknown> | undefined)?.['mode'] as string | undefined;
    if (botVenueType && botExecutionMode) {
      const capCheck = validateExecutionCapability({
        actorType: 'bot',
        executionMode: botExecutionMode as 'paper' | 'shadow' | 'live',
        venueType: botVenueType,
      });
      if (!capCheck.ok) {
        return reply.status(400).send({
          error: `execution_capability.${capCheck.error.code}`,
          message: capCheck.error.message,
        });
      }
    }

    // swapAssets validation for swap-venue bots is deferred to BotConfigSchema at
    // worker startup — it enforces stricter constraints (int / 0–18 range for
    // decimals) than an ad-hoc gate here could.

    // Live-mode plan gate
    if (plansConfig && botExecutionMode === 'live') {
      const liveCheck = checkLiveEnabled(plansConfig, request.userPlanId || 'free', request.isAdmin);
      if (!liveCheck.ok) {
        return reply.status(403).send({ error: liveCheck.error.code, message: liveCheck.error.message });
      }
    }

    if (plansConfig) {
      const planId = request.userPlanId || 'free';
      const result = await db.transaction(async (tx) => {
        // Advisory lock: serialise concurrent bot creates for the same user.
        // hashtext() returns int4; the two-argument form takes (int4, int4).
        await tx.execute(sql`SELECT pg_advisory_xact_lock(1, hashtext(${request.userId}))`);

        // Verify connection ownership inside the transaction.
        const [conn] = await tx.select({ id: connections.id, provider: connections.provider, credentialId: connections.credentialId, resolvedVenueAccountId: connections.resolvedVenueAccountId }).from(connections)
          .where(and(eq(connections.id, connectionId), eq(connections.userId, request.userId)));
        if (!conn) return { kind: 'not_found' as const };
        if (!conn.resolvedVenueAccountId) return { kind: 'missing_venue_account' as const };

        // Atomic count-and-insert: re-check the limit inside the lock.
        const planCheck = await checkBotLimit(tx as unknown as Database, plansConfig, request.userId, planId, request.isAdmin);
        if (!planCheck.ok) return { kind: 'limit' as const, error: planCheck.error };

        try {
          await tx.insert(bots).values({
            id,
            userId: request.userId,
            venueAccountId: conn.resolvedVenueAccountId,
            connectionId,
            config: resolvedConfig,
            blueprintId,
            configSnapshot,
            status: 'stopped',
            creatorType: 'user',
            creatorId: request.userId,
            createdAt: now,
            updatedAt: now,
          });
        } catch (err: unknown) {
          // Blueprint was deleted between the pre-transaction lookup and the insert.
          if ((err as { code?: string }).code === '23503') {
            return { kind: 'blueprint_deleted' as const };
          }
          throw err;
        }
        return { kind: 'ok' as const };
      });

      if (result.kind === 'not_found') {
        return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
      }
      if (result.kind === 'missing_venue_account') {
        return reply.status(400).send({ error: 'connection.missing_venue_account', message: 'No venue account found for this connection. Please complete trading setup first.' });
      }
      if (result.kind === 'blueprint_deleted') {
        return reply.status(404).send({ error: 'not_found', message: 'Blueprint not found' });
      }
      if (result.kind === 'limit') {
        return reply.status(403).send(errorPayload(result.error.code, result.error.message, result.error.params));
      }
    } else {
      // No plan config — verify connection ownership then insert directly.
      const [conn] = await db.select({ id: connections.id, provider: connections.provider, resolvedVenueAccountId: connections.resolvedVenueAccountId }).from(connections)
        .where(and(eq(connections.id, connectionId), eq(connections.userId, request.userId)));
      if (!conn) {
        return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
      }
      if (!conn.resolvedVenueAccountId) {
        return reply.status(400).send({ error: 'connection.missing_venue_account', message: 'No venue account found for this connection. Please complete trading setup first.' });
      }

      try {
        await db.insert(bots).values({
          id,
          userId: request.userId,
          venueAccountId: conn.resolvedVenueAccountId,
          connectionId,
          config: resolvedConfig,
          blueprintId,
          configSnapshot,
          status: 'stopped',
          creatorType: 'user',
          creatorId: request.userId,
          createdAt: now,
          updatedAt: now,
        });
      } catch (err: unknown) {
        // Blueprint was deleted between the pre-transaction lookup and the insert.
        if ((err as { code?: string }).code === '23503') {
          return reply.status(404).send({ error: 'not_found', message: 'Blueprint not found' });
        }
        throw err;
      }
    }

    const [bot] = await db.select().from(bots).where(eq(bots.id, id));
    // Notify callers using the deprecated inline config field to migrate to blueprintId.
    if (usingDeprecatedInlineConfig) {
      void reply.header('Deprecation', 'true');
      void reply.header('Link', '</blueprints>; rel="deprecation"; title="Use blueprintId instead of config"');
    }
    return reply.status(201).send(bot);
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

    // Validate execution capability for the updated config against the bot's venue type
    const newExecutionMode = (parsed.data.config['execution'] as Record<string, unknown> | undefined)?.['mode'] as string | undefined;
    if (newExecutionMode) {
      const [conn] = await db.select({ provider: connections.provider }).from(connections)
        .where(eq(connections.id, existing.connectionId));
      const botVenueType = conn ? venueTypeFromProvider(conn.provider) : undefined;
      if (botVenueType) {
        const capCheck = validateExecutionCapability({
          actorType: 'bot',
          executionMode: newExecutionMode as 'paper' | 'shadow' | 'live',
          venueType: botVenueType,
        });
        if (!capCheck.ok) {
          return reply.status(400).send({
            error: `execution_capability.${capCheck.error.code}`,
            message: capCheck.error.message,
          });
        }
      }
    }

    // Live-mode plan gate
    if (plansConfig) {
      if (newExecutionMode === 'live') {
        const liveCheck = checkLiveEnabled(plansConfig, request.userPlanId || 'free', request.isAdmin);
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
        config: { ...parsed.data.config, connectionId: existing.connectionId, venueAccountId: existing.venueAccountId, userId: existing.userId },
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

  // ── Bot Lifecycle Endpoints ──────────────────────────────────────────

  // DELETE /bots/:id — delete a stopped or crashed bot
  app.delete<{ Params: { id: string } }>('/bots/:id', async (request, reply) => {
    const { id } = request.params;

    const [bot] = await db.select().from(bots).where(and(eq(bots.id, id), eq(bots.userId, request.userId)));
    if (!bot) {
      return reply.status(404).send({ error: 'not_found' });
    }

    if (bot.status === 'running') {
      return reply.status(409).send({ error: 'conflict', message: 'Cannot delete a running bot. Stop it first.' });
    }

    // Check for pending start jobs to avoid deleting a bot that is about to start.
    // Without this guard, a start job enqueued milliseconds earlier would try to
    // operate on a deleted bot and fail silently in the dead-letter queue.
    const pendingJobs = await queue.getJobs(['delayed', 'waiting', 'active']);
    const pendingStart = pendingJobs.find((j) => j.name === 'start-instance' && j.data?.botId === id);
    if (pendingStart) {
      await pendingStart.remove();
    }

    await db.delete(bots).where(eq(bots.id, id));
    return reply.status(204).send();
  });

  // POST /bots/:id/stop — stop a running bot (idempotent)
  app.post<{ Params: { id: string } }>('/bots/:id/stop', async (request, reply) => {
    const { id } = request.params;

    const [bot] = await db.select().from(bots).where(and(eq(bots.id, id), eq(bots.userId, request.userId)));
    if (!bot) {
      return reply.status(404).send({ error: 'not_found' });
    }

    // Already in a terminal state — no-op to preserve crash forensic data
    if (bot.status === 'stopped' || bot.status === 'crashed') {
      return reply.status(200).send({ status: 'already_stopped', botId: id });
    }

    // Enqueue stop job on the lifecycle queue
    await queue.add('stop-instance', { command: 'stop', botId: id });

    return reply.status(202).send({ status: 'stopping', botId: id });
  });

  // POST /bots/:id/start — start a stopped or crashed bot (idempotent)
  app.post<{ Params: { id: string } }>('/bots/:id/start', async (request, reply) => {
    const { id } = request.params;

    const [bot] = await db.select().from(bots).where(and(eq(bots.id, id), eq(bots.userId, request.userId)));
    if (!bot) {
      return reply.status(404).send({ error: 'not_found' });
    }

    if (bot.status === 'running') {
      return reply.status(200).send({ status: 'already_running', botId: id });
    }

    // Resolve execution mode from config for capability validation
    const execConfig = (bot.config as Record<string, unknown> | undefined)?.['execution'] as Record<string, unknown> | undefined;
    const executionMode = (execConfig?.['mode'] as string | undefined) ?? 'paper';

    // Validate execution capability
    const [conn] = await db.select({ provider: connections.provider }).from(connections)
      .where(eq(connections.id, bot.connectionId));
    const botVenueType = conn ? venueTypeFromProvider(conn.provider) : undefined;
    if (botVenueType) {
      const capCheck = validateExecutionCapability({
        actorType: 'bot',
        executionMode: executionMode as 'paper' | 'shadow' | 'live',
        venueType: botVenueType,
      });
      if (!capCheck.ok) {
        return reply.status(400).send({
          error: `execution_capability.${capCheck.error.code}`,
          message: capCheck.error.message,
        });
      }
    }

    // Live-mode plan gate
    if (plansConfig && executionMode === 'live') {
      const liveCheck = checkLiveEnabled(plansConfig, request.userPlanId || 'free', request.isAdmin);
      if (!liveCheck.ok) {
        return reply.status(403).send({ error: liveCheck.error.code, message: liveCheck.error.message });
      }
    }

    // Enqueue start job on the lifecycle queue
    await queue.add('start-instance', {
      command: 'start',
      botId: id,
      config: { ...bot.config as Record<string, unknown>, connectionId: bot.connectionId, venueAccountId: bot.venueAccountId, userId: bot.userId },
    });

    return reply.status(202).send({ status: 'starting', botId: id });
  });
}
