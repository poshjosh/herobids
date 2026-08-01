import type { ProviderSetupResult } from '../../lib/api-client.js';
import type { CapabilityMode, HybridMode } from './CapabilitySelector.js';
import type { TechnicalConfig } from './technical-config-helpers.js';
import type { RuntimePolicyOverrides } from './style-mapping.js';
import { parseTickIntervalMinutesInput } from './tick-interval.js';

const VALID_ESCALATION_POLICIES = ['never', 'uncovered_or_triggered', 'always'] as const;

export function normalizeEscalationPolicy(value: string | null | undefined): 'never' | 'uncovered_or_triggered' | 'always' | null {
  if (value === null || value === undefined || value === '') return null;
  if ((VALID_ESCALATION_POLICIES as readonly string[]).includes(value)) {
    return value as 'never' | 'uncovered_or_triggered' | 'always';
  }
  return null; // invalid values fall back to omission (let DB default handle it)
}

function getTickIntervalMsOrThrow(value: string): number | undefined {
  const parsedTickInterval = parseTickIntervalMinutesInput(value);
  if (parsedTickInterval.kind === 'empty') {
    return undefined;
  }

  if (parsedTickInterval.kind === 'invalid') {
    throw new Error('Invalid tick interval minutes input');
  }

  return parsedTickInterval.tickIntervalMs;
}

function parseCooldownMsOrNull(value: string): number | null {
  if (!value.trim()) {
    return null;
  }

  return Math.round(Number.parseFloat(value) * 1000);
}

function buildPlatformAssessmentPayload(enabled?: boolean, reviewIntervalHours?: string): { enabled?: boolean; reviewIntervalMs?: number } | null {
  if (!enabled) return null;
  const hours = parseInt(reviewIntervalHours ?? '', 10);
  const payload: { enabled: true; reviewIntervalMs?: number } = { enabled: true };
  if (!isNaN(hours) && hours > 0) {
    payload.reviewIntervalMs = hours * 3_600_000;
  }
  return payload;
}

type AgentNotificationPolicy = {
  sendMessage: {
    email: {
      enabled: boolean;
      source: 'explicit_update';
    };
  };
} | null;

/** Maps the tri-state UI selection to an API notificationPolicy value. */
function buildEmailDeliveryPolicy(emailDelivery: 'inherit' | 'allow' | 'disable' | undefined): AgentNotificationPolicy | undefined {
  if (emailDelivery === 'allow') {
    return { sendMessage: { email: { enabled: true, source: 'explicit_update' } } };
  }
  if (emailDelivery === 'disable') {
    return { sendMessage: { email: { enabled: false, source: 'explicit_update' } } };
  }
  // 'inherit' and undefined both mean no override — omit from create, undefined → null (same as inherit) on update
  return undefined;
}

export interface CreateAgentIntentPayloadInput {
  name: string;
  goal: string;
  capabilityMode: CapabilityMode;
  hybridMode: HybridMode;
  technicalPreFilterEnabled: boolean;
  technical: TechnicalConfig | null;
  skillIds: string[];
  hasBotManagementSkill: boolean;
  requiresTradingSetup: boolean;
  executionMode: 'test' | 'live';
  executionVenue?: string;
  connectionIds?: string[];
  modelPayload: {
    inherits: boolean;
    provider?: string | null;
    lightModel?: string | null;
    heavyModel?: string | null;
  };
  costPreset: '' | 'minimal' | 'standard' | 'premium' | 'custom';
  dailySpendBudgetUsd: string;
  telegramChatId: string;
  emailDelivery?: 'inherit' | 'allow' | 'disable';
  tickIntervalMins: string;
  capital: string;
  dailyMaxLossPct: string;
  maxDrawdownPct: string;
  maxSlippageBps: string;
  maxOpenPositions: string;
  maxPositionSizePct: string;
  stopLossPct: string;
  stopLossCooldownSecs: string;
  style?: string;
  strategyPreset?: string;
  /** When true, enable platform preset assessment for this agent. */
  platformAssessmentEnabled?: boolean;
  /** Review interval in hours: "12", "24", "48", "96", or empty string for unset. */
  platformAssessmentReviewIntervalHours?: string;
  openPositionEscalationToJudgePolicy?: 'never' | 'uncovered_or_triggered' | 'always';
  runtimePolicyOverrides?: RuntimePolicyOverrides;
  subscribedSources?: string[];
  /** Product preset identifier (trading, direct-trading, trading-assistant, etc.). */
  skillPresetId?: string;
  /** Authorization mode: 'direct' or 'approval_required'. Only meaningful for trading agents. */
  authorizationMode?: 'direct' | 'approval_required';
}

