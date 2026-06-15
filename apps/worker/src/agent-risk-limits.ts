import { price, quantity, type AgentRiskDefaultsConfig } from '@herobids/domain';
import type { RiskLimits } from '@herobids/engine';

export interface AgentRiskLimitSource {
  capital: string | null;
  dailyLossLimit: string | null;
  maxOpenPositions: number | null;
  maxPositionSizePct: string | number | null;
  stopLossPct: string | number | null;
  stopLossCooldownMs: number | null;
}

function parseOptionalNumber(value: string | number | null): number | undefined {
  if (value == null) {
    return undefined;
  }

  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function buildAgentRiskLimits(source: AgentRiskLimitSource, defaults: AgentRiskDefaultsConfig): RiskLimits {
  const capital = source.capital;
  const dailyLossLimit = source.dailyLossLimit;

  return {
    maxPositionSize: quantity(String(defaults.maxPositionSize)),
    maxOpenPositions: source.maxOpenPositions ?? defaults.maxOpenPositions,
    maxDrawdown: price(dailyLossLimit ?? '1000000000'),
    stopLossMaxUnrealizedLossPct: parseOptionalNumber(source.stopLossPct) ?? defaults.stopLossMaxUnrealizedLossPct,
    stopLossCooldownMs: source.stopLossCooldownMs ?? defaults.stopLossCooldownMs,
    // maxPositionSizePct is user-configurable independently of capital — preserve it whenever set.
    // When capital is null and the user hasn't explicitly configured it, omit it entirely
    // (percentage-based sizing has no meaning without a capital base).
    ...(parseOptionalNumber(source.maxPositionSizePct) != null || capital != null ? {
      maxPositionSizePct: parseOptionalNumber(source.maxPositionSizePct) ?? defaults.maxPositionSizePct,
    } : {}),
    ...(capital != null ? {
      maxOrderNotional: price(String(Number.parseFloat(capital) * defaults.maxOrderNotionalMultiplier)),
      dailyMaxLossPct: dailyLossLimit != null
        ? (Number.parseFloat(dailyLossLimit) / Number.parseFloat(capital)) * 100
        : defaults.dailyMaxLossPct,
    } : {}),
  };
}