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
 *
 * `SkillDefinition.capabilityFamilies` is typed as a required `string[]`, but the
 * resolved-skill entries that reach this function via `RuntimeDescriptor.resolvedSkills`
 * are a narrower runtime shape that may omit the field entirely (the type is lying at
 * this boundary). Guard with `Array.isArray` so a missing/non-array value yields `false`
 * instead of throwing a TypeError — a thrown error here is silently swallowed by the
 * session-launch try/catch and prevents the runtime from launching.
 */
export function deriveHasTradingCapability(resolvedSkills: SkillDefinition[]): boolean {
  return resolvedSkills.some(
    (skill) => Array.isArray(skill.capabilityFamilies) && skill.capabilityFamilies.includes('trading'),
  );
}

export function deriveTradingTickWorkPlan(
  resolvedSkills: SkillDefinition[],
  tradertonBoundaryAvailable: boolean,
): TradingTickWorkPlan {
  const hasTradingCapability = deriveHasTradingCapability(resolvedSkills);
  // Regime is evaluated over the Traderton `check_regime` boundary — enabled
  // when the boundary is available. In-process market-data has been removed
  // (B7), so the boundary is the sole source; this matches the coordinator's
  // presence-based regime gate + venue-intelligence's capability-only gate.
  const canEvaluateRegime = hasTradingCapability && tradertonBoundaryAvailable;
  // Volatility (ATR%) is derived over the Traderton `get_volatility` boundary
  // (B5) — enabled when the boundary is available, mirroring the regime gate.
  // Only the derived number crosses the boundary; raw candles stay
  // Traderton-side (legal isolation).
  const shouldFetchVolatilityPct = hasTradingCapability && tradertonBoundaryAvailable;

  return {
    hasTradingCapability,
    shouldEvaluateRegime: canEvaluateRegime,
    shouldFetchVolatilityPct,
    shouldRecordRegimeEvaluation: hasTradingCapability,
    shouldRefreshVenueIntelligence: hasTradingCapability,
    shouldRecordPerformanceInputs: hasTradingCapability,
  };
}
