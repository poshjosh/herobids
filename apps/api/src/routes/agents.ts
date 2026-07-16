import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { eq, and, inArray, notInArray, desc, sql, or, asc, isNull, isNotNull, sum } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Database } from '@herobids/db';
import {
  agents,
  agentArtifacts,
  agentConnectionAudit,
  agentConnections,
  agentMessages,
  agentOutboundMessages,
  agentRuntimeSessions,
  agentSkills,
  billingUsageEvents,
  bots,
  connections,
  decisions,
  decisionFailures,
  executionPlans,
  skillEntitlements,
  skillRevisions,
  skillUsageEvents,
  skills,
  users,
  venueAccounts,
  positions,
} from '@herobids/db';
import type { PlansConfig } from '@herobids/domain';
import {
  AgentRiskDefaultsSchema,
  AgentRuntimePolicyOverridesSchema,
  CapabilityModeSchema,
  HybridModeSchema,
  RUNTIME_POLICY_CEILINGS,
  normalizePersistedAiModelConfig,
  TechnicalConfigSchema,
  validateExecutionCapability,
  venueTypeFromProvider,
  WakePreferencesSchema,
  type AgentRiskDefaultsConfig,
  type AgentCostEstimatesConfig,
  agentStyleToPresetStyle,
  applyPresetToAgent,
} from '@herobids/domain';
import { getPreset } from '@herobids/domain/config/presets-loader';
import { checkAgentLimit, resolvePlanLimitEntitlements, resolvePlanSkillEntitlements } from '../plan-guards.js';
import { errorPayload } from '../error-payload.js';
import { startAgent, pauseAgent, resumeAgent, stopAgent } from '../services/agent-lifecycle-service.js';
import type { LlmCatalogDeps } from '../llm-model-catalog.js';
import {
  CostPresetSchema,
  decorateAgentResponse,
  extractModelSelection,
  hasModelFieldsWithoutProvider,
  mergeModelPolicy,
  nullablePositiveDecimalStringSchema,
  nullablePositiveIntegerSchema,
  optionalPositiveDecimalStringSchema,
  optionalPositiveIntegerSchema,
  resolveExecutionModeForSkills,
  validateConnectionRequirement,
  resolveNotificationPolicy,
  resolveAgentRiskContractForResponse,
  validateAgentModelPolicy,
  validateDailyLossRequiresCapital,
  validateMaxHoldDurationInvariant,
  validateAgentRiskBounds,
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
  executionMode: z.enum(['paper', 'shadow', 'live', 'test']).optional(),
  executionVenue: z.string().min(1).optional(),
  dailyLossLimit: optionalPositiveDecimalStringSchema,
  maxDrawdownPct: z.number().min(0).max(100).optional(),
  maxBots: optionalPositiveIntegerSchema(),
  maxSlippageBps: optionalPositiveIntegerSchema(0),
  maxOpenPositions: optionalPositiveIntegerSchema(),
  maxPositionSizePct: z.number().min(0).max(100).optional(),
  stopLossPct: z.number().min(0).max(100).optional(),
  stopLossCooldownMs: optionalPositiveIntegerSchema(0),
  tickIntervalMs: optionalPositiveIntegerSchema(1000),
  capital: optionalPositiveDecimalStringSchema,
  style: z.enum(['careful', 'balanced', 'bold']).optional(),
  strategyPreset: z.enum([
    'momentum',
    'momentum-position',
    'range',
    'swing',
    'scalper',
    'contrarian',
  ]).optional(),
  runtimePolicyOverrides: AgentRuntimePolicyOverridesSchema.optional(),
  openPositionEscalationToJudgePolicy: z.enum(['never', 'uncovered_or_triggered', 'always']).optional(),
  connectionIds: z.array(z.string().min(1)).max(20).optional(),
  wakePreferences: WakePreferencesSchema.optional(),
  capabilityMode: CapabilityModeSchema.optional(),
  hybridMode: HybridModeSchema.optional(),
}).superRefine((data, ctx) => {
  if (!data.technical && !data.prompt) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['prompt'],
      message: 'prompt is required when no technical config is provided',
    });
  }
  // 004: capabilityMode='hybrid' requires technical config (or a strategy preset)
  if (data.capabilityMode === 'hybrid' && !data.technical && !data.strategyPreset) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['capabilityMode'],
      message: '"technical" config is required when capabilityMode is "hybrid"',
    });
  }
  // 004: capabilityMode='intelligence' must not set hybridMode
  if (data.capabilityMode === 'intelligence' && data.hybridMode !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['hybridMode'],
      message: '"hybridMode" must not be set when capabilityMode is not "hybrid"',
    });
  }
});

const UpdateAgentSchema = z.object({
  name: AgentNameSchema.optional(),
  prompt: z.string().max(4000).optional(),
  style: z.enum(['careful', 'balanced', 'bold']).nullable().optional(),
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
  executionMode: z.enum(['paper', 'shadow', 'live', 'test']).nullable().optional(),
  dailyLossLimit: nullablePositiveDecimalStringSchema,
  maxDrawdownPct: z.number().min(0).max(100).nullable().optional(),
  maxBots: nullablePositiveIntegerSchema(),
  maxSlippageBps: nullablePositiveIntegerSchema(0),
  maxOpenPositions: nullablePositiveIntegerSchema(),
  maxPositionSizePct: z.number().min(0).max(100).nullable().optional(),
  stopLossPct: z.number().min(0).max(100).nullable().optional(),
  stopLossCooldownMs: nullablePositiveIntegerSchema(0),
  tickIntervalMs: nullablePositiveIntegerSchema(1000),
  capital: nullablePositiveDecimalStringSchema,
  technical: TechnicalConfigSchema.nullable().optional(),
  strategyPreset: z.enum([
    'momentum',
    'momentum-position',
    'range',
    'swing',
    'scalper',
    'contrarian',
  ]).nullable().optional(),
  runtimePolicyOverrides: AgentRuntimePolicyOverridesSchema.nullable().optional(),
  openPositionEscalationToJudgePolicy: z.enum(['never', 'uncovered_or_triggered', 'always']).optional(),
  connectionIds: z.array(z.string().min(1)).max(20).optional(),
  wakePreferences: WakePreferencesSchema.nullable().optional(),
  capabilityMode: CapabilityModeSchema.nullable().optional(),
  hybridMode: HybridModeSchema.nullable().optional(),
});

const PauseAgentSchema = z.object({
  reason: z.string().min(1).max(500).optional(),
}).optional();

/** Extract preset fields from unifiedConfig.metadata, if present. */
function extractPresetMeta(unifiedConfig: unknown): { strategyPreset: string | null; strategyPresetName: string | null } {
  const uc = unifiedConfig as Record<string, unknown> | null;
  const meta = uc?.['metadata'] as Record<string, unknown> | undefined;
  const preset = meta?.['strategyPreset'];
  const name = meta?.['strategyPresetName'];
  return {
    strategyPreset: typeof preset === 'string' && preset.length > 0 ? preset : null,
    strategyPresetName: typeof name === 'string' && name.length > 0 ? name : null,
  };
}

/** Build the extra response fields derived from unifiedConfig. */
function enrichAgentResponse(agent: typeof agents.$inferSelect & { skillIds?: string[] }): {
  technical: unknown;
  strategyPreset: string | null;
  strategyPresetName: string | null;
  capabilityMode: string | null;
  hybridMode: string | null;
} {
  const { strategyPreset, strategyPresetName } = extractPresetMeta(agent.unifiedConfig);
  const uc = agent.unifiedConfig as Record<string, unknown> | null;
  return {
    technical: uc?.['technical'] ?? null,
    strategyPreset,
    strategyPresetName,
    capabilityMode: (uc?.['capabilityMode'] as string) ?? null,
    hybridMode: (uc?.['hybridMode'] as string) ?? null,
  };
}

