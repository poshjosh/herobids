import crypto from 'node:crypto';
import type { Database, DatabaseTransaction } from '@herobids/db';
import {
  agents,
  agentConnections,
  agentSkills,
  connections,
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
} from '../routes/agent-config-helpers.js';
import type { LlmCatalogDeps } from '../llm-model-catalog.js';
import { projectAgentToBlueprintPayload } from './blueprint-projection.js';
import { createAgentFromPayload } from './agent-instantiation-service.js';
import { selectExecutionBinding, type TradingProfileConnection } from '../agents/trading-profile-reconciliation.js';
import type { TradingProfileReconciliationSaga } from '../agents/trading-profile-reconciliation-saga.js';
import { TradingProfileCeilingViolationError } from '../agents/trading-profile-reconciliation-saga.js';

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
  profileReconciliationSaga?: TradingProfileReconciliationSaga;
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
    profileReconciliationSaga,
  } = params;

  // C2.1: local `validateAgentRiskBounds` ceiling enforcement is dropped —
  // traderton's `set_agent_trading_profile` is the sole authority. The
  // `agentRiskDefaults` param is retained for call-site compatibility only.
  // TODO(C2.2): remove after call-site cleanup — retained only for positional signature compatibility.
  void agentRiskDefaults;

  // 1. Load source agent + verify ownership
  const [sourceAgent] = await db.select().from(agents)
    .where(and(eq(agents.id, sourceAgentId), eq(agents.userId, userId)));

  if (!sourceAgent) {
    return { ok: false, status: 404, error: 'not_found', message: 'Agent not found' };
  }
  if (!profileReconciliationSaga) {
    return { ok: false, status: 503, error: 'precondition.not_ready', message: 'Trading service is unavailable — the agent was not promoted.' };
  }

  // 2. Load source agent's active connections and skill assignments
  const activeConnections = await db.select({
    connectionId: agentConnections.connectionId,
    venueAccountId: connections.resolvedVenueAccountId,
    status: connections.status,
  }).from(agentConnections)
    .innerJoin(connections, eq(agentConnections.connectionId, connections.id))
    .where(and(eq(agentConnections.agentId, sourceAgentId), eq(agentConnections.status, 'active')));

  const sourceSkillRows = await db.select({ skillId: agentSkills.skillId })
    .from(agentSkills)
    .where(eq(agentSkills.agentId, sourceAgentId))
    .orderBy(asc(agentSkills.orderIndex), asc(agentSkills.skillId));

  const sourceSkillIds = sourceSkillRows.map((r) => r.skillId);

  const profileConnections: TradingProfileConnection[] = activeConnections.map((connection, index) => ({
    connectionId: connection.connectionId,
    venueAccountId: connection.venueAccountId,
    active: true,
    ready: connection.status === 'active',
    isDefault: index === activeConnections.length - 1,
  }));
  const sourceProfiles = await profileReconciliationSaga.readCurrentProfiles(userId, sourceAgentId, profileConnections);
  const sourceBinding = selectExecutionBinding(profileConnections);
  const sourceProfile = sourceBinding ? sourceProfiles.get(sourceBinding.venueAccountId) : undefined;
  if (sourceProfile?.executionDefaults?.mode === 'live') {
    return { ok: false, status: 400, error: 'validation_error', message: 'Agent is already in live mode' };
  }

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
  const projected = projectAgentToBlueprintPayload({
    ...sourceAgent,
    capital: sourceProfile?.capital ?? null,
    risk: sourceProfile?.riskPosture ?? null,
    executionDefaults: sourceProfile?.executionDefaults ?? null,
  });

  // 7. Apply Go Live transformations
  const liveName = nameOverride ?? `${sourceAgent.name} (Live)`;

  // Override execution mode to live
  const liveExecutionDefaults = {
    ...(projected.executionDefaults ?? {}),
    mode: 'live' as const,
  };

  // Carry over source unifiedConfig for the metadata overlay step later.
  const sourceUc = (sourceAgent.unifiedConfig as Record<string, unknown> | null) ?? {};

  const livePayload: AgentBlueprintRevisionPayload = {
    ...projected,
    name: liveName,
    executionDefaults: liveExecutionDefaults,
  };

  // 8. Validate model policy and provider/model availability
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

  const commitLocal = async (tx: DatabaseTransaction, markLocalCommitted: () => Promise<void>) => {
    const [currentSource] = await tx.select({ userId: agents.userId, status: agents.status })
        .from(agents).where(eq(agents.id, sourceAgentId));
    if (!currentSource || currentSource.userId !== userId || currentSource.status === 'live') {
      throw new Error('source agent changed before go-live could be committed');
    }
    const currentConnections = await tx.select({ connectionId: agentConnections.connectionId })
        .from(agentConnections)
        .where(and(eq(agentConnections.agentId, sourceAgentId), eq(agentConnections.status, 'active')));
    if (currentConnections.length !== activeConnections.length
      || currentConnections.some((connection) => !activeConnections.some((prepared) => prepared.connectionId === connection.connectionId))) {
      throw new Error('source agent connections changed before go-live could be committed');
    }
    const result = await createAgentFromPayload(
      tx,
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
    // TODO: if new authored unifiedConfig fields are added that aren't modeled by
    // AgentBlueprintRevisionPayload, add them to preserveKeys here.
    const preserveKeys = ['metadata'];
    const overlayFields: Record<string, unknown> = {};
    for (const key of preserveKeys) {
      if (sourceUc[key] !== undefined) {
        overlayFields[key] = sourceUc[key];
      }
    }

    // 13. Single UPDATE for agent-private fields that blueprints don't carry,
    // plus the unifiedConfig overlay from step 12b.
    const updateSet: Record<string, unknown> = {
      notificationPolicy: sourceAgent.notificationPolicy,
    };
    if (Object.keys(overlayFields).length > 0) {
      const currentUc = result.unifiedConfig ?? {};
      updateSet.unifiedConfig = { ...currentUc, ...overlayFields };
    }
    await tx.update(agents)
      .set(updateSet)
      .where(eq(agents.id, newAgentId));

    // 14. Copy active agent_connections to the new agent (batch insert)
    if (activeConnections.length > 0) {
      await tx.insert(agentConnections).values(
        activeConnections.map((conn) => ({
          id: crypto.randomUUID(),
          agentId: newAgentId,
          connectionId: conn.connectionId,
          status: 'active' as const,
          grantedBy: userId,
          grantedAt: now,
          createdAt: now,
          updatedAt: now,
        })),
      );
    }

    await markLocalCommitted();
    return result;
  };

  try {
    await profileReconciliationSaga.executeStaged({
      ownerId: userId,
      actorId: newAgentId,
      localMutationId: crypto.randomUUID(),
      preparePlannerInput: () => {
        const profiles = new Map(profileConnections
          .filter((connection): connection is TradingProfileConnection & { venueAccountId: string } => connection.venueAccountId !== null)
          .map((connection) => [connection.venueAccountId, {
            actorId: newAgentId,
            venueAccountId: connection.venueAccountId,
            capital: livePayload.capital != null ? String(livePayload.capital) : null,
            riskPosture: livePayload.risk ?? null,
            executionDefaults: livePayload.executionDefaults ?? null,
          }] as const));
        return {
          prior: { profiles: new Map(), connections: [] },
          proposed: { profiles, connections: profileConnections },
        };
      },
      commitLocal,
    });
  } catch (error) {
    if (error instanceof TradingProfileCeilingViolationError) {
      return { ok: false, status: 400, error: 'validation_error', message: error.message };
    }
    throw error;
  }

  return { ok: true, agentId: newAgentId };
}
