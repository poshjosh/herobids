import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import crypto from 'node:crypto';
import { z } from 'zod';
import { eq, and, inArray } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { agents, bots, fills } from '@herobids/db';
import type { AlertsConfig } from '@herobids/domain';
import {
  CostPresetSchema,
  decorateAgentResponse,
  hasModelFieldsWithoutProvider,
  mergeModelPolicy,
  nullablePositiveDecimalStringSchema,
  nullablePositiveIntegerSchema,
  resolveDailyLlmTokenBudget,
  resolveExecutionModeForSkills,
  validateAgentModelPolicy,
} from './agent-config-helpers.js';

// --- Schemas ---

const SendMessageSchema = z.object({
  message: z.string().min(1).max(4000),
});

const VerifyTelegramSchema = z.object({
  chatId: z.string().min(1),
});

const UpdateAgentSchema = z.object({
  name: z.string().min(1).max(100),
  prompt: z.string().min(1).max(4000),
  skillIds: z.array(z.string().min(1)).optional(),
  toolPolicy: z.record(z.unknown()).optional(),
  modelPolicy: z.record(z.unknown()).optional(),
  provider: z.string().min(1).max(200).nullable().optional(),
  lightModel: z.string().min(1).max(200).nullable().optional(),
  heavyModel: z.string().min(1).max(200).nullable().optional(),
  costPreset: CostPresetSchema.nullable().optional(),
  dailySpendBudgetUsd: z.number().positive().nullable().optional(),
  dexWatchlistSymbols: z.array(z.string().min(1).max(64)).max(25).nullable().optional(),
  telegramChatId: z.string().nullable().optional(),
  executionMode: z.enum(['paper', 'shadow', 'live']).nullable().optional(),
  dailyTokenBudget: nullablePositiveIntegerSchema(),
  dailyLlmTokenBudget: nullablePositiveIntegerSchema(),
  dailyLossLimit: nullablePositiveDecimalStringSchema,
  maxBots: nullablePositiveIntegerSchema(),
  maxSlippageBps: nullablePositiveIntegerSchema(0),
  tickIntervalMs: nullablePositiveIntegerSchema(1000),
  capital: nullablePositiveDecimalStringSchema,
});

// --- Route module ---

