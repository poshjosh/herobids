import type { FastifyInstance } from 'fastify';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import crypto from 'node:crypto';
import { z } from 'zod';
import { eq, and, sql, sum, asc, inArray, or } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { bots, connections, blueprints, blueprintRevisions, PgJournal, fills, journalEvents, agents } from '@herobids/db';
import type { PlansConfig, AgentRiskDefaultsConfig } from '@herobids/domain';
import {
  CreateInstanceSchema,
  UpdateInstanceConfigSchema,
} from '../schemas.js';
import { checkBotLimit, checkLiveEnabled } from '../plan-guards.js';
import { errorPayload } from '../error-payload.js';
import { canonicalizeExecutionMode } from './agent-config-helpers.js';
import { BotConfigSchema, INSTANCE_MESSAGE_TYPES, validateExecutionCapability, venueTypeFromProvider, AGENT_STREAM_MAXLEN } from '@herobids/domain';
import { projectBotToBlueprintPayload } from '../services/blueprint-projection.js';
import { buildBlueprintDetail } from './blueprints.js';
import type { LifecycleJob } from '../types.js';

function normalizeBotConfig(config: Record<string, unknown>, venue: string, symbol: string): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    ...config,
    venue,
    symbol,
  };
  const venueType = venueTypeFromProvider(venue);
  if (venueType !== undefined && normalized['venueType'] === undefined) {
    normalized['venueType'] = venueType;
  }
  return normalized;
}

