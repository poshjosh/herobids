export interface UserModelDefaults {
  provider: string | null;
  lightModel: string | null;
  heavyModel: string | null;
}

import type { ModelDefaults } from './config/schema.js';

/** Re-exported from the config schema so callers don't need a separate import. */
export type { ModelDefaults as OperatorModelDefaults } from './config/schema.js';

type OperatorModelDefaults = ModelDefaults;

export interface AgentLlmSelectionInput {
  provider?: string;
  lightModel?: string;
  heavyModel?: string;
  userModelDefaults?: UserModelDefaults | null;
  operatorModelDefaults?: OperatorModelDefaults | null;
}

export interface ResolvedLlmSelection {
  provider: string | null;
  lightModel: string | null;
  heavyModel: string | null;
}

function getNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function resolveEffectiveLlmSelection(input: {
  agentConfig: AgentLlmSelectionInput;
}): ResolvedLlmSelection {
  const userModelDefaults = input.agentConfig.userModelDefaults ?? null;
  const operatorModelDefaults = input.agentConfig.operatorModelDefaults ?? null;
  const resolvedProvider = getNonEmptyString(input.agentConfig.provider)
    ?? getNonEmptyString(userModelDefaults?.provider)
    ?? getNonEmptyString(operatorModelDefaults?.provider);
  const resolvedHeavyModel = getNonEmptyString(input.agentConfig.heavyModel)
    ?? getNonEmptyString(userModelDefaults?.heavyModel)
    ?? getNonEmptyString(operatorModelDefaults?.heavyModel);
  const resolvedLightModel = getNonEmptyString(input.agentConfig.lightModel)
    ?? getNonEmptyString(userModelDefaults?.lightModel)
    ?? getNonEmptyString(operatorModelDefaults?.lightModel);

  return {
    provider: resolvedProvider,
    lightModel: resolvedLightModel,
    heavyModel: resolvedHeavyModel,
  };
}
