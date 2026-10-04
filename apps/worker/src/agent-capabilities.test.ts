import { describe, expect, it } from 'vitest';
import type { SkillDefinition } from '@herobids/domain';
import {
  BASE_SKILL,
  TASK_MANAGEMENT_SKILL,
  WEB_ACCESS_SKILL,
  PROGRAMMING_SKILL,
} from '@herobids/domain';
import { deriveHasTradingCapability, deriveTradingTickWorkPlan } from './agent-capabilities.js';

// Phase 4 (D21/EC-1): the built-in trading skills were removed. Trading
// capability is now carried by an installed external skills.sh skill whose
// resolved definition declares the 'trading' capability family. These synthetic
// definitions stand in for such installed skills.
function makeTradingSkill(id: string): SkillDefinition {
  return {
    id,
    name: id,
    description: `Installed external trading skill (${id})`,
    instructions: 'Resolved over MCP at runtime.',
    requiredTools: [],
    capabilityFamilies: ['trading'],
    bindingRequirements: {},
    contextRequirements: [],
    requiredContextBlocks: ['corePlatformContext'],
    promptRendererHints: ['core-system'],
    requiredGuardrails: [],
    suggestedTickIntervalMs: 900_000,
    visibility: 'private',
  };
}

const CRYPTO_TRADING_DEF = makeTradingSkill('traderton/skills/crypto-trading');
const CRYPTO_BOT_MGMT_DEF = makeTradingSkill('traderton/skills/crypto-bot-management');
const CRYPTO_RISK_MON_DEF = makeTradingSkill('traderton/skills/crypto-risk-monitoring');

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

  it('returns true when an installed bot-management trading skill is present', () => {
    expect(deriveHasTradingCapability([BASE_SKILL, CRYPTO_BOT_MGMT_DEF])).toBe(true);
  });

  it('returns true when an installed trading skill is present', () => {
    expect(deriveHasTradingCapability([BASE_SKILL, CRYPTO_TRADING_DEF])).toBe(true);
  });

  it('returns true when an installed risk-monitoring trading skill is present', () => {
    expect(deriveHasTradingCapability([BASE_SKILL, CRYPTO_RISK_MON_DEF])).toBe(true);
  });

  it('returns true for an agent with both trading and non-trading skills', () => {
    expect(deriveHasTradingCapability([BASE_SKILL, TASK_MANAGEMENT_SKILL, CRYPTO_BOT_MGMT_DEF])).toBe(true);
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

  it('enables market-data and trading follow-up work for a trading agent with a boundary', () => {
    expect(deriveTradingTickWorkPlan([BASE_SKILL, CRYPTO_TRADING_DEF], true)).toEqual({
      hasTradingCapability: true,
      shouldEvaluateRegime: true,
      shouldFetchVolatilityPct: true,
      shouldRecordRegimeEvaluation: true,
      shouldRefreshVenueIntelligence: true,
      shouldRecordPerformanceInputs: true,
    });
  });

  it('keeps trading follow-up work enabled even when the boundary is unavailable', () => {
    expect(deriveTradingTickWorkPlan([BASE_SKILL, CRYPTO_BOT_MGMT_DEF], false)).toEqual({
      hasTradingCapability: true,
      shouldEvaluateRegime: false,
      shouldFetchVolatilityPct: false,
      shouldRecordRegimeEvaluation: true,
      shouldRefreshVenueIntelligence: true,
      shouldRecordPerformanceInputs: true,
    });
  });

  it('evaluates regime and volatility over the boundary when the boundary is present', () => {
    // Target end-state (B7): in-process registry removed, regime sourced over
    // check_regime and volatility over get_volatility (B5) — both evaluate over
    // the boundary, which is now the sole source.
    expect(deriveTradingTickWorkPlan([BASE_SKILL, CRYPTO_TRADING_DEF], true)).toEqual({
      hasTradingCapability: true,
      shouldEvaluateRegime: true,
      shouldFetchVolatilityPct: true,
      shouldRecordRegimeEvaluation: true,
      shouldRefreshVenueIntelligence: true,
      shouldRecordPerformanceInputs: true,
    });
  });
});
