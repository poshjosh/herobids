import crypto from 'node:crypto';
import type { Database } from '@herobids/db';
import {
  agents,
  agentConnections,
  agentSkills,
  users,
  resolveSkillAssignmentsForUser,
} from '@herobids/db';
import { eq, and, asc } from 'drizzle-orm';
import type {
  AgentBlueprintRevisionPayload,
  PlansConfig,
  AgentRiskDefaultsConfig,
  ModelDefaults,
} from '@herobids/domain';
import { normalizePersistedAiModelConfig } from '@herobids/domain';
import { checkLiveEnabled, checkAgentLimit, resolvePlanLimitEntitlements, resolvePlanSkillEntitlements } from '../plan-guards.js';
import {
  extractModelSelection,
  mergeModelPolicy,
  validateAgentModelPolicy,
  validateAgentRiskBounds,
} from '../routes/agent-config-helpers.js';
import type { LlmCatalogDeps } from '../llm-model-catalog.js';
import { projectAgentToBlueprintPayload } from './blueprint-projection.js';
import { createAgentFromPayload } from './agent-instantiation-service.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface GoLiveParams {
  sourceAgentId: string;
  userId: string;
  nameOverride?: string;
  db: Database;
  plansConfig?: PlansConfig;
  userPlanId: string;
  isAdmin: boolean;
  llmCatalogDeps?: LlmCatalogDeps;
  agentRiskDefaults?: AgentRiskDefaultsConfig;
  operatorModelDefaults?: ModelDefaults;
}

export type GoLiveResult =
  | { ok: true; agentId: string }
  | { ok: false; status: number; error: string; message: string; params?: Record<string, unknown> };

// ── Service ──────────────────────────────────────────────────────────────────