/**
 * Resolve a style-based strategy preset into agent config fields.
 *
 * Returns the unifiedConfig patch and risk column overrides to persist.
 * Explicit user-supplied risk values take precedence over preset defaults.
 */
function resolveAgentStrategyPreset(params: {
  strategyPreset: string;
  style: string | null | undefined;
  explicitStopLossPct?: number | null;
  explicitMaxPositionSizePct?: number | null;
}): {
  unifiedConfigPatch: Record<string, unknown>;
  riskOverrides: { stopLossPct?: string | null; maxPositionSizePct?: string | null };
} | null {
  const { strategyPreset, style, explicitStopLossPct, explicitMaxPositionSizePct } = params;

  const presetStyle = agentStyleToPresetStyle(style ?? 'balanced');
  const preset = getPreset(strategyPreset, presetStyle);
  if (!preset) {
    return null;
  }

  const split = applyPresetToAgent(preset, 'llm');

  // Build unifiedConfig with technical, execution, and metadata
  const unifiedConfigPatch: Record<string, unknown> = {
    technical: split.technical,
    execution: {
      mode: split.execution.positionSizeMode === 'percent_equity' ? undefined : undefined,
      positionSizeMode: (split.execution.positionSizeMode as 'fixed' | 'percent_equity' | undefined) ?? undefined,
      fixedPositionSize: split.execution.fixedPositionSize,
    },
    metadata: {
      strategyPreset,
      strategyPresetName: preset.name,
      strategyPresetStyle: presetStyle,
      strategyPresetSource: 'agent-style',
    },
  };

  // Remove undefined keys from execution to keep config clean
  const exec = unifiedConfigPatch['execution'] as Record<string, unknown>;
  if (exec['positionSizeMode'] === undefined && exec['fixedPositionSize'] === undefined) {
    delete unifiedConfigPatch['execution'];
  } else {
    // Clean individual undefined values
    for (const key of Object.keys(exec)) {
      if (exec[key] === undefined) delete exec[key];
    }
  }

  // Risk overrides: explicit user values win, otherwise use preset defaults
  const stopLossPct =
    explicitStopLossPct !== undefined
      ? (explicitStopLossPct != null ? String(explicitStopLossPct) : null)
      : (split.risk.stopLossPct != null ? String(split.risk.stopLossPct) : undefined);

  const maxPositionSizePct =
    explicitMaxPositionSizePct !== undefined
      ? (explicitMaxPositionSizePct != null ? String(explicitMaxPositionSizePct) : null)
      : (split.risk.maxPositionSizePct != null ? String(split.risk.maxPositionSizePct) : undefined);

  return {
    unifiedConfigPatch,
    riskOverrides: { stopLossPct, maxPositionSizePct },
  };
}

type SkillAssignmentResolution = {
  skillId: string;
  skillRevisionId: string;
};

