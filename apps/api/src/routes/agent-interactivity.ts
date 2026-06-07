import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import crypto from 'node:crypto';
import { z } from 'zod';
import { eq, and, inArray, desc } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { agents, bots, fills, journalEvents, agentRuntimeSessions } from '@herobids/db';
import type { AlertsConfig } from '@herobids/domain';

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
  telegramChatId: z.string().nullable().optional(),
  executionMode: z.enum(['paper', 'shadow', 'live']).nullable().optional(),
  dailyTokenBudget: z.number().int().min(1).nullable().optional(),
  dailyLossLimit: z.string().nullable().optional(),
  maxBots: z.number().int().min(1).nullable().optional(),
  maxSlippageBps: z.number().int().min(0).nullable().optional(),
});

// --- Helpers ---

function rowsToCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const keys = Object.keys(rows[0]!);
  const header = keys.join(',');
  const lines = rows.map((row) =>
    keys.map((k) => {
      const v = row[k];
      if (v === null || v === undefined) return '';
      const str = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return str.includes(',') || str.includes('"') || str.includes('\n')
        ? `"${str.replace(/"/g, '""')}"` : str;
    }).join(','),
  );
  return [header, ...lines].join('\n');
}

async function resolveAgentBotIds(db: Database, agentId: string): Promise<string[]> {
  const managed = await db.select({ id: bots.id }).from(bots)
    .where(and(eq(bots.creatorType, 'agent'), eq(bots.creatorId, agentId)));
  return managed.map((b) => b.id);
}

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

    await db.update(agents).set({
      ...parsed.data,
      toolPolicy: effectiveToolPolicy,
      updatedAt: new Date(),
    }).where(eq(agents.id, id));

    const [updated] = await db.select().from(agents).where(eq(agents.id, id));
    return reply.send(updated);
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

  // --- Export endpoints ---

  // GET /agents/:id/export/trades — CSV of fills across managed bots
  app.get<{ Params: { id: string } }>('/agents/:id/export/trades', async (request, reply) => {
    const { id } = request.params;
    const [agent] = await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) return reply.status(404).send({ error: 'not_found' });

    const botIds = await resolveAgentBotIds(db, id);
    const rows = botIds.length > 0
      ? await db.select().from(fills)
          .where(and(eq(fills.actorType, 'bot'), inArray(fills.actorId, botIds)))
          .orderBy(desc(fills.filledAt))
      : [];

    const csv = rowsToCsv(rows as Record<string, unknown>[]);
    void reply.header('Content-Type', 'text/csv');
    void reply.header('Content-Disposition', `attachment; filename="agent-${id}-trades.csv"`);
    return reply.send(csv);
  });

  // GET /agents/:id/export/journal — CSV of journal events across managed bots
  app.get<{ Params: { id: string } }>('/agents/:id/export/journal', async (request, reply) => {
    const { id } = request.params;
    const [agent] = await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) return reply.status(404).send({ error: 'not_found' });

    const botIds = await resolveAgentBotIds(db, id);
    const rows = botIds.length > 0
      ? await db.select().from(journalEvents)
          .where(inArray(journalEvents.actorId, botIds))
          .orderBy(desc(journalEvents.createdAt))
      : [];

    const csv = rowsToCsv(rows as Record<string, unknown>[]);
    void reply.header('Content-Type', 'text/csv');
    void reply.header('Content-Disposition', `attachment; filename="agent-${id}-journal.csv"`);
    return reply.send(csv);
  });

  // GET /agents/:id/export/costs — CSV cost summary by currency
  app.get<{ Params: { id: string } }>('/agents/:id/export/costs', async (request, reply) => {
    const { id } = request.params;
    const [agent] = await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) return reply.status(404).send({ error: 'not_found' });

    const botIds = await resolveAgentBotIds(db, id);
    let rows: Record<string, unknown>[] = [];
    if (botIds.length > 0) {
      const feeRows = await db.select({ feeCurrency: fills.feeCurrency, fee: fills.fee })
        .from(fills)
        .where(and(eq(fills.actorType, 'bot'), inArray(fills.actorId, botIds)));
      // Aggregate by currency
      const byCurrency: Record<string, number> = {};
      for (const row of feeRows) {
        const cur = row.feeCurrency ?? 'unknown';
        byCurrency[cur] = (byCurrency[cur] ?? 0) + parseFloat(row.fee ?? '0');
      }
      rows = Object.entries(byCurrency).map(([currency, total]) => ({ currency, total: total.toFixed(8) }));
    }

    const csv = rowsToCsv(rows);
    void reply.header('Content-Type', 'text/csv');
    void reply.header('Content-Disposition', `attachment; filename="agent-${id}-costs.csv"`);
    return reply.send(csv);
  });

  // GET /agents/:id/export/sessions — CSV of runtime sessions
  app.get<{ Params: { id: string } }>('/agents/:id/export/sessions', async (request, reply) => {
    const { id } = request.params;
    const [agent] = await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) return reply.status(404).send({ error: 'not_found' });

    const rows = await db.select().from(agentRuntimeSessions)
      .where(eq(agentRuntimeSessions.agentId, id))
      .orderBy(desc(agentRuntimeSessions.startedAt));

    const csv = rowsToCsv(rows as Record<string, unknown>[]);
    void reply.header('Content-Type', 'text/csv');
    void reply.header('Content-Disposition', `attachment; filename="agent-${id}-sessions.csv"`);
    return reply.send(csv);
  });

  // GET /agents/:id/export/config — JSON agent config
  app.get<{ Params: { id: string } }>('/agents/:id/export/config', async (request, reply) => {
    const { id } = request.params;
    const [agent] = await db.select().from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) return reply.status(404).send({ error: 'not_found' });

    void reply.header('Content-Disposition', `attachment; filename="agent-${id}-config.json"`);
    return reply.send(agent);
  });

  // GET /agents/:id/export/bundle — JSON bundle of all agent data
  app.get<{ Params: { id: string } }>('/agents/:id/export/bundle', async (request, reply) => {
    const { id } = request.params;
    const [agent] = await db.select().from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) return reply.status(404).send({ error: 'not_found' });

    const botIds = await resolveAgentBotIds(db, id);
    const [trades, journal, sessions] = await Promise.all([
      botIds.length > 0
        ? db.select().from(fills).where(and(eq(fills.actorType, 'bot'), inArray(fills.actorId, botIds))).orderBy(desc(fills.filledAt))
        : Promise.resolve([]),
      botIds.length > 0
        ? db.select().from(journalEvents).where(inArray(journalEvents.actorId, botIds)).orderBy(desc(journalEvents.createdAt))
        : Promise.resolve([]),
      db.select().from(agentRuntimeSessions).where(eq(agentRuntimeSessions.agentId, id)).orderBy(desc(agentRuntimeSessions.startedAt)),
    ]);

    void reply.header('Content-Disposition', `attachment; filename="agent-${id}-bundle.json"`);
    return reply.send({
      agent,
      trades,
      journal,
      sessions,
      exportedAt: new Date().toISOString(),
    });
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
