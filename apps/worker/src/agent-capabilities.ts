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
  tradertonBoundaryAvailable = false,
): TradingTickWorkPlan {
  const hasTradingCapability = deriveHasTradingCapability(resolvedSkills);
  // Regime can be evaluated either in-process (registry) OR over the Traderton
  // `check_regime` boundary — so it is enabled when EITHER source is available.
  // This keeps the ratified regime re-point reachable in the target end-state
  // (boundary present, in-process registry removed) and matches the coordinator's
  // presence-based regime gate + venue-intelligence's capability-only gate.
  const canEvaluateRegime = hasTradingCapability && (marketDataRegistryAvailable || tradertonBoundaryAvailable);
  // Volatility candles have NO boundary tool yet (deferred), so they stay
  // strictly registry-dependent.
  const shouldFetchVolatilityCandles = hasTradingCapability && marketDataRegistryAvailable;

  return {
    hasTradingCapability,
    shouldEvaluateRegime: canEvaluateRegime,
    shouldFetchVolatilityCandles,
    shouldRecordRegimeEvaluation: hasTradingCapability,
    shouldRefreshVenueIntelligence: hasTradingCapability,
    shouldRecordPerformanceInputs: hasTradingCapability,
  };
}
