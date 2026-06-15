import { z } from 'zod';
import { Decimal, SYSTEM_SKILLS, validateLlmModelSelection, resolveAgentRiskContract, type AgentRiskCeilings, type AgentRiskCreatorInput, type AgentRiskOverrides, type ResolvedAgentRiskContract, type AgentRiskDefaultsConfig } from '@herobids/domain';
import type { OperatorLlmCatalogContext } from '../llm-model-catalog.js';
import { validateAiModelSelection, normalizeAgentModelPolicy } from '../llm-model-catalog.js';

const CAPABILITY_FAMILIES_BY_SKILL_ID = new Map(SYSTEM_SKILLS.map((skill) => [skill.id, skill.capabilityFamilies] as const));

const AGENT_EXECUTION_MODES = new Set(['paper', 'shadow', 'live'] as const);

type AgentExecutionMode = 'paper' | 'shadow' | 'live';
type NullableAgentExecutionMode = AgentExecutionMode | null | undefined;

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

export function resolveDailyLlmTokenBudget(payload: {
  dailyTokenBudget?: number | null;
  dailyLlmTokenBudget?: number | null;
}): { value: number | null | undefined; issue?: { code: 'custom'; path: string[]; message: string } } {
  if (
    payload.dailyTokenBudget !== undefined &&
    payload.dailyLlmTokenBudget !== undefined &&
    payload.dailyTokenBudget !== payload.dailyLlmTokenBudget
  ) {
    return {
      value: undefined,
      issue: {
        code: 'custom',
        path: ['dailyLlmTokenBudget'],
        message: 'dailyLlmTokenBudget and dailyTokenBudget must match when both are provided',
      },
    };
  }

  return {
    value: payload.dailyLlmTokenBudget ?? payload.dailyTokenBudget,
  };
}

export function hasSkillCapabilityFamily(skillIds: string[] | null | undefined, capabilityFamily: string): boolean {
  return (skillIds ?? []).some((skillId) => CAPABILITY_FAMILIES_BY_SKILL_ID.get(skillId)?.includes(capabilityFamily));
}

function normalizeExecutionMode(value: string | null | undefined): NullableAgentExecutionMode {
  if (value == null) {
    return value;
  }

  return AGENT_EXECUTION_MODES.has(value as AgentExecutionMode) ? value as AgentExecutionMode : null;
}

export function resolveExecutionModeForSkills(input: {
  skillIds: string[] | null | undefined;
  submittedExecutionMode: NullableAgentExecutionMode;
  executionModeProvided: boolean;
  currentExecutionMode?: string | null;
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

  if (input.executionModeProvided) {
    const resolved = normalizeExecutionMode(input.submittedExecutionMode);
    if (resolved == null) {
      return {
        value: null,
        issue: {
          code: 'custom',
          path: ['executionMode'],
          message: 'executionMode must be explicitly set for agents with trading skills (paper, shadow, or live)',
        },
      };
    }
    return { value: resolved };
  }

  // Carry forward existing mode when not provided in the update
  const existing = normalizeExecutionMode(input.currentExecutionMode);
  if (existing != null) {
    return { value: existing };
  }

  // No existing mode and none provided — default to paper for backward compat during creation
  return { value: 'paper' };
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
  context?: OperatorLlmCatalogContext,
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

  if (context) {
    return validateAiModelSelection({ provider: selection.provider, lightModel: selection.lightModel!, heavyModel: selection.heavyModel! }, context);
  }
  // No catalog context — fall back to static domain validation
  return validateLlmModelSelection({ provider: selection.provider, lightModel: selection.lightModel!, heavyModel: selection.heavyModel! });
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

export function decorateAgentResponse<T extends { modelPolicy?: Record<string, unknown> | null; dailyTokenBudget?: number | null }>(agent: T): T & {
  provider: string | null;
  lightModel: string | null;
  heavyModel: string | null;
  costPreset: CostPreset | null;
  dailySpendBudgetUsd: number | null;
  dailyLlmTokenBudget: number | null;
  dexWatchlistSymbols: string[] | null;
} {
  const modelPolicy = (agent.modelPolicy as Record<string, unknown> | null | undefined) ?? null;
  return {
    ...agent,
    provider: typeof modelPolicy?.['provider'] === 'string' ? modelPolicy['provider'] : null,
    lightModel: typeof modelPolicy?.['lightModel'] === 'string' ? modelPolicy['lightModel'] : null,
    heavyModel: typeof modelPolicy?.['heavyModel'] === 'string' ? modelPolicy['heavyModel'] : null,
    costPreset: typeof modelPolicy?.['costPreset'] === 'string' ? modelPolicy['costPreset'] as CostPreset : null,
    dailySpendBudgetUsd: typeof modelPolicy?.['dailySpendBudgetUsd'] === 'number' ? modelPolicy['dailySpendBudgetUsd'] : null,
    dailyLlmTokenBudget: typeof agent.dailyTokenBudget === 'number' ? agent.dailyTokenBudget : null,
    dexWatchlistSymbols: Array.isArray(modelPolicy?.['dexWatchlistSymbols'])
      ? modelPolicy['dexWatchlistSymbols'].filter((value): value is string => typeof value === 'string')
      : null,
  };
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
    riskOverrides?: AgentRiskOverrides | null;
  },
  agentRiskDefaults: AgentRiskDefaultsConfig,
): ResolvedAgentRiskContract {
  const ceilings: AgentRiskCeilings = {
    maxOpenPositions: agentRiskDefaults.maxOpenPositions,
    maxPositionSizePct: agentRiskDefaults.maxPositionSizePct,
    stopLossPct: agentRiskDefaults.stopLossMaxUnrealizedLossPct,
    stopLossCooldownMs: agentRiskDefaults.stopLossCooldownMs,
  };

  const creatorInput: AgentRiskCreatorInput = {
    maxOpenPositions: agent.maxOpenPositions ?? null,
    maxPositionSizePct: agent.maxPositionSizePct != null ? Number(agent.maxPositionSizePct) : null,
    stopLossPct: agent.stopLossPct != null ? Number(agent.stopLossPct) : null,
    stopLossCooldownMs: agent.stopLossCooldownMs ?? null,
  };

  return resolveAgentRiskContract(creatorInput, ceilings, agent.riskOverrides ?? {}, {
    hasCapital: agent.capital != null,
  });
}