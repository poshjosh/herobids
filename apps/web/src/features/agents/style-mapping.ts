import type { ReasoningLevel, TradingSessionName } from '@herobids/domain';

export type { TradingSessionName };
export type AgentStyleValue = 'careful' | 'balanced' | 'bold';

const MS_PER_MINUTE = 60_000;

export interface StyleDefaults {
  costPreset: 'minimal' | 'standard' | 'premium';
  tickIntervalMins: string;
  dailySpendBudgetUsd: string;
  openPositionEscalationToJudgePolicy: 'never' | 'uncovered_or_triggered' | 'always';
  // Tool turn limits
  scoutMaxTurns: number;
  judgeMaxTurns: number;
  // LLM token limits
  scoutMaxTokens: number;
  judgeMaxTokens: number;
  lightThinkingTokens: number;
  deepThinkingTokens: number;
  // Trading hours
  allowedHoursUtc: number[];
  weekendPause: boolean;
  // Context budgets
  maxHistoryMessages: number;
  maxHistoryTokens: number;
  maxRecentToolMessages: number;
  maxToolResultChars: number;
  maxVisibleToolSchemas: number;
  maxContextBlockChars: number;
  toolResultFullRetentionTurns: number;
  toolResultMaxStaleChars: number;
  // Scout hold
  maxHoldDurationMs: number;
  // Reasoning level defaults (per-style base; agent overrides via runtime policy)
  scoutReasoning: ReasoningLevel;
  judgeReasoning: ReasoningLevel;
  adaptScoutReasoning: boolean;
  adaptJudgeReasoning: boolean;
}

/** Per-field overrides for runtime policy. Fields not present use the style default. */
export type RuntimePolicyOverrides = Partial<{
  scoutMaxTurns: number | null;
  judgeMaxTurns: number | null;
  scoutMaxTokens: number | null;
  judgeMaxTokens: number | null;
  lightThinkingTokens: number | null;
  deepThinkingTokens: number | null;
  allowedHoursUtc: number[] | null;
  weekendPause: boolean | null;
  tradingSessions: TradingSessionName[] | null;
  maxHistoryMessages: number | null;
  maxHistoryTokens: number | null;
  maxRecentToolMessages: number | null;
  maxToolResultChars: number | null;
  maxVisibleToolSchemas: number | null;
  maxContextBlockChars: number | null;
  toolResultFullRetentionTurns: number | null;
  toolResultMaxStaleChars: number | null;
  maxHoldDurationMs: number | null;
  scoutReasoning: ReasoningLevel | null;
  judgeReasoning: ReasoningLevel | null;
  adaptScoutReasoning: boolean | null;
  adaptJudgeReasoning: boolean | null;
}>;

export const STYLE_CONFIG: Record<AgentStyleValue, StyleDefaults> = {
  careful:  {
    costPreset: 'minimal',
    tickIntervalMins: '90',
    dailySpendBudgetUsd: '3',
    openPositionEscalationToJudgePolicy: 'never',
    scoutMaxTurns: 10,
    judgeMaxTurns: 25,
    scoutMaxTokens: 512,
    judgeMaxTokens: 2_048,
    lightThinkingTokens: 1_024,
    deepThinkingTokens: 4_096,
    allowedHoursUtc: [14, 15, 16, 17, 18, 19, 20],
    weekendPause: false,
    maxHistoryMessages: 10,
    maxHistoryTokens: 20_000,
    maxRecentToolMessages: 3,
    maxToolResultChars: 2_000,
    maxVisibleToolSchemas: 32,
    maxContextBlockChars: 2_000,
    toolResultFullRetentionTurns: 2,
    toolResultMaxStaleChars: 250,
    maxHoldDurationMs: 27_000_000, // 450 min (5 × tick interval)
    scoutReasoning: 'none',
    judgeReasoning: 'low',
    adaptScoutReasoning: true,
    adaptJudgeReasoning: true,
  },
  balanced: {
    costPreset: 'standard',
    tickIntervalMins: '30',
    dailySpendBudgetUsd: '10',
    openPositionEscalationToJudgePolicy: 'uncovered_or_triggered',
    scoutMaxTurns: 30,
    judgeMaxTurns: 75,
    scoutMaxTokens: 1_024,
    judgeMaxTokens: 4_096,
    lightThinkingTokens: 2_048,
    deepThinkingTokens: 10_240,
    allowedHoursUtc: [],
    weekendPause: false,
    maxHistoryMessages: 20,
    maxHistoryTokens: 40_000,
    maxRecentToolMessages: 6,
    maxToolResultChars: 4_000,
    maxVisibleToolSchemas: 64,
    maxContextBlockChars: 4_000,
    toolResultFullRetentionTurns: 3,
    toolResultMaxStaleChars: 500,
    maxHoldDurationMs: 5_400_000, // 90 min (3 × tick interval)
    scoutReasoning: 'none',
    judgeReasoning: 'medium',
    adaptScoutReasoning: true,
    adaptJudgeReasoning: true,
  },
  bold:     {
    costPreset: 'premium',
    tickIntervalMins: '10',
    dailySpendBudgetUsd: '30',
    openPositionEscalationToJudgePolicy: 'always',
    scoutMaxTurns: 100,
    judgeMaxTurns: 300,
    scoutMaxTokens: 2_048,
    judgeMaxTokens: 8_192,
    lightThinkingTokens: 4_096,
    deepThinkingTokens: 20_480,
    allowedHoursUtc: [],
    weekendPause: false,
    maxHistoryMessages: 40,
    maxHistoryTokens: 80_000,
    maxRecentToolMessages: 12,
    maxToolResultChars: 8_000,
    maxVisibleToolSchemas: 128,
    maxContextBlockChars: 8_000,
    toolResultFullRetentionTurns: 5,
    toolResultMaxStaleChars: 1_000,
    maxHoldDurationMs: 600_000, // 10 min (1 × tick interval)
    scoutReasoning: 'low',
    judgeReasoning: 'high',
    adaptScoutReasoning: true,
    adaptJudgeReasoning: true,
  },
};

