import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { eq, and, inArray, desc } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { agents, agentRuntimeSessions, agentMessages, agentArtifacts, agentOutboundMessages, bots, decisions } from '@herobids/db';
import type { PlansConfig } from '@herobids/domain';
import { checkAgentLimit } from '../plan-guards.js';
import { errorPayload } from '../error-payload.js';
import {
  CostPresetSchema,
  decorateAgentResponse,
  hasModelFieldsWithoutProvider,
  mergeModelPolicy,
  nullablePositiveDecimalStringSchema,
  nullablePositiveIntegerSchema,
  optionalPositiveDecimalStringSchema,
  optionalPositiveIntegerSchema,
  resolveDailyLlmTokenBudget,
  resolveNotificationPolicy,
  validateAgentModelPolicy,
} from './agent-config-helpers.js';

// --- Request Schemas ---

const CreateAgentSchema = z.object({
  name: z.string().min(1).max(100),
  prompt: z.string().min(1).max(4000),
  skillIds: z.array(z.string().min(1)).optional(),
  toolPolicy: z.record(z.unknown()).optional(),
  modelPolicy: z.record(z.unknown()).optional(),
  provider: z.string().min(1).max(200).optional(),
  lightModel: z.string().min(1).max(200).optional(),
  heavyModel: z.string().min(1).max(200).optional(),
  costPreset: CostPresetSchema.optional(),
  dailySpendBudgetUsd: z.number().positive().optional(),
  dexWatchlistSymbols: z.array(z.string().min(1).max(64)).max(25).optional(),
  telegramChatId: z.string().optional(),
  notificationPolicy: z.object({
    sendMessage: z.object({
      email: z.object({
        enabled: z.boolean(),
        source: z.enum(['explicit_prompt', 'explicit_update']),
      }).optional(),
    }).optional(),
  }).nullable().optional(),
  executionMode: z.enum(['paper', 'shadow', 'live']).optional(),
  dailyTokenBudget: optionalPositiveIntegerSchema(),
  dailyLlmTokenBudget: optionalPositiveIntegerSchema(),
  dailyLossLimit: optionalPositiveDecimalStringSchema,
  maxBots: optionalPositiveIntegerSchema(),
  maxSlippageBps: optionalPositiveIntegerSchema(0),
  tickIntervalMs: optionalPositiveIntegerSchema(1000),
  capital: optionalPositiveDecimalStringSchema,
});

const UpdateAgentSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  prompt: z.string().min(1).max(4000).optional(),
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
  notificationPolicy: z.object({
    sendMessage: z.object({
      email: z.object({
        enabled: z.boolean(),
        source: z.enum(['explicit_prompt', 'explicit_update']),
      }).optional(),
    }).optional(),
  }).nullable().optional(),
  // nullable allows clearing a previously set value; undefined (omitted) leaves the field unchanged
  executionMode: z.enum(['paper', 'shadow', 'live']).nullable().optional(),
  dailyTokenBudget: nullablePositiveIntegerSchema(),
  dailyLlmTokenBudget: nullablePositiveIntegerSchema(),
  dailyLossLimit: nullablePositiveDecimalStringSchema,
  maxBots: nullablePositiveIntegerSchema(),
  maxSlippageBps: nullablePositiveIntegerSchema(0),
  tickIntervalMs: nullablePositiveIntegerSchema(1000),
  capital: nullablePositiveDecimalStringSchema,
});

const PauseAgentSchema = z.object({
  reason: z.string().min(1).max(500),
});