export async function agentInteractivityRoutes(
  app: FastifyInstance,
  db: Database,
  redisClient: Redis,
  alertsConfig?: AlertsConfig,
): Promise<void> {
  const telegramToken = alertsConfig?.telegram?.botToken ?? '';

  // PUT /agents/:id — full replacement update (agent must be stopped or crashed)
  app.put<{ Params: { id: string }; Body: unknown }>('/agents/:id', async (request, reply) => {
    const { id } = request.params;
    const parsed = UpdateAgentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const dailyLlmTokenBudget = resolveDailyLlmTokenBudget(parsed.data);
    if (dailyLlmTokenBudget.issue) {
      return reply.status(400).send({ error: 'validation_error', details: [dailyLlmTokenBudget.issue] });
    }

    if (hasModelFieldsWithoutProvider(parsed.data)) {
      return reply.status(400).send({
        error: 'validation_error',
        details: [{ code: 'custom', path: ['provider'], message: 'Provider is required when economy or premium model fields are set' }],
      });
    }

    const [agent] = await db.select().from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) return reply.status(404).send({ error: 'not_found' });

    if (agent.status !== 'stopped') {
      return reply.status(409).send({
        error: 'agent_not_editable',
        message: `Agent config can only be updated when stopped (current status: ${agent.status}).`,
      });
    }

    const mergedSkillIds = parsed.data.skillIds ?? agent.skillIds ?? [];
    const basePolicy: Record<string, unknown> = parsed.data.toolPolicy !== undefined
      ? { ...parsed.data.toolPolicy }
      : { ...((agent.toolPolicy as Record<string, unknown> | null) ?? {}) };
    if (mergedSkillIds.includes('bot-management') && !basePolicy['manage_bot']) {
      basePolicy['manage_bot'] = {
        capability: 'manage_bot',
        tier: 'brokered',
        enabled: true,
        limits: { maxPerMinute: 5, maxConcurrent: 1, timeoutMs: 30_000 },
      };
    } else if (!mergedSkillIds.includes('bot-management') && !(parsed.data.toolPolicy && 'manage_bot' in parsed.data.toolPolicy)) {
      delete basePolicy['manage_bot'];
    }
    const effectiveToolPolicy = Object.keys(basePolicy).length > 0 ? basePolicy : null;

    const effectiveModelPolicy = mergeModelPolicy(
      (agent.modelPolicy as Record<string, unknown> | null | undefined) ?? null,
      {
        modelPolicy: parsed.data.modelPolicy,
        provider: parsed.data.provider,
        lightModel: parsed.data.lightModel,
        heavyModel: parsed.data.heavyModel,
        costPreset: parsed.data.costPreset,
        dailySpendBudgetUsd: parsed.data.dailySpendBudgetUsd,
        dexWatchlistSymbols: parsed.data.dexWatchlistSymbols,
      },
    );
    const modelIssues = validateAgentModelPolicy(effectiveModelPolicy);
    if (modelIssues.length > 0) {
      return reply.status(400).send({ error: 'validation_error', details: modelIssues });
    }

    const executionMode = resolveExecutionModeForSkills({
      skillIds: mergedSkillIds,
      submittedExecutionMode: parsed.data.executionMode,
      executionModeProvided: parsed.data.executionMode !== undefined,
      currentExecutionMode: agent.executionMode,
    });
    if (executionMode.issue) {
      return reply.status(400).send({ error: 'validation_error', details: [executionMode.issue] });
    }

    const {
      executionMode: _executionMode,
      provider: _provider,
      lightModel: _lightModel,
      heavyModel: _heavyModel,
      costPreset: _costPreset,
      dailySpendBudgetUsd: _dailySpendBudgetUsd,
      dexWatchlistSymbols: _dexWatchlistSymbols,
      dailyLlmTokenBudget: _dailyLlmTokenBudget,
      modelPolicy: _modelPolicy,
      ...agentUpdates
    } = parsed.data;

    await db.update(agents).set({
      ...agentUpdates,
      executionMode: executionMode.value,
      ...(dailyLlmTokenBudget.value !== undefined ? { dailyTokenBudget: dailyLlmTokenBudget.value } : {}),
      toolPolicy: effectiveToolPolicy,
      modelPolicy: effectiveModelPolicy,
      updatedAt: new Date(),
    }).where(eq(agents.id, id));

    const [updated] = await db.select().from(agents).where(eq(agents.id, id));
    return reply.send(decorateAgentResponse(updated!));
  });

  // POST /agents/:id/message — deliver user message to running agent (rate-limited 10/min)
  app.post<{ Params: { id: string }; Body: unknown }>('/agents/:id/message', async (request, reply) => {
    const { id } = request.params;
    const parsed = SendMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    // Rate limit: 10 messages per user per minute
    const rateLimitKey = `ratelimit:agent:message:${request.userId}`;
    const count = await redisClient.incr(rateLimitKey);
    if (count === 1) await redisClient.expire(rateLimitKey, 60);
    if (count > 10) {
      return reply.status(429).send({ error: 'rate_limited', message: 'Maximum 10 messages per minute' });
    }

    const [agent] = await db.select({ id: agents.id, userId: agents.userId, status: agents.status })
      .from(agents).where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) return reply.status(404).send({ error: 'not_found' });

    if (agent.status === 'stopped' || agent.status === 'crashed') {
      return reply.status(409).send({ error: 'agent_not_running', message: 'Agent is not running' });
    }

    // Publish to agent:outbound:{agentId} — the platform→agent channel
    const envelope = {
      schemaVersion: 'v1',
      messageId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      initiatorType: 'user',
      initiatorId: request.userId,
      agentId: id,
      type: 'user.message',
      createdAt: new Date().toISOString(),
      payload: { message: parsed.data.message },
    };
    await redisClient.xadd(`agent:outbound:${id}`, '*', 'envelope', JSON.stringify(envelope));

    return reply.status(202).send({ delivered: true });
  });

  // GET /agents/:id/memory — agent memory entries
  app.get<{ Params: { id: string }; Querystring: { prefix?: string; limit?: string; keysOnly?: string } }>(
    '/agents/:id/memory', async (request, reply) => {
      const { id } = request.params;
      const limit = Math.min(parseInt(request.query.limit ?? '100', 10), 500);
      const { prefix, keysOnly } = request.query;
      const onlyKeys = keysOnly === 'true' || keysOnly === '1';

      const [agent] = await db.select({ id: agents.id }).from(agents)
        .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
      if (!agent) return reply.status(404).send({ error: 'not_found' });

      // Memory is stored as a Redis hash under agent:memory:{agentId}
      const rawEntries = await redisClient.hgetall(`agent:memory:${id}`);
      if (!rawEntries) {
        return reply.send({ agentId: id, entries: [] });
      }

        const entries = Object.entries(rawEntries)
          .filter(([k]) => !prefix || k.startsWith(prefix))
          .slice(0, limit)
          .map(([key, rawVal]) => {
            if (onlyKeys) return { key };
            let value: unknown;
            try { value = JSON.parse(rawVal); } catch { value = rawVal; }
            return { key, value };
          });

      return reply.send({ agentId: id, entries });
    },
  );

  // GET /agents/:id/prompt — last compiled system prompt (in-memory Redis, 404 if not running)
  app.get<{ Params: { id: string } }>('/agents/:id/prompt', async (request, reply) => {
    const { id } = request.params;

    const [agent] = await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) return reply.status(404).send({ error: 'not_found' });

    const prompt = await redisClient.get(`agent:prompt:${id}`);
    if (!prompt) {
      return reply.status(404).send({ error: 'prompt_not_available', message: 'No compiled prompt available. Agent may not be running.' });
    }

    return reply.send({ agentId: id, prompt });
  });

  // GET /agents/:id/trades — fills (trades) attributed to bots owned by this agent
  app.get<{ Params: { id: string } }>('/agents/:id/trades', async (request, reply) => {
    const { id } = request.params;

    const [agent] = await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) return reply.status(404).send({ error: 'not_found' });

    const agentBots = await db.select({ id: bots.id }).from(bots)
      .where(and(eq(bots.creatorType, 'agent'), eq(bots.creatorId, id)));
    const agentBotIds = agentBots.map((b) => b.id);

    if (agentBotIds.length === 0) {
      return reply.send({ agentId: id, trades: [] });
    }

    const trades = await db.select().from(fills)
      .where(and(eq(fills.actorType, 'bot'), inArray(fills.actorId, agentBotIds)));

    return reply.send({ agentId: id, trades });
  });

  // GET /agents/telegram-bot — platform Telegram bot username (501 if not configured)
  // Must be registered before /agents/:id to avoid param capture
  app.get('/agents/telegram-bot', async (_request, reply) => {
    if (!telegramToken) {
      return reply.status(501).send({ error: 'not_configured', message: 'Telegram is not configured on this platform' });
    }

    const response = await fetch(`https://api.telegram.org/bot${telegramToken}/getMe`);
    if (!response.ok) {
      return reply.status(502).send({ error: 'telegram_error', message: 'Could not reach Telegram API' });
    }
    const data = await response.json() as { ok: boolean; result?: { username?: string } };
    if (!data.ok || !data.result?.username) {
      return reply.status(502).send({ error: 'telegram_error', message: 'Unexpected Telegram API response' });
    }

    return reply.send({ username: `@${data.result.username}` });
  });

  // POST /agents/verify-telegram — verify a Telegram chat ID is reachable (501 if not configured)
  app.post<{ Body: unknown }>('/agents/verify-telegram', async (request, reply) => {
    if (!telegramToken) {
      return reply.status(501).send({ error: 'not_configured', message: 'Telegram is not configured on this platform' });
    }

    const parsed = VerifyTelegramSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const { chatId } = parsed.data;
    const response = await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: 'Herobids: Telegram notification test — your chat ID is verified.',
      }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { description?: string };
      return reply.status(422).send({
        error: 'telegram_unreachable',
        message: body.description ?? 'Chat ID is not reachable',
      });
    }

    return reply.send({ verified: true, chatId });
  });
}

// Telegram webhook handler — registered as a public (unauthenticated) route
export async function telegramWebhookHandler(
  app: FastifyInstance,
  alertsConfig?: AlertsConfig,
): Promise<void> {
  const botToken = alertsConfig?.telegram?.botToken ?? '';

  app.post<{ Body: unknown }>('/api/telegram/webhook', async (request, reply) => {
    if (!botToken) {
      return reply.status(501).send({ error: 'not_configured' });
    }

    // Validate the Telegram webhook secret token
    const secretHeader = (request.headers['x-telegram-bot-api-secret-token'] as string | undefined) ?? '';
    if (!secretHeader || secretHeader !== botToken) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    // Acknowledge immediately — Telegram expects a fast response
    // The update body can be processed asynchronously in a real implementation
    return reply.status(200).send({ ok: true });
  });
}