export function resolveStyleDefaults(style: AgentStyleValue): StyleDefaults {
  const config = STYLE_CONFIG[style];
  if (!config) {
    return STYLE_CONFIG.balanced;
  }
  return config;
}

function isPositiveFiniteNumber(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}

export function resolveStyleTickIntervalMs(style: AgentStyleValue, tickIntervalMsOverride?: number | null): number {
  if (isPositiveFiniteNumber(tickIntervalMsOverride)) {
    return tickIntervalMsOverride;
  }

  return Number(resolveStyleDefaults(style).tickIntervalMins) * MS_PER_MINUTE;
}

export function deriveStyleMaxHoldDurationMs(style: AgentStyleValue, tickIntervalMsOverride?: number | null): number {
  const defaults = resolveStyleDefaults(style);
  const defaultTickIntervalMs = Number(defaults.tickIntervalMins) * MS_PER_MINUTE;
  const multiplier = defaultTickIntervalMs > 0
    ? defaults.maxHoldDurationMs / defaultTickIntervalMs
    : 1;

  return Math.round(resolveStyleTickIntervalMs(style, tickIntervalMsOverride) * multiplier);
}

export function applyAutoMaxHoldOverride(
  style: AgentStyleValue,
  overrides: RuntimePolicyOverrides | null,
  tickIntervalMsOverride?: number | null,
): RuntimePolicyOverrides | null {
  const defaults = resolveStyleDefaults(style);
  const derivedMaxHoldDurationMs = deriveStyleMaxHoldDurationMs(style, tickIntervalMsOverride);
  const next: RuntimePolicyOverrides = { ...(overrides ?? {}) };

  if (derivedMaxHoldDurationMs === defaults.maxHoldDurationMs) {
    delete next.maxHoldDurationMs;
  } else {
    next.maxHoldDurationMs = derivedMaxHoldDurationMs;
  }

  return Object.keys(next).length > 0 ? next : null;
}

/** Pricing info for the selected economy and premium models. Pass to formatStyleSummary for computed estimates. */
export interface ModelPricingInfo {
  /** Input price per 1M tokens for the economy (scout) model. */
  economyInputUsdPer1M: number;
  /** Output price per 1M tokens for the economy (scout) model. */
  economyOutputUsdPer1M: number;
  /** Input price per 1M tokens for the premium (judge) model. */
  premiumInputUsdPer1M: number;
  /** Output price per 1M tokens for the premium (judge) model. */
  premiumOutputUsdPer1M: number;
}

/**
 * Extract pricing for the selected economy and premium models from a provider catalog.
 * Returns undefined if pricing cannot be resolved (missing provider, missing models, missing prices).
 */