export interface UpdateAgentPayloadInput {
  name: string;
  prompt: string;
  capabilityMode: CapabilityMode;
  hybridMode: HybridMode;
  technicalPreFilterEnabled: boolean;
  technical: TechnicalConfig | null;
  skillIds: string[];
  hasBotManagementSkill: boolean;
  executionMode: string;
  hasTradingCapability: boolean;
  connectionIds?: string[];
  telegramChatId: string;
  emailDelivery: 'inherit' | 'allow' | 'disable';
  costPreset: '' | 'minimal' | 'standard' | 'premium' | 'custom';
  dailySpendBudgetUsd: string;
  dailyMaxLossPct: string;
  maxDrawdownPct: string;
  maxSlippageBps: string;
  maxOpenPositions: string;
  maxPositionSizePct: string;
  stopLossPct: string;
  stopLossCooldownSecs: string;
  tickIntervalMins: string;
  capital: string;
  openPositionEscalationToJudgePolicy?: 'never' | 'uncovered_or_triggered' | 'always' | null;
  modelOverrideEnabled: boolean;
  modelForm: {
    provider: string;
    lightModel: string;
    heavyModel: string;
  };
  preserveOriginalTickIntervalMs?: boolean;
  originalTickIntervalMs?: number | null;
  style?: string;
  strategyPreset?: string;
  /** When true, enable platform preset assessment for this agent. */
  platformAssessmentEnabled?: boolean;
  /** Review interval in hours: "12", "24", "48", "96", or empty string for unset. */
  platformAssessmentReviewIntervalHours?: string;
  runtimePolicyOverrides?: RuntimePolicyOverrides;
  subscribedSources?: string[];
  /** Product preset identifier (trading, direct-trading, trading-assistant, etc.). */
  skillPresetId?: string;
  /** Authorization mode: 'direct' or 'approval_required'. Only meaningful for trading agents. */
  authorizationMode?: 'direct' | 'approval_required';
}

