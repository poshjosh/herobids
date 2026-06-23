import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { eq, and, inArray, notInArray, desc, sql, or, asc, isNull } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Database } from '@herobids/db';
import {
  agents,
  agentArtifacts,
  agentMessages,
  agentOutboundMessages,
  agentRuntimeSessions,
  agentSkills,
  billingUsageEvents,
  bots,
  capabilityGrants,
  decisions,
  decisionFailures,
  executionPlans,
  skillEntitlements,
  skillRevisions,
  skillUsageEvents,
  skills,
  tradingBindings,
  venueAccounts,
} from '@herobids/db';
import type { PlansConfig } from '@herobids/domain';
import { AgentRiskDefaultsSchema, TechnicalConfigSchema, validateExecutionCapability, venueTypeFromProvider, type AgentRiskDefaultsConfig } from '@herobids/domain';
import { checkAgentLimit, resolvePlanSkillEntitlements } from '../plan-guards.js';
import { errorPayload } from '../error-payload.js';
import type { OperatorLlmCatalogContext } from '../llm-model-catalog.js';
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
  resolveExecutionModeForSkills,
  resolveNotificationPolicy,
  resolveAgentRiskContractForResponse,
  validateAgentModelPolicy,
} from './agent-config-helpers.js';
import {
  mapProtocolMessage,
  mapRuntimeSession,
  mapOutboundMessage,
  mapArtifact,
  isSuppressedProtocolMessageType,
  SUPPRESSED_PROTOCOL_MESSAGE_TYPES,
} from './agent-activity-mapper.js';
import type { AgentActivityEntry } from './agent-activity-types.js';

// --- Request Schemas ---
const AgentNameSchema = z.string().min(1).max(100).refine((value) => {
  const normalized = value.trim().toLowerCase();
  return normalized !== 'all' && normalized !== '*';
}, {
  message: 'Agent name is reserved for Telegram broadcast targeting',
});

const CreateAgentSchema = z.object({
  name: AgentNameSchema,
  prompt: z.string().max(4000).optional(),
  technical: TechnicalConfigSchema.optional(),
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
  maxOpenPositions: optionalPositiveIntegerSchema(),
  maxPositionSizePct: z.number().min(0).max(100).optional(),
  stopLossPct: z.number().min(0).max(100).optional(),
  stopLossCooldownMs: optionalPositiveIntegerSchema(0),
  tickIntervalMs: optionalPositiveIntegerSchema(1000),
  capital: optionalPositiveDecimalStringSchema,
}).superRefine((data, ctx) => {
  if (!data.technical && !data.prompt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['prompt'],
      message: 'prompt is required when no technical config is provided',
    });
  }
});

const UpdateAgentSchema = z.object({
  name: AgentNameSchema.optional(),
  prompt: z.string().max(4000).optional(),
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
  maxOpenPositions: nullablePositiveIntegerSchema(),
  maxPositionSizePct: z.number().min(0).max(100).nullable().optional(),
  stopLossPct: z.number().min(0).max(100).nullable().optional(),
  stopLossCooldownMs: nullablePositiveIntegerSchema(0),
  tickIntervalMs: nullablePositiveIntegerSchema(1000),
  capital: nullablePositiveDecimalStringSchema,
  technical: TechnicalConfigSchema.nullable().optional(),
});

const PauseAgentSchema = z.object({
  reason: z.string().min(1).max(500),
});

type SkillAssignmentResolution = {
  skillId: string;
  skillRevisionId: string;
};

const DEFAULT_AGENT_RISK_DEFAULTS: AgentRiskDefaultsConfig = AgentRiskDefaultsSchema.parse({});

