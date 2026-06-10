import { resolveDefaultScoutModel } from './scout-dispatch.js';

export interface UserModelDefaults {
  provider: string | null;
  lightModel: string | null;
  heavyModel: string | null;
}

export interface AgentLlmSelectionInput {
  provider?: string;
  lightModel?: string;
  heavyModel?: string;
  userModelDefaults?: UserModelDefaults | null;
}

export interface ResolvedLlmSelection {
  provider: string;
  lightModel: string;
  heavyModel: string;
}

function getNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function resolveEffectiveLlmSelection(input: {
  agentConfig: AgentLlmSelectionInput;
  operatorProvider: string;
  operatorHeavyModel: string;
  defaultScoutModels: { anthropic: string; openai: string; openrouter: string };
}): ResolvedLlmSelection {
  const userModelDefaults = input.agentConfig.userModelDefaults ?? null;
  const resolvedProvider = getNonEmptyString(input.agentConfig.provider)
    ?? getNonEmptyString(userModelDefaults?.provider)
    ?? input.operatorProvider;
  const resolvedHeavyModel = getNonEmptyString(input.agentConfig.heavyModel)
    ?? getNonEmptyString(userModelDefaults?.heavyModel)
    ?? input.operatorHeavyModel;
  const resolvedLightModel = getNonEmptyString(input.agentConfig.lightModel)
    ?? getNonEmptyString(userModelDefaults?.lightModel)
    ?? resolveDefaultScoutModel(resolvedProvider, resolvedHeavyModel, input.defaultScoutModels);

  return {
    provider: resolvedProvider,
    lightModel: resolvedLightModel,
    heavyModel: resolvedHeavyModel,
  };
}