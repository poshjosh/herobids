import { z } from 'zod';
import { Decimal } from '@herobids/domain';
import { validateAiModelSelection, normalizeAgentModelPolicy } from '../llm-model-catalog.js';

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

export function validateAgentModelPolicy(
  modelPolicy: Record<string, unknown> | null | undefined,
  operatorProvider?: string,
): Array<{ code: 'custom'; path: string[]; message: string }> {
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

  return validateAiModelSelection({ provider: selection.provider, lightModel: selection.lightModel!, heavyModel: selection.heavyModel! }, operatorProvider);
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