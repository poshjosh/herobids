import { price, quantity, type AgentRiskDefaultsConfig, type AgentRiskOverrides, type AgentRiskCreatorInput, type AgentRiskCeilings, type ResolvedAgentRiskContract, resolveAgentRiskContract, type RiskPosture } from '@herobids/domain';
import type { RiskLimits } from '@herobids/engine';

export interface AgentRiskLimitSource {
  capital: string | null;
  dailyLossLimit: string | null;
  maxDrawdownPct: string | number | null;
  maxOpenPositions: number | null;
  maxPositionSizePct: string | number | null;
  stopLossPct: string | number | null;
  stopLossCooldownMs: number | null;
  /** Typed RiskPosture JSONB — canonical source. Takes precedence over column values when present. */
  riskPosture: RiskPosture | null;
}

function parseOptionalNumber(value: string | number | null): number | undefined {
  if (value == null) {
    return undefined;
  }

  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Extract AgentRiskCeilings from operator config defaults.
 */
export function extractCeilings(defaults: AgentRiskDefaultsConfig): AgentRiskCeilings {
  // Read stopLossPct first (canonical name, lands in WP5), fall back to
  // stopLossMaxUnrealizedLossPct (legacy name in current operator config).
  // Uses a type assertion because AgentRiskDefaultsConfig currently only
  // carries the legacy field — the canonical field arrives in WP5.
  const raw = defaults as Record<string, number>;
  if (raw['stopLossPct'] !== undefined && defaults.stopLossMaxUnrealizedLossPct !== undefined) {
    console.debug('agent-risk-limits: both stopLossPct (canonical) and stopLossMaxUnrealizedLossPct (legacy) are set; using canonical');
  }
  return {
    maxOpenPositions: defaults.maxOpenPositions,
    maxPositionSizePct: defaults.maxPositionSizePct,
    stopLossPct: raw['stopLossPct'] ?? defaults.stopLossMaxUnrealizedLossPct,
    stopLossCooldownMs: defaults.stopLossCooldownMs,
    maxDrawdownPct: defaults.maxDrawdownPct,
  };
}

/**
 * Extract AgentRiskCreatorInput from the raw nullable source columns.
 * Reads from the typed riskPosture JSONB first, falling back to legacy column values.
 */
export function extractCreatorInput(source: AgentRiskLimitSource): AgentRiskCreatorInput {
  const rp = source.riskPosture;
  return {
    maxOpenPositions: rp?.maxOpenPositions ?? source.maxOpenPositions,
    maxPositionSizePct: rp?.maxPositionSizePct ?? parseOptionalNumber(source.maxPositionSizePct) ?? null,
    stopLossPct: rp?.stopLossPct ?? parseOptionalNumber(source.stopLossPct) ?? null,
    stopLossCooldownMs: rp?.stopLossCooldownMs ?? source.stopLossCooldownMs,
    maxDrawdownPct: rp?.maxDrawdownPct ?? parseOptionalNumber(source.maxDrawdownPct) ?? null,
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
 * Build engine-facing RiskLimits from the resolved contract and additional capital-derived fields.
 */
export function buildRiskLimitsFromContract(
  contract: ResolvedAgentRiskContract,
  source: AgentRiskLimitSource,
  defaults: AgentRiskDefaultsConfig,
): RiskLimits {
  const capital = source.capital;
  const dailyLossLimit = source.dailyLossLimit;

  // Agent flows always use the operator ceiling for absolute maxDrawdown.
  // The canonical agent drawdown control is maxDrawdownPct.
  const maxDrawdown = defaults.maxDrawdown != null ? String(defaults.maxDrawdown) : '1000000000';

  return {
    maxPositionSize: quantity(String(defaults.maxPositionSize)),
    maxOpenPositions: contract.maxOpenPositions.effectiveValue,
    maxDrawdown: price(maxDrawdown),
    maxDrawdownPct: contract.maxDrawdownPct.effectiveValue,
    stopLossMaxUnrealizedLossPct: contract.stopLossPct.effectiveValue,
    stopLossCooldownMs: contract.stopLossCooldownMs.effectiveValue,
    // maxPositionSizePct is included when capital is present or when the field has an effective value from creator/override
    ...(contract.maxPositionSizePct.source !== 'default' || capital != null ? {
      maxPositionSizePct: contract.maxPositionSizePct.effectiveValue,
    } : {}),
    ...(capital != null ? {
      maxOrderNotional: price(String(Number.parseFloat(capital) * defaults.maxOrderNotionalMultiplier)),
      dailyMaxLossPct: dailyLossLimit != null
        ? (Number.parseFloat(dailyLossLimit) / Number.parseFloat(capital)) * 100
        : defaults.dailyMaxLossPct,
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