function validateAgentRiskBounds(
  input: {
    maxOpenPositions?: number | null;
    maxPositionSizePct?: number | null;
    stopLossPct?: number | null;
    stopLossCooldownMs?: number | null;
  },
  defaults: AgentRiskDefaultsConfig,
): Array<{ code: 'custom'; path: string[]; message: string }> {
  const issues: Array<{ code: 'custom'; path: string[]; message: string }> = [];

  if (input.maxOpenPositions != null && input.maxOpenPositions > defaults.maxOpenPositions) {
    issues.push({
      code: 'custom',
      path: ['maxOpenPositions'],
      message: `maxOpenPositions cannot exceed the platform limit of ${defaults.maxOpenPositions}`,
    });
  }

  if (input.maxPositionSizePct != null && input.maxPositionSizePct > defaults.maxPositionSizePct) {
    issues.push({
      code: 'custom',
      path: ['maxPositionSizePct'],
      message: `maxPositionSizePct cannot exceed the platform limit of ${defaults.maxPositionSizePct}%`,
    });
  }

  if (input.stopLossPct != null && input.stopLossPct > defaults.stopLossMaxUnrealizedLossPct) {
    issues.push({
      code: 'custom',
      path: ['stopLossPct'],
      message: `stopLossPct cannot exceed the platform limit of ${defaults.stopLossMaxUnrealizedLossPct}%`,
    });
  }

  if (input.stopLossCooldownMs != null && input.stopLossCooldownMs > defaults.stopLossCooldownMs) {
    issues.push({
      code: 'custom',
      path: ['stopLossCooldownMs'],
      message: `stopLossCooldownMs cannot exceed the platform limit of ${defaults.stopLossCooldownMs}ms`,
    });
  }

  return issues;
}

function isSkillSelectableForUser(input: {
  skill: typeof skills.$inferSelect;
  userId: string;
  entitledSkillIds: Set<string>;
  preservedSkillIds?: Set<string>;
  canViewMarketplaceSkills: boolean;
}): boolean {
  if (input.skill.authorId === null) return true;
  if (input.skill.authorId === input.userId) return true;
  if (input.preservedSkillIds?.has(input.skill.id)) return true;
  if (input.entitledSkillIds.has(input.skill.id)) return true;
  return input.canViewMarketplaceSkills && input.skill.publicationStatus === 'published' && input.skill.priceCents === 0;
}

