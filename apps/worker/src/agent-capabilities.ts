import type { SkillDefinition } from '@herobids/domain';

export interface TradingTickWorkPlan {
  hasTradingCapability: boolean;
  shouldEvaluateRegime: boolean;
  shouldFetchVolatilityCandles: boolean;
  shouldRecordRegimeEvaluation: boolean;
  shouldRefreshVenueIntelligence: boolean;
  shouldRecordPerformanceInputs: boolean;
}

/**
 * Returns true when at least one resolved skill declares a 'trading' capability family.
 * Used to gate all trading-specific tick work: regime evaluation, venue intelligence,
 * performance recording, and their upstream market-data provider calls.
 */
export function deriveHasTradingCapability(resolvedSkills: SkillDefinition[]): boolean {
  return resolvedSkills.some((skill) => skill.capabilityFamilies.includes('trading'));
}

export function deriveTradingTickWorkPlan(
  resolvedSkills: SkillDefinition[],
  marketDataRegistryAvailable: boolean,
): TradingTickWorkPlan {
  const hasTradingCapability = deriveHasTradingCapability(resolvedSkills);
  const shouldUseMarketData = hasTradingCapability && marketDataRegistryAvailable;

  return {
    hasTradingCapability,
    shouldEvaluateRegime: shouldUseMarketData,
    shouldFetchVolatilityCandles: shouldUseMarketData,
    shouldRecordRegimeEvaluation: hasTradingCapability,
    shouldRefreshVenueIntelligence: hasTradingCapability,
    shouldRecordPerformanceInputs: hasTradingCapability,
  };
}
