import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import crypto from 'node:crypto';
import { z } from 'zod';
import { eq, and, or, inArray, notInArray, sql, asc } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { AgentRepository, AgentDocumentsRepository, agents, agentConnections, agentSkills, bots, fills, skillEntitlements, skillRevisions, skillUsageEvents, skills, users } from '@herobids/db';
import { AgentDocumentService, sanitizeFilename } from '@herobids/documents';
import { LocalDocumentStore } from '@herobids/documents/local-document-store';
import { createDocumentTextExtractor } from '@herobids/documents/document-text-extractors';
import { resolve } from 'node:path';
import type { AgentRiskDefaultsConfig, AlertsConfig, AuthConfig, PlanAgentsEntitlements, PlansConfig } from '@herobids/domain';
import { AgentRuntimePolicyOverridesSchema, AgentRiskDefaultsSchema, AGENT_STREAM_MAXLEN } from '@herobids/domain';
import type { LlmCatalogDeps } from '../llm-model-catalog.js';
import { resolvePlanAgentEntitlements, resolvePlanSkillEntitlements } from '../plan-guards.js';
import { parseTelegramCommand } from './telegram-command-parser.js';
import {
  parseSlashCommand,
  formatCommandHelp,
  formatUnknownCommandResponse,
} from './telegram-slash-commands.js';
import {
  handleAgents,
  handleInfo,
  handleLog,
  handleConnections,
  handleConnectSetup,
  handleStart,
  handlePause,
  handleResume,
  handleStop,
  handleRestart,
  handleMode,
  handleConnect,
  handleDisconnect,
} from './telegram-command-handlers.js';
import {
  CostPresetSchema,
  decorateAgentResponse,
  hasModelFieldsWithoutProvider,
  mergeModelPolicy,
  nullablePositiveDecimalStringSchema,
  nullablePositiveIntegerSchema,
  resolveExecutionModeForSkills,
  validateAgentModelPolicy,
  validateAgentRiskBounds,
  validateConnectionRequirement,
  validateDailyLossRequiresCapital,
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
    caption: z.string().optional(),
    document: z.object({
      file_id: z.string(),
      file_name: z.string().optional(),
      mime_type: z.string().optional(),
      file_size: z.number().int().optional(),
    }).optional(),
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
  executionMode: z.enum(['paper', 'shadow', 'live', 'test']).nullable().optional(),
  dailyLossLimit: nullablePositiveDecimalStringSchema,
  maxDrawdownPct: z.number().min(0).max(100).nullable().optional(),
  maxBots: nullablePositiveIntegerSchema(),
  maxSlippageBps: nullablePositiveIntegerSchema(0),
  tickIntervalMs: nullablePositiveIntegerSchema(1000),
  capital: nullablePositiveDecimalStringSchema,
  style: z.enum(['careful', 'balanced', 'bold']).nullable().optional(),
  runtimePolicyOverrides: AgentRuntimePolicyOverridesSchema.nullable().optional(),
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
  llmCatalogDeps?: LlmCatalogDeps,
  plansConfig?: PlansConfig,
  agentRiskDefaults?: AgentRiskDefaultsConfig,
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

    // Validate risk bounds against operator ceilings (resolved config, not schema defaults)
    const riskDefaults = agentRiskDefaults ?? AgentRiskDefaultsSchema.parse({});
    const riskIssues = validateAgentRiskBounds(parsed.data, riskDefaults);
    if (riskIssues.length > 0) {
      return reply.status(400).send({ error: 'validation_error', details: riskIssues });
    }

    // Validate dailyLossLimit and maxDrawdownPct require capital (effective after this update).
    // Use the post-merge effective values: new if explicitly provided, else existing.
    const effectiveDailyLossLimit = parsed.data.dailyLossLimit !== undefined ? parsed.data.dailyLossLimit : agent.dailyLossLimit;
    const effectiveMaxDrawdownPct = parsed.data.maxDrawdownPct !== undefined ? parsed.data.maxDrawdownPct : (agent.maxDrawdownPct != null ? Number(agent.maxDrawdownPct) : null);
    const effectiveCapital = parsed.data.capital !== undefined ? parsed.data.capital : agent.capital;
    const capitalIssues = validateDailyLossRequiresCapital({
      dailyLossLimit: effectiveDailyLossLimit,
      maxDrawdownPct: effectiveMaxDrawdownPct,
      capital: effectiveCapital,
    });
    if (capitalIssues.length > 0) {
      return reply.status(400).send({ error: 'validation_error', details: capitalIssues });
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
    const modelIssues = await validateAgentModelPolicy(effectiveModelPolicy, llmCatalogDeps);
    if (modelIssues.length > 0) {
      return reply.status(400).send({ error: 'validation_error', details: modelIssues });
    }

    // Determine whether the agent has trading connections — used to resolve
    // the `test` input alias to the correct concrete simulation mode.
    const [existingActiveConn] = await db.select({ id: agentConnections.id })
      .from(agentConnections)
      .where(and(eq(agentConnections.agentId, id), eq(agentConnections.status, 'active')))
      .limit(1);
    const hasAgentConnections = !!existingActiveConn;

    const executionMode = resolveExecutionModeForSkills({
      skillIds: mergedSkillIds,
      submittedExecutionMode: parsed.data.executionMode,
      executionModeProvided: parsed.data.executionMode !== undefined,
      currentExecutionMode: agent.executionMode,
      hasConnections: hasAgentConnections,
    });
    if (executionMode.issue) {
      return reply.status(400).send({ error: 'validation_error', details: [executionMode.issue] });
    }

    const connectionRequirementIssue = validateConnectionRequirement(executionMode.value, hasAgentConnections);
    if (connectionRequirementIssue) {
      return reply.status(400).send({ error: 'validation_error', details: [connectionRequirementIssue] });
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
      modelPolicy: _modelPolicy,
      skillIds: _skillIds,
      runtimePolicyOverrides: _runtimePolicyOverrides,
      maxDrawdownPct: rawMaxDrawdownPct,
      ...agentUpdates
    } = parsed.data;
    void _skillIds;

    await db.update(agents).set({
      ...agentUpdates,
      ...(rawMaxDrawdownPct !== undefined ? { maxDrawdownPct: rawMaxDrawdownPct != null ? String(rawMaxDrawdownPct) : null } : {}),
      executionMode: executionMode.value ?? 'paper',
      ...(parsed.data.runtimePolicyOverrides !== undefined ? { runtimePolicyOverrides: parsed.data.runtimePolicyOverrides } : {}),
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
    await redisClient.xadd(`agent:outbound:${id}`, 'MAXLEN', '~', AGENT_STREAM_MAXLEN, '*', 'envelope', JSON.stringify(envelope));

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

    const [judgeSystem, scoutSystem, userContext, judgeUserContext, hybridSystem] = await Promise.all([
      redisClient.get(`agent:prompt:${id}`),
      redisClient.get(`agent:prompt:scout:${id}`),
      redisClient.get(`agent:prompt:user-context:${id}`),
      redisClient.get(`agent:prompt:judge-user-context:${id}`),
      redisClient.get(`agent:prompt:hybrid:${id}`),
    ]);

    if (!judgeSystem && !scoutSystem && !userContext && !judgeUserContext && !hybridSystem) {
      return reply.status(404).send({ error: 'prompt_not_available', message: 'No compiled prompt available. Agent may not be running.' });
    }

    return reply.send({
      agentId: id,
      judgeSystem,
      scoutSystem,
      userContext,
      judgeUserContext,
      hybridSystem,
    });
  });

  // GET /agents/:id/trades — fills (trades) attributed to this agent.
  // Includes both agent-native fills (actorType='agent') and fills from bots
  // created by the agent (actorType='bot').
  app.get<{ Params: { id: string } }>('/agents/:id/trades', async (request, reply) => {
    const { id } = request.params;

    const [agent] = await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) return reply.status(404).send({ error: 'not_found' });

    const agentBots = await db.select({ id: bots.id }).from(bots)
      .where(and(eq(bots.creatorType, 'agent'), eq(bots.creatorId, id)));
    const agentBotIds = agentBots.map((b) => b.id);

    // Agent-native fills (actorType='agent') OR bot fills (actorType='bot' for agent-created bots)
    const agentNativeCondition = and(eq(fills.actorType, 'agent'), eq(fills.actorId, id));
    if (agentBotIds.length === 0) {
      const trades = await db.select().from(fills).where(agentNativeCondition);
      return reply.send({ agentId: id, trades });
    }

    const botCondition = and(eq(fills.actorType, 'bot'), inArray(fills.actorId, agentBotIds));
    const trades = await db.select().from(fills)
      .where(or(agentNativeCondition, botCondition));

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
        text: 'OpenAIdom: Telegram notification test — your chat ID is verified.',
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
  authConfig?: AuthConfig,
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
        link_preview_options: { is_disabled: true },
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
    await redisClient.xadd(`agent:outbound:${agentId}`, 'MAXLEN', '~', AGENT_STREAM_MAXLEN, '*', 'envelope', JSON.stringify(envelope));
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

    let userId = userRows[0]?.userId;

    const trimmedText = message.text!.trim();

    // ── Slash-command routing ──────────────────────────────────────────
    // Detect and dispatch explicit slash commands before falling through
    // to the existing /to parser and plain-text routing.
    const slashCmd = parseSlashCommand(trimmedText);
    if (slashCmd) {
      // /to is handled by the existing parseTelegramCommand logic below.
      if (slashCmd.command !== 'to') {
        if (slashCmd.command === 'unknown') {
          await sendTelegramText(chatId, formatUnknownCommandResponse(slashCmd.args[0] ?? ''));
          return;
        }
        if (slashCmd.command === 'help') {
          await sendTelegramText(chatId, formatCommandHelp(slashCmd.args[0]));
          return;
        }
        if (slashCmd.command === 'start' && slashCmd.args.length === 0) {
          // Exact bare /start → onboarding/help, not lifecycle.
          await sendTelegramText(chatId, formatCommandHelp());
          return;
        }
        // Require user binding for all other commands
        if (!userId) {
          await sendTelegramText(chatId, 'Please bind your Telegram account first. Use /start to begin.');
          return;
        }

        // ── Read commands (Slice 3) ────────────────────────────────
        if (slashCmd.command === 'agents') {
          const response = await handleAgents(db, userId);
          await sendTelegramText(chatId, response);
          return;
        }
        if (slashCmd.command === 'info') {
          const response = await handleInfo(db, userId, slashCmd.args);
          await sendTelegramText(chatId, response);
          return;
        }
        if (slashCmd.command === 'log') {
          const response = await handleLog(db, userId, slashCmd.args);
          await sendTelegramText(chatId, response);
          return;
        }
        if (slashCmd.command === 'connections') {
          const response = await handleConnections(db, userId, slashCmd.args);
          await sendTelegramText(chatId, response);
          return;
        }

        // ── /connect <agent> (no connection id) — connect entrypoint flow ──
        if (slashCmd.command === 'connect' && slashCmd.args.length === 1) {
          const response = await handleConnectSetup(db, redisClient, authConfig, userId, slashCmd.args);
          await sendTelegramText(chatId, response);
          return;
        }

        // Lifecycle commands (Slice 4)
        if (slashCmd.command === 'start') {
          const response = await handleStart(db, userId, slashCmd.args);
          await sendTelegramText(chatId, response);
          return;
        }
        if (slashCmd.command === 'pause') {
          const response = await handlePause(db, userId, slashCmd.args);
          await sendTelegramText(chatId, response);
          return;
        }
        if (slashCmd.command === 'resume') {
          const response = await handleResume(db, userId, slashCmd.args);
          await sendTelegramText(chatId, response);
          return;
        }
        if (slashCmd.command === 'stop') {
          const response = await handleStop(db, userId, slashCmd.args);
          await sendTelegramText(chatId, response);
          return;
        }
        if (slashCmd.command === 'restart') {
          const response = await handleRestart(db, userId, slashCmd.args);
          await sendTelegramText(chatId, response);
          return;
        }

        // Config commands (Slice 5)
        if (slashCmd.command === 'mode') {
          const response = await handleMode(db, userId, slashCmd.args);
          await sendTelegramText(chatId, response);
          return;
        }
        // /connect <agent> <id> (with-id form — Slice 5)
        // /connect <agent> (no-id form) is handled above by handleConnectSetup
        // /connect (zero args) — show usage
        if (slashCmd.command === 'connect' && slashCmd.args.length === 0) {
          await sendTelegramText(chatId, 'Usage: /connect <agent> [connection-id|label]');
          return;
        }
        if (slashCmd.command === 'connect' && slashCmd.args.length >= 2) {
          const response = await handleConnect(db, userId, slashCmd.args);
          await sendTelegramText(chatId, response);
          return;
        }
        if (slashCmd.command === 'disconnect') {
          const response = await handleDisconnect(db, userId, slashCmd.args);
          await sendTelegramText(chatId, response);
          return;
        }

        await sendTelegramText(chatId, `Command /${slashCmd.command} will be available soon.`);
        return;
      }
    }

    if (message.reply_to_message) {
      // Resolve the reply target directly from the outbound message record.
      // The chatId + Telegram message ID pair uniquely identifies the
      // message being replied to; we do not need to pre-resolve the user
      // via mutable chat bindings before consulting the authoritative
      // outbound message table.
      const agent = await agentRepo.resolveAgentForTelegramReply(
        String(message.reply_to_message.message_id),
        chatId,
      );
      if (!agent) {
        await sendTelegramText(chatId, "I couldn't find which agent that reply belongs to. The message may be too old.");
        return;
      }

      // Use the userId from the agent owner record — authoritative and
      // immune to stale chat-binding state.
      userId = agent.userId;

      if (!agentCanReceiveTelegram(agent.status)) {
        await sendTelegramText(chatId, `Agent ${agent.agentName} is stopped and cannot receive messages right now.`);
        return;
      }

      await deliverTelegramMessage(agent.agentId, userId, trimmedText);
      await sendTelegramText(chatId, `Delivered to ${agent.agentName}.`);
      return;
    }

    // Non-reply messages: require a user-level chat binding.
    // Agent-level overrides do not grant a general command surface —
    // the user must be explicitly bound to this chat.
    if (!userId) {
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

  // ── Document helpers ────────────────────────────────────────────────────

  /** Download a file from Telegram's servers via the Bot API. */
  async function downloadTelegramFile(fileId: string): Promise<{ buffer: Buffer; filename: string; mimeType: string } | null> {
    try {
      const getFileUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`;
      const fileRes = await fetch(getFileUrl);
      const fileData = await fileRes.json() as { ok: boolean; result?: { file_path?: string } };
      if (!fileData.ok || !fileData.result?.file_path) return null;

      const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`;
      const downloadRes = await fetch(downloadUrl);
      if (!downloadRes.ok) return null;

      const buffer = Buffer.from(await downloadRes.arrayBuffer());
      return { buffer, filename: '', mimeType: '' };
    } catch {
      return null;
    }
  }

  /** Lazily-initialised {@link AgentDocumentService} singleton scoped to this webhook handler. */
  let _documentService: AgentDocumentService | null = null;
  function getDocumentService(): AgentDocumentService {
    if (!_documentService) {
      const store = new LocalDocumentStore(resolve(process.cwd(), 'data/agent-documents'));
      const extractor = createDocumentTextExtractor();
      const repo = new AgentDocumentsRepository(db);
      _documentService = new AgentDocumentService(store, extractor, repo);
    }
    return _documentService;
  }

  /**
   * Handle a Telegram document message:
   * 1. Resolve target agent(s) from chat binding and optional caption {@code /to} command.
   * 2. Download the file from Telegram.
   * 3. Ingest through {@link AgentDocumentService}.
   * 4. Publish a text notification to each target agent.
   *
   * Targets only running agents in v1 — stopped/crashed agents are rejected.
   */
  async function processWebhookDocument(
    chatId: string,
    message: NonNullable<z.infer<typeof TelegramWebhookUpdateSchema>['message']>,
  ): Promise<void> {
    const document = message.document!; // guaranteed present by caller

    // ── 1. Resolve user ──────────────────────────────────────────────────

    const userRows = await db.select({ userId: users.id })
      .from(users)
      .where(eq(users.telegramChatId, chatId))
      .limit(1);

    const userId = userRows[0]?.userId;
    if (!userId) return; // no chat binding — silent drop

    // ── 2. Find running agents for this user ─────────────────────────────

    const userAgents = await db.select({
      agentId: agents.id,
      agentName: agents.name,
      status: agents.status,
    })
      .from(agents)
      .where(eq(agents.userId, userId));

    const runningAgents = userAgents.filter((row) => agentCanReceiveTelegram(row.status));

    // ── 3. Resolve target agent(s) from caption /to command ──────────────

    const caption = message.caption?.trim();
    const parsedCommand = caption ? parseTelegramCommand(caption) : null;

    let targetAgents: typeof runningAgents;

    if (parsedCommand?.targets.length) {
      targetAgents = [];
      for (const target of parsedCommand.targets) {
        const isBroadcast = target === '*' || target.toLowerCase() === 'all';
        const matches = isBroadcast
          ? runningAgents
          : runningAgents.filter((row) => row.agentName.toLowerCase() === target.toLowerCase());
        for (const match of matches) {
          if (!targetAgents.some((a) => a.agentId === match.agentId)) {
            targetAgents.push(match);
          }
        }
      }
      if (targetAgents.length === 0) {
        await sendTelegramText(chatId, 'No running agents found matching the target. Start an agent first to send documents.');
        return;
      }
    } else if (runningAgents.length === 1) {
      targetAgents = [runningAgents[0]!];
    } else if (runningAgents.length === 0) {
      await sendTelegramText(chatId, 'No running agents found. Start an agent first to send documents.');
      return;
    } else {
      await sendTelegramText(chatId, 'Multiple running agents found. Use /to <agent name> in the caption to choose a target.');
      return;
    }

    // ── 4. Download the file from Telegram ───────────────────────────────

    const fileData = await downloadTelegramFile(document.file_id);
    if (!fileData) {
      await sendTelegramText(chatId, 'Failed to download the document from Telegram. Please try again.');
      return;
    }

    // ── 5. Ingest through AgentDocumentService for each target agent ─────

    const filename = document.file_name ?? 'document';
    const mimeType = document.mime_type ?? 'application/octet-stream';
    const docService = getDocumentService();

    for (const targetAgent of targetAgents) {
      const result = await docService.uploadDocument({
        agentId: targetAgent.agentId,
        userId,
        source: 'telegram',
        originalFilename: filename,
        mimeType,
        body: fileData.buffer,
        sourceRef: document.file_id,
        captionOrPrompt: caption ?? null,
      });

      if (!result.ok) {
        await sendTelegramText(chatId, `Document upload failed for ${targetAgent.agentName}: ${result.error.message}`);
        continue;
      }

      // ── 6. Publish text notification to the agent ─────────────────────

      const docResult = result.data;
      const safeName = sanitizeFilename(filename);
      const extracted = docResult.extractionStatus === 'ready';
      const notificationText = [
        `User sent document \`${filename}\`.`,
        `Original saved at \`docs/original/${docResult.id}-${safeName}\`.`,
        extracted ? `Extracted text saved at \`docs/extracted/${docResult.id}.txt\`.` : '',
        caption ? `Caption: "${caption}"` : '',
      ].filter(Boolean).join('\n');

      await deliverTelegramMessage(targetAgent.agentId, userId, notificationText);
      await sendTelegramText(chatId, `Document delivered to ${targetAgent.agentName}.`);
    }
  }

  app.post<{ Body: unknown }>('/telegram/webhook', async (request, reply) => {
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

    // Handle document messages — download, ingest, and notify the agent
    if (message.document) {
      reply.status(200).send({ ok: true });
      void processWebhookDocument(message.chat.id, message).catch((err) => {
        app.log.warn({ err }, 'Telegram webhook document processing failed');
      });
      return;
    }

    // Drop other non-text messages
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
