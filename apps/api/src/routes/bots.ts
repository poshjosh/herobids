import type { FastifyInstance } from 'fastify';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import crypto from 'node:crypto';
import { z } from 'zod';
import { eq, and, or } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { connections, blueprints, blueprintRevisions } from '@herobids/db';
import type { PlansConfig } from '@herobids/domain';
import {
  CreateInstanceSchema,
  UpdateInstanceConfigSchema,
} from '../schemas.js';
import { checkLiveEnabled } from '../plan-guards.js';
import { errorPayload } from '../error-payload.js';
import { canonicalizeExecutionMode } from './agent-config-helpers.js';
import { INSTANCE_MESSAGE_TYPES, validateExecutionCapability, venueTypeFromProvider, AGENT_STREAM_MAXLEN } from '@herobids/domain';
import type { TradertonReadResult } from '@herobids/domain';
import type { TradertonClient, TradertonClientResult } from '@herobids/domain/traderton';
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

export async function botRoutes(app: FastifyInstance, queue: Queue<LifecycleJob>, db: Database, redis: Redis, plansConfig?: PlansConfig, tradertonClient?: TradertonClient): Promise<void> {
  // L3c: route a user-initiated bot side effect to the Traderton boundary,
  // injecting ownerId + actor(type:'user') ONLY (D2). Traderton owns bots + the
  // limit and resolves the venue account from the subject. Returns the typed
  // client result. NO silent fallback to the in-process lifecycle queue.
  const invokeBoundary = async (
    toolName: 'create_bot' | 'start_bot' | 'stop_bot' | 'adjust_bot_config' | 'delete_bot',
    payload: Record<string, unknown>,
    userId: string,
  ): Promise<TradertonClientResult> => {
    if (!tradertonClient) {
      return { kind: 'transport_error', requestId: '', retryable: true, message: 'trading boundary not configured' };
    }
    return tradertonClient.invoke({
      toolName,
      payload,
      subject: { ownerId: userId, actor: { type: 'user', id: userId } },
      deadlineMs: 30_000,
    });
  };

  // Bot READS route over the owner-scoped Traderton boundary tools
  // (`list_owner_bots` / `get_owner_bot_status` / ...). The read boundary is
  // present exactly when the write `tradertonClient` is — they share the same
  // transport + subject (ownerId + actor(user)); a read is a single synchronous
  // invoke. The boundary is MANDATORY: when it is absent or returns
  // transport_error/in_progress, callers surface a typed 503 precondition.not_ready
  // (no local `bots` mirror fallback). This mirrors the worker read-adapter's
  // client→read-result mapping (in_progress/transport_error become typed
  // retryable failures).
  const readBoundary = async (
    toolName:
      | 'list_owner_bots'
      | 'get_owner_bot_status'
      | 'get_owner_bot_costs'
      | 'get_owner_bot_sessions'
      | 'get_owner_bot_journal_summary'
      | 'get_owner_bot_journal',
    payload: Record<string, unknown>,
    userId: string,
  ): Promise<TradertonReadResult> => {
    if (!tradertonClient) {
      return { kind: 'transport_error', message: 'trading boundary not configured', retryable: true };
    }
    const result = await tradertonClient.invoke({
      toolName,
      payload,
      subject: { ownerId: userId, actor: { type: 'user', id: userId } },
      deadlineMs: 30_000,
    });
    switch (result.kind) {
      case 'success':
        return { kind: 'success', data: result.payload };
      case 'failure': {
        // The boundary dispatcher maps a tool's fault:false errorCode (e.g.
        // `not_found.resource`) onto the closed wire code `validation.invalid_payload`
        // and carries the ORIGINAL under `details.errorCode`. TradertonReadResult
        // has no `details` field, so unwrap it HERE: when the wire code is the
        // generic validation code and a tool errorCode is present, surface the
        // tool errorCode as `code` so the read handlers' not_found.resource → 404
        // mapping fires. (Mirrors accounts.ts `toolErrorCode` + the delete path.)
        const toolCode = result.details?.['errorCode'];
        const code = result.code === 'validation.invalid_payload' && typeof toolCode === 'string'
          ? toolCode
          : result.code;
        return { kind: 'failure', code, message: result.message, retryable: result.retryable };
      }
      case 'in_progress':
        return { kind: 'in_progress' };
      case 'transport_error':
        return { kind: 'transport_error', message: result.message, retryable: true };
    }
  };

  // Resolve a bot's existence + status + config + ownership for the lifecycle
  // handlers (DELETE/stop/start). The boundary is the sole source of truth
  // (owner-scoped: a bot not owned by this user resolves as not-found). When the
  // boundary is absent or transiently unavailable this resolves to
  // `{kind:'unavailable'}` (callers map that to a 503). The lifecycle ACTION
  // still routes over the write boundary — this only resolves the pre-action
  // existence/ownership/status gate.
  type ResolvedBot =
    | { kind: 'found'; status: string; config: Record<string, unknown> }
    | { kind: 'not_found' }
    | { kind: 'unavailable' };
  const resolveBotForLifecycle = async (id: string, userId: string): Promise<ResolvedBot> => {
    const result = await readBoundary('get_owner_bot_status', { botId: id }, userId);
    if (result.kind === 'success') {
      const data = (result.data ?? {}) as Record<string, unknown>;
      const status = typeof data['status'] === 'string' ? data['status'] : 'stopped';
      const config = (data['config'] as Record<string, unknown> | undefined) ?? {};
      return { kind: 'found', status, config };
    }
    if (result.kind === 'failure') {
      return result.code === 'not_found.resource' ? { kind: 'not_found' } : { kind: 'unavailable' };
    }
    return { kind: 'unavailable' };
  };

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

    const botExecutionMode = (resolvedConfig['execution'] as Record<string, unknown> | undefined)?.['mode'] as string | undefined;

    // Live-mode plan gate (a platform plan/entitlement check — KEPT). The
    // trading-config validation (BotConfigSchema) + execution-capability check
    // MOVE behind the boundary (Traderton's copied create_bot owns them). maxBots
    // (checkBotLimit) is DROPPED — Traderton owns the limit (#4). See
    // 004-l3d-plan.md §C/§D.
    if (plansConfig && botExecutionMode === 'live') {
      const liveCheck = checkLiveEnabled(plansConfig, request.userPlanId || 'free', request.isAdmin);
      if (!liveCheck.ok) {
        return reply.status(403).send({ error: liveCheck.error.code, message: liveCheck.error.message });
      }
    }

    // Platform authz (KEPT): verify the connection belongs to this user before
    // acting. It is NOT injected into the envelope (D2) — herobids injects
    // ownerId + actor only; Traderton resolves the venue account from the subject.
    const [conn] = await db.select({ id: connections.id, resolvedVenueAccountId: connections.resolvedVenueAccountId }).from(connections)
      .where(and(eq(connections.id, connectionId), eq(connections.userId, request.userId)));
    if (!conn) {
      return reply.status(404).send({ error: 'not_found', message: 'Connection not found' });
    }

    // L3c: create the bot over the Traderton boundary — no bots-table write, no
    // maxBots, no venue-stamp (#4/D2). connectionId is forwarded so Traderton can
    // resolve the account grant. NO silent fallback to a local insert.
    const result = await invokeBoundary('create_bot', {
      connectionId,
      config: resolvedConfig,
      ...(blueprintId ? { blueprintId } : {}),
      ...(configSnapshot ? { configSnapshot } : {}),
    }, request.userId);

    if (result.kind === 'transport_error') {
      return reply.status(503).send(errorPayload('precondition.not_ready', 'Trading service is unavailable — the bot was not created.', {}));
    }
    if (result.kind === 'in_progress') {
      return reply.status(503).send(errorPayload('boundary.in_progress', 'Bot creation did not complete in time. Please retry.', {}));
    }
    if (result.kind === 'failure') {
      const status = result.code === 'validation.invalid_payload' ? 400
        : result.code === 'authorization.denied' ? 403
        : result.code === 'not_found.resource' ? 404
        : result.code === 'rate_limit.exceeded' ? 429
        : 502;
      // B1: preserve the paper_swap identity. When the boundary rejects a
      // paper+swap config, its `details.errorCode` names the specific
      // execution-capability violation. Surface THAT code/message in the 400 so
      // the client sees the paper_swap identity, not a generic validation error.
      const paperSwapCode = result.details?.['errorCode'];
      if (paperSwapCode === 'execution_capability.paper_swap_not_supported') {
        return reply.status(status).send(errorPayload(
          'execution_capability.paper_swap_not_supported',
          result.message,
          {},
        ));
      }
      return reply.status(status).send(errorPayload(result.code, result.message, {}));
    }

    // Notify callers using the deprecated inline config field to migrate to blueprintId.
    if (usingDeprecatedInlineConfig) {
      void reply.header('Deprecation', 'true');
      void reply.header('Link', '</blueprints>; rel="deprecation"; title="Use blueprintId instead of config"');
    }
    // A1: the create_bot boundary success carries `botId`. Return 201 with the
    // payload, ensuring an `id` field is present (existing clients/tests read
    // `.id`). Keep `botId` too so callers reading either key work.
    const createPayload = (result.payload ?? {}) as Record<string, unknown>;
    const createdBotId = createPayload['botId'] ?? createPayload['id'];
    return reply.status(201).send({
      ...createPayload,
      ...(createdBotId !== undefined ? { id: createdBotId, botId: createdBotId } : {}),
    });
  });

  // Update bot config
  app.patch<{ Params: { id: string } }>('/bots/:id/config', async (request, reply) => {
    const { id } = request.params;
    const parsed = UpdateInstanceConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    // Resolve the bot's existence + current status/config + creator over the
    // owner-scoped boundary read (ruling 1). Owner-scoped: a bot not owned by
    // this user resolves as not_found → 404. The boundary is mandatory —
    // absent/transport/in_progress → 503.
    const existingResult = await readBoundary('get_owner_bot_status', { botId: id }, request.userId);
    if (existingResult.kind === 'failure') {
      if (existingResult.code === 'not_found.resource') {
        return reply.status(404).send({ error: 'not_found' });
      }
      return reply.status(502).send(errorPayload(existingResult.code, existingResult.message, {}));
    }
    if (existingResult.kind !== 'success') {
      return reply.status(503).send(errorPayload('precondition.not_ready', 'Trading service is unavailable — the config change was not applied.', {}));
    }
    const existingData = (existingResult.data ?? {}) as Record<string, unknown>;
    const existingConfig = (existingData['config'] as Record<string, unknown> | undefined) ?? {};
    const existingCreatorType = existingData['creatorType'] as string | undefined;
    const existingCreatorId = existingData['creatorId'] as string | undefined;

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

    // Validate execution capability for the updated config against the bot's venue
    // type. The bot's venue is carried in its persisted config (stamped from the
    // connection at create via normalizeBotConfig); the boundary surfaces it as
    // `config.venue`, so we derive the venue type from there — the boundary read
    // does not return a connectionId, and config.venue is the same value the
    // connection.provider lookup previously resolved.
    if (newExecutionMode) {
      const existingVenue = existingConfig['venue'];
      const botVenueType = typeof existingVenue === 'string' ? venueTypeFromProvider(existingVenue) : undefined;
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

    // Notify the agent when a user changes an agent-created bot's execution mode.
    if (existingCreatorType === 'agent' && existingCreatorId && newExecutionMode) {
      const previousMode = existingConfig['execution'] as Record<string, unknown> | undefined;
      const prevMode = typeof previousMode?.['mode'] === 'string' ? previousMode['mode'] : null;
      if (prevMode !== newExecutionMode) {
        const streamKey = `agent:inbound:${existingCreatorId}`;
        const envelope = {
          schemaVersion: 'v1',
          messageId: crypto.randomUUID(),
          correlationId: crypto.randomUUID(),
          initiatorType: 'system',
          initiatorId: 'api',
          agentId: existingCreatorId,
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

    // Apply the config change over the boundary — Traderton owns the bot config
    // and persists it for ANY status (it enforces mode-escalation internally),
    // so this runs unconditionally. herobids injects ownerId + actor(user) only
    // (D2). The boundary is authoritative — there is NO local bots-table write.
    const adjustResult = await invokeBoundary('adjust_bot_config', {
      botId: id,
      config: parsed.data.config,
    }, request.userId);
    if (adjustResult.kind === 'transport_error' || adjustResult.kind === 'in_progress') {
      return reply.status(503).send(errorPayload('precondition.not_ready', 'Trading service is unavailable — the config change was not applied.', {}));
    }
    if (adjustResult.kind === 'failure') {
      const status = adjustResult.code === 'validation.invalid_payload' ? 400
        : adjustResult.code === 'authorization.denied' ? 403
        : adjustResult.code === 'not_found.resource' ? 404
        : 502;
      return reply.status(status).send(errorPayload(adjustResult.code, adjustResult.message, {}));
    }

    return reply.send({ status: 'updated', botId: id });
  });

  // List bots — routed over the owner-scoped boundary read (ruling 1). Traderton
  // owns the bots; the boundary returns owner-scoped summaries. The boundary is
  // mandatory — absent/transport/in_progress → 503 precondition.not_ready.
  app.get('/bots', async (request, reply) => {
    const result = await readBoundary('list_owner_bots', {}, request.userId);
    if (result.kind === 'success') {
      const data = (result.data ?? {}) as Record<string, unknown>;
      const list = Array.isArray(data['bots']) ? (data['bots'] as unknown[]) : [];
      return reply.send({ bots: list });
    }
    if (result.kind === 'transport_error' || result.kind === 'in_progress') {
      return reply.status(503).send(errorPayload('precondition.not_ready', 'Trading service is unavailable — could not list bots.', {}));
    }
    return reply.status(502).send(errorPayload(result.code, result.message, {}));
  });

  // Get single bot — routed over the owner-scoped boundary read (ruling 1). A
  // boundary not-found (the bot does not exist or is not owned by this user)
  // maps to 404. The boundary is mandatory — absent/transport/in_progress → 503.
  app.get<{ Params: { id: string } }>('/bots/:id', async (request, reply) => {
    const { id } = request.params;
    const result = await readBoundary('get_owner_bot_status', { botId: id }, request.userId);
    if (result.kind === 'success') {
      return reply.send((result.data ?? {}) as Record<string, unknown>);
    }
    if (result.kind === 'failure') {
      if (result.code === 'not_found.resource') {
        return reply.status(404).send({ error: 'not_found' });
      }
      return reply.status(502).send(errorPayload(result.code, result.message, {}));
    }
    return reply.status(503).send(errorPayload('precondition.not_ready', 'Trading service is unavailable — could not fetch the bot.', {}));
  });

  // GET /bots/:id/costs — total fees from fills for this bot.
  // Wave A2: routed over the owner-scoped boundary read (`get_owner_bot_costs`).
  // Aggregation stays in Traderton — the boundary returns the identical
  // `{ botId, feesByCurrency }` shape; herobids is a thin pass-through.
  // not_found.resource → 404; other failure → 502; the boundary is mandatory —
  // absent/transport/in_progress → 503.
  app.get<{ Params: { id: string } }>('/bots/:id/costs', async (request, reply) => {
    const { id } = request.params;
    const result = await readBoundary('get_owner_bot_costs', { botId: id }, request.userId);
    if (result.kind === 'success') {
      const data = (result.data ?? {}) as Record<string, unknown>;
      return reply.send({ botId: id, feesByCurrency: data['feesByCurrency'] ?? {} });
    }
    if (result.kind === 'failure') {
      if (result.code === 'not_found.resource') {
        return reply.status(404).send({ error: 'not_found' });
      }
      return reply.status(502).send(errorPayload(result.code, result.message, {}));
    }
    return reply.status(503).send(errorPayload('precondition.not_ready', 'Trading service is unavailable — could not fetch bot costs.', {}));
  });

  // GET /bots/:id/sessions — lifecycle sessions derived by pairing instance.started / instance.stopped events.
  // Wave A2: routed over the owner-scoped boundary read (`get_owner_bot_sessions`).
  // The boundary applies the SAME limit/offset clamping and returns the identical
  // `{ botId, sessions, limit, offset }` shape; herobids is a thin pass-through.
  // The boundary is mandatory — absent/transport/in_progress → 503.
  app.get<{ Params: { id: string }; Querystring: { limit?: string; offset?: string } }>('/bots/:id/sessions', async (request, reply) => {
    const { id } = request.params;
    const limit = Math.min(parseInt(request.query.limit ?? '20', 10), 100);
    const offset = parseInt(request.query.offset ?? '0', 10);

    const result = await readBoundary('get_owner_bot_sessions', { botId: id, limit, offset }, request.userId);
    if (result.kind === 'success') {
      const data = (result.data ?? {}) as Record<string, unknown>;
      return reply.send({
        botId: id,
        sessions: data['sessions'] ?? [],
        limit: data['limit'] ?? limit,
        offset: data['offset'] ?? offset,
      });
    }
    if (result.kind === 'failure') {
      if (result.code === 'not_found.resource') {
        return reply.status(404).send({ error: 'not_found' });
      }
      return reply.status(502).send(errorPayload(result.code, result.message, {}));
    }
    return reply.status(503).send(errorPayload('precondition.not_ready', 'Trading service is unavailable — could not fetch bot sessions.', {}));
  });

  // GET /bots/:id/events — recent journal events for this bot.
  // Wave A2: routed over the owner-scoped boundary read (`get_owner_bot_journal`,
  // called with just `limit` — the /events call shape). Response shape
  // `{ botId, events }` is preserved. The boundary is mandatory —
  // absent/transport/in_progress → 503.
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/bots/:id/events', async (request, reply) => {
    const { id } = request.params;
    const limit = Math.min(parseInt(request.query.limit ?? '50', 10), 500);

    const result = await readBoundary('get_owner_bot_journal', { botId: id, limit }, request.userId);
    if (result.kind === 'success') {
      const data = (result.data ?? {}) as Record<string, unknown>;
      return reply.send({ botId: id, events: data['events'] ?? [] });
    }
    if (result.kind === 'failure') {
      if (result.code === 'not_found.resource') {
        return reply.status(404).send({ error: 'not_found' });
      }
      return reply.status(502).send(errorPayload(result.code, result.message, {}));
    }
    return reply.status(503).send(errorPayload('precondition.not_ready', 'Trading service is unavailable — could not fetch bot events.', {}));
  });

  // GET /bots/:id/journal — paginated journal events with optional type filter.
  // Wave A2: routed over the owner-scoped boundary read (`get_owner_bot_journal`,
  // called with type + limit + offset). Response shape
  // `{ botId, events, limit, offset }` is preserved — the same journal tool
  // serves BOTH /events and /journal. The boundary is mandatory —
  // absent/transport/in_progress → 503.
  app.get<{ Params: { id: string }; Querystring: { limit?: string; offset?: string; type?: string } }>('/bots/:id/journal', async (request, reply) => {
    const { id } = request.params;
    const limit = Math.min(parseInt(request.query.limit ?? '50', 10), 200);
    const offset = parseInt(request.query.offset ?? '0', 10);

    const result = await readBoundary('get_owner_bot_journal', { botId: id, type: request.query.type, limit, offset }, request.userId);
    if (result.kind === 'success') {
      const data = (result.data ?? {}) as Record<string, unknown>;
      return reply.send({ botId: id, events: data['events'] ?? [], limit, offset });
    }
    if (result.kind === 'failure') {
      if (result.code === 'not_found.resource') {
        return reply.status(404).send({ error: 'not_found' });
      }
      return reply.status(502).send(errorPayload(result.code, result.message, {}));
    }
    return reply.status(503).send(errorPayload('precondition.not_ready', 'Trading service is unavailable — could not fetch the bot journal.', {}));
  });

  // GET /bots/:id/journal/summary — aggregate stats from fills for this bot.
  // Wave A2: routed over the owner-scoped boundary read
  // (`get_owner_bot_journal_summary`). Response shape
  // `{ botId, tradeCount, feesByCurrency }` is preserved. The boundary is
  // mandatory — absent/transport/in_progress → 503.
  app.get<{ Params: { id: string } }>('/bots/:id/journal/summary', async (request, reply) => {
    const { id } = request.params;
    const result = await readBoundary('get_owner_bot_journal_summary', { botId: id }, request.userId);
    if (result.kind === 'success') {
      const data = (result.data ?? {}) as Record<string, unknown>;
      return reply.send({
        botId: id,
        tradeCount: data['tradeCount'] ?? 0,
        feesByCurrency: data['feesByCurrency'] ?? {},
      });
    }
    if (result.kind === 'failure') {
      if (result.code === 'not_found.resource') {
        return reply.status(404).send({ error: 'not_found' });
      }
      return reply.status(502).send(errorPayload(result.code, result.message, {}));
    }
    return reply.status(503).send(errorPayload('precondition.not_ready', 'Trading service is unavailable — could not fetch the bot journal summary.', {}));
  });

  // ── Bot Lifecycle Endpoints ──────────────────────────────────────────

  // DELETE /bots/:id — delete a stopped or crashed bot
  app.delete<{ Params: { id: string } }>('/bots/:id', async (request, reply) => {
    const { id } = request.params;

    // Existence + ownership + status gate over the boundary (ruling 1). The
    // boundary resolves existence/ownership so the ownership check is NOT
    // weakened; when it is absent/unavailable this gate fails closed (503).
    //
    // The `delete_bot` boundary tool is AUTHORITATIVE. The delete routes over the
    // boundary (fail-closed, 503 when absent — same posture as create/stop/start).
    const resolved = await resolveBotForLifecycle(id, request.userId);
    if (resolved.kind === 'unavailable') {
      return reply.status(503).send(errorPayload('precondition.not_ready', 'Trading service is unavailable — the bot was not deleted.', {}));
    }
    if (resolved.kind === 'not_found') {
      return reply.status(404).send({ error: 'not_found' });
    }

    if (resolved.status === 'running') {
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

    // Wave A1 (S4/S5): the AUTHORITATIVE delete over the boundary. herobids
    // injects ownerId + actor(user) only (D2); Traderton owns the bot. NO silent
    // fallback — a missing boundary fails closed (503). The running-guard code
    // rides in the boundary failure `details.errorCode` (`bot.running`), mapped
    // to 409 here (mirrors how create/stop preserve dedicated codes).
    const deleteResult = await invokeBoundary('delete_bot', { botId: id }, request.userId);
    if (deleteResult.kind === 'transport_error' || deleteResult.kind === 'in_progress') {
      return reply.status(503).send(errorPayload('precondition.not_ready', 'Trading service is unavailable — the bot was not deleted.', {}));
    }
    if (deleteResult.kind === 'failure') {
      const runningCode = deleteResult.details?.['errorCode'];
      const status = runningCode === 'bot.running' ? 409
        : deleteResult.code === 'not_found.resource' ? 404
        : deleteResult.code === 'authorization.denied' ? 403
        : 502;
      if (status === 409) {
        return reply.status(409).send(errorPayload('bot.running', deleteResult.message, {}));
      }
      return reply.status(status).send(errorPayload(deleteResult.code, deleteResult.message, {}));
    }

    // The authoritative delete over the boundary succeeded — Traderton owns the
    // removal, so there is nothing left to do here.
    return reply.status(204).send();
  });

  // POST /bots/:id/stop — stop a running bot (idempotent)
  app.post<{ Params: { id: string } }>('/bots/:id/stop', async (request, reply) => {
    const { id } = request.params;

    // Existence + ownership + status gate over the boundary (ruling 1). The stop
    // ACTION still routes over the write boundary; the gate fails closed (503)
    // when the boundary is absent/unavailable.
    const resolved = await resolveBotForLifecycle(id, request.userId);
    if (resolved.kind === 'unavailable') {
      return reply.status(503).send(errorPayload('precondition.not_ready', 'Trading service is unavailable — the bot was not stopped.', {}));
    }
    if (resolved.kind === 'not_found') {
      return reply.status(404).send({ error: 'not_found' });
    }

    // Already in a terminal state — no-op to preserve crash forensic data
    if (resolved.status === 'stopped' || resolved.status === 'crashed') {
      return reply.status(200).send({ status: 'already_stopped', botId: id });
    }

    // L3c: stop over the boundary instead of the lifecycle queue. herobids
    // injects ownerId + actor(user) only (D2); Traderton owns the bot. NO silent
    // fallback to the queue.
    const stopResult = await invokeBoundary('stop_bot', { botId: id }, request.userId);
    if (stopResult.kind === 'transport_error' || stopResult.kind === 'in_progress') {
      return reply.status(503).send(errorPayload('precondition.not_ready', 'Trading service is unavailable — the bot was not stopped.', {}));
    }
    if (stopResult.kind === 'failure') {
      const status = stopResult.code === 'authorization.denied' ? 403
        : stopResult.code === 'not_found.resource' ? 404
        : 502;
      return reply.status(status).send(errorPayload(stopResult.code, stopResult.message, {}));
    }

    return reply.status(202).send({ status: 'stopping', botId: id });
  });

  // POST /bots/:id/start — start a stopped or crashed bot (idempotent)
  app.post<{ Params: { id: string } }>('/bots/:id/start', async (request, reply) => {
    const { id } = request.params;

    // Existence + ownership + status gate over the boundary (ruling 1). The start
    // ACTION still routes over the write boundary; the gate fails closed (503)
    // when the boundary is absent/unavailable.
    const resolved = await resolveBotForLifecycle(id, request.userId);
    if (resolved.kind === 'unavailable') {
      return reply.status(503).send(errorPayload('precondition.not_ready', 'Trading service is unavailable — the bot was not started.', {}));
    }
    if (resolved.kind === 'not_found') {
      return reply.status(404).send({ error: 'not_found' });
    }

    if (resolved.status === 'running') {
      return reply.status(200).send({ status: 'already_running', botId: id });
    }

    // L3c: maxBots is DROPPED (#4 — Traderton owns the limit); the execution-
    // capability + config-preflight validations MOVE behind the boundary. The
    // live-mode plan gate (a platform entitlement check) is KEPT.
    const execConfig = resolved.config['execution'] as Record<string, unknown> | undefined;
    const executionMode = (execConfig?.['mode'] as string | undefined) ?? 'paper';
    if (plansConfig && executionMode === 'live') {
      const liveCheck = checkLiveEnabled(plansConfig, request.userPlanId || 'free', request.isAdmin);
      if (!liveCheck.ok) {
        return reply.status(403).send({ error: liveCheck.error.code, message: liveCheck.error.message });
      }
    }

    // L3c: start over the boundary instead of the lifecycle queue. NO silent
    // fallback to the queue.
    const startResult = await invokeBoundary('start_bot', { botId: id }, request.userId);
    if (startResult.kind === 'transport_error' || startResult.kind === 'in_progress') {
      return reply.status(503).send(errorPayload('precondition.not_ready', 'Trading service is unavailable — the bot was not started.', {}));
    }
    if (startResult.kind === 'failure') {
      const status = startResult.code === 'validation.invalid_payload' ? 400
        : startResult.code === 'authorization.denied' ? 403
        : startResult.code === 'not_found.resource' ? 404
        : startResult.code === 'rate_limit.exceeded' ? 429
        : 502;
      return reply.status(status).send(errorPayload(startResult.code, startResult.message, {}));
    }

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

    // Resolve the bot's config over the owner-scoped boundary read (ruling 1).
    // Owner-scoped: a bot not owned by this user resolves as not_found → 404.
    // The boundary is mandatory — absent/transport/in_progress → 503.
    const botResult = await readBoundary('get_owner_bot_status', { botId: request.params.id }, request.userId);
    if (botResult.kind === 'failure') {
      if (botResult.code === 'not_found.resource') {
        return reply.status(404).send({ error: 'not_found', message: 'Bot not found' });
      }
      return reply.status(502).send(errorPayload(botResult.code, botResult.message, {}));
    }
    if (botResult.kind !== 'success') {
      return reply.status(503).send(errorPayload('precondition.not_ready', 'Trading service is unavailable — could not fetch the bot.', {}));
    }
    const botData = (botResult.data ?? {}) as Record<string, unknown>;
    const botConfig = (botData['config'] as Record<string, unknown> | undefined) ?? {};

    // Project bot to blueprint payload
    const payload = projectBotToBlueprintPayload({
      name: (botConfig['name'] as string) ?? '',
      config: botConfig,
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
