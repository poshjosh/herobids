import type { Database } from '@herobids/db';
import { connections, users } from '@herobids/db';
import { eq, and, inArray } from 'drizzle-orm';
import {
  TechnicalConfigSchema,
  venueTypeFromProvider,
  normalizePersistedAiModelConfig,
  type TechnicalConfig,
  type RiskPosture,
  type StrategyIdentity,
  type ExecutionDefaults,
  type AgentRiskDefaultsConfig,
} from '@herobids/domain';
import type { PlansConfig } from '@herobids/domain';
import { resolvePlanLimitEntitlements } from '../plan-guards.js';
import { resolveAgentStrategyPreset } from './strategy-preset-resolver.js';
import { resolveNotificationPolicy } from '../routes/agent-config-helpers.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface PrepareAgentCreateFieldsParams {
  name: string;
  prompt: string;
  skillIds: string[];
  style?: string | null;
  capabilityMode?: string;
  hybridMode?: string;
  strategyPreset?: string;
  capital?: string | null;
  skillPresetId?: string | null;
  connectionIds?: string[];
  toolPolicy?: Record<string, unknown> | null;
  modelPolicy?: Record<string, unknown> | null;
  platformAssessment?: { enabled?: boolean; reviewIntervalMs?: number };
  authorizationMode?: string | null;
  tickIntervalMs?: number | null;
  runtimePolicyOverrides?: Record<string, unknown> | null;
  telegramChatId?: string | null;
  notificationPolicy?: Record<string, unknown> | null;
  wakePreferences?: unknown | null;
  openPositionEscalationToJudgePolicy?: string;
  technical?: Record<string, unknown> | null;
  executionDefaults?: ExecutionDefaults | null;
  risk?: RiskPosture | null;
  strategy?: StrategyIdentity | null;
  executionVenue?: string;
  maxBots?: number | null;

  // Infrastructure
  db: Database;
  userId: string;
  plansConfig?: PlansConfig;
  userPlanId?: string;
  isAdmin?: boolean;
  agentRiskDefaults?: AgentRiskDefaultsConfig;
}

export interface AgentCreateFields {
  unifiedConfig: Record<string, unknown> | null;
  toolPolicy: Record<string, unknown> | null;
  runtimePolicyOverrides: Record<string, unknown> | null;
  maxBots: number | null;
  notificationPolicy: Record<string, unknown> | null;
  executionDefaults: ExecutionDefaults | null;
  strategy: StrategyIdentity | null;
  risk: RiskPosture | null;
}

// ── Shared Helpers ────────────────────────────────────────────────────────────

/**
 * Auto-populate toolPolicy from skillIds.
 * If 'bot-management' is in skillIds, add a brokered manage_bot grant.
 * Merges with any existing toolPolicy entries supplied by the caller.
 */
export function deriveToolPolicyFromSkills(
  skillIds: string[],
  existingToolPolicy?: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const basePolicy: Record<string, unknown> = { ...(existingToolPolicy ?? {}) };
  if (skillIds.includes('bot-management') && !basePolicy['manage_bot']) {
    basePolicy['manage_bot'] = {
      capability: 'manage_bot',
      tier: 'brokered',
      enabled: true,
      limits: { maxPerMinute: 5, maxConcurrent: 1, timeoutMs: 30_000 },
    };
  }
  return Object.keys(basePolicy).length > 0 ? basePolicy : null;
}

/**
 * Enrich unifiedConfig with capabilityMode, hybridMode, platformAssessment,
 * authorizationMode, skillPresetId metadata, preset-derived technical/execution,
 * venue filters from connections, and TechnicalConfigSchema defaults.
 */