const DEFAULT_AGENT_RISK_DEFAULTS: AgentRiskDefaultsConfig = AgentRiskDefaultsSchema.parse({});

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
  llmCatalogDeps?: LlmCatalogDeps,
  agentRiskDefaults: AgentRiskDefaultsConfig = DEFAULT_AGENT_RISK_DEFAULTS,
  agentCostEstimates?: AgentCostEstimatesConfig,
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
      dailyLossLimitDefaultRatio: agentRiskDefaults.dailyLossLimitDefaultRatio,
      maxOpenPositions: agentRiskDefaults.maxOpenPositions,
      maxPositionSizePct: agentRiskDefaults.maxPositionSizePct,
      stopLossPct: agentRiskDefaults.stopLossMaxUnrealizedLossPct,
      stopLossCooldownMs: agentRiskDefaults.stopLossCooldownMs,
      dailyMaxLossPct: agentRiskDefaults.dailyMaxLossPct,
      maxDrawdownPct: agentRiskDefaults.maxDrawdownPct,
      costPerTickEstimates: agentCostEstimates ?? { minimal: 0.12, standard: 0.21, premium: 0.31 },
      runtimePolicyCeilings: RUNTIME_POLICY_CEILINGS,
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

    const capitalIssues = validateDailyLossRequiresCapital({
      dailyLossLimit: parsed.data.dailyLossLimit,
      maxDrawdownPct: parsed.data.maxDrawdownPct,
      capital: parsed.data.capital,
    });
    if (capitalIssues.length > 0) {
      return reply.status(400).send({ error: 'validation_error', details: capitalIssues });
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

    // Resolve maxBots from plan — if not provided, default to plan limit; if provided, validate ≤ plan limit
    let resolvedMaxBots: number | null = null;
    if (plansConfig) {
      const planLimits = resolvePlanLimitEntitlements(plansConfig, request.userPlanId || 'free', request.isAdmin);
      if (parsed.data.maxBots != null) {
        if (parsed.data.maxBots > planLimits.maxBots) {
          return reply.status(400).send(errorPayload(
            'plan.max_bots_exceeded',
            `maxBots (${parsed.data.maxBots}) exceeds your plan limit of ${planLimits.maxBots}.`,
            { limit: planLimits.maxBots, requested: parsed.data.maxBots },
          ));
        }
        resolvedMaxBots = parsed.data.maxBots;
      } else {
        resolvedMaxBots = planLimits.maxBots;
      }
    } else {
      resolvedMaxBots = parsed.data.maxBots ?? null;
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
    const modelIssues = await validateAgentModelPolicy(effectiveModelPolicy, llmCatalogDeps);
    if (modelIssues.length > 0) {
      return reply.status(400).send({ error: 'validation_error', details: modelIssues });
    }

    // Reject creation when neither the agent policy nor the user's saved AI defaults have models.
    // Without any model configured, the agent would fail to start immediately.
    const agentModelSelection = extractModelSelection(effectiveModelPolicy);
    if (!agentModelSelection.provider) {
      const [userRow] = await db.select({ aiModelConfig: users.aiModelConfig })
        .from(users)
        .where(eq(users.id, request.userId))
        .limit(1);
      const userAiConfig = normalizePersistedAiModelConfig(userRow?.aiModelConfig);
      if (!userAiConfig) {
        return reply.status(400).send({
          error: 'validation_error',
          details: [{ code: 'custom', path: ['provider'], message: 'Provider is required — set it here or configure your AI settings in Settings' }],
        });
      }
    }

    // Validate maxHoldDurationMs >= tickIntervalMs invariant.
    // maxHoldDurationMs < tickIntervalMs is meaningless — every tick always finds
    // the hold expired, so the backstop is a permanent no-op.
    const holdInvariantIssues = validateMaxHoldDurationInvariant({
      tickIntervalMs: parsed.data.tickIntervalMs,
      style: parsed.data.style,
      runtimePolicyOverrides: parsed.data.runtimePolicyOverrides ?? null,
    });
    if (holdInvariantIssues.length > 0) {
      return reply.status(400).send({ error: 'validation_error', details: holdInvariantIssues });
    }

    const connectionIds = parsed.data.connectionIds ?? [];

    const executionMode = resolveExecutionModeForSkills({
      skillIds: parsed.data.skillIds ?? [],
      submittedExecutionMode: parsed.data.executionMode,
      executionModeProvided: parsed.data.executionMode !== undefined,
      currentExecutionMode: null,
      hasConnections: connectionIds.length > 0,
      hasVenue: parsed.data.executionVenue !== undefined,
    });
    if (executionMode.issue) {
      return reply.status(400).send({ error: 'validation_error', details: [executionMode.issue] });
    }

    const connectionRequirementIssue = validateConnectionRequirement(executionMode.value, connectionIds.length > 0);
    if (connectionRequirementIssue) {
      return reply.status(400).send({ error: 'validation_error', details: [connectionRequirementIssue] });
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

    // Resolve style-based strategy preset into agent config
    let presetUnifiedConfig: Record<string, unknown> | null = null;
    let presetRiskStopLossPct: string | null | undefined = undefined;
    let presetRiskMaxPositionSizePct: string | null | undefined = undefined;

    if (parsed.data.strategyPreset) {
      const resolution = resolveAgentStrategyPreset({
        strategyPreset: parsed.data.strategyPreset,
        style: parsed.data.style,
        explicitStopLossPct: parsed.data.stopLossPct,
        explicitMaxPositionSizePct: parsed.data.maxPositionSizePct,
      });

      if (!resolution) {
        return reply.status(400).send({
          error: 'preset_not_found',
          message: `Preset "${parsed.data.strategyPreset}" not found for the resolved style tier.`,
        });
      }

      presetUnifiedConfig = resolution.unifiedConfigPatch;
      presetRiskStopLossPct = resolution.riskOverrides.stopLossPct;
      presetRiskMaxPositionSizePct = resolution.riskOverrides.maxPositionSizePct;
    }

    // Build final unifiedConfig: explicit technical wins over preset technical
    let finalUnifiedConfig: Record<string, unknown> | null = null;
    if (parsed.data.technical) {
      // Explicit technical provided — use it, but preserve preset metadata if present
      finalUnifiedConfig = {
        ...(presetUnifiedConfig ?? {}),
        technical: parsed.data.technical,
      };
    } else if (presetUnifiedConfig) {
      finalUnifiedConfig = { ...presetUnifiedConfig };
    }

    // 004: Stamp capabilityMode and hybridMode into unifiedConfig.
    // Default hybridMode to 'mixed' when capabilityMode is 'hybrid' and hybridMode is not explicitly set.
    const capabilityMode = parsed.data.capabilityMode ?? 'intelligence';
    const hybridMode = parsed.data.hybridMode ?? (capabilityMode === 'hybrid' ? 'mixed' : undefined);

    if (finalUnifiedConfig) {
      finalUnifiedConfig.capabilityMode = capabilityMode;
      if (hybridMode !== undefined) {
        finalUnifiedConfig.hybridMode = hybridMode;
      }
    } else {
      // No technical or preset — still need to persist capabilityMode/hybridMode
      finalUnifiedConfig = {
        capabilityMode,
        ...(hybridMode !== undefined ? { hybridMode } : {}),
      };
    }

    // Populate technical.filters from the agent's selected connections.
    // The strategy preset defines HOW to trade (indicators, sizing) but not
    // WHERE to trade — venue/venueType come from the connection's provider.
    if (finalUnifiedConfig?.technical && connectionIds.length > 0) {
      const providerRows = await db
        .select({ provider: connections.provider })
        .from(connections)
        .where(and(inArray(connections.id, connectionIds), eq(connections.status, 'active')))
        .limit(1);
      if (providerRows.length > 0) {
        const venueType = venueTypeFromProvider(providerRows[0]!.provider) ?? 'orderbook';
        (finalUnifiedConfig.technical as Record<string, unknown>).filters = {
          venue: providerRows[0]!.provider,
          venueType,
        };
      }
    }

    // Apply TechnicalConfigSchema defaults so the stored JSONB is self-describing.
    // Presets and explicit input may omit fields that have Zod defaults
    // (scanBatchSize, autonomousExit, etc.). Parsing through the schema fills them in
    // so that direct DB reads (e.g. smoke tests) see the complete config.
    if (finalUnifiedConfig?.technical) {
      try {
        finalUnifiedConfig.technical = TechnicalConfigSchema.parse(finalUnifiedConfig.technical);
      } catch {
        // If parse fails, leave as-is — UnifiedAgentConfigSchema superRefine
        // catches validation issues downstream.
      }
    }

    // Resolve final risk fields: explicit values win, then preset values, then null
    const finalStopLossPct: string | null =
      parsed.data.stopLossPct != null
        ? String(parsed.data.stopLossPct)
        : (presetRiskStopLossPct !== undefined ? presetRiskStopLossPct : null);

    const finalMaxPositionSizePct: string | null =
      parsed.data.maxPositionSizePct != null
        ? String(parsed.data.maxPositionSizePct)
        : (presetRiskMaxPositionSizePct !== undefined ? presetRiskMaxPositionSizePct : null);

    // Stamp adaptive reasoning flags from user's AI model settings into runtimePolicyOverrides.
    // If the user has set these preferences in Settings, they flow through to new agents
    // so the worker can apply the correct ceiling/fixed behavior.
    let stampedRuntimePolicyOverrides = parsed.data.runtimePolicyOverrides ?? null;
    const [userRow] = await db.select({ aiModelConfig: users.aiModelConfig })
      .from(users)
      .where(eq(users.id, request.userId))
      .limit(1);
    const userAiConfig = normalizePersistedAiModelConfig(userRow?.aiModelConfig);
    if (userAiConfig) {
      const current = (stampedRuntimePolicyOverrides ?? {}) as Record<string, unknown>;
      if (userAiConfig.adaptScoutReasoning !== undefined && current['adaptScoutReasoning'] === undefined) {
        current['adaptScoutReasoning'] = userAiConfig.adaptScoutReasoning;
      }
      if (userAiConfig.adaptJudgeReasoning !== undefined && current['adaptJudgeReasoning'] === undefined) {
        current['adaptJudgeReasoning'] = userAiConfig.adaptJudgeReasoning;
      }
      if (Object.keys(current).length > 0) {
        stampedRuntimePolicyOverrides = (current as typeof parsed.data.runtimePolicyOverrides) ?? null;
      }
    }

    const createTxResult = await db.transaction(async (tx): Promise<
      | { kind: 'ok' }
      | { kind: 'conn_error'; status: number; body: Record<string, unknown> }
    > => {
        await tx.insert(agents).values({
          id: agentId,
          userId: request.userId,
          name: parsed.data.name,
          prompt: parsed.data.prompt ?? '',
          status: 'stopped',
          toolPolicy: effectiveToolPolicy,
          modelPolicy: effectiveModelPolicy,
          telegramChatId: parsed.data.telegramChatId?.trim() || null,
          notificationPolicy: parsed.data.notificationPolicy !== undefined
            ? (parsed.data.notificationPolicy === null ? null : resolveNotificationPolicy(parsed.data.notificationPolicy, null))
            : null,
          ...(executionMode.value != null ? { executionMode: executionMode.value } : {}),
          dailyLossLimit: parsed.data.dailyLossLimit ?? null,
          maxDrawdown: null,
          maxDrawdownPct: parsed.data.maxDrawdownPct != null ? String(parsed.data.maxDrawdownPct) : null,
          maxBots: resolvedMaxBots,
          maxSlippageBps: parsed.data.maxSlippageBps ?? null,
          maxOpenPositions: parsed.data.maxOpenPositions ?? null,
          maxPositionSizePct: finalMaxPositionSizePct,
          stopLossPct: finalStopLossPct,
          stopLossCooldownMs: parsed.data.stopLossCooldownMs ?? null,
          tickIntervalMs: parsed.data.tickIntervalMs ?? null,
          capital: parsed.data.capital ?? null,
          style: parsed.data.style ?? null,
          runtimePolicyOverrides: stampedRuntimePolicyOverrides ?? null,
          openPositionEscalationToJudgePolicy: parsed.data.openPositionEscalationToJudgePolicy ?? undefined,
          ...(finalUnifiedConfig ? { unifiedConfig: finalUnifiedConfig } : {}),
          wakePreferences: parsed.data.wakePreferences ?? null,
          createdAt: now,
          updatedAt: now,
        } as never);

        if (connectionIds.length > 0) {
          // Validate connectionIds inside the transaction for a consistent view
          const connRows = await tx.select({
            id: connections.id,
            userId: connections.userId,
            status: connections.status,
          }).from(connections).where(inArray(connections.id, connectionIds));

          const connById = new Map(connRows.map((r) => [r.id, r]));
          for (const cid of connectionIds) {
            const conn = connById.get(cid);
            if (!conn) {
              return {
                kind: 'conn_error' as const,
                status: 400,
                body: {
                  error: 'validation_error',
                  details: [{ code: 'custom', path: ['connectionIds'], message: `Connection ${cid} does not exist` }],
                },
              };
            }
            if (conn.userId !== request.userId) {
              return {
                kind: 'conn_error' as const,
                status: 400,
                body: {
                  error: 'validation_error',
                  details: [{ code: 'custom', path: ['connectionIds'], message: `Connection ${cid} does not belong to you` }],
                },
              };
            }
            if (conn.status !== 'active') {
              return {
                kind: 'conn_error' as const,
                status: 400,
                body: {
                  error: 'validation_error',
                  details: [{ code: 'custom', path: ['connectionIds'], message: `Connection ${cid} is not active (status: ${conn.status})` }],
                },
              };
            }
          }

          for (const cid of connectionIds) {
            await tx.insert(agentConnections).values({
              id: crypto.randomUUID(),
              agentId,
              connectionId: cid,
              status: 'active',
              grantedBy: request.userId,
              grantedAt: now,
              createdAt: now,
              updatedAt: now,
            });
          }
        }
        return { kind: 'ok' as const };
      });

    if (createTxResult.kind === 'conn_error') {
      return reply.status(createTxResult.status).send(createTxResult.body);
    }

    await syncAgentSkillAssignments(db, agentId, request.userId, assignmentResolution.assignments ?? []);

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    const skillIds = await listSkillIdsForAgent(db, agentId);
    const riskContract = resolveAgentRiskContractForResponse(agent!, agentRiskDefaults);
    return reply.status(201).send({ ...decorateAgentResponse({ ...agent!, skillIds }), ...enrichAgentResponse(agent!), riskContract });
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
      ...enrichAgentResponse(agent),
    })));
  });

  // ─── GET /agents/outcomes ──────────────────────────────────────────────────
  // Capability-keyed outcomes for all of the user's agents in a single query.
  // Each capability family contributes its own outcome shape; the frontend
  // renders whichever families are present rather than assuming trading.
  //
  // Trading outcomes: realized PnL, trade counts, win-rate inputs via a
  // two-part union of agent-direct positions and bot-owned positions
  // attributed via agent_connections → bots.
  app.get('/agents/outcomes', async (request, reply) => {
    const agentRows = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.userId, request.userId));

    const agentIds = agentRows.map((a) => a.id);

    if (agentIds.length === 0) {
      return reply.send({ outcomes: [] });
    }

    // Part 1: Agent-direct positions — grouped by actorId (the agent itself).
    const directQuery = db
      .select({
        agentId: positions.actorId,
        totalPnl: sum(positions.realizedPnl),
        openPositionCount: sql<number>`COUNT(*) FILTER (WHERE ${positions.closedAt} IS NULL)::int`,
        winningClosedCount: sql<number>`COUNT(*) FILTER (WHERE ${positions.closedAt} IS NOT NULL AND ${positions.realizedPnl} > '0')::int`,
        closedPositionCount: sql<number>`COUNT(*) FILTER (WHERE ${positions.closedAt} IS NOT NULL)::int`,
      })
      .from(positions)
      .where(and(
        eq(positions.actorType, 'agent'),
        inArray(positions.actorId, agentIds),
        isNotNull(positions.actorId),
      ))
      .groupBy(positions.actorId);

    // Part 2: Bot-owned positions attributed via agent_connections → bots.
    const botOwnedQuery = db
      .select({
        agentId: agentConnections.agentId,
        totalPnl: sum(positions.realizedPnl),
        openPositionCount: sql<number>`COUNT(*) FILTER (WHERE ${positions.closedAt} IS NULL)::int`,
        winningClosedCount: sql<number>`COUNT(*) FILTER (WHERE ${positions.closedAt} IS NOT NULL AND ${positions.realizedPnl} > '0')::int`,
        closedPositionCount: sql<number>`COUNT(*) FILTER (WHERE ${positions.closedAt} IS NOT NULL)::int`,
      })
      .from(positions)
      .innerJoin(bots, and(
        eq(bots.id, positions.actorId),
        eq(positions.actorType, 'bot'),
      ))
      .innerJoin(agentConnections, eq(agentConnections.connectionId, bots.connectionId))
      .where(inArray(agentConnections.agentId, agentIds))
      .groupBy(agentConnections.agentId);

    const [directResults, botOwnedResults] = await Promise.all([directQuery, botOwnedQuery]);

    // Merge both result sets by agentId.
    const tradingByAgent = new Map<string, {
      totalPnl: number;
      openPositionCount: number;
      winningClosedCount: number;
      closedPositionCount: number;
    }>();

    for (const row of directResults) {
      if (!row.agentId) continue;
      tradingByAgent.set(row.agentId, {
        totalPnl: Number(row.totalPnl ?? '0'),
        openPositionCount: row.openPositionCount ?? 0,
        winningClosedCount: row.winningClosedCount ?? 0,
        closedPositionCount: row.closedPositionCount ?? 0,
      });
    }

    for (const row of botOwnedResults) {
      if (!row.agentId) continue;
      const existing = tradingByAgent.get(row.agentId);
      if (existing) {
        existing.totalPnl += Number(row.totalPnl ?? '0');
        existing.openPositionCount += row.openPositionCount ?? 0;
        existing.winningClosedCount += row.winningClosedCount ?? 0;
        existing.closedPositionCount += row.closedPositionCount ?? 0;
      } else {
        tradingByAgent.set(row.agentId, {
          totalPnl: Number(row.totalPnl ?? '0'),
          openPositionCount: row.openPositionCount ?? 0,
          winningClosedCount: row.winningClosedCount ?? 0,
          closedPositionCount: row.closedPositionCount ?? 0,
        });
      }
    }

    const outcomes = agentIds.map((agentId) => {
      const trading = tradingByAgent.get(agentId);
      const agentOutcomes: Record<string, unknown> = {};
      if (trading) {
        agentOutcomes.trading = {
          totalRealizedPnl: trading.totalPnl.toFixed(6),
          openPositionCount: trading.openPositionCount,
          closedPositionCount: trading.closedPositionCount,
          winningClosedCount: trading.winningClosedCount,
        };
      }
      return {
        agentId,
        outcomes: agentOutcomes as { trading?: { totalRealizedPnl: string; openPositionCount: number; closedPositionCount: number; winningClosedCount: number } },
      };
    });

    return reply.send({ outcomes });
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
    return reply.send({ ...decorateAgentResponse({ ...agent, skillIds }), ...enrichAgentResponse(agent), riskContract, activeSession: session ?? null });
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

    // Validate dailyLossLimit and maxDrawdownPct require capital (effective after PATCH merge)
    const effectiveCapitalForCheck = parsed.data.capital !== undefined ? parsed.data.capital : agent.capital;
    const capitalIssues = validateDailyLossRequiresCapital({
      dailyLossLimit: parsed.data.dailyLossLimit !== undefined ? parsed.data.dailyLossLimit : agent.dailyLossLimit,
      maxDrawdownPct: parsed.data.maxDrawdownPct !== undefined ? parsed.data.maxDrawdownPct : (agent.maxDrawdownPct != null ? Number(agent.maxDrawdownPct) : null),
      capital: effectiveCapitalForCheck,
    });
    if (capitalIssues.length > 0) {
      return reply.status(400).send({ error: 'validation_error', details: capitalIssues });
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
    const modelIssues = await validateAgentModelPolicy(effectiveModelPolicy, llmCatalogDeps);
    if (modelIssues.length > 0) {
      return reply.status(400).send({ error: 'validation_error', details: modelIssues });
    }

    // Determine whether the agent has trading connections — used to resolve
    // the `test` input alias to the correct concrete simulation mode.
    let hasAgentConnections: boolean;
    if (parsed.data.connectionIds !== undefined) {
      hasAgentConnections = parsed.data.connectionIds.length > 0;
    } else {
      const [existingActiveConn] = await db.select({ id: agentConnections.id })
        .from(agentConnections)
        .where(and(eq(agentConnections.agentId, id), eq(agentConnections.status, 'active')))
        .limit(1);
      hasAgentConnections = !!existingActiveConn;
    }

    // Validate maxHoldDurationMs >= tickIntervalMs invariant (effective after PATCH merge).
    // PATCH semantics: use new value if explicitly provided, otherwise keep the existing one.
    const holdInvariantIssues = validateMaxHoldDurationInvariant({
      tickIntervalMs: parsed.data.tickIntervalMs !== undefined
        ? parsed.data.tickIntervalMs
        : agent.tickIntervalMs,
      style: parsed.data.style !== undefined
        ? parsed.data.style
        : agent.style,
      runtimePolicyOverrides: parsed.data.runtimePolicyOverrides !== undefined
        ? (parsed.data.runtimePolicyOverrides as Record<string, unknown> | null)
        : (agent.runtimePolicyOverrides as Record<string, unknown> | null),
    });
    if (holdInvariantIssues.length > 0) {
      return reply.status(400).send({ error: 'validation_error', details: holdInvariantIssues });
    }

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

    // Validate execution capability against the agent's active trading connection (if any)
    if (executionMode.value) {
      const [activeConn] = await db.select({ provider: connections.provider })
        .from(agentConnections)
        .innerJoin(connections, eq(agentConnections.connectionId, connections.id))
        .where(and(
          eq(agentConnections.agentId, id),
          eq(agentConnections.status, 'active'),
          eq(connections.status, 'active'),
        ))
        .limit(1);
      if (activeConn) {
        const agentVenueType = venueTypeFromProvider(activeConn.provider);
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
      modelPolicy: _modelPolicy,
      skillIds: _skillIds,
      notificationPolicy: notificationPolicyInput,
      telegramChatId: rawTelegramChatId,
      maxPositionSizePct: rawMaxPositionSizePct,
      stopLossPct: rawStopLossPct,
      maxBots: rawMaxBots,
      maxDrawdownPct: rawMaxDrawdownPct,
      technical: technicalUpdate,
      strategyPreset: strategyPresetUpdate,
      capabilityMode: capabilityModeUpdate,
      hybridMode: hybridModeUpdate,
      ...agentUpdates
    } = parsed.data;
    void _skillIds;

    // Stamp adaptive reasoning flags from user's AI model settings into runtimePolicyOverrides.
    // This happens on every edit — the user's current adaptive preferences are always stamped.
    // User-provided values win over stamped defaults.
    const [stampUserRow] = await db.select({ aiModelConfig: users.aiModelConfig })
      .from(users)
      .where(eq(users.id, request.userId))
      .limit(1);
    const stampUserAiConfig = normalizePersistedAiModelConfig(stampUserRow?.aiModelConfig);
    if (stampUserAiConfig) {
      // Resolve the base: user-provided overrides, or agent's existing overrides, or empty
      let baseOverrides: Record<string, unknown>;
      if (agentUpdates.runtimePolicyOverrides !== undefined && agentUpdates.runtimePolicyOverrides !== null) {
        baseOverrides = agentUpdates.runtimePolicyOverrides as Record<string, unknown>;
      } else if (agentUpdates.runtimePolicyOverrides === null) {
        // User explicitly cleared — start fresh, but stamp adaptive flags
        baseOverrides = {};
      } else {
        // Not provided — use agent's existing overrides as base
        baseOverrides = (agent.runtimePolicyOverrides as Record<string, unknown> | null) ?? {};
      }
      if (stampUserAiConfig.adaptScoutReasoning !== undefined && baseOverrides['adaptScoutReasoning'] === undefined) {
        baseOverrides['adaptScoutReasoning'] = stampUserAiConfig.adaptScoutReasoning;
      }
      if (stampUserAiConfig.adaptJudgeReasoning !== undefined && baseOverrides['adaptJudgeReasoning'] === undefined) {
        baseOverrides['adaptJudgeReasoning'] = stampUserAiConfig.adaptJudgeReasoning;
      }
      agentUpdates.runtimePolicyOverrides = Object.keys(baseOverrides).length > 0 ? baseOverrides : null;
    }

    // Resolve maxBots from plan — if not provided, default to plan limit; if provided, validate ≤ plan limit
    let resolvedMaxBotsPatch: { maxBots: number | null } | Record<string, never> = {};
    if (rawMaxBots !== undefined) {
      // Caller explicitly provided a value (including null to clear)
      if (rawMaxBots !== null && plansConfig) {
        const planLimits = resolvePlanLimitEntitlements(plansConfig, request.userPlanId || 'free', request.isAdmin);
        if (rawMaxBots > planLimits.maxBots) {
          return reply.status(400).send(errorPayload(
            'plan.max_bots_exceeded',
            `maxBots (${rawMaxBots}) exceeds your plan limit of ${planLimits.maxBots}.`,
            { limit: planLimits.maxBots, requested: rawMaxBots },
          ));
        }
      }
      resolvedMaxBotsPatch = { maxBots: rawMaxBots };
    }
    // If not provided, leave existing value unchanged (no-op for PATCH)

    // Resolve style-based strategy preset for update
    // - omitted: leave existing preset-managed config unchanged
    // - provided with value: re-apply preset using effective style after merge
    // - null: clear preset-managed config
    let presetUnifiedConfigUpdate: Record<string, unknown> | null | undefined = undefined;
    let presetRiskStopLossPctUpdate: string | null | undefined = undefined;
    let presetRiskMaxPositionSizePctUpdate: string | null | undefined = undefined;

    if (strategyPresetUpdate !== undefined && strategyPresetUpdate !== null) {
      // Re-apply preset using the effective style after merge
      const effectiveStyle = parsed.data.style !== undefined ? parsed.data.style : agent.style;
      const resolution = resolveAgentStrategyPreset({
        strategyPreset: strategyPresetUpdate,
        style: effectiveStyle,
        explicitStopLossPct: rawStopLossPct,
        explicitMaxPositionSizePct: rawMaxPositionSizePct,
      });

      if (!resolution) {
        return reply.status(400).send({
          error: 'preset_not_found',
          message: `Preset "${strategyPresetUpdate}" not found for the resolved style tier.`,
        });
      }

      presetUnifiedConfigUpdate = resolution.unifiedConfigPatch;
      presetRiskStopLossPctUpdate = resolution.riskOverrides.stopLossPct;
      presetRiskMaxPositionSizePctUpdate = resolution.riskOverrides.maxPositionSizePct;
    } else if (strategyPresetUpdate === null) {
      // Clear preset-managed config — remove metadata and execution blocks
      presetUnifiedConfigUpdate = null;
    }

    // Merge technical into unifiedConfig — only touch the 'technical' key, preserve other keys.
    //
    // technicalUpdate semantics by agent type (documentation guard — do not remove):
    // ┌─────────────────────────┬──────────────────────────┬────────────────────────────────────┐
    // │ Agent type              │ technical sent by client │ Backend handling                   │
    // ├─────────────────────────┼──────────────────────────┼────────────────────────────────────┤
    // │ intelligence (create)   │ omitted                  │ no preset → no technical, correct  │
    // │ intelligence (update)   │ null                     │ deletes any existing technical     │
    // │ hybrid (create)         │ omitted                  │ preset fills technical ✅          │
    // │ hybrid (update)         │ null (no manual config)  │ preset fills → null must NOT delete│
    // │ hybrid (update)         │ {…} (manual config)     │ explicit object overrides preset   │
    // └─────────────────────────┴──────────────────────────┴────────────────────────────────────┘
    // Key invariant: when a strategy preset is active and client sends technical:null,
    // the null means "I didn't set a manual technical config" — NOT "delete it".
    // Preserve the preset's technical and let the filters-population code below run.
    let unifiedConfigPatch: Record<string, unknown> | null | undefined = undefined;
    if (technicalUpdate !== undefined || presetUnifiedConfigUpdate !== undefined) {
      const current = (agent.unifiedConfig as Record<string, unknown> | null) ?? {};

      if (presetUnifiedConfigUpdate === null) {
        // Explicit clear (strategyPreset: null) — strip preset-managed keys
        // (metadata + execution) while preserving unrelated keys and any
        // technical config. Manual config stays; the agent becomes 'custom'.
        const { metadata: _meta, execution: _exec, ...rest } = current;
        void _meta;
        void _exec;
        if (technicalUpdate === null) {
          // Also clear technical when explicitly nulled (no preset active).
          const { technical: _t, ...withoutTechnical } = rest;
          void _t;
          unifiedConfigPatch = Object.keys(withoutTechnical).length > 0 ? withoutTechnical : null;
        } else if (technicalUpdate !== undefined) {
          unifiedConfigPatch = { ...rest, technical: technicalUpdate };
        } else {
          unifiedConfigPatch = Object.keys(rest).length > 0 ? rest : null;
        }
      } else if (presetUnifiedConfigUpdate) {
        // Preset provided — merge with current, explicit technical wins.
        // technical:null from the client means "no manual config" — do NOT delete
        // the preset's technical. Only an explicit {…} object overrides the preset.
        const merged = { ...current, ...presetUnifiedConfigUpdate };
        if (technicalUpdate !== undefined && technicalUpdate !== null) {
          merged['technical'] = technicalUpdate;
        }
        unifiedConfigPatch = Object.keys(merged).length > 0 ? merged : null;
      } else {
        // No preset change — handle technical update as before.
        // In this branch technical:null IS honored because there is no preset to fill.
        if (technicalUpdate === null) {
          const { technical: _t, ...rest } = current;
          void _t;
          unifiedConfigPatch = Object.keys(rest).length > 0 ? rest : null;
        } else if (technicalUpdate !== undefined) {
          unifiedConfigPatch = { ...current, technical: technicalUpdate };
        }
        // else: neither preset nor technical changed → undefined (don't update)
      }
    }

    // 004: Merge capabilityMode and hybridMode into unifiedConfigPatch.
    if (capabilityModeUpdate !== undefined || hybridModeUpdate !== undefined) {
      const current = (agent.unifiedConfig as Record<string, unknown> | null) ?? {};

      if (unifiedConfigPatch === undefined) {
        // No other unifiedConfig changes — start from current
        unifiedConfigPatch = { ...current };
      } else if (unifiedConfigPatch === null) {
        // Previous logic explicitly cleared unifiedConfig — start fresh
        unifiedConfigPatch = {};
      }

      if (capabilityModeUpdate !== undefined) {
        if (capabilityModeUpdate === null) {
          delete (unifiedConfigPatch as Record<string, unknown>)['capabilityMode'];
          // MEDIUM-4: clearing capabilityMode also removes hybridMode — hybridMode
          // is meaningless without capabilityMode.
          delete (unifiedConfigPatch as Record<string, unknown>)['hybridMode'];
        } else {
          unifiedConfigPatch['capabilityMode'] = capabilityModeUpdate;
        }
      }

      if (hybridModeUpdate !== undefined) {
        if (hybridModeUpdate === null) {
          delete (unifiedConfigPatch as Record<string, unknown>)['hybridMode'];
        } else {
          unifiedConfigPatch['hybridMode'] = hybridModeUpdate;
        }
      }

      // Default hybridMode to 'mixed' for hybrid agents when not explicitly set.
      // Uses the *new* capabilityMode if provided, otherwise falls back to existing.
      const effectiveCapability = capabilityModeUpdate !== undefined
        ? capabilityModeUpdate
        : current['capabilityMode'] as string | undefined;
      const explicitHybridMode =
        hybridModeUpdate !== undefined
          ? hybridModeUpdate
          : current['hybridMode'];

      if (effectiveCapability === 'hybrid' && explicitHybridMode === undefined) {
        unifiedConfigPatch['hybridMode'] = 'mixed';
      }

      // HIGH-1: Strip hybridMode whenever the effective capability is not 'hybrid'.
      // This prevents orphaned hybridMode when patching capabilityMode from
      // 'hybrid' → 'intelligence' without also explicitly clearing hybridMode.
      if (effectiveCapability !== 'hybrid') {
        delete (unifiedConfigPatch as Record<string, unknown>)['hybridMode'];
      }
    }

    // Populate technical.filters from the agent's connections during PATCH.
    // Three sources for the effective connection IDs, in priority order:
    //   1. connectionIds explicitly provided in the request
    //   2. existing active agent_connections for this agent (when connectionIds omitted)
    //   3. None — leave filters alone (worker's Fix 2 guard handles gracefully)
    if (unifiedConfigPatch?.technical) {
      let effectiveConnectionIds: string[];

      if (parsed.data.connectionIds !== undefined) {
        // Explicitly provided — use those (even if empty, which clears filters)
        effectiveConnectionIds = parsed.data.connectionIds;
      } else {
        // Omitted — fall back to existing active connections
        const existingRows = await db
          .select({ connectionId: agentConnections.connectionId })
          .from(agentConnections)
          .where(and(
            eq(agentConnections.agentId, id),
            eq(agentConnections.status, 'active'),
          ));
        effectiveConnectionIds = existingRows.map((r) => r.connectionId);
      }

      if (effectiveConnectionIds.length > 0) {
        const providerRows = await db
          .select({ provider: connections.provider })
          .from(connections)
          .where(and(inArray(connections.id, effectiveConnectionIds), eq(connections.status, 'active')))
          .limit(1);
        if (providerRows.length > 0) {
          const venueType = venueTypeFromProvider(providerRows[0]!.provider) ?? 'orderbook';
          (unifiedConfigPatch.technical as Record<string, unknown>).filters = {
            venue: providerRows[0]!.provider,
            venueType,
          };
        }
      }
    }

    // Apply TechnicalConfigSchema defaults to the merged technical block so the
    // stored JSONB is self-describing (scanBatchSize, autonomousExit, etc.).
    if (unifiedConfigPatch?.technical) {
      try {
        unifiedConfigPatch.technical = TechnicalConfigSchema.parse(unifiedConfigPatch.technical);
      } catch {
        // If parse fails, leave as-is — downstream validation catches issues.
      }
    }

    // 004: Validate cross-field constraints for capabilityMode/hybridMode.
    // Setting hybridMode on an intelligence agent is invalid.
    if (hybridModeUpdate !== undefined && hybridModeUpdate !== null) {
      const existingConfig = (agent.unifiedConfig as Record<string, unknown> | null) ?? {};
      const effectiveCapability = capabilityModeUpdate !== undefined && capabilityModeUpdate !== null
        ? capabilityModeUpdate
        : existingConfig['capabilityMode'] as string | undefined;
      if (effectiveCapability !== 'hybrid') {
        return reply.status(400).send({
          error: 'validation_error',
          details: [{
            code: 'custom',
            path: ['hybridMode'],
            message: '"hybridMode" must not be set when capabilityMode is not "hybrid"',
          }],
        });
      }
    }

    // Resolve final risk fields for update: explicit values win, then preset, then existing
    const finalStopLossPctUpdate: string | null | undefined =
      rawStopLossPct !== undefined
        ? (rawStopLossPct != null ? String(rawStopLossPct) : null)
        : presetRiskStopLossPctUpdate;

    const finalMaxPositionSizePctUpdate: string | null | undefined =
      rawMaxPositionSizePct !== undefined
        ? (rawMaxPositionSizePct != null ? String(rawMaxPositionSizePct) : null)
        : presetRiskMaxPositionSizePctUpdate;

    const effectiveNotificationPolicy = notificationPolicyInput !== undefined
      ? (notificationPolicyInput === null ? null : resolveNotificationPolicy(notificationPolicyInput, agent.notificationPolicy as Parameters<typeof resolveNotificationPolicy>[1]))
      : undefined;

    const txResult = await db.transaction(async (tx): Promise<
      | { kind: 'ok' }
      | { kind: 'conn_error'; status: number; body: Record<string, unknown> }
    > => {
        await tx.update(agents).set({
          ...agentUpdates,
          ...(rawTelegramChatId !== undefined ? { telegramChatId: rawTelegramChatId?.trim() || null } : {}),
          ...(finalMaxPositionSizePctUpdate !== undefined ? { maxPositionSizePct: finalMaxPositionSizePctUpdate } : {}),
          ...(finalStopLossPctUpdate !== undefined ? { stopLossPct: finalStopLossPctUpdate } : {}),
          ...(rawMaxDrawdownPct !== undefined ? { maxDrawdownPct: rawMaxDrawdownPct != null ? String(rawMaxDrawdownPct) : null } : {}),
          ...resolvedMaxBotsPatch,
          ...(executionMode.value != null ? { executionMode: executionMode.value } : {}),
          ...(effectiveNotificationPolicy !== undefined ? { notificationPolicy: effectiveNotificationPolicy } : {}),
          ...(unifiedConfigPatch !== undefined ? { unifiedConfig: unifiedConfigPatch } : {}),
          toolPolicy: effectiveToolPolicy,
          modelPolicy: effectiveModelPolicy,
          updatedAt: new Date(),
        } as never).where(eq(agents.id, id));

        // Declarative sync of agent_connections when connectionIds is explicitly provided.
        // This is a batch diff (add/revoke) performed inside the PATCH transaction —
        // intentionally separate from agent-config-service's grantConnection/revokeConnection
        // which are single-operation functions used by Telegram slash commands.
        if (parsed.data.connectionIds !== undefined) {
          const patchConnectionIds = parsed.data.connectionIds;

          // Fetch existing active agent_connections for this agent
          const existingRows = await tx.select({
            id: agentConnections.id,
            connectionId: agentConnections.connectionId,
          }).from(agentConnections)
            .where(and(
              eq(agentConnections.agentId, id),
              eq(agentConnections.status, 'active'),
            ));

          const existingConnectionIds = new Set(existingRows.map((r) => r.connectionId));
          const newConnectionIds = new Set(patchConnectionIds);

          const toAdd = patchConnectionIds.filter((cid) => !existingConnectionIds.has(cid));
          const toRevoke = existingRows.filter((r) => !newConnectionIds.has(r.connectionId));

          // Validate all new connectionIds inside the transaction
          if (toAdd.length > 0) {
            const connRows = await tx.select({
              id: connections.id,
              userId: connections.userId,
              status: connections.status,
            }).from(connections).where(inArray(connections.id, toAdd));

            const connById = new Map(connRows.map((r) => [r.id, r]));
            for (const cid of toAdd) {
              const conn = connById.get(cid);
              if (!conn) {
                return {
                  kind: 'conn_error' as const,
                  status: 400,
                  body: {
                    error: 'validation_error',
                    details: [{ code: 'custom', path: ['connectionIds'], message: `Connection ${cid} does not exist` }],
                  },
                };
              }
              if (conn.userId !== request.userId) {
                return {
                  kind: 'conn_error' as const,
                  status: 400,
                  body: {
                    error: 'validation_error',
                    details: [{ code: 'custom', path: ['connectionIds'], message: `Connection ${cid} does not belong to you` }],
                  },
                };
              }
              if (conn.status !== 'active') {
                return {
                  kind: 'conn_error' as const,
                  status: 400,
                  body: {
                    error: 'validation_error',
                    details: [{ code: 'custom', path: ['connectionIds'], message: `Connection ${cid} is not active (status: ${conn.status})` }],
                  },
                };
              }
            }
          }

          const now = new Date();

          // Insert rows for newly added connections
          for (const cid of toAdd) {
            const acId = crypto.randomUUID();
            await tx.insert(agentConnections).values({
              id: acId,
              agentId: id,
              connectionId: cid,
              status: 'active',
              grantedBy: request.userId,
              grantedAt: now,
              createdAt: now,
              updatedAt: now,
            });
            await tx.insert(agentConnectionAudit).values({
              id: crypto.randomUUID(),
              agentConnectionId: acId,
              action: 'granted',
              actorType: 'user',
              actorId: request.userId,
              createdAt: now,
            });
          }

          // Revoke rows that are no longer in the list
          for (const row of toRevoke) {
            await tx.update(agentConnections).set({
              status: 'revoked',
              revokedAt: now,
              updatedAt: now,
            }).where(eq(agentConnections.id, row.id));
            await tx.insert(agentConnectionAudit).values({
              id: crypto.randomUUID(),
              agentConnectionId: row.id,
              action: 'revoked',
              actorType: 'user',
              actorId: request.userId,
              createdAt: now,
            });
          }
        }
        return { kind: 'ok' as const };
      });

    if (txResult.kind === 'conn_error') {
      return reply.status(txResult.status).send(txResult.body);
    }

    // Sync wake preferences to Redis so the market monitor picks up changes
    // immediately (no restart required). null = all sources = delete the key
    // so the monitor treats the agent as "subscribed to everything".
    if (redisClient && 'wakePreferences' in parsed.data) {
      const prefsKey = `agent:wake:prefs:${id}`;
      try {
        if (parsed.data.wakePreferences === null) {
          await redisClient.del(prefsKey);
        } else {
          await redisClient.set(prefsKey, JSON.stringify(parsed.data.wakePreferences));
        }
      } catch (err) {
        request.log.warn({ err, agentId: id }, 'Failed to sync wake preferences to Redis');
      }
    }

    await syncAgentSkillAssignments(db, id, request.userId, assignmentResolution.assignments ?? []);

    const [updated] = await db.select().from(agents).where(eq(agents.id, id));
    const skillIds = await listSkillIdsForAgent(db, id);
    const riskContract = resolveAgentRiskContractForResponse(updated!, agentRiskDefaults);
    return reply.send({ ...decorateAgentResponse({ ...updated!, skillIds }), ...enrichAgentResponse(updated!), riskContract });
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
    // 7. Clean up orphaned connections: for each connection linked exclusively to this
    //    agent (no other agent holds an agent_connection to it), revoke the connection
    //    and null out the venue account's credentialId so the credential can be deleted.
    //    Connections are user-owned and persist after agent deletion; only the linkage
    //    is cleaned up here.
    const myConnRows = await db
      .select({ connectionId: agentConnections.connectionId })
      .from(agentConnections)
      .where(eq(agentConnections.agentId, id));
    const uniqueConnectionIds = [...new Set(myConnRows.map((r) => r.connectionId))];
    for (const connectionId of uniqueConnectionIds) {
      // Count all agent_connections for this connection across all agents.
      // If exactly one exists (this agent's row, not yet cascade-deleted), the connection
      // is orphaned once this agent is gone.
      const allUsersOfConn = await db
        .select({ connectionId: agentConnections.connectionId })
        .from(agentConnections)
        .where(eq(agentConnections.connectionId, connectionId));
      if (allUsersOfConn.length === 1) {
        const [conn] = await db
          .select({ id: connections.id, resolvedVenueAccountId: connections.resolvedVenueAccountId })
          .from(connections)
          .where(eq(connections.id, connectionId));
        if (conn) {
          if (conn.resolvedVenueAccountId) {
            await db.update(venueAccounts)
              .set({ credentialId: null })
              .where(eq(venueAccounts.id, conn.resolvedVenueAccountId));
          }
          await db.update(connections)
            .set({ status: 'revoked' })
            .where(eq(connections.id, connectionId));
        }
      }
    }
    // 8. DELETE agents (cascades: agent_skills, agent_connections, agent_connection_audit)
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

    const result = await pauseAgent(db, id, request.userId, parsed.data?.reason);
    if (!result.ok) {
      if (result.error.code === 'agent.not_found') {
        return reply.status(404).send({ error: 'not_found' });
      }
      return reply.status(500).send({ error: result.error.code, message: result.error.message });
    }

    return reply.send({ status: result.data.status });
  });

  // Resume agent
  app.post<{ Params: { id: string } }>('/agents/:id/resume', async (request, reply) => {
    const { id } = request.params;

    const result = await resumeAgent(db, id, request.userId);
    if (!result.ok) {
      if (result.error.code === 'agent.not_found') {
        return reply.status(404).send({ error: 'not_found' });
      }
      if (result.error.code === 'agent.invalid_status') {
        return reply.status(409).send(errorPayload('not_paused', 'Agent is not paused', { status: result.error.currentStatus }));
      }
      return reply.status(500).send({ error: result.error.code, message: result.error.message });
    }

    return reply.send({ status: result.data.status });
  });

  // Start agent (stopped → starting) — records the request durably.
  app.post<{ Params: { id: string } }>('/agents/:id/start', async (request, reply) => {
    const { id } = request.params;

    const result = await startAgent(db, id, request.userId);
    if (!result.ok) {
      if (result.error.code === 'agent.not_found') {
        return reply.status(404).send({ error: 'not_found' });
      }
      if (result.error.code === 'agent.invalid_status') {
        return reply.status(409).send(errorPayload('not_stopped', 'Agent is not stopped', { status: result.error.currentStatus }));
      }
      if (result.error.code === 'agent.model_selection_incomplete') {
        return reply.status(422).send(errorPayload(
          'config.model_selection_incomplete',
          'Agent cannot start — set provider, lightModel, and heavyModel in agent config or user AI settings',
        ));
      }
      return reply.status(500).send({ error: result.error.code, message: result.error.message });
    }

    return reply.status(202).send({ status: result.data.status, sessionId: result.data.sessionId });
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

  // Get single artifact with full detail (including location ref for content retrieval)
  app.get<{ Params: { id: string; artifactId: string } }>('/agents/:id/artifacts/:artifactId', async (request, reply) => {
    const { id, artifactId } = request.params;

    const [agent] = await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) return reply.status(404).send({ error: 'not_found' });

    const [artifact] = await db.select().from(agentArtifacts)
      .where(and(eq(agentArtifacts.id, artifactId), eq(agentArtifacts.agentId, id)));

    if (!artifact) return reply.status(404).send({ error: 'not_found' });

    return reply.send(artifact);
  });

  // Download agent artifact content (serves inline body or proxies from location.url)
  app.get<{ Params: { id: string; artifactId: string } }>('/agents/:id/artifacts/:artifactId/download', async (request, reply) => {
    const { id, artifactId } = request.params;

    const [agent] = await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.id, id), eq(agents.userId, request.userId)));
    if (!agent) return reply.status(404).send({ error: 'not_found' });

    const [artifact] = await db.select().from(agentArtifacts)
      .where(and(eq(agentArtifacts.id, artifactId), eq(agentArtifacts.agentId, id)));

    if (!artifact) return reply.status(404).send({ error: 'not_found' });

    const filename = `${artifact.artifactType}-${artifact.id.slice(0, 8)}`;

    // Serve inline body if present
    if (artifact.location?.body) {
      const bodyBuffer = Buffer.from(artifact.location.body, 'utf-8');
      void reply.header('Content-Type', artifact.contentType);
      void reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      void reply.header('Content-Length', bodyBuffer.byteLength);
      return reply.send(bodyBuffer);
    }

    // Proxy from location.url if present
    const locationUrl = artifact.location?.url;
    if (!locationUrl) {
      return reply.status(404).send({ error: 'no_downloadable_content', message: 'This artifact has no downloadable content.' });
    }

    try {
      const response = await fetch(locationUrl);
      if (!response.ok) {
        request.log.warn({ status: response.status, locationUrl }, 'Failed to fetch artifact content from location');
        return reply.status(502).send({ error: 'fetch_failed', message: 'Failed to retrieve artifact content from storage.' });
      }

      const contentBuffer = await response.arrayBuffer();

      void reply.header('Content-Type', artifact.contentType);
      void reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      void reply.header('Content-Length', contentBuffer.byteLength);
      return reply.send(Buffer.from(contentBuffer));
    } catch (err) {
      request.log.error({ err, locationUrl }, 'Error fetching artifact content');
      return reply.status(502).send({ error: 'fetch_failed', message: 'Failed to retrieve artifact content from storage.' });
    }
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

    const result = await stopAgent(db, id, request.userId);
    if (!result.ok) {
      if (result.error.code === 'agent.not_found') {
        return reply.status(404).send({ error: 'not_found' });
      }
      return reply.status(500).send({ error: result.error.code, message: result.error.message });
    }

    return reply.send({ status: result.data.status });
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
