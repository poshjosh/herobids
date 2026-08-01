import { price, type AgentRiskDefaultsConfig, type AgentRiskOverrides, type AgentRiskCreatorInput, type AgentRiskCeilings, type ResolvedAgentRiskContract, resolveAgentRiskContract, type ResolvedAgentRiskProfile, resolveAgentRiskProfile, type RiskPosture } from '@herobids/domain';
import type { RiskLimits } from '@herobids/engine';

export interface AgentRiskLimitSource {
  capital: string | null;
  /** Canonical RiskPosture JSONB — the sole risk source. */
  riskPosture: RiskPosture | null;
}

/**
 * Extract AgentRiskCeilings from operator config defaults.
 */
export function extractCeilings(defaults: AgentRiskDefaultsConfig): AgentRiskCeilings {
  return {
    maxOpenPositions: defaults.maxOpenPositions,
    maxPositionSizePct: defaults.maxPositionSizePct,
    stopLossPct: defaults.stopLossPct,
    stopLossCooldownMs: defaults.stopLossCooldownMs,
    maxDrawdownPct: defaults.maxDrawdownPct,
  };
}

/**
 * Extract AgentRiskCreatorInput from the canonical riskPosture JSONB.
 */
export function extractCreatorInput(source: AgentRiskLimitSource): AgentRiskCreatorInput {
  const rp = source.riskPosture;
  return {
    maxOpenPositions: rp?.maxOpenPositions ?? null,
    maxPositionSizePct: rp?.maxPositionSizePct ?? null,
    stopLossPct: rp?.stopLossPct ?? null,
    stopLossCooldownMs: rp?.stopLossCooldownMs ?? null,
    maxDrawdownPct: rp?.maxDrawdownPct ?? null,
  };
}

/**
 * Resolve the full agent risk contract from all three sources.
 */
export function resolveContract(
  source: AgentRiskLimitSource,
  defaults: AgentRiskDefaultsConfig,
  overrides: AgentRiskOverrides = {},
): ResolvedAgentRiskContract {
  return resolveAgentRiskContract(
    extractCreatorInput(source),
    extractCeilings(defaults),
    overrides,
    { hasCapital: source.capital != null },
  );
}

/**
 * Resolve the full 9-field agent risk profile (read-only read model).
 *
 * Includes the 5 mutable fields from the contract + 4 immutable fields
 * (dailyMaxLossPct, maxNewPositionsPerDay, avoidParabolicMovePct, maxOrderNotional).
 *
 * Used by get_risk_limits to give the agent full visibility into its risk posture.
 */
export function resolveProfile(
  source: AgentRiskLimitSource,
  defaults: AgentRiskDefaultsConfig,
  overrides: AgentRiskOverrides = {},
): ResolvedAgentRiskProfile {
  return resolveAgentRiskProfile(
    source.riskPosture ?? null,
    extractCeilings(defaults),
    defaults.dailyMaxLossPct,
    overrides,
    {
      hasCapital: source.capital != null,
      capital: source.capital != null ? Number.parseFloat(source.capital) : undefined,
      maxOrderNotionalMultiplier: defaults.maxOrderNotionalMultiplier,
    },
  );
}

/**
 * Build engine-facing RiskLimits from the resolved contract and additional capital-derived fields.
 */
export function buildRiskLimitsFromContract(
  contract: ResolvedAgentRiskContract,
  source: AgentRiskLimitSource,
  defaults: AgentRiskDefaultsConfig,
): RiskLimits {
  const capital = source.capital;
  const rp = source.riskPosture;

  return {
    maxOpenPositions: contract.maxOpenPositions.effectiveValue,
    maxDrawdownPct: contract.maxDrawdownPct.effectiveValue,
    stopLossMaxUnrealizedLossPct: contract.stopLossPct.effectiveValue,
    stopLossCooldownMs: contract.stopLossCooldownMs.effectiveValue,
    // maxPositionSizePct is included when capital is present or when the field has an effective value from creator/override
    ...(contract.maxPositionSizePct.source !== 'default' || capital != null ? {
      maxPositionSizePct: contract.maxPositionSizePct.effectiveValue,
    } : {}),
    // dailyMaxLossPct: creator-set → use it; otherwise → operator default
    dailyMaxLossPct: rp?.dailyMaxLossPct ?? defaults.dailyMaxLossPct,
    // maxOrderNotional: creator-set → use it; otherwise → derive from capital
    ...(rp?.maxOrderNotional != null ? {
      maxOrderNotional: price(String(rp.maxOrderNotional)),
    } : capital != null ? {
      maxOrderNotional: price(String(Number.parseFloat(capital) * defaults.maxOrderNotionalMultiplier)),
    } : {}),
  };
}

/**
 * Build engine-facing RiskLimits from raw source, defaults, and overrides.
 * This is the single entry point that combines contract resolution and limit derivation.
 */
export function buildAgentRiskLimits(
  source: AgentRiskLimitSource,
  defaults: AgentRiskDefaultsConfig,
  overrides: AgentRiskOverrides = {},
): RiskLimits {
  const contract = resolveContract(source, defaults, overrides);
  return buildRiskLimitsFromContract(contract, source, defaults);
}