export async function botRoutes(app: FastifyInstance, queue: Queue<LifecycleJob>, db: Database, redis: Redis, plansConfig?: PlansConfig, agentRiskDefaults?: AgentRiskDefaultsConfig): Promise<void> {
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
        .select({ id: blueprints.id, configData: blueprintRevisions.payload })
        .from(blueprints)
        .innerJoin(blueprintRevisions, eq(blueprints.currentRevisionId, blueprintRevisions.id))
        .where(and(
          eq(blueprints.id, parsed.data.blueprintId),
          or(eq(blueprints.authorId, request.userId), eq(blueprints.publicationStatus, 'published')),
        ));
      if (!bp) {
        return reply.status(404).send({ error: 'not_found', message: 'Blueprint not found' });
      }
      const base = bp.configData as Record<string, unknown>;
      const overrides = parsed.data.configOverrides ?? {};
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
      resolvedConfig = parsed.data.config ?? {};
    }

    resolvedConfig = normalizeBotConfig(resolvedConfig, parsed.data.venue, parsed.data.symbol);

    // Pass-through canonical execution mode; non-canonical values (including `test`)
    // will be rejected by BotConfigSchema validation below.
    const rawExecutionMode = (resolvedConfig['execution'] as Record<string, unknown> | undefined)?.['mode'] as string | undefined;
    if (rawExecutionMode) {
      const canonical = canonicalizeExecutionMode(rawExecutionMode, { hasConnections: true });
      if (canonical !== rawExecutionMode && typeof canonical === 'string') {
        const exec = (resolvedConfig['execution'] ?? {}) as Record<string, unknown>;
        exec['mode'] = canonical;
        resolvedConfig['execution'] = exec;
      }
    }

    const configCheck = BotConfigSchema.safeParse(resolvedConfig);
    if (!configCheck.success) {
      return reply.status(400).send({ error: 'validation_error', details: configCheck.error.issues });
    }

    const id = crypto.randomUUID();
    const now = new Date();

    const botExecutionMode = (resolvedConfig['execution'] as Record<string, unknown> | undefined)?.['mode'] as string | undefined;

    // Validate execution capability for the bot's venue + mode combination
    const botVenueType = venueTypeFromProvider(parsed.data.venue);
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
    return reply.status(201).send(bot as Record<string, unknown>);
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

    // Pass-through canonical execution mode; non-canonical values (including `test`)
    // will be rejected by BotConfigSchema validation. Bots always require a venue.
    let newExecutionMode = (parsed.data.config['execution'] as Record<string, unknown> | undefined)?.['mode'] as string | undefined;
    if (newExecutionMode) {
      const canonical = canonicalizeExecutionMode(newExecutionMode, { hasConnections: true });
      if (canonical !== newExecutionMode && typeof canonical === 'string') {
        newExecutionMode = canonical;
        // Write the canonical value back so the DB stores the concrete mode
        const exec = (parsed.data.config['execution'] ?? {}) as Record<string, unknown>;
        exec['mode'] = canonical;
        parsed.data.config['execution'] = exec;
      }
    }

    // Validate execution capability for the updated config against the bot's venue type
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

    // Notify the agent when a user changes an agent-created bot's execution mode.
    if (existing.creatorType === 'agent' && existing.creatorId && newExecutionMode) {
      const previousMode = (existing.config as Record<string, unknown>)?.['execution'] as Record<string, unknown> | undefined;
      const prevMode = typeof previousMode?.['mode'] === 'string' ? previousMode['mode'] : null;
      if (prevMode !== newExecutionMode) {
        const streamKey = `agent:inbound:${existing.creatorId}`;
        const envelope = {
          schemaVersion: 'v1',
          messageId: crypto.randomUUID(),
          correlationId: crypto.randomUUID(),
          initiatorType: 'system',
          initiatorId: 'api',
          agentId: existing.creatorId,
          type: INSTANCE_MESSAGE_TYPES.BOT_CONFIG_CHANGED,
          createdAt: new Date().toISOString(),
          payload: {
            botId: id,
            changedBy: 'user',
            previousExecutionMode: prevMode,
            newExecutionMode,
            changedAt: new Date().toISOString(),
          },
        };
        redis.xadd(streamKey, 'MAXLEN', '~', AGENT_STREAM_MAXLEN, '*', 'envelope', JSON.stringify(envelope)).catch(() => {
          // Fire-and-forget — don't block the API response on notification delivery.
        });
      }
    }

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
    return reply.send({ bots: botList.map((b) => b as Record<string, unknown>) });
  });

  // Get single bot
  app.get<{ Params: { id: string } }>('/bots/:id', async (request, reply) => {
    const { id } = request.params;
    const [bot] = await db.select().from(bots).where(and(eq(bots.id, id), eq(bots.userId, request.userId)));
    if (!bot) {
      return reply.status(404).send({ error: 'not_found' });
    }
    return reply.send(bot as Record<string, unknown>);
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

    // Enforce agent-level maxBots limit for agent-created bots.
    // Non-agent bots (user-created, system) are not subject to this limit.
    if (bot.creatorType === 'agent' && bot.creatorId) {
      const [agentRow] = await db.select({ maxBots: agents.maxBots })
        .from(agents)
        .where(eq(agents.id, bot.creatorId))
        .limit(1);
      const maxBots = agentRow?.maxBots ?? agentRiskDefaults?.maxBots ?? 5;
      const runningRows = await db
        .select({ id: bots.id })
        .from(bots)
        .where(and(
          eq(bots.creatorType, 'agent'),
          eq(bots.creatorId, bot.creatorId),
          eq(bots.status, 'running'),
        ));
      if (runningRows.length >= maxBots) {
        return reply.status(409).send({
          error: 'max_bots_reached',
          message: `Agent has reached its max concurrent bots limit (${maxBots}). Stop a bot before starting a new one.`,
        });
      }
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

    // Preflight: validate persisted config before enqueuing start.
    // A persisted invalid config (legacy, corrupted, etc.) must not be pushed
    // through start → fail → retry cycles.
    const configCheck = BotConfigSchema.safeParse(bot.config as Record<string, unknown>);
    if (!configCheck.success) {
      return reply.status(400).send({
        error: 'config_invalid',
        message: 'Bot config is invalid — cannot start. Fix the config before retrying.',
        details: configCheck.error.issues,
      });
    }

    // Enqueue start job on the lifecycle queue
    await queue.add('start-instance', {
      command: 'start',
      botId: id,
      config: { ...bot.config as Record<string, unknown>, connectionId: bot.connectionId, venueAccountId: bot.venueAccountId, userId: bot.userId },
    });

    return reply.status(202).send({ status: 'starting', botId: id });
  });

  // POST /bots/:id/blueprints — create a draft blueprint from an existing bot
  app.post<{ Params: { id: string }; Body: unknown }>('/bots/:id/blueprints', async (request, reply) => {
    const parsing = z.object({
      name: z.string().min(1).optional(),
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
    }).safeParse(request.body ?? {});
    if (!parsing.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsing.error.issues });
    }

    // Find bot owned by user
    const [bot] = await db.select().from(bots)
      .where(and(eq(bots.id, request.params.id), eq(bots.userId, request.userId)))
      .limit(1);
    if (!bot) {
      return reply.status(404).send({ error: 'not_found', message: 'Bot not found' });
    }

    // Project bot to blueprint payload
    const payload = projectBotToBlueprintPayload({
      name: ((bot.config as Record<string, unknown>)['name'] as string) ?? '',
      config: bot.config as Record<string, unknown>,
    });

    // Override name/description/tags from request body if provided
    if (parsing.data.name) payload.name = parsing.data.name;
    if (parsing.data.description) payload.description = parsing.data.description;
    if (parsing.data.tags) payload.tags = parsing.data.tags;

    // Bot blueprints do not have skill dependencies in Phase 1

    const blueprintId = crypto.randomUUID();
    const revisionId = crypto.randomUUID();
    const now = new Date();

    // Derive facets from payload
    const bpName = payload.name;
    const bpDescription = payload.description;
    const bpTags = payload.tags;
    const bpStrategyType = (payload.strategy?.type as string | undefined) ?? null;
    const bpVenueType = payload.venueType;

    await db.transaction(async (tx) => {
      // Insert blueprint (draft)
      await tx.insert(blueprints).values({
        id: blueprintId,
        authorId: request.userId,
        publicationStatus: 'draft',
        kind: 'bot',
        name: bpName,
        description: bpDescription,
        strategyType: bpStrategyType,
        style: null,
        tags: bpTags,
        venueType: bpVenueType,
        currentRevisionId: revisionId,
        createdAt: now,
        updatedAt: now,
      });

      // Insert revision 1
      await tx.insert(blueprintRevisions).values({
        id: revisionId,
        blueprintId,
        version: 1,
        kind: 'bot',
        name: bpName,
        description: bpDescription,
        strategyType: bpStrategyType,
        style: null,
        tags: bpTags,
        venueType: bpVenueType,
        payload,
        createdByUserId: request.userId,
        createdAt: now,
      });
    });

    const [bp] = await db.select().from(blueprints).where(eq(blueprints.id, blueprintId)).limit(1);
    const [rev] = await db.select().from(blueprintRevisions).where(eq(blueprintRevisions.id, revisionId)).limit(1);
    if (!bp || !rev) {
      return reply.status(500).send({ error: 'internal_error', message: 'Failed to create blueprint' });
    }
    const detail = await buildBlueprintDetail(db, bp, rev);
    return reply.status(201).send(detail);
  });
}