export async function cloneAgentAsLive(params: GoLiveParams): Promise<GoLiveResult> {
  const {
    sourceAgentId,
    userId,
    nameOverride,
    db,
    plansConfig,
    userPlanId,
    isAdmin,
    llmCatalogDeps,
    agentRiskDefaults,
    operatorModelDefaults,
  } = params;

  // 1. Load source agent + verify ownership
  const [sourceAgent] = await db.select().from(agents)
    .where(and(eq(agents.id, sourceAgentId), eq(agents.userId, userId)));

  if (!sourceAgent) {
    return { ok: false, status: 404, error: 'not_found', message: 'Agent not found' };
  }

  // 2. Validate source mode is paper/shadow (400 if live)
  const sourceMode = (sourceAgent.executionDefaults as Record<string, unknown> | null)?.mode;
  if (sourceMode === 'live') {
    return { ok: false, status: 400, error: 'validation_error', message: 'Agent is already in live mode' };
  }

  // 3. Load source agent's active connections and skill assignments
  const activeConnections = await db.select()
    .from(agentConnections)
    .where(and(eq(agentConnections.agentId, sourceAgentId), eq(agentConnections.status, 'active')));

  const sourceSkillRows = await db.select({ skillId: agentSkills.skillId })
    .from(agentSkills)
    .where(eq(agentSkills.agentId, sourceAgentId))
    .orderBy(asc(agentSkills.orderIndex), asc(agentSkills.skillId));

  const sourceSkillIds = sourceSkillRows.map((r) => r.skillId);

  // 4. Validate at least one active connection (required for live)
  if (activeConnections.length === 0) {
    return { ok: false, status: 400, error: 'validation_error', message: 'At least one active connection is required for live mode' };
  }

  // 5. Plan enforcement: live enabled + agent limit
  if (plansConfig) {
    const liveCheck = checkLiveEnabled(plansConfig, userPlanId, isAdmin);
    if (!liveCheck.ok) {
      return { ok: false, status: 403, error: liveCheck.error.code, message: liveCheck.error.message };
    }

    const agentLimitCheck = await checkAgentLimit(db, plansConfig, userId, userPlanId, isAdmin);
    if (!agentLimitCheck.ok) {
      return {
        ok: false,
        status: 403,
        error: agentLimitCheck.error.code,
        message: agentLimitCheck.error.message,
        params: agentLimitCheck.error.params as Record<string, unknown> | undefined,
      };
    }
  }

  // 6. Project source agent into blueprint payload
  const projected = projectAgentToBlueprintPayload(sourceAgent);

  // 7. Apply Go Live transformations
  const liveName = nameOverride ?? `${sourceAgent.name} (Live)`;

  // Override execution mode to live
  const liveExecutionDefaults = {
    ...(projected.executionDefaults ?? {}),
    mode: 'live' as const,
  };

  // Fix the executionPolicy mapping: the projection reads uc.executionPolicy,
  // but stored unifiedConfig uses uc.execution. Carry over from source directly.
  const sourceUc = (sourceAgent.unifiedConfig as Record<string, unknown> | null) ?? {};
  const sourceExecution = sourceUc.execution as Record<string, unknown> | undefined;
  let executionPolicy = projected.executionPolicy;
  if (!executionPolicy && sourceExecution) {
    executionPolicy = {
      positionSizeMode: sourceExecution.positionSizeMode as 'fixed' | 'percent_equity' | undefined,
      fixedPositionSize: sourceExecution.fixedPositionSize as string | undefined,
    };
  }

  const livePayload: AgentBlueprintRevisionPayload = {
    ...projected,
    name: liveName,
    executionDefaults: liveExecutionDefaults,
    executionPolicy,
  };

  // 8. Validate canonical risk against operator ceilings
  if (livePayload.risk && agentRiskDefaults) {
    const riskIssues = validateAgentRiskBounds(livePayload.risk, agentRiskDefaults);
    if (riskIssues.length > 0) {
      return { ok: false, status: 400, error: 'validation_error', message: riskIssues.map((i) => i.message).join('; ') };
    }
  }

  // 9. Validate model policy and provider/model availability
  const effectiveModelPolicy = mergeModelPolicy(livePayload.modelPolicy ?? null, {});
  const modelIssues = await validateAgentModelPolicy(effectiveModelPolicy, llmCatalogDeps);
  if (modelIssues.length > 0) {
    return { ok: false, status: 400, error: 'validation_error', message: modelIssues.map((i) => i.message).join('; ') };
  }

  const modelSelection = extractModelSelection(effectiveModelPolicy);
  if (!modelSelection.provider) {
    const [userRow] = await db.select({ aiModelConfig: users.aiModelConfig })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const userAiConfig = normalizePersistedAiModelConfig(userRow?.aiModelConfig);
    if (!userAiConfig && !operatorModelDefaults?.provider) {
      return {
        ok: false,
        status: 400,
        error: 'validation_error',
        message: 'Provider is required — set it on the agent or configure your AI settings in Settings',
      };
    }
  }

  // 10. Re-resolve skills to current selectable revisions
  const skillPlanPolicy = plansConfig
    ? resolvePlanSkillEntitlements(plansConfig, userPlanId, isAdmin)
    : { canViewMarketplaceSkills: true };

  const assignmentResolution = await resolveSkillAssignmentsForUser(
    db,
    userId,
    sourceSkillIds,
    new Set(),
    skillPlanPolicy.canViewMarketplaceSkills,
  );
  if (assignmentResolution.error) {
    return {
      ok: false,
      status: 400,
      error: assignmentResolution.error.code,
      message: assignmentResolution.error.message,
    };
  }

  // 11. Resolve maxBots from plan
  let resolvedMaxBots: number | null = null;
  if (plansConfig) {
    const planLimits = resolvePlanLimitEntitlements(plansConfig, userPlanId, isAdmin);
    const requestedMaxBots = livePayload.maxBots;
    if (requestedMaxBots != null) {
      resolvedMaxBots = requestedMaxBots > planLimits.maxBots ? planLimits.maxBots : requestedMaxBots;
    } else {
      resolvedMaxBots = planLimits.maxBots;
    }
  } else {
    resolvedMaxBots = livePayload.maxBots ?? null;
  }

  // Override maxBots in the payload with plan-resolved value
  livePayload.maxBots = resolvedMaxBots;

  // 12. Preserve all authored unifiedConfig subtrees from the source agent.
  // The createAgentFromPayload service builds unifiedConfig from the payload,
  // but fields not modeled by the blueprint payload surface (intelligence,
  // execution, allowedPresets, presetTransition, metadata) need to be carried
  // over. We build the payload-derived config first, then merge source fields.
  const newAgentId = crypto.randomUUID();
  const now = new Date();

  await db.transaction(async (tx) => {
    const result = await createAgentFromPayload(
      tx as unknown as Database,
      livePayload,
      assignmentResolution.assignments ?? [],
      {
        userId,
        agentId: newAgentId,
        // No blueprint attribution for Go Live
        telegramChatId: sourceAgent.telegramChatId,
      },
    );

    // 12b. Merge source unifiedConfig subtrees that the payload path doesn't model.
    // The createAgentFromPayload already built unifiedConfig from the payload fields
    // (technical, intelligence, capabilityMode, hybridMode, executionPolicy,
    //  executionDefaults, allowedPresets, presetTransition, platformAssessment, authorizationMode).
    // We now overlay any source-only fields (metadata, and any future authored fields).
    const preserveKeys = ['metadata'];
    const overlayFields: Record<string, unknown> = {};
    for (const key of preserveKeys) {
      if (sourceUc[key] !== undefined) {
        overlayFields[key] = sourceUc[key];
      }
    }

    if (Object.keys(overlayFields).length > 0) {
      const currentUc = result.unifiedConfig ?? {};
      const mergedUc = { ...currentUc, ...overlayFields };
      await (tx as unknown as Database).update(agents)
        .set({ unifiedConfig: mergedUc })
        .where(eq(agents.id, newAgentId));
    }

    // 13. Copy agent's notificationPolicy from source
    // These are agent-private fields that blueprints intentionally don't carry
    await (tx as unknown as Database).update(agents)
      .set({
        notificationPolicy: sourceAgent.notificationPolicy,
      })
      .where(eq(agents.id, newAgentId));

    // 14. Copy active agent_connections to the new agent
    for (const conn of activeConnections) {
      await tx.insert(agentConnections).values({
        id: crypto.randomUUID(),
        agentId: newAgentId,
        connectionId: conn.connectionId,
        status: 'active',
        grantedBy: userId,
        grantedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }

    return result;
  });

  return { ok: true, agentId: newAgentId };
}
