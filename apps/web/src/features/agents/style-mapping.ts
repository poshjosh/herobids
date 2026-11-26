import {
  AGENT_STYLE_RUNTIME_DEFAULTS,
  findModelMaxOutputTokens,
  resolveAgentRuntimePolicy,
  resolveMediumThinkingTokens,
  resolveStyleTradingTickIntervalMs,
  type ReasoningLevel,
  type TradingSessionName,
} from '@herobids/domain';

export type { TradingSessionName };
export type AgentStyleValue = 'careful' | 'balanced' | 'bold';

type StyleDefaults = (typeof AGENT_STYLE_RUNTIME_DEFAULTS)[AgentStyleValue];

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
  skipUnchangedTicks: boolean | null;
}>;

export const STYLE_CONFIG: Record<AgentStyleValue, StyleDefaults> = AGENT_STYLE_RUNTIME_DEFAULTS;

export function resolveStyleDefaults(style: AgentStyleValue): StyleDefaults {
  const config = STYLE_CONFIG[style];
  if (!config) {
    return STYLE_CONFIG.balanced;
  }
  return config;
}

/** A selected model whose maximum output cannot fit the thinking budget of the agent's reasoning level plus the output reserve. */
export interface ModelOutputLimitShortfall {
  role: 'scout' | 'judge';
  reasoning: ReasoningLevel;
  maxOutputTokens: number;
  /** Thinking budget for `reasoning` plus the role's output reserve. */
  requiredTokens: number;
}

function resolveThinkingBudgetTokens(level: ReasoningLevel, lightThinkingTokens: number, deepThinkingTokens: number): number {
  switch (level) {
    case 'none': return 0;
    case 'low': return lightThinkingTokens;
    case 'medium': return resolveMediumThinkingTokens(lightThinkingTokens, deepThinkingTokens);
    case 'high': return deepThinkingTokens;
  }
}

/**
 * D21 (C): models that cannot fit the thinking budget of the chosen (or style default) reasoning level plus the output
 * reserve, so replies may be cut off. Uses the token-budget formula, applied to every model in the built-in table.
 * Only the built-in DEFAULT_MAX_OUTPUT_TOKENS_BY_MODEL table is checked: operator `llm.maxOutputTokensByModel`
 * overrides and the operator default for unknown models are not visible to the web, so those models are not warned about.
 */
export function findModelOutputLimitShortfalls(params: {
  style: AgentStyleValue;
  overrides: RuntimePolicyOverrides | null | undefined;
  lightModel: string | null | undefined;
  heavyModel: string | null | undefined;
}): ModelOutputLimitShortfall[] {
  const policy = resolveAgentRuntimePolicy(params.style, params.overrides);
  const checks = [
    { role: 'scout' as const, model: params.lightModel, reasoning: policy.scoutReasoning, reserveTokens: policy.scoutOutputReserveTokens },
    { role: 'judge' as const, model: params.heavyModel, reasoning: policy.judgeReasoning, reserveTokens: policy.judgeOutputReserveTokens },
  ];
  const shortfalls: ModelOutputLimitShortfall[] = [];
  for (const { role, model, reasoning, reserveTokens } of checks) {
    const maxOutputTokens = model ? findModelMaxOutputTokens(model) : undefined;
    if (maxOutputTokens === undefined) continue;
    const requiredTokens = resolveThinkingBudgetTokens(reasoning, policy.lightThinkingTokens, policy.deepThinkingTokens) + reserveTokens;
    if (requiredTokens > maxOutputTokens) {
      shortfalls.push({ role, reasoning, maxOutputTokens, requiredTokens });
    }
  }
  return shortfalls;
}

/**
 * D9: the effective skip-unchanged default for the form, following the selected
 * skills — on for trading agents, off otherwise. Mirrors the resolver default in
 * `@herobids/domain` resolveAgentRuntimePolicy.
 */
export function resolveDefaultSkipUnchangedTicks(hasTradingCapability: boolean): boolean {
  return hasTradingCapability;
}

function isPositiveFiniteNumber(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}

export function resolveStyleTickIntervalMs(style: AgentStyleValue, tickIntervalMsOverride?: number | null): number {
  if (isPositiveFiniteNumber(tickIntervalMsOverride)) {
    return tickIntervalMsOverride;
  }

  return resolveStyleTradingTickIntervalMs(style);
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

// Approximate escalation rates by style, used only for the display-only $/day cost
// estimate below. These were originally derived from observed agent behaviour
// (former careful ~0.05, former balanced ~0.20, former bold ~0.60).
//
// After the agent-style-ladder rescale the behavioural posture of each style
// shifted up one notch — new careful now behaves like the former balanced
// (escalation policy 'uncovered_or_triggered'), and new balanced/bold behave
// like the former bold ('always'). We shift the rates the same way so the
// estimate is not grossly wrong, rather than inventing new empirical numbers.
// These remain approximate and should be re-derived from live telemetry when
// available; they drive a display-only estimate, not any trading behaviour.
const STYLE_ESCALATION_RATES: Record<AgentStyleValue, number> = {
  careful: 0.20,  // shifted from former balanced posture
  balanced: 0.60, // shifted from former bold posture
  bold: 0.60,     // former bold posture, unchanged
};

/**
 * Build a compact summary string for a style.
 *
 * When full `pricing` (input + output for both models) is provided, the cost is
 * computed from real-data per-tick token estimates × model pricing × escalation rate.
 * Both input and output token costs are included — input tokens are 10–25× larger
 * than output tokens and dominate the estimate. The result is an estimate, not an
 * enforced cap, and is worded as such ("~$X.XX/day estimated").
 *
 * When `pricing` is omitted or incomplete, returns just the style name with no cost
 * clause. dailySpendBudgetUsd is a user budget target, not an enforced cap, so showing
 * it as a "$X/day" limit would be misleading; we omit the clause rather than invent a number.
 */
export function formatStyleSummary(
  style: AgentStyleValue,
  styleName: string,
  pricing?: ModelPricingInfo,
  tickIntervalMsOverride?: number | null,
): string {
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

    return `${styleName}, ~$${dailyCost.toFixed(2)}/day estimated`;
  }

  // Fallback: no pricing available. Omit the cost clause entirely rather than
  // present dailySpendBudgetUsd as an enforced "$X/day" limit (it is not).
  return styleName;
}