export async function agentRoutes(app: FastifyInstance, db: Database, plansConfig?: PlansConfig, llmConfig?: { provider: string }): Promise<void> {
  // --- CRUD ---

  // Create agent
  app.post('/agents', async (request, reply) => {
    const parsed = CreateAgentSchema.safeParse(request.body);
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

    // Plan enforcement
    if (plansConfig) {
      const planCheck = await checkAgentLimit(db, plansConfig, request.userId, request.userPlanId || 'free');
      if (!planCheck.ok) {
        return reply.status(403).send(errorPayload(planCheck.error.code, planCheck.error.message, planCheck.error.params));
      }
    }

    const agentId = crypto.randomUUID();
    const now = new Date();

    // Auto-populate toolPolicy from skillIds so the broker enforces the right capability grants
    // without requiring the caller to supply raw CapabilityGrant objects.
    const basePolicy: Record<string, unknown> = { ...(parsed.data.toolPolicy ?? {}) };
    if ((parsed.data.skillIds ?? []).includes('bot-management') && !basePolicy['manage_bot']) {
      basePolicy['manage_bot'] = {
        capability: 'manage_bot',
        tier: 'brokered',
        enabled: true,
        limits: { maxPerMinute: 5, maxConcurrent: 1, timeoutMs: 30_000 },
      };
    }
    const effectiveToolPolicy = Object.keys(basePolicy).length > 0 ? basePolicy : null;

    const effectiveModelPolicy = mergeModelPolicy(parsed.data.modelPolicy ?? null, parsed.data);
    const modelIssues = validateAgentModelPolicy(effectiveModelPolicy, llmConfig?.provider);
    if (modelIssues.length > 0) {
      return reply.status(400).send({ error: 'validation_error', details: modelIssues });
    }

    await db.insert(agents).values({
      id: agentId,
      userId: request.userId,
      name: parsed.data.name,
      prompt: parsed.data.prompt,
      skillIds: parsed.data.skillIds ?? [],
      status: 'stopped',
      toolPolicy: effectiveToolPolicy,
      modelPolicy: effectiveModelPolicy,
      telegramChatId: parsed.data.telegramChatId ?? null,
      notificationPolicy: parsed.data.notificationPolicy !== undefined
        ? (parsed.data.notificationPolicy === null ? null : resolveNotificationPolicy(parsed.data.notificationPolicy, null))
        : null,
      executionMode: parsed.data.executionMode ?? null,
      dailyTokenBudget: dailyLlmTokenBudget.value ?? null,
      dailyLossLimit: parsed.data.dailyLossLimit ?? null,
      maxBots: parsed.data.maxBots ?? null,
      maxSlippageBps: parsed.data.maxSlippageBps ?? null,
      tickIntervalMs: parsed.data.tickIntervalMs ?? null,
      capital: parsed.data.capital ?? null,
      createdAt: now,
      updatedAt: now,
    });

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    return reply.status(201).send(decorateAgentResponse(agent!));
  });

  // List user's agents
  app.get('/agents', async (request, reply) => {
    const rows = await db.select().from(agents)
      .where(eq(agents.userId, request.userId))
      .orderBy(agents.createdAt);
    return reply.send(rows.map((agent) => decorateAgentResponse(agent)));
  });

  // Get single agent
  app.get<{ Params: { id: string } }>('/agents/:id', async (request, reply) => {
    const { id } = request.params;
    const [agent] = await db.select().from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) {
      return reply.status(404).send({ error: 'not_found' });
    }

    // Include active session (starting/launching/running/unhealthy).
    // Do not return lingering sessions for stopped/crashed agents — any such session is stale.
    const isTerminalState = agent.status === 'stopped' || agent.status === 'crashed';
    const [session] = isTerminalState ? [] : await db.select().from(agentRuntimeSessions)
      .where(and(
        eq(agentRuntimeSessions.agentId, id),
        inArray(agentRuntimeSessions.status, ['starting', 'launching', 'running', 'unhealthy']),
      ))
      .orderBy(desc(agentRuntimeSessions.startedAt));

    return reply.send({ ...decorateAgentResponse(agent), activeSession: session ?? null });
  });

  // Update agent
  app.patch<{ Params: { id: string } }>('/agents/:id', async (request, reply) => {
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
    if (!agent) {
      return reply.status(404).send({ error: 'not_found' });
    }

    // Config changes are only safe when the agent is not running.
    // Mutating prompt, skills, or limits while a session is active would produce
    // inconsistent behaviour — the running process has already loaded its config.
    if (!['stopped', 'crashed'].includes(agent.status)) {
      return reply.status(409).send(
        errorPayload(
          'agent_not_editable',
          `Agent config can only be updated when stopped or crashed (current status: ${agent.status}).`,
          { status: agent.status },
        ),
      );
    }

    // Re-derive toolPolicy from the effective skillIds — same logic as the create path —
    // so that capability grants stay consistent whenever skills are added or removed via PATCH.
    const mergedSkillIds = parsed.data.skillIds ?? agent.skillIds ?? [];
    // If toolPolicy is explicitly provided in the PATCH body, replace the stored policy entirely
    // (allow callers to remove overrides). If omitted, preserve the existing stored policy.
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
    } else if (
      !mergedSkillIds.includes('bot-management') &&
      // Only auto-remove if the caller did not explicitly supply a grant entry.
      !(parsed.data.toolPolicy && 'manage_bot' in parsed.data.toolPolicy)
    ) {
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
    const modelIssues = validateAgentModelPolicy(effectiveModelPolicy, llmConfig?.provider);
    if (modelIssues.length > 0) {
      return reply.status(400).send({ error: 'validation_error', details: modelIssues });
    }

    const {
      provider: _provider,
      lightModel: _lightModel,
      heavyModel: _heavyModel,
      costPreset: _costPreset,
      dailySpendBudgetUsd: _dailySpendBudgetUsd,
      dexWatchlistSymbols: _dexWatchlistSymbols,
      dailyLlmTokenBudget: _dailyLlmTokenBudget,
      modelPolicy: _modelPolicy,
      notificationPolicy: notificationPolicyInput,
      ...agentUpdates
    } = parsed.data;

    const effectiveNotificationPolicy = notificationPolicyInput !== undefined
      ? (notificationPolicyInput === null ? null : resolveNotificationPolicy(notificationPolicyInput, agent.notificationPolicy as Parameters<typeof resolveNotificationPolicy>[1]))
      : undefined;

    await db.update(agents).set({
      ...agentUpdates,
      ...(effectiveNotificationPolicy !== undefined ? { notificationPolicy: effectiveNotificationPolicy } : {}),
      ...(dailyLlmTokenBudget.value !== undefined ? { dailyTokenBudget: dailyLlmTokenBudget.value } : {}),
      toolPolicy: effectiveToolPolicy,
      modelPolicy: effectiveModelPolicy,
      updatedAt: new Date(),
    }).where(eq(agents.id, id));

    const [updated] = await db.select().from(agents).where(eq(agents.id, id));
    return reply.send(decorateAgentResponse(updated!));
  });

  // Delete agent
  app.delete<{ Params: { id: string } }>('/agents/:id', async (request, reply) => {
    const { id } = request.params;
    const [agent] = await db.select().from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) {
      return reply.status(404).send({ error: 'not_found' });
    }

    // Only allow delete when stopped
    if (agent.status !== 'stopped') {
      return reply.status(409).send(
        errorPayload('agent_not_stopped', 'Agent must be stopped before deletion', { status: agent.status }),
      );
    }

    // Delete the agent — explicitly cascade-delete child rows before the parent.
    await db.delete(agentOutboundMessages).where(eq(agentOutboundMessages.agentId, id));
    await db.delete(agentArtifacts).where(eq(agentArtifacts.agentId, id));
    await db.delete(agentRuntimeSessions).where(eq(agentRuntimeSessions.agentId, id));
    await db.delete(agents).where(eq(agents.id, id));
    return reply.status(204).send();
  });

  // --- Lifecycle ---

  // Pause agent
  app.post<{ Params: { id: string } }>('/agents/:id/pause', async (request, reply) => {
    const { id } = request.params;
    const parsed = PauseAgentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const [agent] = await db.select().from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) {
      return reply.status(404).send({ error: 'not_found' });
    }

    // Idempotent
    if (agent.status === 'paused') {
      return reply.send({ status: 'paused' });
    }

    await db.update(agents).set({
      status: 'paused',
      pauseState: { reason: parsed.data.reason, requestedBy: 'user', pausedAt: new Date().toISOString() },
      updatedAt: new Date(),
    }).where(eq(agents.id, id));

    return reply.send({ status: 'paused' });
  });

  // Resume agent
  app.post<{ Params: { id: string } }>('/agents/:id/resume', async (request, reply) => {
    const { id } = request.params;
    const [agent] = await db.select().from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) {
      return reply.status(404).send({ error: 'not_found' });
    }

    if (agent.status !== 'paused') {
      return reply.status(409).send(errorPayload('not_paused', 'Agent is not paused', { status: agent.status }));
    }

    await db.update(agents).set({
      status: 'active',
      pauseState: null,
      updatedAt: new Date(),
    }).where(eq(agents.id, id));

    return reply.send({ status: 'active' });
  });

  // Start agent (stopped → starting) — records the request durably.
  app.post<{ Params: { id: string } }>('/agents/:id/start', async (request, reply) => {
    const { id } = request.params;
    const sessionId = crypto.randomUUID();
    const now = new Date();
    const result = await db.transaction(async (tx) => {
      const [agent] = await tx.select({ status: agents.status }).from(agents)
        .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
      if (!agent) {
        return { kind: 'not_found' as const };
      }

      if (agent.status !== 'stopped') {
        return { kind: 'not_stopped' as const, status: agent.status };
      }

      const [claimedAgent] = await tx.update(agents).set({
        status: 'starting',
        pauseState: null,
        updatedAt: now,
      }).where(and(
        eq(agents.id, id),
        eq(agents.userId, request.userId),
        eq(agents.status, 'stopped'),
      )).returning({ id: agents.id });
      if (!claimedAgent) {
        return { kind: 'not_stopped' as const, status: 'starting' };
      }

      await tx.update(agentRuntimeSessions)
        .set({ status: 'stopped', stoppedAt: now })
        .where(and(
          eq(agentRuntimeSessions.agentId, id),
          inArray(agentRuntimeSessions.status, ['starting', 'launching', 'running', 'unhealthy']),
        ));

      await tx.insert(agentRuntimeSessions).values({
        id: sessionId,
        agentId: id,
        status: 'starting',
      });

      return { kind: 'started' as const };
    });

    if (result.kind === 'not_found') {
      return reply.status(404).send({ error: 'not_found' });
    }

    if (result.kind === 'not_stopped') {
      return reply.status(409).send(errorPayload('not_stopped', 'Agent is not stopped', { status: result.status }));
    }

    return reply.status(202).send({ status: 'starting', sessionId });
  });

  // --- Views ---

  // Get agent activity (recent messages)
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/agents/:id/activity', async (request, reply) => {
    const { id } = request.params;
    const limit = parseInt(request.query.limit ?? '50', 10);

    const [agent] = await db.select().from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) {
      return reply.status(404).send({ error: 'not_found' });
    }

    const messages = await db.select().from(agentMessages)
      .where(eq(agentMessages.agentId, id))
      .orderBy(desc(agentMessages.createdAt))
      .limit(limit);

    return reply.send(messages);
  });

  // Get agent artifacts
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/agents/:id/artifacts', async (request, reply) => {
    const { id } = request.params;
    const limit = parseInt(request.query.limit ?? '50', 10);

    const [agent] = await db.select().from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) {
      return reply.status(404).send({ error: 'not_found' });
    }

    const artifacts = await db.select().from(agentArtifacts)
      .where(eq(agentArtifacts.agentId, id))
      .orderBy(desc(agentArtifacts.createdAt))
      .limit(limit);

    return reply.send(artifacts);
  });

  // Get agent sessions history
  app.get<{ Params: { id: string } }>('/agents/:id/sessions', async (request, reply) => {
    const { id } = request.params;

    const [agent] = await db.select().from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) {
      return reply.status(404).send({ error: 'not_found' });
    }

    const sessions = await db.select().from(agentRuntimeSessions)
      .where(eq(agentRuntimeSessions.agentId, id))
      .orderBy(agentRuntimeSessions.startedAt);

    return reply.send(sessions);
  });

  // Get recent decisions from bots owned by this agent
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/agents/:id/decisions', async (request, reply) => {
    const { id } = request.params;
    const limit = Math.min(parseInt(request.query.limit ?? '20', 10), 100);

    const [agent] = await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) return reply.status(404).send({ error: 'not_found' });

    const agentBots = await db.select({ id: bots.id }).from(bots)
      .where(and(eq(bots.creatorType, 'agent'), eq(bots.creatorId, id)));
    const agentBotIds = agentBots.map((b) => b.id);

    if (agentBotIds.length === 0) {
      return reply.send([]);
    }

    const agentDecisions = await db.select().from(decisions)
      .where(and(eq(decisions.actorType, 'bot'), inArray(decisions.actorId, agentBotIds)))
      .orderBy(desc(decisions.createdAt))
      .limit(limit);

    return reply.send(agentDecisions);
  });

  // Stop agent (active/paused/starting → stopped).
  // Marks the agent and its active sessions as stopped. The worker's health monitor
  // cleans up any in-memory runtime handles on the next check cycle.
  app.post<{ Params: { id: string } }>('/agents/:id/stop', async (request, reply) => {
    const { id } = request.params;
    const now = new Date();
    const result = await db.transaction(async (tx) => {
      const [agent] = await tx.select({ status: agents.status })
        .from(agents)
        .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
      if (!agent) return { kind: 'not_found' as const };
      if (agent.status === 'stopped') return { kind: 'already_stopped' as const };

      await tx.update(agents).set({ status: 'stopped', pauseState: null, updatedAt: now })
        .where(eq(agents.id, id));

      await tx.update(agentRuntimeSessions)
        .set({ status: 'stopped', stoppedAt: now })
        .where(and(
          eq(agentRuntimeSessions.agentId, id),
          inArray(agentRuntimeSessions.status, ['starting', 'launching', 'running', 'unhealthy']),
        ));

      return { kind: 'stopped' as const };
    });

    if (result.kind === 'not_found') return reply.status(404).send({ error: 'not_found' });
    return reply.send({ status: 'stopped' });
  });

  // Get agent outbound messages (agent-authored + platform safety alerts).
  // Returns the actual content sent to the user, with authorship distinction.
  app.get<{ Params: { id: string }; Querystring: { limit?: string; authoredBy?: string } }>('/agents/:id/messages', async (request, reply) => {
    const { id } = request.params;
    const limit = Math.min(parseInt(request.query.limit ?? '50', 10), 200);
    const authoredByFilter = request.query.authoredBy;

    const [agent] = await db.select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) return reply.status(404).send({ error: 'not_found' });

    const query = db.select().from(agentOutboundMessages)
      .where(
        authoredByFilter
          ? and(eq(agentOutboundMessages.agentId, id), eq(agentOutboundMessages.authoredBy, authoredByFilter))
          : eq(agentOutboundMessages.agentId, id),
      )
      .orderBy(desc(agentOutboundMessages.createdAt))
      .limit(limit);

    return reply.send(await query);
  });
}
