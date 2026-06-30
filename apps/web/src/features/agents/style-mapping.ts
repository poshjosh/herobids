export type AgentStyleValue = 'careful' | 'balanced' | 'bold';

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
  maxHistoryMessages: number | null;
  maxHistoryTokens: number | null;
  maxRecentToolMessages: number | null;
  maxToolResultChars: number | null;
  maxVisibleToolSchemas: number | null;
  maxContextBlockChars: number | null;
  toolResultFullRetentionTurns: number | null;
  toolResultMaxStaleChars: number | null;
  maxHoldDurationMs: number | null;
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
    weekendPause: true,
    maxHistoryMessages: 10,
    maxHistoryTokens: 20_000,
    maxRecentToolMessages: 3,
    maxToolResultChars: 2_000,
    maxVisibleToolSchemas: 32,
    maxContextBlockChars: 2_000,
    toolResultFullRetentionTurns: 2,
    toolResultMaxStaleChars: 250,
    maxHoldDurationMs: 27_000_000, // 450 min (5 × tick interval)
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
    weekendPause: true,
    maxHistoryMessages: 20,
    maxHistoryTokens: 40_000,
    maxRecentToolMessages: 6,
    maxToolResultChars: 4_000,
    maxVisibleToolSchemas: 64,
    maxContextBlockChars: 4_000,
    toolResultFullRetentionTurns: 3,
    toolResultMaxStaleChars: 500,
    maxHoldDurationMs: 5_400_000, // 90 min (3 × tick interval)
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
  },
};

export function resolveStyleDefaults(style: AgentStyleValue): StyleDefaults {
  const config = STYLE_CONFIG[style];
  if (!config) {
    return STYLE_CONFIG.balanced;
  }
  return config;
}

/** Pricing info for the selected economy and premium models. Pass to formatStyleSummary for computed estimates. */
export interface ModelPricingInfo {
  /** Output price per 1M tokens for the economy model. */
  economyOutputUsdPer1M: number;
  /** Output price per 1M tokens for the premium model. */
  premiumOutputUsdPer1M: number;
}

/**
 * Extract pricing for the selected economy and premium models from a provider catalog.
 * Returns undefined if pricing cannot be resolved (missing provider, missing models, missing prices).
 */
export function resolveModelPricing(
  providers: ReadonlyArray<{ provider: string; models: ReadonlyArray<{ id: string; pricing?: { outputUsdPer1M?: string } }> }>,
  selectedProvider: string,
  economyModelId: string,
  premiumModelId: string,
): ModelPricingInfo | undefined {
  if (!selectedProvider || !economyModelId || !premiumModelId) return undefined;

  const provider = providers.find((p) => p.provider === selectedProvider);
  if (!provider) return undefined;

  const economyModel = provider.models.find((m) => m.id === economyModelId);
  const premiumModel = provider.models.find((m) => m.id === premiumModelId);

  const economyPrice = economyModel?.pricing?.outputUsdPer1M;
  const premiumPrice = premiumModel?.pricing?.outputUsdPer1M;

  if (!economyPrice || !premiumPrice) return undefined;

  const economyNum = Number(economyPrice);
  const premiumNum = Number(premiumPrice);
  if (!Number.isFinite(economyNum) || !Number.isFinite(premiumNum)) return undefined;

  return {
    economyOutputUsdPer1M: economyNum,
    premiumOutputUsdPer1M: premiumNum,
  };
}

/**
 * Build a compact summary string for a style.
 *
 * When `pricing` is provided, the cost is computed from:
 *   ticksPerDay × estimatedTokensPerTick × blendedPricePerToken
 * using the style's tick interval, token budgets, and the selected model pricing.
 * The result is prefixed with "~" to indicate it is an estimate.
 *
 * When `pricing` is omitted (or both prices are 0), falls back to the hardcoded
 * dailySpendBudgetUsd from the style config (the user's budget target, not a cost estimate).
 *
 * Both paths produce a consistent format: cost · cadence.
 */
export function formatStyleSummary(style: AgentStyleValue, pricing?: ModelPricingInfo): string {
  const d = resolveStyleDefaults(style);
  const cadence = `every ${d.tickIntervalMins} min`;

  // Compute estimated daily cost if we have model pricing
  if (pricing && pricing.economyOutputUsdPer1M > 0 && pricing.premiumOutputUsdPer1M > 0) {
    const ticksPerDay = 1440 / Number(d.tickIntervalMins);

    // Estimated output tokens per tick — assume 50% utilization of max budgets
    const outputTokensPerTick =
      (d.scoutMaxTurns * d.scoutMaxTokens + d.judgeMaxTurns * d.judgeMaxTokens) * 0.5;

    // Economy model handles ~70% of work, premium ~30%
    const economyTokens = outputTokensPerTick * 0.7 + d.lightThinkingTokens;
    const premiumTokens = outputTokensPerTick * 0.3 + d.deepThinkingTokens;

    const blendedPricePer1M =
      pricing.economyOutputUsdPer1M * 0.7 + pricing.premiumOutputUsdPer1M * 0.3;

    const costPerTick = (economyTokens + premiumTokens) * blendedPricePer1M / 1_000_000;
    const dailyCost = costPerTick * ticksPerDay;

    return `~$${dailyCost.toFixed(2)}/day · ${cadence}`;
  }

  // Fallback: show budget target
  return `~$${d.dailySpendBudgetUsd}/day target · ${cadence}`;
}