export async function resolveUnifiedConfig(params: {
  technical?: Record<string, unknown> | null;
  strategyPreset?: string;
  style?: string | null;
  capabilityMode?: string;
  hybridMode?: string;
  platformAssessment?: { enabled?: boolean; reviewIntervalMs?: number };
  authorizationMode?: string | null;
  skillPresetId?: string | null;
  connectionIds?: string[];
  db: Database;
}): Promise<Record<string, unknown> | null> {
  const {
    technical,
    strategyPreset,
    style,
    capabilityMode: rawCapabilityMode,
    hybridMode: rawHybridMode,
    platformAssessment,
    authorizationMode,
    skillPresetId,
    connectionIds,
    db,
  } = params;

  // 1. Resolve strategy preset into unifiedConfig patch
  let presetUnifiedConfig: Record<string, unknown> | null = null;
  if (strategyPreset) {
    const resolution = resolveAgentStrategyPreset({ strategyPreset, style });
    if (resolution) {
      presetUnifiedConfig = resolution.unifiedConfigPatch;
    }
  }

  // 2. Build final unifiedConfig: explicit technical wins over preset technical
  let finalUnifiedConfig: Record<string, unknown> | null = null;
  if (technical) {
    finalUnifiedConfig = {
      ...(presetUnifiedConfig ?? {}),
      technical,
    };
  } else if (presetUnifiedConfig) {
    finalUnifiedConfig = { ...presetUnifiedConfig };
  }

  // 3. Stamp capabilityMode and hybridMode
  const capabilityMode = rawCapabilityMode ?? 'intelligence';
  const hybridMode = rawHybridMode ?? (capabilityMode === 'hybrid' ? 'mixed' : undefined);

  if (finalUnifiedConfig) {
    finalUnifiedConfig.capabilityMode = capabilityMode;
    if (hybridMode !== undefined) {
      finalUnifiedConfig.hybridMode = hybridMode;
    }
  } else {
    finalUnifiedConfig = {
      capabilityMode,
      ...(hybridMode !== undefined ? { hybridMode } : {}),
    };
  }

  // 4. Stamp platformAssessment
  if (platformAssessment) {
    if (!finalUnifiedConfig) finalUnifiedConfig = {};
    finalUnifiedConfig.platformAssessment = platformAssessment;
  }

  // 5. Stamp authorizationMode
  if (authorizationMode) {
    if (!finalUnifiedConfig) finalUnifiedConfig = {};
    finalUnifiedConfig.authorizationMode = authorizationMode;
  }

  // 6. Stamp skillPresetId into unifiedConfig.metadata
  if (skillPresetId) {
    if (!finalUnifiedConfig) finalUnifiedConfig = {};
    const meta = (finalUnifiedConfig['metadata'] as Record<string, unknown>) ?? {};
    meta['skillPresetId'] = skillPresetId;
    finalUnifiedConfig['metadata'] = meta;
  }

  // 7. Populate technical.filters from selected connections
  if (finalUnifiedConfig?.technical && connectionIds && connectionIds.length > 0) {
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

  // 8. Apply TechnicalConfigSchema defaults
  if (finalUnifiedConfig?.technical) {
    try {
      finalUnifiedConfig.technical = TechnicalConfigSchema.parse(finalUnifiedConfig.technical);
    } catch {
      // If parse fails, leave as-is — downstream validation catches issues
    }
  }

  // 9. Guard: scanner_gated agents MUST have a technical config.
  // Without it the worker will reject the agent at startup with a cryptic
  // Zod error ("expected object, received undefined"). Fail fast here with
  // a clear message so the caller can fix the setup.
  if (
    finalUnifiedConfig &&
    finalUnifiedConfig['hybridMode'] === 'scanner_gated' &&
    !finalUnifiedConfig['technical']
  ) {
    throw new Error(
      'Cannot create a scanner-gated agent without a technical configuration. ' +
      'Provide a strategy preset or an explicit technical config.',
    );
  }

  // 9b. Default regime injection for scanner-gated orderbook agents.
  // Strategy presets do not include regime config, so preset-derived technical
  // configs arrive without one. Rather than rejecting, inject the platform
  // default (BTC benchmark) so the scanner fingerprint works out of the box.
  // Swap venues are excluded — BTC regime is not meaningful for memecoin scanning.
  if (
    finalUnifiedConfig &&
    finalUnifiedConfig['hybridMode'] === 'scanner_gated' &&
    finalUnifiedConfig['technical']
  ) {
    const tech = finalUnifiedConfig['technical'] as TechnicalConfig;
    if (tech.filters?.venueType === 'orderbook' && !tech.regime) {
      (finalUnifiedConfig['technical'] as Record<string, unknown>).regime = { benchmarkSymbol: 'BTC' };
    }
  }

  // 10. Guard: scanner_gated orderbook agents MUST have a regime config.
  // Without it the scanner fingerprint is permanently 'regime:unavailable',
  // the dedup gate never changes, and wake signals are suppressed indefinitely.
  // Swap/DEX venues are excluded — BTC regime is not meaningful for memecoin scanning.
  if (
    finalUnifiedConfig &&
    finalUnifiedConfig['hybridMode'] === 'scanner_gated' &&
    finalUnifiedConfig['technical']
  ) {
    const tech = finalUnifiedConfig['technical'] as TechnicalConfig;
    if (tech.filters?.venueType === 'orderbook' && !tech.regime) {
      throw new Error(
        'Scanner-gated orderbook agents require a regime configuration for the scanner to function. ' +
        'Add a "regime" field to the technical config (e.g. { "benchmarkSymbol": "BTC" }) or use a strategy preset that includes one.',
      );
    }
  }

  return finalUnifiedConfig;
}

/**
 * Stamp adaptive reasoning flags from the user's AI model settings into
 * runtimePolicyOverrides. If the user has set adaptScoutReasoning or
 * adaptJudgeReasoning in Settings, they flow through to new agents so the
 * worker can apply the correct ceiling/fixed behavior.
 */
export async function resolveRuntimePolicyOverrides(params: {
  db: Database;
  userId: string;
  runtimePolicyOverrides?: Record<string, unknown> | null;
}): Promise<Record<string, unknown> | null> {
  const { db, userId, runtimePolicyOverrides } = params;

  let stamped = runtimePolicyOverrides ?? null;

  const [userRow] = await db
    .select({ aiModelConfig: users.aiModelConfig })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const userAiConfig = normalizePersistedAiModelConfig(userRow?.aiModelConfig);
  if (userAiConfig) {
    const current = (stamped ?? {}) as Record<string, unknown>;
    if (userAiConfig.adaptScoutReasoning !== undefined && current['adaptScoutReasoning'] === undefined) {
      current['adaptScoutReasoning'] = userAiConfig.adaptScoutReasoning;
    }
    if (userAiConfig.adaptJudgeReasoning !== undefined && current['adaptJudgeReasoning'] === undefined) {
      current['adaptJudgeReasoning'] = userAiConfig.adaptJudgeReasoning;
    }
    if (Object.keys(current).length > 0) {
      stamped = current;
    }
  }

  return stamped;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Main orchestrator that calls all create-time normalization helpers and
 * returns the complete set of normalized fields to persist when creating
 * an agent. Both POST /agents and Guided Setup should use this.
 */
export async function prepareAgentCreateFields(
  params: PrepareAgentCreateFieldsParams,
): Promise<AgentCreateFields> {
  const {
    skillIds,
    toolPolicy: rawToolPolicy,
    style,
    capabilityMode,
    hybridMode,
    strategyPreset,
    skillPresetId,
    connectionIds,
    platformAssessment,
    authorizationMode,
    technical,
    runtimePolicyOverrides: rawRuntimePolicyOverrides,
    executionDefaults,
    risk,
    strategy,
    notificationPolicy: rawNotificationPolicy,
    db,
    userId,
    plansConfig,
    userPlanId,
    isAdmin,
  } = params;

  // ── Tool policy derivation ─────────────────────────────────────────────
  const toolPolicy = deriveToolPolicyFromSkills(skillIds, rawToolPolicy);

  // ── Unified config enrichment ──────────────────────────────────────────
  const unifiedConfig = await resolveUnifiedConfig({
    technical,
    strategyPreset,
    style,
    capabilityMode,
    hybridMode,
    platformAssessment,
    authorizationMode,
    skillPresetId,
    connectionIds,
    db,
  });

  // ── Runtime policy overrides ───────────────────────────────────────────
  const runtimePolicyOverrides = await resolveRuntimePolicyOverrides({
    db,
    userId,
    runtimePolicyOverrides: rawRuntimePolicyOverrides,
  });

  // ── Resolve maxBots from plan ──────────────────────────────────────────
  let maxBots: number | null = null;
  if (plansConfig) {
    const planLimits = resolvePlanLimitEntitlements(plansConfig, userPlanId || 'free', isAdmin ?? false);
    const requestedMaxBots = params.maxBots;
    if (requestedMaxBots != null) {
      // Validated upstream — trust the caller
      maxBots = requestedMaxBots > planLimits.maxBots ? planLimits.maxBots : requestedMaxBots;
    } else {
      maxBots = planLimits.maxBots;
    }
  } else {
    maxBots = params.maxBots ?? null;
  }

  // ── Notification policy normalization ──────────────────────────────────
  // Stamp enabledAt ISO timestamp when a non-null notification policy is
  // provided (mirrors form route behaviour via resolveNotificationPolicy).
  const notificationPolicy = rawNotificationPolicy
    ? resolveNotificationPolicy(rawNotificationPolicy as { sendMessage?: { email?: { enabled: boolean; source: 'explicit_prompt' | 'explicit_update' } } }, null)
    : null;

  return {
    unifiedConfig,
    toolPolicy,
    runtimePolicyOverrides,
    maxBots,
    notificationPolicy,
    executionDefaults: executionDefaults ?? null,
    strategy: strategy ?? null,
    risk: risk ?? null,
  };
}