async function resolveSkillAssignmentsForUser(
  db: Database,
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
    return !isSkillSelectableForUser({ skill, userId, entitledSkillIds, preservedSkillIds, canViewMarketplaceSkills });
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
  db: Database,
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

async function listSkillIdsForAgent(db: Database, agentId: string): Promise<string[]> {
  const rows = await db.select({ skillId: agentSkills.skillId })
    .from(agentSkills)
    .where(eq(agentSkills.agentId, agentId))
    .orderBy(asc(agentSkills.orderIndex), asc(agentSkills.skillId));
  return rows.map((row) => row.skillId);
}

async function listSkillIdsByAgentId(db: Database, agentIds: string[]): Promise<Map<string, string[]>> {
  if (agentIds.length === 0) {
    return new Map();
  }

  const rows = await db.select({
    agentId: agentSkills.agentId,
    skillId: agentSkills.skillId,
  }).from(agentSkills)
    .where(inArray(agentSkills.agentId, agentIds))
    .orderBy(asc(agentSkills.agentId), asc(agentSkills.orderIndex), asc(agentSkills.skillId));

  const skillIdsByAgentId = new Map<string, string[]>();
  for (const row of rows) {
    const current = skillIdsByAgentId.get(row.agentId) ?? [];
    current.push(row.skillId);
    skillIdsByAgentId.set(row.agentId, current);
  }

  return skillIdsByAgentId;
}

export async function agentRoutes(
  app: FastifyInstance,
  db: Database,
  plansConfig?: PlansConfig,
  llmCatalogContext?: OperatorLlmCatalogContext,
  agentRiskDefaults: AgentRiskDefaultsConfig = DEFAULT_AGENT_RISK_DEFAULTS,
  redisClient?: Redis,
): Promise<void> {
  function resolveSkillPlanPolicy(planId: string, isAdmin: boolean) {
    if (!plansConfig) {
      return { canViewMarketplaceSkills: true };
    }
    return resolvePlanSkillEntitlements(plansConfig, planId, isAdmin);
  }

  app.get('/agents/risk-defaults', async (_request, reply) => {
    return reply.send({
      maxOpenPositions: agentRiskDefaults.maxOpenPositions,
      maxPositionSizePct: agentRiskDefaults.maxPositionSizePct,
      stopLossPct: agentRiskDefaults.stopLossMaxUnrealizedLossPct,
      stopLossCooldownMs: agentRiskDefaults.stopLossCooldownMs,
    });
  });

  // --- CRUD ---

  // Create agent
  app.post('/agents', async (request, reply) => {
    const parsed = CreateAgentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const riskIssues = validateAgentRiskBounds(parsed.data, agentRiskDefaults);
    if (riskIssues.length > 0) {
      return reply.status(400).send({ error: 'validation_error', details: riskIssues });
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
      const planCheck = await checkAgentLimit(db, plansConfig, request.userId, request.userPlanId || 'free', request.isAdmin);
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
    const modelIssues = await validateAgentModelPolicy(effectiveModelPolicy, llmCatalogContext);
    if (modelIssues.length > 0) {
      return reply.status(400).send({ error: 'validation_error', details: modelIssues });
    }

    // Shadow mode is admin-only
    if (parsed.data.executionMode === 'shadow' && !request.isAdmin) {
      return reply.status(403).send(errorPayload('execution_mode.admin_only', 'Shadow execution mode is restricted to admin users.'));
    }

    const executionMode = resolveExecutionModeForSkills({
      skillIds: parsed.data.skillIds ?? [],
      submittedExecutionMode: parsed.data.executionMode,
      executionModeProvided: parsed.data.executionMode !== undefined,
      currentExecutionMode: null,
    });
    if (executionMode.issue) {
      return reply.status(400).send({ error: 'validation_error', details: [executionMode.issue] });
    }

    const skillPlanPolicy = resolveSkillPlanPolicy(request.userPlanId || 'free', request.isAdmin);
    const assignmentResolution = await resolveSkillAssignmentsForUser(
      db,
      request.userId,
      parsed.data.skillIds ?? [],
      new Set(),
      skillPlanPolicy.canViewMarketplaceSkills,
    );
    if (assignmentResolution.error) {
      return reply.status(400).send({ error: assignmentResolution.error.code, details: assignmentResolution.error.details ?? [], message: assignmentResolution.error.message });
    }

    await db.insert(agents).values({
      id: agentId,
      userId: request.userId,
      name: parsed.data.name,
      prompt: parsed.data.prompt ?? '',
      status: 'stopped',
      toolPolicy: effectiveToolPolicy,
      modelPolicy: effectiveModelPolicy,
      telegramChatId: parsed.data.telegramChatId ?? null,
      notificationPolicy: parsed.data.notificationPolicy !== undefined
        ? (parsed.data.notificationPolicy === null ? null : resolveNotificationPolicy(parsed.data.notificationPolicy, null))
        : null,
      ...(executionMode.value != null ? { executionMode: executionMode.value } : {}),
      dailyTokenBudget: dailyLlmTokenBudget.value ?? null,
      dailyLossLimit: parsed.data.dailyLossLimit ?? null,
      maxBots: parsed.data.maxBots ?? null,
      maxSlippageBps: parsed.data.maxSlippageBps ?? null,
      maxOpenPositions: parsed.data.maxOpenPositions ?? null,
      maxPositionSizePct: parsed.data.maxPositionSizePct != null ? String(parsed.data.maxPositionSizePct) : null,
      stopLossPct: parsed.data.stopLossPct != null ? String(parsed.data.stopLossPct) : null,
      stopLossCooldownMs: parsed.data.stopLossCooldownMs ?? null,
      tickIntervalMs: parsed.data.tickIntervalMs ?? null,
      capital: parsed.data.capital ?? null,
      ...(parsed.data.technical ? { unifiedConfig: { technical: parsed.data.technical } } : {}),
      createdAt: now,
      updatedAt: now,
    });

    await syncAgentSkillAssignments(db, agentId, request.userId, assignmentResolution.assignments ?? []);

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    const skillIds = await listSkillIdsForAgent(db, agentId);
    const riskContract = resolveAgentRiskContractForResponse(agent!, agentRiskDefaults);
    return reply.status(201).send({ ...decorateAgentResponse({ ...agent!, skillIds }), technical: (agent!.unifiedConfig as Record<string, unknown> | null)?.['technical'] ?? null, riskContract });
  });

  // List user's agents
  app.get('/agents', async (request, reply) => {
    const rows = await db.select().from(agents)
      .where(eq(agents.userId, request.userId))
      .orderBy(agents.createdAt);
    const skillIdsByAgentId = await listSkillIdsByAgentId(db, rows.map((row) => row.id));
    return reply.send(rows.map((agent) => ({
      ...decorateAgentResponse({
        ...agent,
        skillIds: skillIdsByAgentId.get(agent.id) ?? [],
      }),
      technical: (agent.unifiedConfig as Record<string, unknown> | null)?.['technical'] ?? null,
    })));
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

    const skillIds = await listSkillIdsForAgent(db, id);
    const riskContract = resolveAgentRiskContractForResponse(agent, agentRiskDefaults);
    return reply.send({ ...decorateAgentResponse({ ...agent, skillIds }), technical: (agent.unifiedConfig as Record<string, unknown> | null)?.['technical'] ?? null, riskContract, activeSession: session ?? null });
  });

  // Update agent
  app.patch<{ Params: { id: string } }>('/agents/:id', async (request, reply) => {
    const { id } = request.params;
    const parsed = UpdateAgentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const riskIssues = validateAgentRiskBounds(parsed.data, agentRiskDefaults);
    if (riskIssues.length > 0) {
      return reply.status(400).send({ error: 'validation_error', details: riskIssues });
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
    const existingSkillIds = await listSkillIdsForAgent(db, id);
    const mergedSkillIds = parsed.data.skillIds ?? existingSkillIds;
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
    const modelIssues = await validateAgentModelPolicy(effectiveModelPolicy, llmCatalogContext);
    if (modelIssues.length > 0) {
      return reply.status(400).send({ error: 'validation_error', details: modelIssues });
    }

    // Shadow mode is admin-only
    if (parsed.data.executionMode === 'shadow' && !request.isAdmin) {
      return reply.status(403).send(errorPayload('execution_mode.admin_only', 'Shadow execution mode is restricted to admin users.'));
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

    // Validate execution capability against the agent's active trading binding (if any)
    if (executionMode.value) {
      const [activeGrant] = await db.select({ provider: tradingBindings.provider })
        .from(capabilityGrants)
        .innerJoin(tradingBindings, eq(capabilityGrants.bindingId, tradingBindings.id))
        .where(and(
          eq(capabilityGrants.agentId, id),
          eq(capabilityGrants.capabilityFamily, 'trading'),
          eq(capabilityGrants.status, 'active'),
          eq(tradingBindings.status, 'active'),
        ))
        .limit(1);
      if (activeGrant) {
        const agentVenueType = venueTypeFromProvider(activeGrant.provider);
        if (agentVenueType) {
          const capCheck = validateExecutionCapability({
            actorType: 'agent',
            executionMode: executionMode.value as 'paper' | 'shadow' | 'live',
            venueType: agentVenueType,
          });
          if (!capCheck.ok) {
            return reply.status(400).send({
              error: `execution_capability.${capCheck.error.code}`,
              message: capCheck.error.message,
            });
          }
        }
      }
    }

    const skillPlanPolicy = resolveSkillPlanPolicy(request.userPlanId || 'free', request.isAdmin);
    const assignmentResolution = await resolveSkillAssignmentsForUser(
      db,
      request.userId,
      mergedSkillIds,
      new Set(existingSkillIds),
      skillPlanPolicy.canViewMarketplaceSkills,
    );
    if (assignmentResolution.error) {
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
      notificationPolicy: notificationPolicyInput,
      maxPositionSizePct: rawMaxPositionSizePct,
      stopLossPct: rawStopLossPct,
      technical: technicalUpdate,
      ...agentUpdates
    } = parsed.data;
    void _skillIds;

    // Merge technical into unifiedConfig — only touch the 'technical' key, preserve other keys
    let unifiedConfigPatch: Record<string, unknown> | null | undefined = undefined;
    if (technicalUpdate !== undefined) {
      const current = (agent.unifiedConfig as Record<string, unknown> | null) ?? {};
      if (technicalUpdate === null) {
        const { technical: _t, ...rest } = current;
        void _t;
        unifiedConfigPatch = Object.keys(rest).length > 0 ? rest : null;
      } else {
        unifiedConfigPatch = { ...current, technical: technicalUpdate };
      }
    }

    const effectiveNotificationPolicy = notificationPolicyInput !== undefined
      ? (notificationPolicyInput === null ? null : resolveNotificationPolicy(notificationPolicyInput, agent.notificationPolicy as Parameters<typeof resolveNotificationPolicy>[1]))
      : undefined;

    await db.update(agents).set({
      ...agentUpdates,
      ...(rawMaxPositionSizePct !== undefined ? { maxPositionSizePct: rawMaxPositionSizePct != null ? String(rawMaxPositionSizePct) : null } : {}),
      ...(rawStopLossPct !== undefined ? { stopLossPct: rawStopLossPct != null ? String(rawStopLossPct) : null } : {}),
      ...(executionMode.value != null ? { executionMode: executionMode.value } : {}),
      ...(effectiveNotificationPolicy !== undefined ? { notificationPolicy: effectiveNotificationPolicy } : {}),
      ...(dailyLlmTokenBudget.value !== undefined ? { dailyTokenBudget: dailyLlmTokenBudget.value } : {}),
      ...(unifiedConfigPatch !== undefined ? { unifiedConfig: unifiedConfigPatch } : {}),
      toolPolicy: effectiveToolPolicy,
      modelPolicy: effectiveModelPolicy,
      updatedAt: new Date(),
    }).where(eq(agents.id, id));

    await syncAgentSkillAssignments(db, id, request.userId, assignmentResolution.assignments ?? []);

    const [updated] = await db.select().from(agents).where(eq(agents.id, id));
    const skillIds = await listSkillIdsForAgent(db, id);
    const riskContract = resolveAgentRiskContractForResponse(updated!, agentRiskDefaults);
    return reply.send({ ...decorateAgentResponse({ ...updated!, skillIds }), technical: (updated!.unifiedConfig as Record<string, unknown> | null)?.['technical'] ?? null, riskContract });
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

    // Agent deletion cleanup — execution order resolves all FK chains.
    // See docs/features/2026/06/20/003-agent-deletion-cleanup/001-plan.md.
    // 1-2. DELETE agent-scoped child rows (no FK to agent_runtime_sessions)
    await db.delete(agentOutboundMessages).where(eq(agentOutboundMessages.agentId, id));
    await db.delete(agentArtifacts).where(eq(agentArtifacts.agentId, id));
    // 3. NULL billing_usage_events.sessionId refs before deleting runtime sessions
    //    (billing_usage_events has ON DELETE NO ACTION on session_id FK).
    //    Must select session IDs first since we delete them in step 4.
    const { sessionIds } = await db
      .select({ sessionIds: agentRuntimeSessions.id })
      .from(agentRuntimeSessions)
      .where(eq(agentRuntimeSessions.agentId, id))
      .then((rows) => ({ sessionIds: rows.map((r) => r.sessionIds) }));
    if (sessionIds.length > 0) {
      await db
        .update(billingUsageEvents)
        .set({ sessionId: null, agentId: null })
        .where(inArray(billingUsageEvents.sessionId, sessionIds));
      // Also handle skill_usage_events which has ON DELETE SET NULL (nullify before delete)
      // to avoid any race with concurrent usage recording.
    }
    // 4. DELETE agent_runtime_sessions (agent-scoped, must come after billing nullification)
    await db.delete(agentRuntimeSessions).where(eq(agentRuntimeSessions.agentId, id));
    // 5. NULL remaining billing_usage_events refs by agentId (catches events with null sessionId)
    await db
      .update(billingUsageEvents)
      .set({ sessionId: null, agentId: null })
      .where(and(eq(billingUsageEvents.agentId, id), isNull(billingUsageEvents.sessionId)));
    // 6. DELETE agent-created bots (must precede binding/venue_account cleanup)
    await db.delete(bots).where(
      and(eq(bots.creatorType, 'agent'), eq(bots.creatorId, id)),
    );
    // 7. RESOLVE orphaned trading_bindings. Only revoke when this agent is the
    //    sole grant holder — shared bindings with other active agents stay active.
    //    Per-binding grant-count queries (N+1). Acceptable: agents rarely have
    //    more than a handful of trading bindings. If that changes, replace with
    //    a single GROUP BY / HAVING count(*) = 1 query.
    const agentBindings = await db
      .select({ id: tradingBindings.id, sourceVenueAccountId: tradingBindings.sourceVenueAccountId })
      .from(tradingBindings)
      .innerJoin(capabilityGrants, eq(capabilityGrants.bindingId, tradingBindings.id))
      .where(eq(capabilityGrants.agentId, id));
    const orphanedBindings: typeof agentBindings = [];
    for (const binding of agentBindings) {
      const allGrants = await db
        .select()
        .from(capabilityGrants)
        .where(eq(capabilityGrants.bindingId, binding.id));
      if (allGrants.length === 1) {
        orphanedBindings.push(binding);
      }
    }
    // 8. NULL venue_accounts.credentialId on orphaned venue accounts (unblocks credential deletion).
    // 9. MARK orphaned trading_bindings as revoked (preserves audit trail).
    if (orphanedBindings.length > 0) {
      const orphanedVenueAccountIds = [...new Set(
        orphanedBindings
          .map((b) => b.sourceVenueAccountId)
          .filter((vaId): vaId is string => vaId !== null),
      )];
      if (orphanedVenueAccountIds.length > 0) {
        await db
          .update(venueAccounts)
          .set({ credentialId: null })
          .where(inArray(venueAccounts.id, orphanedVenueAccountIds));
      }
      await db
        .update(tradingBindings)
        .set({ status: 'revoked' })
        .where(inArray(tradingBindings.id, orphanedBindings.map((b) => b.id)));
    }
    // 9. DELETE agents (cascades: agent_skills, agent_credentials, capability_grants, capability_grant_audit)
    await db.delete(agents).where(eq(agents.id, id));

    // Signal the worker to stop and remove the Docker container for this agent.
    // Best-effort — the 204 response does not guarantee the worker received or
    // processed this signal. The worker's periodic reconciliation is the safety net
    // for missed deliveries (Redis pub/sub has no delivery guarantees).
    if (redisClient) {
      redisClient.publish(`agent:cleanup:${id}`, JSON.stringify({ agentId: id })).catch((err: unknown) => {
        app.log.warn({ err, agentId: id }, 'Failed to publish agent cleanup signal to Redis');
      });
    }

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

  // Get recent decisions initiated by this agent directly or through its bots.
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>('/agents/:id/decisions', async (request, reply) => {
    const { id } = request.params;
    const limit = Math.min(parseInt(request.query.limit ?? '20', 10), 100);

    const [agent] = await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) return reply.status(404).send({ error: 'not_found' });

    const agentBots = await db.select({ id: bots.id }).from(bots)
      .where(and(eq(bots.creatorType, 'agent'), eq(bots.creatorId, id)));
    const agentBotIds = agentBots.map((b) => b.id);

    const decisionOwners = [
      and(eq(decisions.actorType, 'agent'), eq(decisions.actorId, id)),
    ];
    if (agentBotIds.length > 0) {
      decisionOwners.push(and(eq(decisions.actorType, 'bot'), inArray(decisions.actorId, agentBotIds)));
    }

    const agentDecisions = await db.select({
      id: decisions.id,
      venueAccountId: decisions.venueAccountId,
      instrumentId: decisions.instrumentId,
      intent: decisions.intent,
      targetSize: decisions.targetSize,
      limitPrice: decisions.limitPrice,
      contextHash: decisions.contextHash,
      actorType: decisions.actorType,
      actorId: decisions.actorId,
      metadata: decisions.metadata,
      createdAt: decisions.createdAt,
      // Derived from execution_plans — decisions are append-only with no status column
      status: sql<string | null>`(
        SELECT ep.status FROM ${executionPlans} ep
        WHERE ep.decision_id = ${decisions.id}
        ORDER BY ep.created_at DESC
        LIMIT 1
      )`.as('status'),
    }).from(decisions)
      .where(or(...decisionOwners))
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

  // ─── GET /agents/:id/activity-feed ────────────────────────────────────────
  // Canonical agent activity feed — merges protocol messages, runtime sessions,
  // outbound messages, and artifacts into a normalized operator-facing timeline.
  app.get<{ Params: { id: string }; Querystring: { limit?: string; before?: string } }>('/agents/:id/activity-feed', async (request, reply) => {
    const { id } = request.params;
    const limit = Math.min(parseInt(request.query.limit ?? '50', 10), 200);
    const before = request.query.before;

    const [agent] = await db.select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) return reply.status(404).send({ error: 'not_found' });

    // Fetch all data sources in parallel
    const beforeFilter = before ? new Date(before) : undefined;

    const [protocolRows, sessionRows, outboundRows, artifactRows] = await Promise.all([
      db.select().from(agentMessages)
        .where(
          beforeFilter
            ? and(
                eq(agentMessages.agentId, id),
                notInArray(agentMessages.type, [...SUPPRESSED_PROTOCOL_MESSAGE_TYPES]),
                sql`${agentMessages.createdAt} < ${beforeFilter.toISOString()}::timestamptz`,
              )
            : and(
                eq(agentMessages.agentId, id),
                notInArray(agentMessages.type, [...SUPPRESSED_PROTOCOL_MESSAGE_TYPES]),
              ),
        )
        .orderBy(desc(agentMessages.createdAt))
        .limit(limit),
      db.select().from(agentRuntimeSessions)
        .where(eq(agentRuntimeSessions.agentId, id))
        .orderBy(desc(agentRuntimeSessions.startedAt))
        .limit(10),
      db.select().from(agentOutboundMessages)
        .where(
          beforeFilter
            ? and(eq(agentOutboundMessages.agentId, id), sql`${agentOutboundMessages.createdAt} < ${beforeFilter.toISOString()}::timestamptz`)
            : eq(agentOutboundMessages.agentId, id),
        )
        .orderBy(desc(agentOutboundMessages.createdAt))
        .limit(limit),
      db.select().from(agentArtifacts)
        .where(
          beforeFilter
            ? and(eq(agentArtifacts.agentId, id), sql`${agentArtifacts.createdAt} < ${beforeFilter.toISOString()}::timestamptz`)
            : eq(agentArtifacts.agentId, id),
        )
        .orderBy(desc(agentArtifacts.createdAt))
        .limit(limit),
    ]);

    // Map each data source to normalized entries
    const entries: AgentActivityEntry[] = [];

    for (const row of protocolRows) {
      if (isSuppressedProtocolMessageType(String((row as { type?: unknown }).type ?? ''))) {
        continue;
      }
      entries.push(mapProtocolMessage(row as Parameters<typeof mapProtocolMessage>[0]));
    }

    for (const session of sessionRows) {
      const sessionEntries = mapRuntimeSession(session as Parameters<typeof mapRuntimeSession>[0]);
      for (const entry of sessionEntries) {
        if (!beforeFilter || new Date(entry.timestamp) < beforeFilter) {
          entries.push(entry);
        }
      }
    }

    for (const msg of outboundRows) {
      entries.push(mapOutboundMessage(msg as Parameters<typeof mapOutboundMessage>[0]));
    }

    for (const artifact of artifactRows) {
      entries.push(mapArtifact(artifact as Parameters<typeof mapArtifact>[0]));
    }

    // Sort by timestamp descending, then slice to limit
    entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    const fetchedOverLimit = entries.length > limit;
    const trimmed = entries.slice(0, limit);

    return reply.send({ entries: trimmed, hasMore: fetchedOverLimit });
  });

  // --- Decision Failures ---

  // GET /agents/:id/decision-failures — query durable failed-decision records
  app.get<{ Params: { id: string }; Querystring: { limit?: string; since?: string } }>('/agents/:id/decision-failures', async (request, reply) => {
    const { id } = request.params;
    const [agent] = await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) {
      return reply.status(404).send({ error: 'not_found' });
    }

    const limit = Math.min(parseInt(request.query.limit || '50', 10) || 50, 200);
    const sinceFilter = request.query.since ? new Date(request.query.since) : undefined;

    const conditions = [eq(decisionFailures.actorId, id)];
    if (sinceFilter && !isNaN(sinceFilter.getTime())) {
      conditions.push(sql`${decisionFailures.failedAt} >= ${sinceFilter}`);
    }

    const rows = await db.select().from(decisionFailures)
      .where(and(...conditions))
      .orderBy(desc(decisionFailures.failedAt))
      .limit(limit);

    return reply.send({ agentId: id, failures: rows });
  });
}
