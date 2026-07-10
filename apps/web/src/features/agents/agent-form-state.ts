import type { CapabilityMode } from './CapabilitySelector.js';
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
  /** true = scanner pre-filters trade candidates before LLM decides (hybrid mode). Only applies to trading agents. */
  technicalPreFilterEnabled: boolean;
  technicalConfig: TechnicalConfigFormState;

  // Skills
  skillIds: string[];

  // Connections
  connectionIds?: string[];

  // Trading setup
  executionMode: 'paper' | 'shadow' | 'live' | '';
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
  dailyLossLimit: string;
  maxDrawdownPct: string;
  maxSlippageBps: string;
  maxOpenPositions: string;
  maxPositionSizePct: string;
  stopLossPct: string;
  stopLossCooldownSecs: string;
  openPositionEscalationToJudgePolicy: 'never' | 'uncovered_or_triggered' | 'always';

  // Style-based strategy preset
  strategyPreset: string;

  // Wake source subscriptions (empty = all sources)
  subscribedSources: string[];
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
  const capabilityMode: CapabilityMode = agent.technical
    ? (goal.trim() ? 'both' : 'technical')
    : 'intelligence';

  // Runtime-validate union literal fields
  const VALID_EXECUTION_MODES = ['paper', 'shadow', 'live', ''] as const;
  const rawExecutionMode = agent.executionMode;
  const executionMode: AgentFormState['executionMode'] =
    typeof rawExecutionMode === 'string' &&
    (VALID_EXECUTION_MODES as readonly string[]).includes(rawExecutionMode)
      ? (rawExecutionMode as AgentFormState['executionMode'])
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
    dailyLossLimit: agent.dailyLossLimit ?? '',
    maxDrawdownPct: agent.maxDrawdownPct != null ? String(agent.maxDrawdownPct) : '',
    maxSlippageBps:
      agent.maxSlippageBps != null ? String(agent.maxSlippageBps) : '',
    maxOpenPositions:
      agent.maxOpenPositions != null ? String(agent.maxOpenPositions) : '',
    maxPositionSizePct: agent.maxPositionSizePct ?? '',
    stopLossPct: agent.stopLossPct ?? '',
    stopLossCooldownSecs:
      agent.stopLossCooldownMs != null
        ? String(agent.stopLossCooldownMs / 1000)
        : '',
    openPositionEscalationToJudgePolicy,
    // Hydrate the preset selection from the persisted metadata so preset-managed
    // agents reopen with the matching preset card selected. Agents with no preset
    // metadata but with a technical config fall back to 'custom'; agents with
    // neither fall back to '' (no selection yet).
    strategyPreset: agent.strategyPreset ?? (agent.technical != null ? 'custom' : ''),
    subscribedSources: agent.wakePreferences?.subscribedSources ?? [],
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
  technicalPreFilterEnabled: boolean;
  technicalConfig: TechnicalConfigFormState;
  skillIds: string[];
  connectionIds?: string[];
  executionMode: 'paper' | 'shadow' | 'live' | '';
  capital: string;
  telegramChatId: string;
  emailDelivery: 'inherit' | 'allow' | 'disable';
  costPreset: '' | 'minimal' | 'standard' | 'premium' | 'custom';
  dailySpendBudgetUsd: string;
  tickIntervalMins: string;
  dailyLossLimit: string;
  maxDrawdownPct: string;
  maxSlippageBps: string;
  maxOpenPositions: string;
  maxPositionSizePct: string;
  stopLossPct: string;
  stopLossCooldownSecs: string;
  openPositionEscalationToJudgePolicy: 'never' | 'uncovered_or_triggered' | 'always';
  strategyPreset: string;
  subscribedSources: string[];
}): AgentFormState {
  const {
    name,
    goal,
    capabilityMode,
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
    dailyLossLimit,
    maxDrawdownPct,
    maxSlippageBps,
    maxOpenPositions,
    maxPositionSizePct,
    stopLossPct,
    stopLossCooldownSecs,
    openPositionEscalationToJudgePolicy,
    strategyPreset,
    subscribedSources,
  } = intent;
  return {
    name,
    goal,
    capabilityMode,
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
    dailyLossLimit,
    maxDrawdownPct,
    maxSlippageBps,
    maxOpenPositions,
    maxPositionSizePct,
    stopLossPct,
    stopLossCooldownSecs,
    openPositionEscalationToJudgePolicy,
    strategyPreset,
    subscribedSources,
  };
}
