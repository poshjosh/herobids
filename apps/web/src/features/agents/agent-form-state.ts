import type { CapabilityMode, HybridMode } from './CapabilitySelector.js';
import type { TechnicalConfigFormState } from './technical-config-helpers.js';
import type { Agent } from '../../lib/api-client.js';
import { extractAgentObjective } from './agent-display.js';
import { formatTickIntervalMinutesForInput } from './tick-interval.js';
import { defaultTechnicalConfigFormState, technicalConfigToFormState } from './technical-config-helpers.js';

// ---------------------------------------------------------------------------
// Unified form state
// ---------------------------------------------------------------------------

export interface AgentFormState {
  // Identity
  name: string;
  goal: string;

  // Capability
  capabilityMode: CapabilityMode;
  hybridMode?: HybridMode;
  /** true = scanner pre-filters trade candidates before LLM decides (hybrid mode). Only applies to trading agents. */
  technicalPreFilterEnabled: boolean;
  technicalConfig: TechnicalConfigFormState;

  // Skills
  skillIds: string[];

  // Connections
  connectionIds?: string[];

  // Trading setup
  executionMode: 'test' | 'live' | '';
  capital: string;

  // Notifications
  telegramChatId: string;
  /** Tri-state email delivery override: inherit account default, always allow, or always disable. */
  emailDelivery: 'inherit' | 'allow' | 'disable';

  // AI cost controls
  costPreset: '' | 'minimal' | 'standard' | 'premium' | 'custom';
  dailySpendBudgetUsd: string;
  tickIntervalMins: string;

  // Trading guardrails
  dailyMaxLossPct: string;
  maxDrawdownPct: string;
  maxSlippageBps: string;
  maxOpenPositions: string;
  maxPositionSizePct: string;
  stopLossPct: string;
  stopLossCooldownSecs: string;
  openPositionEscalationToJudgePolicy: 'never' | 'uncovered_or_triggered' | 'always';

  // Style-based strategy preset
  strategyPreset: string;

  // Platform preset assessment (scanner_gated agents only)
  platformAssessmentEnabled: boolean;
  /** Review interval in hours: one of "12", "24", "48", "96", or "" (unset). */
  platformAssessmentReviewIntervalHours: string;

  // Wake source subscriptions (empty = all sources)
  subscribedSources: string[];

  /** Files selected in the document picker, pending upload after agent creation. */
  pendingFiles: File[];

  /** Authorization mode: 'direct' | 'approval_required'. Only meaningful for trading agents. */
  authorizationMode: 'direct' | 'approval_required';
}

// ---------------------------------------------------------------------------
// agentToFormState
// ---------------------------------------------------------------------------

/**
 * Converts an API Agent object to unified AgentFormState.
 * Derives capability mode from technical config + objective presence.
 * Converts all numerics to strings for controlled form inputs.
 */
