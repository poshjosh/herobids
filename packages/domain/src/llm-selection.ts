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
  const resolvedProvider = getNonEmptyString(input.agentConfig.provider)
    ?? getNonEmptyString(userModelDefaults?.provider);
  const resolvedHeavyModel = getNonEmptyString(input.agentConfig.heavyModel)
    ?? getNonEmptyString(userModelDefaults?.heavyModel);
  const resolvedLightModel = getNonEmptyString(input.agentConfig.lightModel)
    ?? getNonEmptyString(userModelDefaults?.lightModel);

  return {
    provider: resolvedProvider,
    lightModel: resolvedLightModel,
    heavyModel: resolvedHeavyModel,
  };
}
