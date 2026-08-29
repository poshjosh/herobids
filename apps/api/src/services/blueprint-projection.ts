import type { AgentBlueprintRevisionPayload, BotBlueprintRevisionPayload } from '@herobids/domain';

/**
 * Project an agent row into an AgentBlueprintRevisionPayload.
 *
 * Strips ALL instance-only fields per the 007 field classification manifest:
 *   - id, userId, status, pauseState, telegramChatId, notificationPolicy,
 *     riskOverrides, blueprintId, blueprintRevisionId, createdAt, updatedAt
 *   - agent_connections (private bindings)
 *   - runtime-derived state
 *   - unifiedConfig runtime self-adjustments (not separately stored — the whole
 *     unifiedConfig column is authored recipe post-harmonization per 007)
 *
 * Template-eligible fields are copied as-is.
 */
export function projectAgentToBlueprintPayload(agent: {
  name: string;
  style: string | null;
  prompt: string;
  runtimePolicyOverrides: unknown;
  toolPolicy: unknown;
  modelPolicy: unknown;
  strategy: unknown;
  risk: unknown;
  executionDefaults: unknown;
  unifiedConfig: unknown;
  wakePreferences: unknown;
  openPositionEscalationToJudgePolicy: string;
  capital: string | null;
  maxBots: number | null;
  tickIntervalMs: number | null;
}): AgentBlueprintRevisionPayload {
  const uc = (agent.unifiedConfig as Record<string, unknown> | null) ?? {};

  return {
    kind: 'agent',
    name: agent.name,
    description: '', // agents don't have a description field; default to empty
    tags: [],        // agents don't have tags; default to empty
    prompt: agent.prompt,
    style: (agent.style as AgentBlueprintRevisionPayload['style']) ?? null,
    strategy: (agent.strategy as AgentBlueprintRevisionPayload['strategy']) ?? null,
    risk: (agent.risk as AgentBlueprintRevisionPayload['risk']) ?? null,
    executionDefaults: (agent.executionDefaults as AgentBlueprintRevisionPayload['executionDefaults']) ?? null,
    technical: (uc.technical as AgentBlueprintRevisionPayload['technical']) ?? undefined,
    intelligence: (uc.intelligence as AgentBlueprintRevisionPayload['intelligence']) ?? undefined,
    capabilityMode: (uc.capabilityMode as AgentBlueprintRevisionPayload['capabilityMode']) ?? 'intelligence',
    hybridMode: (uc.hybridMode as AgentBlueprintRevisionPayload['hybridMode']) ?? undefined,
    executionPolicy: (uc.execution as AgentBlueprintRevisionPayload['executionPolicy']) ?? (uc.executionPolicy as AgentBlueprintRevisionPayload['executionPolicy']) ?? undefined,
    runtimePolicyOverrides: (agent.runtimePolicyOverrides as AgentBlueprintRevisionPayload['runtimePolicyOverrides']) ?? undefined,
    toolPolicy: (agent.toolPolicy as AgentBlueprintRevisionPayload['toolPolicy']) ?? undefined,
    modelPolicy: (agent.modelPolicy as AgentBlueprintRevisionPayload['modelPolicy']) ?? undefined,
    allowedPresets: (uc.allowedPresets as AgentBlueprintRevisionPayload['allowedPresets']) ?? undefined,
    presetTransition: (uc.presetTransition as AgentBlueprintRevisionPayload['presetTransition']) ?? undefined,
    platformAssessment: (uc.platformAssessment as AgentBlueprintRevisionPayload['platformAssessment']) ?? undefined,
    authorizationMode: (uc.authorizationMode as AgentBlueprintRevisionPayload['authorizationMode']) ?? null,
    wakePreferences: (agent.wakePreferences as AgentBlueprintRevisionPayload['wakePreferences']) ?? undefined,
    openPositionEscalationToJudgePolicy: (agent.openPositionEscalationToJudgePolicy as AgentBlueprintRevisionPayload['openPositionEscalationToJudgePolicy']) ?? 'uncovered_or_triggered',
    capital: agent.capital !== null ? Number(agent.capital) : null,
    maxBots: agent.maxBots,
    tickIntervalMs: agent.tickIntervalMs,
  };
}

/**
 * Project a bot row into a BotBlueprintRevisionPayload.
 *
 * Instance-only fields (venueAccountId, connectionId, status, etc.) are stripped.
 * Only the authored recipe inside `config` is projected.
 */
export function projectBotToBlueprintPayload(bot: {
  name: string;
  config: Record<string, unknown>;
}): BotBlueprintRevisionPayload {
  const c = bot.config;
  return {
    kind: 'bot',
    name: bot.name,
    description: (c.description as string) ?? '',
    tags: (c.tags as string[]) ?? [],
    strategy: c.strategy as BotBlueprintRevisionPayload['strategy'],
    risk: c.risk as BotBlueprintRevisionPayload['risk'],
    executionDefaults: c.execution as BotBlueprintRevisionPayload['executionDefaults'],
    tokenSafety: c.tokenSafety as BotBlueprintRevisionPayload['tokenSafety'],
    venue: (c.venue as string) ?? '',
    venueType: (c.venueType as BotBlueprintRevisionPayload['venueType']) ?? 'orderbook',
    symbol: (c.symbol as string) ?? '',
    swapAssets: c.swapAssets as BotBlueprintRevisionPayload['swapAssets'],
    shadowPollIntervalMs: (c.shadowPollIntervalMs as number) ?? 2000,
  };
}
