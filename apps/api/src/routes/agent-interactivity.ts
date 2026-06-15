import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import crypto from 'node:crypto';
import { z } from 'zod';
import { eq, and, inArray, notInArray, sql, asc } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { AgentRepository, agents, agentSkills, bots, fills, skillEntitlements, skillRevisions, skillUsageEvents, skills, users } from '@herobids/db';
import type { AlertsConfig, PlanAgentsEntitlements, PlansConfig } from '@herobids/domain';
import type { OperatorLlmCatalogContext } from '../llm-model-catalog.js';
import { resolvePlanAgentEntitlements, resolvePlanSkillEntitlements } from '../plan-guards.js';
import { parseTelegramCommand } from './telegram-command-parser.js';
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

const TelegramWebhookUpdateSchema = z.object({
  message: z.object({
    chat: z.object({
      id: z.union([z.string(), z.number().int()]).transform((value) => String(value)),
    }),
    text: z.string().optional(),
    reply_to_message: z.object({
      message_id: z.number().int(),
    }).optional(),
  }).optional(),
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

type SkillAssignmentResolution = {
  skillId: string;
  skillRevisionId: string;
};

// --- Route module ---

export async function agentInteractivityRoutes(
  app: FastifyInstance,
  db: Database,
  redisClient: Redis,
  alertsConfig?: AlertsConfig,
  llmCatalogContext?: OperatorLlmCatalogContext,
  plansConfig?: PlansConfig,
): Promise<void> {
  function resolveAgentPlanPolicy(planId: string, isAdmin: boolean): PlanAgentsEntitlements {
    if (!plansConfig) {
      return { canViewOwnPrompts: true };
    }
    return resolvePlanAgentEntitlements(plansConfig, planId, isAdmin);
  }

  function resolveSkillPlanPolicy(planId: string, isAdmin: boolean): { canViewMarketplaceSkills: boolean } {
    if (!plansConfig) {
      return { canViewMarketplaceSkills: true };
    }
    const plan = resolvePlanSkillEntitlements(plansConfig, planId, isAdmin);
    return { canViewMarketplaceSkills: plan.canViewMarketplaceSkills };
  }

  async function resolveSkillAssignmentsForUser(
    userId: string,
    skillIds: string[],
    preservedSkillIds: Set<string> = new Set(),
    canViewMarketplaceSkills = true,
  ): Promise<{ assignments?: SkillAssignmentResolution[]; error?: { code: string; message: string; details?: unknown } }> {
    if (skillIds.length === 0) {
      return { assignments: [] };
    }

    const uniqueSkillIds = [...new Set(skillIds)];
    const [skillRows, entitlementRows] = await Promise.all([
      db.select().from(skills).where(inArray(skills.id, uniqueSkillIds)),
      db.select({ skillId: skillEntitlements.skillId })
        .from(skillEntitlements)
        .where(and(eq(skillEntitlements.userId, userId), sql`${skillEntitlements.revokedAt} IS NULL`)),
    ]);

    const skillById = new Map(skillRows.map((row) => [row.id, row] as const));
    const missingSkillIds = uniqueSkillIds.filter((skillId) => !skillById.has(skillId));
    if (missingSkillIds.length > 0) {
      return {
        error: {
          code: 'validation_error',
          message: 'Some selected skills do not exist',
          details: [{ code: 'custom', path: ['skillIds'], message: `Unknown skillIds: ${missingSkillIds.join(', ')}` }],
        },
      };
    }

    const entitledSkillIds = new Set(entitlementRows.map((row) => row.skillId));
    const nonSelectable = uniqueSkillIds.filter((skillId) => {
      const skill = skillById.get(skillId)!;
      if (skill.authorId === null || skill.authorId === userId || preservedSkillIds.has(skill.id) || entitledSkillIds.has(skill.id)) {
        return false;
      }
      return !(canViewMarketplaceSkills && skill.publicationStatus === 'published' && skill.priceCents === 0);
    });

    if (nonSelectable.length > 0) {
      return {
        error: {
          code: 'validation_error',
          message: 'Some selected skills are not selectable for this user',
          details: [{ code: 'custom', path: ['skillIds'], message: `Non-selectable skillIds: ${nonSelectable.join(', ')}` }],
        },
      };
    }

    const revisionRows = await db.select({
      skillId: skillRevisions.skillId,
      revisionId: skillRevisions.id,
      version: skillRevisions.version,
    }).from(skillRevisions).where(inArray(skillRevisions.skillId, uniqueSkillIds));

    const latestRevisionBySkillId = new Map<string, { revisionId: string; version: number }>();
    for (const row of revisionRows) {
      const current = latestRevisionBySkillId.get(row.skillId);
      if (!current || row.version > current.version) {
        latestRevisionBySkillId.set(row.skillId, { revisionId: row.revisionId, version: row.version });
      }
    }

    const assignments: SkillAssignmentResolution[] = [];
    const missingRevisionSkills: string[] = [];
    for (const skillId of uniqueSkillIds) {
      const skill = skillById.get(skillId)!;
      const resolvedRevisionId = skill.currentRevisionId ?? latestRevisionBySkillId.get(skillId)?.revisionId ?? null;
      if (!resolvedRevisionId) {
        missingRevisionSkills.push(skillId);
        continue;
      }
      assignments.push({ skillId, skillRevisionId: resolvedRevisionId });
    }

    if (missingRevisionSkills.length > 0) {
      return {
        error: {
          code: 'invalid_state',
          message: 'Some selected skills do not have revisions',
          details: [{ code: 'custom', path: ['skillIds'], message: `Skills missing revisions: ${missingRevisionSkills.join(', ')}` }],
        },
      };
    }

    return { assignments };
  }

  async function syncAgentSkillAssignments(
    agentId: string,
    userId: string,
    assignments: SkillAssignmentResolution[],
  ): Promise<void> {
    const now = new Date();
    await db.transaction(async (tx) => {
      const existingRows = await tx.select({
        skillId: agentSkills.skillId,
        skillRevisionId: agentSkills.skillRevisionId,
      }).from(agentSkills).where(eq(agentSkills.agentId, agentId));

      const existingBySkillId = new Map(existingRows.map((row) => [row.skillId, row.skillRevisionId] as const));
      const nextSkillIds = assignments.map((assignment) => assignment.skillId);

      if (nextSkillIds.length === 0) {
        await tx.delete(agentSkills).where(eq(agentSkills.agentId, agentId));
      } else {
        await tx.delete(agentSkills).where(and(
          eq(agentSkills.agentId, agentId),
          notInArray(agentSkills.skillId, nextSkillIds),
        ));
      }

      for (const [orderIndex, assignment] of assignments.entries()) {
        const previousRevisionId = existingBySkillId.get(assignment.skillId);
        await tx.insert(agentSkills).values({
          agentId,
          skillId: assignment.skillId,
          skillRevisionId: assignment.skillRevisionId,
          orderIndex,
          assignedAt: now,
          assignedByUserId: userId,
          assignmentSource: 'user_select',
        }).onConflictDoUpdate({
          target: [agentSkills.agentId, agentSkills.skillId],
          set: {
            skillRevisionId: assignment.skillRevisionId,
            orderIndex,
            assignedAt: now,
            assignedByUserId: userId,
            assignmentSource: 'user_select',
          },
        });

        if (previousRevisionId !== assignment.skillRevisionId) {
          await tx.insert(skillUsageEvents).values({
            id: crypto.randomUUID(),
            skillId: assignment.skillId,
            skillRevisionId: assignment.skillRevisionId,
            userId,
            agentId,
            sessionId: null,
            eventType: 'agent_assigned',
            occurredAt: now,
            metadata: { source: 'agent_update' },
            createdAt: now,
          });
        }
      }
    });
  }

  async function listSkillIdsForAgent(agentId: string): Promise<string[]> {
    const rows = await db.select({ skillId: agentSkills.skillId })
      .from(agentSkills)
      .where(eq(agentSkills.agentId, agentId))
      .orderBy(asc(agentSkills.orderIndex), asc(agentSkills.skillId));
    return rows.map((row) => row.skillId);
  }

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

    const existingSkillIds = await listSkillIdsForAgent(id);
    const mergedSkillIds = parsed.data.skillIds ?? existingSkillIds;
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
    const modelIssues = await validateAgentModelPolicy(effectiveModelPolicy, llmCatalogContext);
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

    const assignmentResolution = parsed.data.skillIds !== undefined
      ? await resolveSkillAssignmentsForUser(
        request.userId,
        parsed.data.skillIds,
        new Set(existingSkillIds),
        resolveSkillPlanPolicy(request.userPlanId || 'free', request.isAdmin).canViewMarketplaceSkills,
      )
      : null;
    if (assignmentResolution?.error) {
      return reply.status(400).send({ error: assignmentResolution.error.code, details: assignmentResolution.error.details ?? [], message: assignmentResolution.error.message });
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
      skillIds: _skillIds,
      ...agentUpdates
    } = parsed.data;
    void _skillIds;

    await db.update(agents).set({
      ...agentUpdates,
      executionMode: executionMode.value,
      ...(dailyLlmTokenBudget.value !== undefined ? { dailyTokenBudget: dailyLlmTokenBudget.value } : {}),
      toolPolicy: effectiveToolPolicy,
      modelPolicy: effectiveModelPolicy,
      updatedAt: new Date(),
    }).where(eq(agents.id, id));

    if (assignmentResolution) {
      await syncAgentSkillAssignments(id, request.userId, assignmentResolution.assignments ?? []);
    }

    const [updated] = await db.select().from(agents).where(eq(agents.id, id));
    const skillIds = await listSkillIdsForAgent(id);
    return reply.send(decorateAgentResponse({ ...updated!, skillIds }));
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

    const planPolicy = resolveAgentPlanPolicy(request.userPlanId || 'free', request.isAdmin);
    if (!planPolicy.canViewOwnPrompts) {
      return reply.status(403).send({
        error: 'plan_limit',
        code: 'plan.agents_prompt_visibility_disabled',
        message: 'Your plan does not include prompt visibility',
      });
    }

    const [judgeSystem, scoutSystem, userContext, judgeUserContext] = await Promise.all([
      redisClient.get(`agent:prompt:${id}`),
      redisClient.get(`agent:prompt:scout:${id}`),
      redisClient.get(`agent:prompt:user-context:${id}`),
      redisClient.get(`agent:prompt:judge-user-context:${id}`),
    ]);

    if (!judgeSystem && !scoutSystem && !userContext && !judgeUserContext) {
      return reply.status(404).send({ error: 'prompt_not_available', message: 'No compiled prompt available. Agent may not be running.' });
    }

    return reply.send({
      agentId: id,
      judgeSystem,
      scoutSystem,
      userContext,
      judgeUserContext,
    });
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
        text: 'HeroBids: Telegram notification test — your chat ID is verified.',
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
  db: Database,
  redisClient: Redis,
  alertsConfig?: AlertsConfig,
): Promise<void> {
  const botToken = alertsConfig?.telegram?.botToken ?? '';
  const webhookSecret = alertsConfig?.telegram?.webhookSecret ?? '';

  async function sendTelegramText(chatId: string, text: string): Promise<void> {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
      }),
    }).catch(() => undefined);
  }

  function agentCanReceiveTelegram(status: string): boolean {
    return status !== 'stopped' && status !== 'crashed';
  }

  function buildEnvelope(agentId: string, userId: string, messageText: string) {
    return {
      schemaVersion: 'v1',
      messageId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      initiatorType: 'user',
      initiatorId: userId,
      agentId,
      type: 'user.message',
      createdAt: new Date().toISOString(),
      payload: { message: messageText },
    };
  }

  async function deliverTelegramMessage(agentId: string, userId: string, messageText: string): Promise<void> {
    const envelope = buildEnvelope(agentId, userId, messageText);
    await redisClient.xadd(`agent:outbound:${agentId}`, '*', 'envelope', JSON.stringify(envelope));
  }

  const agentRepo = new AgentRepository(db);

  async function processWebhookUpdate(
    chatId: string,
    message: NonNullable<z.infer<typeof TelegramWebhookUpdateSchema>['message']>,
  ): Promise<void> {
    const userRows = await db.select({ userId: users.id })
      .from(users)
      .where(eq(users.telegramChatId, chatId))
      .limit(1);
    const userId = userRows[0]?.userId;

    if (!userId) {
      return;
    }

    const trimmedText = message.text!.trim();

    if (message.reply_to_message) {
      const agent = await agentRepo.resolveAgentForTelegramReply(
        String(message.reply_to_message.message_id),
        userId,
      );
      if (!agent) {
        await sendTelegramText(chatId, "I couldn't find which agent that reply belongs to. The message may be too old.");
        return;
      }

      if (!agentCanReceiveTelegram(agent.status)) {
        await sendTelegramText(chatId, `Agent ${agent.agentName} is stopped and cannot receive messages right now.`);
        return;
      }

      await deliverTelegramMessage(agent.agentId, userId, trimmedText);
      await sendTelegramText(chatId, `Delivered to ${agent.agentName}.`);
      return;
    }

    const userAgents = await db.select({
      agentId: agents.id,
      agentName: agents.name,
      status: agents.status,
    })
      .from(agents)
      .where(eq(agents.userId, userId));

    const parsedCommand = parseTelegramCommand(trimmedText);
    const commandBody = parsedCommand?.body.trim() ?? trimmedText;

    if (parsedCommand?.targets.length) {
      if (commandBody.length === 0) {
        await sendTelegramText(chatId, 'Please include a message after the target.');
        return;
      }

      const confirmations: string[] = [];
      const deliveredAgentIds = new Set<string>();

      for (const target of parsedCommand.targets) {
        const isBroadcast = target === '*' || target.toLowerCase() === 'all';
        const targetAgents = isBroadcast
          ? userAgents.filter((row) => agentCanReceiveTelegram(row.status))
          : userAgents.filter((row) => row.agentName.toLowerCase() === target.toLowerCase());

        if (targetAgents.length === 0) {
          confirmations.push(isBroadcast ? 'No running agents found.' : `No agent named ${target} found.`);
          continue;
        }

        for (const targetAgent of targetAgents) {
          if (deliveredAgentIds.has(targetAgent.agentId)) {
            continue;
          }
          deliveredAgentIds.add(targetAgent.agentId);

          if (!agentCanReceiveTelegram(targetAgent.status)) {
            confirmations.push(`Agent ${targetAgent.agentName} is stopped and cannot receive messages right now.`);
            continue;
          }

          await deliverTelegramMessage(targetAgent.agentId, userId, commandBody);
          confirmations.push(`Delivered to ${targetAgent.agentName}.`);
        }
      }

      await sendTelegramText(chatId, confirmations.join('\n'));
      return;
    }

    const runningAgents = userAgents.filter((row) => agentCanReceiveTelegram(row.status));
    if (runningAgents.length === 1) {
      await deliverTelegramMessage(runningAgents[0]!.agentId, userId, commandBody);
      await sendTelegramText(chatId, `Delivered to ${runningAgents[0]!.agentName}.`);
      return;
    }

    if (runningAgents.length === 0) {
      await sendTelegramText(chatId, 'No running agents found. Start an agent or reply to one of its Telegram messages.');
      return;
    }

    await sendTelegramText(chatId, 'Multiple running agents found. Use /to <agent name> <message> to choose a target.');
  }

  app.post<{ Body: unknown }>('/api/telegram/webhook', async (request, reply) => {
    if (!botToken || !webhookSecret) {
      return reply.status(501).send({ error: 'not_configured' });
    }

    // Validate the Telegram webhook secret token
    const secretHeader = (request.headers['x-telegram-bot-api-secret-token'] as string | undefined) ?? '';
    if (!secretHeader || secretHeader !== webhookSecret) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const parsed = TelegramWebhookUpdateSchema.safeParse(request.body);
    if (!parsed.success || !parsed.data.message) {
      return reply.status(200).send({ ok: true });
    }

    const message = parsed.data.message;
    if (!message.text || message.text.trim().length === 0) {
      return reply.status(200).send({ ok: true });
    }

    // Acknowledge Telegram immediately — routing and delivery happen asynchronously
    // to avoid slow-DB or slow-Telegram-API latency causing Telegram retries.
    reply.status(200).send({ ok: true });
    void processWebhookUpdate(message.chat.id, message).catch((err) => {
      app.log.warn({ err }, 'Telegram webhook async processing failed');
    });
  });
}