export function agentToFormState(agent: Agent): AgentFormState {
  const goal = extractAgentObjective(agent.prompt);
  // Read persisted capabilityMode from agent config when available (004-hybrid-mode-split).
  // Fall back to derivation from technical config + goal for backward compatibility
  // with agents created before the capabilityMode field was introduced.
  const capabilityMode: CapabilityMode = (
    agent.capabilityMode === 'intelligence' || agent.capabilityMode === 'hybrid'
  ) ? agent.capabilityMode as CapabilityMode
    : agent.technical
      ? 'hybrid'
      : 'intelligence';
  const hybridMode: HybridMode | undefined = (
    agent.hybridMode === 'mixed' || agent.hybridMode === 'scanner_gated'
  ) ? agent.hybridMode
    : capabilityMode === 'hybrid' ? 'scanner_gated' : undefined;

  // Map stored concrete modes back to the user-facing abstraction.
  // The DB stores paper, shadow, or live; the form state only knows test and live.
  // Read from agent.executionDefaults JSONB (canonical).
  const rawExecutionMode = (agent.executionDefaults as Record<string, unknown> | null)?.mode as string | undefined;
  const executionMode: AgentFormState['executionMode'] =
    rawExecutionMode === 'paper' || rawExecutionMode === 'shadow'
      ? 'test'
      : rawExecutionMode === 'live'
        ? 'live'
        : '';

  const VALID_COST_PRESETS = ['', 'minimal', 'standard', 'premium', 'custom'] as const;
  const rawCostPreset = agent.costPreset;
  const costPreset: AgentFormState['costPreset'] =
    typeof rawCostPreset === 'string' &&
    (VALID_COST_PRESETS as readonly string[]).includes(rawCostPreset)
      ? (rawCostPreset as AgentFormState['costPreset'])
      : '';

  const VALID_ESCALATION_POLICIES = ['never', 'uncovered_or_triggered', 'always'] as const;
  const rawPolicy = agent.openPositionEscalationToJudgePolicy;
  const openPositionEscalationToJudgePolicy: AgentFormState['openPositionEscalationToJudgePolicy'] =
    typeof rawPolicy === 'string' &&
    (VALID_ESCALATION_POLICIES as readonly string[]).includes(rawPolicy)
      ? (rawPolicy as AgentFormState['openPositionEscalationToJudgePolicy'])
      : 'uncovered_or_triggered';

  return {
    name: agent.name,
    goal,
    capabilityMode,
    hybridMode,
    technicalPreFilterEnabled: agent.technical != null,
    technicalConfig: agent.technical
      ? technicalConfigToFormState(agent.technical)
      : defaultTechnicalConfigFormState(),
    skillIds: agent.skillIds ?? [],
    connectionIds: [],
    executionMode,
    capital: agent.capital ?? '',
    telegramChatId: agent.telegramChatId ?? '',
    emailDelivery: agent.notificationPolicy?.sendMessage?.email != null
      ? (agent.notificationPolicy.sendMessage.email.enabled ? 'allow' : 'disable')
      : 'inherit',
    costPreset,
    dailySpendBudgetUsd:
      agent.dailySpendBudgetUsd != null ? String(agent.dailySpendBudgetUsd) : '',
    tickIntervalMins: formatTickIntervalMinutesForInput(agent.tickIntervalMs),
    // Read from agent.risk JSONB (canonical)
    dailyMaxLossPct: (agent.risk as Record<string, unknown> | null)?.dailyMaxLossPct != null ? String((agent.risk as Record<string, unknown> | null)!.dailyMaxLossPct) : '',
    maxDrawdownPct: (agent.risk as Record<string, unknown> | null)?.maxDrawdownPct != null ? String((agent.risk as Record<string, unknown> | null)!.maxDrawdownPct) : '',
    maxSlippageBps:
      (agent.executionDefaults as Record<string, unknown> | null)?.slippageBps != null ? String((agent.executionDefaults as Record<string, unknown> | null)!.slippageBps) : '',
    maxOpenPositions:
      (agent.risk as Record<string, unknown> | null)?.maxOpenPositions != null ? String((agent.risk as Record<string, unknown> | null)!.maxOpenPositions) : '',
    maxPositionSizePct: (agent.risk as Record<string, unknown> | null)?.maxPositionSizePct != null ? String((agent.risk as Record<string, unknown> | null)!.maxPositionSizePct) : '',
    stopLossPct: (agent.risk as Record<string, unknown> | null)?.stopLossPct != null ? String((agent.risk as Record<string, unknown> | null)!.stopLossPct) : '',
    stopLossCooldownSecs:
      (agent.risk as Record<string, unknown> | null)?.stopLossCooldownMs != null
        ? String(Number((agent.risk as Record<string, unknown> | null)!.stopLossCooldownMs) / 1000)
        : '',
    openPositionEscalationToJudgePolicy,
    // Hydrate the preset selection from the persisted metadata so preset-managed
    // agents reopen with the matching preset card selected. Agents with no preset
    // metadata but with a technical config fall back to 'custom'; agents with
    // neither fall back to '' (no selection yet).
    strategyPreset: agent.strategyPreset ?? (agent.technical != null ? 'custom' : ''),
    platformAssessmentEnabled: agent.platformAssessment?.enabled ?? false,
    platformAssessmentReviewIntervalHours: agent.platformAssessment?.reviewIntervalMs
      ? String(Math.round(agent.platformAssessment.reviewIntervalMs / 3_600_000))
      : '',
    subscribedSources: agent.wakePreferences?.subscribedSources ?? [],
    pendingFiles: [],
    authorizationMode: (
      agent.authorizationMode === 'direct' || agent.authorizationMode === 'approval_required'
    ) ? agent.authorizationMode : 'direct',
  };
}