export function resolveModelPricing(
  providers: ReadonlyArray<{ provider: string; models: ReadonlyArray<{ id: string; pricing?: { inputUsdPer1M?: string; outputUsdPer1M?: string } }> }>,
  selectedProvider: string,
  economyModelId: string,
  premiumModelId: string,
): ModelPricingInfo | undefined {
  if (!selectedProvider || !economyModelId || !premiumModelId) return undefined;

  const provider = providers.find((p) => p.provider === selectedProvider);
  if (!provider) return undefined;

  const economyModel = provider.models.find((m) => m.id === economyModelId);
  const premiumModel = provider.models.find((m) => m.id === premiumModelId);

  const economyInputPrice = economyModel?.pricing?.inputUsdPer1M;
  const economyOutputPrice = economyModel?.pricing?.outputUsdPer1M;
  const premiumInputPrice = premiumModel?.pricing?.inputUsdPer1M;
  const premiumOutputPrice = premiumModel?.pricing?.outputUsdPer1M;

  if (!economyInputPrice || !economyOutputPrice || !premiumInputPrice || !premiumOutputPrice) return undefined;

  const economyInputNum = Number(economyInputPrice);
  const economyOutputNum = Number(economyOutputPrice);
  const premiumInputNum = Number(premiumInputPrice);
  const premiumOutputNum = Number(premiumOutputPrice);
  if (!Number.isFinite(economyInputNum) || !Number.isFinite(economyOutputNum) || !Number.isFinite(premiumInputNum) || !Number.isFinite(premiumOutputNum)) return undefined;

  return {
    economyInputUsdPer1M: economyInputNum,
    economyOutputUsdPer1M: economyOutputNum,
    premiumInputUsdPer1M: premiumInputNum,
    premiumOutputUsdPer1M: premiumOutputNum,
  };
}

// Per-tick token counts derived from eval data (.ignore/eval/2026/06/).
// Based on t1inch + thyper (balanced style, 06/26) using deepseek-v4-flash scout
// and deepseek-v4-pro judge at near-100% escalation. Input tokens dominate cost
// (10–25× output), so they must be included for a realistic estimate.
const SCOUT_OUTPUT_TOKENS_PER_TICK = 33_000;
const SCOUT_INPUT_TOKENS_PER_TICK = 332_000;
const JUDGE_OUTPUT_TOKENS_PER_TICK = 42_000;
const JUDGE_INPUT_TOKENS_PER_TICK = 1_030_000;

// Assumed escalation rates by style, derived from observed agent behaviour:
// careful: scout holds ~95% of ticks (06/28 careful-agent-1: 4.1% escalation)
// balanced: scout escalates ~20% of ticks
// bold: scout escalates ~60% of ticks
const STYLE_ESCALATION_RATES: Record<AgentStyleValue, number> = {
  careful: 0.05,
  balanced: 0.20,
  bold: 0.60,
};

/**
 * Build a compact summary string for a style.
 *
 * When full `pricing` (input + output for both models) is provided, the cost is
 * computed from real-data per-tick token estimates × model pricing × escalation rate.
 * Both input and output token costs are included — input tokens are 10–25× larger
 * than output tokens and dominate the estimate. The result is prefixed with "~" to
 * indicate it is an estimate.
 *
 * When `pricing` is omitted or incomplete, falls back to the hardcoded
 * dailySpendBudgetUsd from the style config (the user's budget target, not a cost estimate).
 */
export function formatStyleSummary(
  style: AgentStyleValue,
  styleName: string,
  pricing?: ModelPricingInfo,
  tickIntervalMsOverride?: number | null,
): string {
  const d = resolveStyleDefaults(style);
  const effectiveTickIntervalMs = resolveStyleTickIntervalMs(style, tickIntervalMsOverride);

  // Compute estimated daily cost if we have full model pricing (input + output for both models)
  if (pricing
    && pricing.economyInputUsdPer1M > 0 && pricing.economyOutputUsdPer1M > 0
    && pricing.premiumInputUsdPer1M > 0 && pricing.premiumOutputUsdPer1M > 0
  ) {
    const ticksPerDay = 86_400_000 / effectiveTickIntervalMs;
    const escalationRate = STYLE_ESCALATION_RATES[style];

    const scoutCost =
      (SCOUT_OUTPUT_TOKENS_PER_TICK * pricing.economyOutputUsdPer1M +
       SCOUT_INPUT_TOKENS_PER_TICK * pricing.economyInputUsdPer1M) / 1_000_000;

    const judgeCost =
      (JUDGE_OUTPUT_TOKENS_PER_TICK * pricing.premiumOutputUsdPer1M +
       JUDGE_INPUT_TOKENS_PER_TICK * pricing.premiumInputUsdPer1M) / 1_000_000 * escalationRate;

    const costPerTick = scoutCost + judgeCost;
    const dailyCost = costPerTick * ticksPerDay;

    return `${styleName}, enforces a limit of $${dailyCost.toFixed(2)}/day`;
  }

  // Fallback: show budget target
  return `${styleName}, enforces a limit of $${d.dailySpendBudgetUsd}/day`;
}
