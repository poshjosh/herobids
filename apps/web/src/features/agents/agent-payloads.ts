import type { ProviderSetupResult } from '../../lib/api-client.js';

export interface CreateAgentIntentPayloadInput {
  name: string;
  goal: string;
  skillIds: string[];
  requiresTradingSetup: boolean;
  executionMode: 'paper' | 'shadow' | 'live';
  modelPayload: {
    inherits: boolean;
    provider?: string | null;
    lightModel?: string | null;
    heavyModel?: string | null;
  };
  costPreset: '' | 'minimal' | 'standard' | 'premium' | 'custom';
  dailySpendBudgetUsd: string;
  telegramChatId: string;
  tickIntervalMs: string;
  maxBots: string;
  capital: string;
  dailyLossLimit: string;
  maxSlippageBps: string;
}

export interface UpdateAgentPayloadInput {
  name: string;
  prompt: string;
  skillIds: string[];
  executionMode: string;
  hasTradingCapability: boolean;
  telegramChatId: string;
  costPreset: '' | 'minimal' | 'standard' | 'premium' | 'custom';
  dailySpendBudgetUsd: string;
  dailyLossLimit: string;
  maxBots: string;
  maxSlippageBps: string;
  tickIntervalMs: string;
  capital: string;
  modelOverrideEnabled: boolean;
  modelForm: {
    provider: string;
    lightModel: string;
    heavyModel: string;
  };
}

export function buildCreateAgentPayload(input: CreateAgentIntentPayloadInput): {
  name: string;
  prompt: string;
  skillIds: string[];
  provider?: string | null;
  lightModel?: string | null;
  heavyModel?: string | null;
  costPreset?: 'minimal' | 'standard' | 'premium' | 'custom';
  dailySpendBudgetUsd?: number;
  executionMode?: string;
  telegramChatId?: string;
  dailyLossLimit?: string;
  maxBots?: number;
  maxSlippageBps?: number;
  tickIntervalMs?: number;
  capital?: string;
} {
  return {
    name: input.name.trim(),
    prompt: input.goal.trim(),
    skillIds: [...input.skillIds],
    ...(input.requiresTradingSetup ? { executionMode: input.executionMode } : {}),
    ...(!input.modelPayload.inherits && input.modelPayload.provider ? {
      provider: input.modelPayload.provider,
      ...(input.modelPayload.lightModel ? { lightModel: input.modelPayload.lightModel } : {}),
      ...(input.modelPayload.heavyModel ? { heavyModel: input.modelPayload.heavyModel } : {}),
    } : {}),
    ...(input.costPreset ? { costPreset: input.costPreset } : {}),
    ...(input.dailySpendBudgetUsd ? { dailySpendBudgetUsd: parseFloat(input.dailySpendBudgetUsd) } : {}),
    ...(input.telegramChatId.trim() ? { telegramChatId: input.telegramChatId.trim() } : {}),
    ...(input.tickIntervalMs ? { tickIntervalMs: parseInt(input.tickIntervalMs, 10) } : {}),
    ...(input.maxBots ? { maxBots: parseInt(input.maxBots, 10) } : {}),
    ...(input.capital.trim() ? { capital: input.capital.trim() } : {}),
    ...(input.dailyLossLimit.trim() ? { dailyLossLimit: input.dailyLossLimit.trim() } : {}),
    ...(input.maxSlippageBps ? { maxSlippageBps: parseInt(input.maxSlippageBps, 10) } : {}),
  };
}

export function resolveCreateAgentBindingId(binding: ProviderSetupResult['tradingBinding'] | null | undefined): string | null {
  return binding?.id ?? null;
}

export function buildUpdateAgentPayload(input: UpdateAgentPayloadInput): {
  name: string;
  prompt: string;
  skillIds: string[];
  executionMode: string | null;
  telegramChatId: string | null;
  costPreset: '' | 'minimal' | 'standard' | 'premium' | 'custom' | null;
  dailySpendBudgetUsd: number | null;
  dailyLossLimit: string | null;
  maxBots: number | null;
  maxSlippageBps: number | null;
  tickIntervalMs: number | null;
  capital: string | null;
  provider: string | null;
  lightModel: string | null;
  heavyModel: string | null;
} {
  return {
    name: input.name.trim(),
    prompt: input.prompt.trim(),
    skillIds: [...input.skillIds],
    executionMode: input.hasTradingCapability ? (input.executionMode || null) : null,
    telegramChatId: input.telegramChatId.trim() || null,
    costPreset: input.costPreset || null,
    dailySpendBudgetUsd: input.dailySpendBudgetUsd ? parseFloat(input.dailySpendBudgetUsd) : null,
    dailyLossLimit: input.dailyLossLimit.trim() || null,
    maxBots: input.maxBots ? parseInt(input.maxBots, 10) : null,
    maxSlippageBps: input.maxSlippageBps ? parseInt(input.maxSlippageBps, 10) : null,
    tickIntervalMs: input.tickIntervalMs ? parseInt(input.tickIntervalMs, 10) : null,
    capital: input.capital.trim() || null,
    provider: input.modelOverrideEnabled ? input.modelForm.provider || null : null,
    lightModel: input.modelOverrideEnabled ? input.modelForm.lightModel || null : null,
    heavyModel: input.modelOverrideEnabled ? input.modelForm.heavyModel || null : null,
  };
}