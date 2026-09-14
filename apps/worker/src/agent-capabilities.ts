import type { SkillDefinition } from '@herobids/domain';

export interface TradingTickWorkPlan {
  hasTradingCapability: boolean;
  shouldEvaluateRegime: boolean;
  shouldFetchVolatilityPct: boolean;
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
  // Volatility (ATR%) is derived either in-process (registry candles) OR over the
  // Traderton `get_volatility` boundary (B5) — enabled when EITHER source is
  // available, mirroring the regime gate. Only the derived number crosses the
  // boundary; raw candles stay Traderton-side (legal isolation).
  const shouldFetchVolatilityPct = hasTradingCapability && (marketDataRegistryAvailable || tradertonBoundaryAvailable);

  return {
    hasTradingCapability,
    shouldEvaluateRegime: canEvaluateRegime,
    shouldFetchVolatilityPct,
    shouldRecordRegimeEvaluation: hasTradingCapability,
    shouldRefreshVenueIntelligence: hasTradingCapability,
    shouldRecordPerformanceInputs: hasTradingCapability,
  };
}
