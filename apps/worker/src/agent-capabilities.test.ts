import { describe, expect, it } from 'vitest';
import {
  BASE_SKILL,
  BOT_MANAGEMENT_SKILL,
  TASK_MANAGEMENT_SKILL,
  TRADING_SKILL,
  RISK_MONITORING_SKILL,
  WEB_ACCESS_SKILL,
  PROGRAMMING_SKILL,
} from '@herobids/domain';
import { deriveHasTradingCapability, deriveTradingTickWorkPlan } from './agent-capabilities.js';

describe('deriveHasTradingCapability', () => {
  it('returns false for an agent with only the base skill', () => {
    expect(deriveHasTradingCapability([BASE_SKILL])).toBe(false);
  });

  it('returns false for a non-trading agent (task-management + base)', () => {
    expect(deriveHasTradingCapability([BASE_SKILL, TASK_MANAGEMENT_SKILL])).toBe(false);
  });

  it('returns false for a web-access + programming agent', () => {
    expect(deriveHasTradingCapability([BASE_SKILL, WEB_ACCESS_SKILL, PROGRAMMING_SKILL])).toBe(false);
  });

  it('returns true when bot-management skill is present', () => {
    expect(deriveHasTradingCapability([BASE_SKILL, BOT_MANAGEMENT_SKILL])).toBe(true);
  });

  it('returns true when trading skill is present', () => {
    expect(deriveHasTradingCapability([BASE_SKILL, TRADING_SKILL])).toBe(true);
  });

  it('returns true when risk-monitoring skill is present', () => {
    expect(deriveHasTradingCapability([BASE_SKILL, RISK_MONITORING_SKILL])).toBe(true);
  });

  it('returns true for an agent with both trading and non-trading skills', () => {
    expect(deriveHasTradingCapability([BASE_SKILL, TASK_MANAGEMENT_SKILL, BOT_MANAGEMENT_SKILL])).toBe(true);
  });

  it('returns false for an empty skill set', () => {
    expect(deriveHasTradingCapability([])).toBe(false);
  });
});

describe('deriveTradingTickWorkPlan', () => {
  it('disables all trading tick work for a non-trading agent', () => {
    expect(deriveTradingTickWorkPlan([BASE_SKILL, TASK_MANAGEMENT_SKILL], true)).toEqual({
      hasTradingCapability: false,
      shouldEvaluateRegime: false,
      shouldFetchVolatilityPct: false,
      shouldRecordRegimeEvaluation: false,
      shouldRefreshVenueIntelligence: false,
      shouldRecordPerformanceInputs: false,
    });
  });

  it('enables market-data and trading follow-up work for a trading agent with market data access', () => {
    expect(deriveTradingTickWorkPlan([BASE_SKILL, TRADING_SKILL], true)).toEqual({
      hasTradingCapability: true,
      shouldEvaluateRegime: true,
      shouldFetchVolatilityPct: true,
      shouldRecordRegimeEvaluation: true,
      shouldRefreshVenueIntelligence: true,
      shouldRecordPerformanceInputs: true,
    });
  });

  it('keeps trading follow-up work enabled even when market data is unavailable', () => {
    expect(deriveTradingTickWorkPlan([BASE_SKILL, BOT_MANAGEMENT_SKILL], false)).toEqual({
      hasTradingCapability: true,
      shouldEvaluateRegime: false,
      shouldFetchVolatilityPct: false,
      shouldRecordRegimeEvaluation: true,
      shouldRefreshVenueIntelligence: true,
      shouldRecordPerformanceInputs: true,
    });
  });

  it('evaluates regime and volatility over the boundary when the in-process registry is absent but the boundary is present', () => {
    // Target end-state: registry removed, regime sourced over check_regime and
    // volatility over get_volatility (B5). Both must still evaluate over the boundary.
    expect(deriveTradingTickWorkPlan([BASE_SKILL, TRADING_SKILL], false, true)).toEqual({
      hasTradingCapability: true,
      shouldEvaluateRegime: true,
      shouldFetchVolatilityPct: true,
      shouldRecordRegimeEvaluation: true,
      shouldRefreshVenueIntelligence: true,
      shouldRecordPerformanceInputs: true,
    });
  });
});
