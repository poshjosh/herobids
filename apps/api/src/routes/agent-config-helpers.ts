import { z } from 'zod';
import { Decimal, SYSTEM_SKILLS, resolveAgentRiskContract, resolveAgentRuntimePolicy, type AgentRiskCeilings, type AgentRiskCreatorInput, type AgentRiskOverrides, type ResolvedAgentRiskContract, type AgentRiskDefaultsConfig } from '@herobids/domain';
import type { LlmCatalogDeps } from '../llm-model-catalog.js';
import { validateAiModelSelection, normalizeAgentModelPolicy } from '../llm-model-catalog.js';

const CAPABILITY_FAMILIES_BY_SKILL_ID = new Map(SYSTEM_SKILLS.map((skill) => [skill.id, skill.capabilityFamilies] as const));

const AGENT_EXECUTION_MODES = new Set(['paper', 'shadow', 'live'] as const);

type AgentExecutionMode = 'paper' | 'shadow' | 'live';
type NullableAgentExecutionMode = AgentExecutionMode | 'test' | null | undefined;

/**
 * Map the user-facing input alias `test` to a concrete simulation mode.
 * - test with no venue/connection → paper (pure simulation, no venue needed)
 * - test with a venue/connection → shadow (venue-backed simulation)
 * - All other modes pass through unchanged.
 *
 * `test` is an input alias only — audits, logs, and downstream consumers
 * always see the concrete mode.
 */
export function canonicalizeExecutionMode(
  mode: string | null | undefined,
  opts?: { hasConnections?: boolean; hasVenue?: boolean },
): string | null | undefined {
  if (mode === 'test') return opts?.hasConnections || opts?.hasVenue ? 'shadow' : 'paper';
  return mode;
}

export const CostPresetSchema = z.enum(['minimal', 'standard', 'premium', 'custom']);

export type CostPreset = z.infer<typeof CostPresetSchema>;