export function buildCreateAgentPayload(input: CreateAgentIntentPayloadInput): {
  name: string;
  prompt: string;
  skillIds: string[];
  connectionIds?: string[];
  executionVenue?: string;
  provider?: string | null;
  lightModel?: string | null;
  heavyModel?: string | null;
  costPreset?: 'minimal' | 'standard' | 'premium' | 'custom';
  dailySpendBudgetUsd?: number;
  executionMode?: string;
  telegramChatId?: string;
  risk?: Record<string, unknown>;
  executionDefaults?: Record<string, unknown>;
  tickIntervalMs?: number;
  capital?: string;
  capabilityMode?: CapabilityMode;
  hybridMode?: HybridMode;
  technical?: TechnicalConfig;
  strategyPreset?: string;
  style?: string;
  openPositionEscalationToJudgePolicy?: 'never' | 'uncovered_or_triggered' | 'always' | null;
  runtimePolicyOverrides?: RuntimePolicyOverrides | null;
  wakePreferences?: { subscribedSources?: string[] } | null;
  notificationPolicy?: { sendMessage: { email: { enabled: boolean; source: 'explicit_update' } } } | null;
  platformAssessment?: { enabled?: boolean; reviewIntervalMs?: number };
  skillPresetId?: string;
  authorizationMode?: 'direct' | 'approval_required';
} {
  // Build canonical risk posture (WP4 shared value object)
  const risk: Record<string, unknown> = {};
  if (input.dailyMaxLossPct?.trim()) risk.dailyMaxLossPct = parseFloat(input.dailyMaxLossPct);
  if (input.maxDrawdownPct?.trim()) risk.maxDrawdownPct = parseFloat(input.maxDrawdownPct);
  if (input.maxOpenPositions) risk.maxOpenPositions = parseInt(input.maxOpenPositions, 10);
  if (input.maxPositionSizePct) risk.maxPositionSizePct = parseFloat(input.maxPositionSizePct);
  if (input.stopLossPct) risk.stopLossPct = parseFloat(input.stopLossPct);
  if (input.stopLossCooldownSecs) risk.stopLossCooldownMs = parseCooldownMsOrNull(input.stopLossCooldownSecs) ?? undefined;

  // Build canonical execution defaults (WP4 shared value object)
  const executionDefaults: Record<string, unknown> = {};
  if (input.requiresTradingSetup) executionDefaults.mode = input.executionMode;
  if (input.maxSlippageBps) executionDefaults.slippageBps = parseInt(input.maxSlippageBps, 10);

  const tickIntervalMs = getTickIntervalMsOrThrow(input.tickIntervalMins);
  const includeIntelligence = input.capabilityMode === 'intelligence' || input.capabilityMode === 'hybrid';
  const includeTechnical = input.technicalPreFilterEnabled;
  const includeAuthorizationMode = includeIntelligence && input.requiresTradingSetup;

  const subscribedSources = input.subscribedSources ?? [];
  const wakePreferences: { subscribedSources?: string[] } | undefined =
    subscribedSources.length > 0 ? { subscribedSources } : undefined;
  const emailDeliveryPolicy = buildEmailDeliveryPolicy(input.emailDelivery);
  const platformAssessment = buildPlatformAssessmentPayload(input.platformAssessmentEnabled, input.platformAssessmentReviewIntervalHours);

  return {
    name: input.name.trim(),
    prompt: includeIntelligence ? input.goal.trim() : '',
    skillIds: includeIntelligence ? [...input.skillIds] : [],
    ...((input.connectionIds ?? []).length > 0 ? { connectionIds: input.connectionIds } : {}),
    ...(input.executionVenue?.trim() ? { executionVenue: input.executionVenue.trim() } : {}),
    ...(input.requiresTradingSetup ? { executionMode: input.executionMode } : {}),
    ...(includeIntelligence && !input.modelPayload.inherits && input.modelPayload.provider ? {
      provider: input.modelPayload.provider,
      ...(input.modelPayload.lightModel ? { lightModel: input.modelPayload.lightModel } : {}),
      ...(input.modelPayload.heavyModel ? { heavyModel: input.modelPayload.heavyModel } : {}),
    } : {}),
    ...(input.costPreset ? { costPreset: input.costPreset } : {}),
    ...(input.dailySpendBudgetUsd ? { dailySpendBudgetUsd: parseFloat(input.dailySpendBudgetUsd) } : {}),
    ...(input.telegramChatId.trim() ? { telegramChatId: input.telegramChatId.trim() } : {}),
    ...(emailDeliveryPolicy !== undefined ? { notificationPolicy: emailDeliveryPolicy } : {}),
    ...(tickIntervalMs != null ? { tickIntervalMs } : {}),
    ...(input.capital.trim() ? { capital: input.capital.trim() } : {}),
    ...(Object.keys(risk).length > 0 ? { risk } : {}),
    ...(Object.keys(executionDefaults).length > 0 ? { executionDefaults } : {}),
    ...(input.style ? { style: input.style } : {}),
    ...(input.strategyPreset !== undefined ? { strategyPreset: input.strategyPreset } : {}),
    ...(normalizeEscalationPolicy(input.openPositionEscalationToJudgePolicy) ? { openPositionEscalationToJudgePolicy: normalizeEscalationPolicy(input.openPositionEscalationToJudgePolicy) } : {}),
    ...(input.runtimePolicyOverrides ? { runtimePolicyOverrides: input.runtimePolicyOverrides } : {}),
    ...(includeTechnical && input.technical ? { technical: input.technical } : {}),
    ...(wakePreferences ? { wakePreferences } : {}),
    capabilityMode: input.capabilityMode,
    ...(input.capabilityMode === 'hybrid' ? { hybridMode: input.hybridMode } : {}),
    ...(platformAssessment ? { platformAssessment } : {}),
    ...(input.skillPresetId ? { skillPresetId: input.skillPresetId } : {}),
    ...(includeAuthorizationMode && input.authorizationMode ? { authorizationMode: input.authorizationMode } : {}),
  };
}