// ---------------------------------------------------------------------------
// intentToFormState
// ---------------------------------------------------------------------------

/**
 * Picks the AgentFormState subset from a create-flow IntentState.
 * Uses an inline type rather than importing IntentState from AgentsPage.tsx
 * to avoid a circular dependency (AgentsPage.tsx will import AgentFormState).
 */
export function intentToFormState(intent: {
  name: string;
  goal: string;
  capabilityMode: CapabilityMode;
  hybridMode?: HybridMode;
  technicalPreFilterEnabled: boolean;
  technicalConfig: TechnicalConfigFormState;
  skillIds: string[];
  connectionIds?: string[];
  executionMode: 'test' | 'live' | '';
  capital: string;
  telegramChatId: string;
  emailDelivery: 'inherit' | 'allow' | 'disable';
  costPreset: '' | 'minimal' | 'standard' | 'premium' | 'custom';
  dailySpendBudgetUsd: string;
  tickIntervalMins: string;
  dailyMaxLossPct: string;
  maxDrawdownPct: string;
  maxSlippageBps: string;
  maxOpenPositions: string;
  maxPositionSizePct: string;
  stopLossPct: string;
  stopLossCooldownSecs: string;
  openPositionEscalationToJudgePolicy: 'never' | 'uncovered_or_triggered' | 'always';
  strategyPreset: string;
  platformAssessmentEnabled: boolean;
  platformAssessmentReviewIntervalHours: string;
  subscribedSources: string[];
  pendingFiles: File[];
  authorizationMode: 'direct' | 'approval_required';
}): AgentFormState {
  const {
    name,
    goal,
    capabilityMode,
    hybridMode,
    technicalPreFilterEnabled,
    technicalConfig,
    skillIds,
    connectionIds,
    executionMode,
    capital,
    telegramChatId,
    emailDelivery,
    costPreset,
    dailySpendBudgetUsd,
    tickIntervalMins,
    dailyMaxLossPct,
    maxDrawdownPct,
    maxSlippageBps,
    maxOpenPositions,
    maxPositionSizePct,
    stopLossPct,
    stopLossCooldownSecs,
    openPositionEscalationToJudgePolicy,
    strategyPreset,
    platformAssessmentEnabled,
    platformAssessmentReviewIntervalHours,
    subscribedSources,
    pendingFiles,
    authorizationMode,
  } = intent;
  return {
    name,
    goal,
    capabilityMode,
    hybridMode,
    technicalPreFilterEnabled,
    technicalConfig,
    skillIds,
    connectionIds,
    executionMode,
    capital,
    telegramChatId,
    emailDelivery,
    costPreset,
    dailySpendBudgetUsd,
    tickIntervalMins,
    dailyMaxLossPct,
    maxDrawdownPct,
    maxSlippageBps,
    maxOpenPositions,
    maxPositionSizePct,
    stopLossPct,
    stopLossCooldownSecs,
    openPositionEscalationToJudgePolicy,
    strategyPreset,
    platformAssessmentEnabled,
    platformAssessmentReviewIntervalHours,
    subscribedSources,
    pendingFiles,
    authorizationMode,
  };
}