export const positiveIntegerSchema = (minValue = 1) => z.union([z.number(), z.string()]).transform((value, ctx) => {
  const numericValue = typeof value === 'string' ? Number(value.trim()) : value;
  if (!Number.isInteger(numericValue) || numericValue < minValue) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Value must be an integer greater than or equal to ${minValue}`,
    });
    return z.NEVER;
  }
  return numericValue;
});

export const optionalPositiveIntegerSchema = (minValue = 1) => z.preprocess((value) => {
  if (typeof value === 'string' && value.trim().length === 0) {
    return undefined;
  }
  return value;
}, positiveIntegerSchema(minValue).optional());

export const nullablePositiveIntegerSchema = (minValue = 1) => z.preprocess((value) => {
  if (value === null) {
    return null;
  }
  if (typeof value === 'string' && value.trim().length === 0) {
    return null;
  }
  return value;
}, positiveIntegerSchema(minValue).nullable().optional());

export const positiveDecimalStringSchema = z.union([z.number(), z.string()]).transform((value, ctx) => {
  const rawValue = typeof value === 'string' ? value.trim() : String(value);
  try {
    const decimalValue = new Decimal(rawValue);
    if (!decimalValue.isFinite() || decimalValue.lte(0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Value must be a positive decimal',
      });
      return z.NEVER;
    }
    return decimalValue.toString();
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Value must be a valid decimal',
    });
    return z.NEVER;
  }
});

export const optionalPositiveDecimalStringSchema = z.preprocess((value) => {
  if (typeof value === 'string' && value.trim().length === 0) {
    return undefined;
  }
  return value;
}, positiveDecimalStringSchema.optional());

export const nullablePositiveDecimalStringSchema = z.preprocess((value) => {
  if (value === null) {
    return null;
  }
  if (typeof value === 'string' && value.trim().length === 0) {
    return null;
  }
  return value;
}, positiveDecimalStringSchema.nullable().optional());

export function hasSkillCapabilityFamily(skillIds: string[] | null | undefined, capabilityFamily: string): boolean {
  return (skillIds ?? []).some((skillId) => CAPABILITY_FAMILIES_BY_SKILL_ID.get(skillId)?.includes(capabilityFamily));
}

function normalizeExecutionMode(
  value: string | null | undefined,
  opts?: { hasConnections?: boolean; hasVenue?: boolean },
): NullableAgentExecutionMode {
  if (value == null) {
    return value;
  }

  // Canonicalize user-facing input alias (test) to concrete backend mode
  const canonical = canonicalizeExecutionMode(value, opts);
  return AGENT_EXECUTION_MODES.has(canonical as AgentExecutionMode) ? canonical as AgentExecutionMode : null;
}

export function resolveExecutionModeForSkills(input: {
  skillIds: string[] | null | undefined;
  submittedExecutionMode: NullableAgentExecutionMode;
  executionModeProvided: boolean;
  currentExecutionMode?: string | null;
  /** Whether the agent has trading connections (venue accounts). Used to resolve `test` → paper or shadow. */
  hasConnections?: boolean;
  /** Whether the agent has an explicit venue selection. Used to resolve `test` → shadow before any connection is granted. */
  hasVenue?: boolean;
}): {
  value: Exclude<NullableAgentExecutionMode, undefined>;
  issue?: { code: 'custom'; path: string[]; message: string };
} {
  const hasTradingCapability = hasSkillCapabilityFamily(input.skillIds, 'trading');
  if (!hasTradingCapability) {
    if (input.executionModeProvided && input.submittedExecutionMode != null) {
      return {
        value: null,
        issue: {
          code: 'custom',
          path: ['executionMode'],
          message: 'Execution mode is only valid for agents with trading skills',
        },
      };
    }

    return { value: null };
  }

  const connectionOpts = { hasConnections: input.hasConnections, hasVenue: input.hasVenue };

  if (input.executionModeProvided) {
    const resolved = normalizeExecutionMode(input.submittedExecutionMode, connectionOpts);
    if (resolved == null) {
      return {
        value: null,
        issue: {
          code: 'custom',
          path: ['executionMode'],
          message: 'executionMode must be explicitly set for agents with trading skills (test or live)',
        },
      };
    }
    return { value: resolved };
  }

  // Carry forward existing mode when not provided in the update
  const existing = normalizeExecutionMode(input.currentExecutionMode, connectionOpts);
  if (existing != null) {
    return { value: existing };
  }

  // No existing mode and none provided — default to paper for backward compat during creation
  return { value: 'paper' };
}

/**
 * Live and shadow execution both resolve a trading decision against a real venue
 * account (see AGENTS.md: agent → agent_connections → connections → venue_accounts).
 * Without a granted connection there is no execution context to resolve at runtime,
 * so creating or updating an agent into either mode requires at least one connection.
 */
export function validateConnectionRequirement(
  executionModeValue: string | null | undefined,
  hasConnections: boolean,
): { code: 'custom'; path: string[]; message: string } | null {
  if ((executionModeValue === 'live' || executionModeValue === 'shadow') && !hasConnections) {
    return {
      code: 'custom',
      path: ['connectionIds'],
      message: 'At least one connection is required for live or shadow execution.',
    };
  }
  return null;
}

export function mergeModelPolicy(
  current: Record<string, unknown> | null | undefined,
  update: {
    modelPolicy?: Record<string, unknown>;
    provider?: string | null;
    lightModel?: string | null;
    heavyModel?: string | null;
    costPreset?: CostPreset | null;
    dailySpendBudgetUsd?: number | null;
    dexWatchlistSymbols?: string[] | null;
  },
): Record<string, unknown> | null {
  const merged: Record<string, unknown> = { ...(current ?? {}), ...(update.modelPolicy ?? {}) };

  const setOrDelete = (key: string, value: string | null | undefined) => {
    if (value === undefined) {
      return;
    }
    if (value === null) {
      delete merged[key];
      return;
    }
    merged[key] = value;
  };

  setOrDelete('provider', update.provider);
  setOrDelete('lightModel', update.lightModel);
  setOrDelete('heavyModel', update.heavyModel);
  if (update.costPreset !== undefined) {
    if (update.costPreset === null) delete merged['costPreset'];
    else merged['costPreset'] = update.costPreset;
  }
  if (update.dailySpendBudgetUsd !== undefined) {
    if (update.dailySpendBudgetUsd === null) delete merged['dailySpendBudgetUsd'];
    else merged['dailySpendBudgetUsd'] = update.dailySpendBudgetUsd;
  }
  if (update.dexWatchlistSymbols !== undefined) {
    if (update.dexWatchlistSymbols === null) delete merged['dexWatchlistSymbols'];
    else merged['dexWatchlistSymbols'] = update.dexWatchlistSymbols;
  }

  return normalizeAgentModelPolicy(merged);
}

export function extractModelSelection(modelPolicy: Record<string, unknown> | null | undefined): {
  provider: string | null;
  lightModel: string | null;
  heavyModel: string | null;
} {
  const provider = typeof modelPolicy?.['provider'] === 'string' ? modelPolicy['provider'] : null;
  const lightModel = typeof modelPolicy?.['lightModel'] === 'string' ? modelPolicy['lightModel'] : null;
  const heavyModel = typeof modelPolicy?.['heavyModel'] === 'string' ? modelPolicy['heavyModel'] : null;

  return { provider, lightModel, heavyModel };
}

export async function validateAgentModelPolicy(
  modelPolicy: Record<string, unknown> | null | undefined,
  deps?: LlmCatalogDeps,
): Promise<Array<{ code: 'custom'; path: string[]; message: string }>> {
  const selection = extractModelSelection(modelPolicy);
  if (!selection.provider) {
    return [];
  }

  const issues: Array<{ code: 'custom'; path: string[]; message: string }> = [];
  if (!selection.lightModel) {
    issues.push({ code: 'custom', path: ['lightModel'], message: 'Selected economy model is required when a provider is set' });
  }
  if (!selection.heavyModel) {
    issues.push({ code: 'custom', path: ['heavyModel'], message: 'Selected premium model is required when a provider is set' });
  }
  if (issues.length > 0) {
    return issues;
  }

  if (deps) {
    return validateAiModelSelection({ provider: selection.provider, lightModel: selection.lightModel!, heavyModel: selection.heavyModel! }, deps);
  }
  // No catalog deps — skip catalog validation
  return [];
}

export function extractSubmittedModelSelection(payload: {
  modelPolicy?: Record<string, unknown>;
  provider?: string | null;
  lightModel?: string | null;
  heavyModel?: string | null;
}): { provider: string | null; lightModel: string | null; heavyModel: string | null } {
  const modelPolicy = payload.modelPolicy ?? null;
  const provider = typeof payload.provider === 'string'
    ? payload.provider
    : typeof modelPolicy?.['provider'] === 'string'
      ? modelPolicy['provider']
      : null;
  const lightModel = typeof payload.lightModel === 'string'
    ? payload.lightModel
    : typeof modelPolicy?.['lightModel'] === 'string'
      ? modelPolicy['lightModel']
      : null;
  const heavyModel = typeof payload.heavyModel === 'string'
    ? payload.heavyModel
    : typeof modelPolicy?.['heavyModel'] === 'string'
      ? modelPolicy['heavyModel']
      : null;

  return { provider, lightModel, heavyModel };
}

export function hasModelFieldsWithoutProvider(payload: {
  modelPolicy?: Record<string, unknown>;
  provider?: string | null;
  lightModel?: string | null;
  heavyModel?: string | null;
}): boolean {
  const selection = extractSubmittedModelSelection(payload);
  return !selection.provider && (selection.lightModel !== null || selection.heavyModel !== null);
}

type NotificationPolicyInput = {
  sendMessage?: {
    email?: { enabled: boolean; source: 'explicit_prompt' | 'explicit_update' };
  };
} | null;

type StoredNotificationPolicy = {
  sendMessage?: {
    email?: { enabled: boolean; source: 'explicit_prompt' | 'explicit_update'; enabledAt?: string };
  };
} | null;

/**
 * Resolve the notification policy from a create/update input.
 * Writes `enabledAt` server-side when email is being enabled.
 */
export function resolveNotificationPolicy(
  input: NonNullable<NotificationPolicyInput>,
  current: StoredNotificationPolicy,
): StoredNotificationPolicy {
  const emailInput = input.sendMessage?.email;
  if (!emailInput) {
    return current ?? null;
  }

  const currentEnabledAt = current?.sendMessage?.email?.enabledAt;
  const wasEnabled = current?.sendMessage?.email?.enabled === true;

  // Write enabledAt only when transitioning from disabled → enabled
  const enabledAt = (emailInput.enabled && !wasEnabled)
    ? new Date().toISOString()
    : (emailInput.enabled && currentEnabledAt ? currentEnabledAt : undefined);

  return {
    sendMessage: {
      email: {
        enabled: emailInput.enabled,
        source: emailInput.source,
        ...(enabledAt ? { enabledAt } : {}),
      },
    },
  };
}

export function decorateAgentResponse<T extends { modelPolicy?: Record<string, unknown> | null; style?: string | null; runtimePolicyOverrides?: Record<string, unknown> | null; maxDrawdown?: unknown }>(agent: T): Omit<T, 'maxDrawdown'> & {
  provider: string | null;
  lightModel: string | null;
  heavyModel: string | null;
  costPreset: CostPreset | null;
  dailySpendBudgetUsd: number | null;
  dailyLlmTokenBudget: number | null;
  dexWatchlistSymbols: string[] | null;
  resolvedRuntimePolicy: Record<string, unknown> | null;
} {
  const modelPolicy = (agent.modelPolicy as Record<string, unknown> | null | undefined) ?? null;
  const result: Record<string, unknown> = {
    ...agent,
    provider: typeof modelPolicy?.['provider'] === 'string' ? modelPolicy['provider'] : null,
    lightModel: typeof modelPolicy?.['lightModel'] === 'string' ? modelPolicy['lightModel'] : null,
    heavyModel: typeof modelPolicy?.['heavyModel'] === 'string' ? modelPolicy['heavyModel'] : null,
    costPreset: typeof modelPolicy?.['costPreset'] === 'string' ? modelPolicy['costPreset'] as CostPreset : null,
    dailySpendBudgetUsd: typeof modelPolicy?.['dailySpendBudgetUsd'] === 'number' ? modelPolicy['dailySpendBudgetUsd'] : null,
    dailyLlmTokenBudget: null,
    dexWatchlistSymbols: Array.isArray(modelPolicy?.['dexWatchlistSymbols'])
      ? modelPolicy['dexWatchlistSymbols'].filter((value): value is string => typeof value === 'string')
      : null,
    resolvedRuntimePolicy: resolveAgentRuntimePolicy(
      agent.style ?? null,
      (agent.runtimePolicyOverrides ?? null) as Parameters<typeof resolveAgentRuntimePolicy>[1],
    ) as unknown as Record<string, unknown> | null,
  };
  delete result['maxDrawdown'];
  return result as Omit<T, 'maxDrawdown'> & {
    provider: string | null;
    lightModel: string | null;
    heavyModel: string | null;
    costPreset: CostPreset | null;
    dailySpendBudgetUsd: number | null;
    dailyLlmTokenBudget: number | null;
    dexWatchlistSymbols: string[] | null;
    resolvedRuntimePolicy: Record<string, unknown> | null;
  };
}

/**
 * Validate the invariant that resolved maxHoldDurationMs >= tickIntervalMs.
 * maxHoldDurationMs < tickIntervalMs is semantically meaningless — every tick
 * always finds the hold expired, so the hold backstop is a permanent no-op.
 *
 * Returns validation issues (empty array = valid).
 */
export function validateMaxHoldDurationInvariant(params: {
  tickIntervalMs: number | string | null | undefined;
  style: string | null | undefined;
  runtimePolicyOverrides: Record<string, unknown> | null | undefined;
}): Array<{ code: 'custom'; path: string[]; message: string }> {
  const tickMs = typeof params.tickIntervalMs === 'string'
    ? Number(params.tickIntervalMs)
    : (params.tickIntervalMs ?? null);
  if (tickMs == null || !Number.isFinite(tickMs) || tickMs <= 0) {
    return [];
  }

  const resolved = resolveAgentRuntimePolicy(
    params.style ?? null,
    (params.runtimePolicyOverrides ?? null) as Parameters<typeof resolveAgentRuntimePolicy>[1],
  );
  const maxHoldMs = resolved.maxHoldDurationMs;
  if (maxHoldMs === undefined || maxHoldMs === 0) {
    return [];
  }

  if (maxHoldMs < tickMs) {
    return [{
      code: 'custom',
      path: ['runtimePolicyOverrides', 'maxHoldDurationMs'],
      message: `maxHoldDurationMs (${maxHoldMs}ms) must be >= tickIntervalMs (${tickMs}ms). Set maxHoldDurationMs to at least the tick interval, or reduce tickIntervalMs.`,
    }];
  }

  return [];
}

/**
 * Validate that dailyLossLimit and maxDrawdownPct require capital.
 *
 * The risk gate enforces daily loss as a percentage of equity (dailyMaxLossPct)
 * and drawdown as a percentage of peak equity (maxDrawdownPct).
 * Without capital there is no equity baseline, so a configured limit
 * is silently ignored by the engine. Reject early to prevent that silent no-op.
 *
 * Returns validation issues (empty array = valid).
 */
export function validateDailyLossRequiresCapital(input: {
  dailyLossLimit?: string | null;
  maxDrawdownPct?: number | null;
  capital?: string | null;
}): Array<{ code: 'custom'; path: string[]; message: string }> {
  const issues: Array<{ code: 'custom'; path: string[]; message: string }> = [];

  if (
    input.dailyLossLimit != null &&
    input.dailyLossLimit !== '' &&
    (!input.capital || input.capital === '')
  ) {
    issues.push({
      code: 'custom',
      path: ['dailyLossLimit'],
      message: 'Capital must be set when dailyLossLimit is configured. Daily loss enforcement requires an equity baseline.',
    });
  }

  if (
    input.maxDrawdownPct != null &&
    input.maxDrawdownPct > 0 &&
    (!input.capital || input.capital === '')
  ) {
    issues.push({
      code: 'custom',
      path: ['maxDrawdownPct'],
      message: 'Capital must be set when maxDrawdownPct is configured. Drawdown enforcement requires an equity baseline.',
    });
  }

  return issues;
}

/**
 * Validate agent risk bounds against operator ceilings.
 * maxDrawdownPct is a numeric percentage (0–100).
 */
export function validateAgentRiskBounds(
  input: {
    maxOpenPositions?: number | null;
    maxPositionSizePct?: number | null;
    stopLossPct?: number | null;
    stopLossCooldownMs?: number | null;
    maxDrawdownPct?: number | null;
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

  if (input.maxDrawdownPct != null && input.maxDrawdownPct > defaults.maxDrawdownPct) {
    issues.push({
      code: 'custom',
      path: ['maxDrawdownPct'],
      message: `maxDrawdownPct cannot exceed the platform limit of ${defaults.maxDrawdownPct}%`,
    });
  }

  return issues;
}

/**
 * Resolve the agent's risk contract for API responses.
 * Shows per-field source, mutability, and effective values.
 */
export function resolveAgentRiskContractForResponse(
  agent: {
    capital?: string | number | null;
    maxOpenPositions?: number | null;
    maxPositionSizePct?: string | number | null;
    stopLossPct?: string | number | null;
    stopLossCooldownMs?: number | null;
    maxDrawdownPct?: string | number | null;
    riskOverrides?: AgentRiskOverrides | null;
  },
  agentRiskDefaults: AgentRiskDefaultsConfig,
): ResolvedAgentRiskContract {
  const ceilings: AgentRiskCeilings = {
    maxOpenPositions: agentRiskDefaults.maxOpenPositions,
    maxPositionSizePct: agentRiskDefaults.maxPositionSizePct,
    stopLossPct: agentRiskDefaults.stopLossMaxUnrealizedLossPct,
    stopLossCooldownMs: agentRiskDefaults.stopLossCooldownMs,
    maxDrawdownPct: agentRiskDefaults.maxDrawdownPct,
  };

  const creatorInput: AgentRiskCreatorInput = {
    maxOpenPositions: agent.maxOpenPositions ?? null,
    maxPositionSizePct: agent.maxPositionSizePct != null ? Number(agent.maxPositionSizePct) : null,
    stopLossPct: agent.stopLossPct != null ? Number(agent.stopLossPct) : null,
    stopLossCooldownMs: agent.stopLossCooldownMs ?? null,
    maxDrawdownPct: agent.maxDrawdownPct != null ? Number(agent.maxDrawdownPct) : null,
  };

  return resolveAgentRiskContract(creatorInput, ceilings, agent.riskOverrides ?? {}, {
    hasCapital: agent.capital != null,
  });
}