export function resolveCreateAgentConnectionIds(connection: ProviderSetupResult['connection'] | null | undefined): string[] {
  return connection?.id ? [connection.id] : [];
}

export function buildUpdateAgentPayload(input: UpdateAgentPayloadInput): {
  name: string;
  prompt: string;
  skillIds: string[];
  connectionIds?: string[];
  executionMode: string | null;
  telegramChatId: string | null;
  costPreset: '' | 'minimal' | 'standard' | 'premium' | 'custom' | null;
  dailySpendBudgetUsd: number | null;
  risk?: Record<string, unknown> | null;
  executionDefaults?: Record<string, unknown> | null;
  tickIntervalMs: number | null;
  capital: string | null;
  provider: string | null;
  lightModel: string | null;
  heavyModel: string | null;
  capabilityMode?: CapabilityMode;
  hybridMode?: HybridMode | null;
  technical?: TechnicalConfig | null;
  strategyPreset?: string | null;
  openPositionEscalationToJudgePolicy?: 'never' | 'uncovered_or_triggered' | 'always' | null;
  style?: string | null;
  runtimePolicyOverrides?: RuntimePolicyOverrides | null;
  wakePreferences?: { subscribedSources?: string[] } | null;
  notificationPolicy?: { sendMessage: { email: { enabled: boolean; source: 'explicit_update' } } } | null;
  platformAssessment?: { enabled?: boolean; reviewIntervalMs?: number } | null;
  skillPresetId?: string | null;
  authorizationMode?: 'direct' | 'approval_required' | null;
} {
  // Build canonical risk posture (WP4 shared value object)
  const risk: Record<string, unknown> = {};
  if (input.dailyMaxLossPct?.trim()) risk.dailyMaxLossPct = parseFloat(input.dailyMaxLossPct);
  else risk.dailyMaxLossPct = null; // Explicit clear when empty
  if (input.maxDrawdownPct?.trim()) risk.maxDrawdownPct = parseFloat(input.maxDrawdownPct);
  else risk.maxDrawdownPct = null;
  if (input.maxOpenPositions) risk.maxOpenPositions = parseInt(input.maxOpenPositions, 10);
  else risk.maxOpenPositions = null;
  if (input.maxPositionSizePct) risk.maxPositionSizePct = parseFloat(input.maxPositionSizePct);
  else risk.maxPositionSizePct = null;
  if (input.stopLossPct) risk.stopLossPct = parseFloat(input.stopLossPct);
  else risk.stopLossPct = null;
  risk.stopLossCooldownMs = parseCooldownMsOrNull(input.stopLossCooldownSecs);

  // Build canonical execution defaults (WP4 shared value object)
  const executionDefaults: Record<string, unknown> = {
    mode: includeIntelligence && input.hasTradingCapability ? (input.executionMode || null) : null,
  };
  if (input.maxSlippageBps) executionDefaults.slippageBps = parseInt(input.maxSlippageBps, 10);
  else executionDefaults.slippageBps = null;

  const parsedTickInterval = input.preserveOriginalTickIntervalMs
    ? undefined
    : getTickIntervalMsOrThrow(input.tickIntervalMins);
  const tickIntervalMs = input.preserveOriginalTickIntervalMs
    ? (input.originalTickIntervalMs ?? null)
    : parsedTickInterval ?? null;

  const includeIntelligence = input.capabilityMode === 'intelligence' || input.capabilityMode === 'hybrid';
  const includeTechnical = input.technicalPreFilterEnabled;
  const includeAuthorizationMode = includeIntelligence && input.hasTradingCapability;

  // Resolve wakePreferences for update:
  // - subscribedSources provided with items → send wakePreferences with those sources
  // - subscribedSources explicitly empty (user cleared all) → send default watch_threshold
  // - subscribedSources not provided at all → omit wakePreferences (don't touch)
  const wakePreferences = input.subscribedSources !== undefined
    ? (input.subscribedSources.length > 0 ? { subscribedSources: input.subscribedSources } : { subscribedSources: ['watch_threshold'] })
    : undefined;
  const emailDeliveryPolicy = buildEmailDeliveryPolicy(input.emailDelivery);

  return {
    name: input.name.trim(),
    ...(includeIntelligence ? { prompt: input.prompt.trim() } : { prompt: '' }),
    skillIds: includeIntelligence ? [...input.skillIds] : [],
    ...(input.connectionIds !== undefined ? { connectionIds: input.connectionIds } : {}),
    executionMode: includeIntelligence && input.hasTradingCapability ? (input.executionMode || null) : null,
    telegramChatId: input.telegramChatId.trim() || null,
    costPreset: input.costPreset || null,
    dailySpendBudgetUsd: input.dailySpendBudgetUsd ? parseFloat(input.dailySpendBudgetUsd) : null,
    risk,
    executionDefaults,
    tickIntervalMs,
    capital: input.capital.trim() || null,
    ...(normalizeEscalationPolicy(input.openPositionEscalationToJudgePolicy) ? { openPositionEscalationToJudgePolicy: normalizeEscalationPolicy(input.openPositionEscalationToJudgePolicy) } : {}),
    provider: includeIntelligence && input.modelOverrideEnabled ? input.modelForm.provider || null : null,
    lightModel: includeIntelligence && input.modelOverrideEnabled ? input.modelForm.lightModel || null : null,
    heavyModel: includeIntelligence && input.modelOverrideEnabled ? input.modelForm.heavyModel || null : null,
    // Send technical: null to explicitly remove it when switching away from technical mode
    ...(includeTechnical ? { technical: input.technical } : { technical: null }),
    ...(input.style ? { style: input.style } : {}),
    ...(input.strategyPreset !== undefined ? { strategyPreset: input.strategyPreset } : {}),
    ...(input.runtimePolicyOverrides ? { runtimePolicyOverrides: input.runtimePolicyOverrides } : {}),
    ...(wakePreferences !== undefined ? { wakePreferences } : {}),
    // 'inherit' → send null to clear any existing override; allow/disable → send explicit policy; undefined → null (same as inherit)
    notificationPolicy: emailDeliveryPolicy ?? null,
    capabilityMode: input.capabilityMode,
    hybridMode: input.capabilityMode === 'hybrid' ? input.hybridMode : null,
    platformAssessment: buildPlatformAssessmentPayload(input.platformAssessmentEnabled, input.platformAssessmentReviewIntervalHours),
    ...(input.skillPresetId !== undefined ? { skillPresetId: input.skillPresetId } : {}),
    ...(includeAuthorizationMode && input.authorizationMode !== undefined ? { authorizationMode: input.authorizationMode } : {}),
  };
}
