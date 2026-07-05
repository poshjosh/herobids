import { describe, it, expect } from 'vitest';
import { buildAgentRiskLimits, resolveContract, extractCeilings, extractCreatorInput, type AgentRiskLimitSource } from './agent-risk-limits.js';
import type { AgentRiskDefaultsConfig } from '@herobids/domain';

const DEFAULTS: AgentRiskDefaultsConfig = {
  maxOpenPositions: 10,
  maxPositionSizePct: 100,
  maxPositionSize: 1_000_000,
  stopLossMaxUnrealizedLossPct: 10,
  dailyMaxLossPct: 20,
  stopLossCooldownMs: 300_000,
  maxOrderNotionalMultiplier: 1,
  maxDrawdown: 1_000_000_000,
  botConfigInvalidHaltThreshold: 1,
  botExecutionErrorHaltThreshold: 5,
};

const EMPTY_SOURCE: AgentRiskLimitSource = {
  capital: null,
  dailyLossLimit: null,
  maxDrawdown: null,
  maxOpenPositions: null,
  maxPositionSizePct: null,
  stopLossPct: null,
  stopLossCooldownMs: null,
};

describe('buildAgentRiskLimits()', () => {
  describe('maxPositionSizePct', () => {
    it('omits maxPositionSizePct when neither source nor capital is provided', () => {
      // Percentage-based sizing has no meaning without a capital base.
      // When neither is set, the field is omitted so callers can detect the absence.
      const limits = buildAgentRiskLimits(EMPTY_SOURCE, DEFAULTS);
      expect(limits.maxPositionSizePct).toBeUndefined();
    });

    it('preserves user-configured maxPositionSizePct even when capital is null', () => {
      // Regression guard: previously this field was dropped when capital was null
      const limits = buildAgentRiskLimits(
        { ...EMPTY_SOURCE, capital: null, maxPositionSizePct: 25 },
        DEFAULTS,
      );
      expect(limits.maxPositionSizePct).toBe(25);
    });

    it('preserves user-configured maxPositionSizePct when capital is also provided', () => {
      const limits = buildAgentRiskLimits(
        { ...EMPTY_SOURCE, capital: '10000', maxPositionSizePct: 15 },
        DEFAULTS,
      );
      expect(limits.maxPositionSizePct).toBe(15);
    });

    it('accepts string-encoded percentage values', () => {
      const limits = buildAgentRiskLimits(
        { ...EMPTY_SOURCE, maxPositionSizePct: '30.5' },
        DEFAULTS,
      );
      expect(limits.maxPositionSizePct).toBe(30.5);
    });
  });

  describe('capital-dependent fields', () => {
    it('does not include maxOrderNotional when capital is null', () => {
      const limits = buildAgentRiskLimits(EMPTY_SOURCE, DEFAULTS);
      expect(limits.maxOrderNotional).toBeUndefined();
    });

    it('computes maxOrderNotional from capital × multiplier when capital is provided', () => {
      const limits = buildAgentRiskLimits(
        { ...EMPTY_SOURCE, capital: '10000' },
        { ...DEFAULTS, maxOrderNotionalMultiplier: 0.1 },
      );
      // 10000 * 0.1 = 1000
      expect(limits.maxOrderNotional?.toString()).toBe('1000');
    });
  });

  describe('stopLossPct', () => {
    it('uses default stopLossMaxUnrealizedLossPct when source is null', () => {
      const limits = buildAgentRiskLimits(EMPTY_SOURCE, DEFAULTS);
      expect(limits.stopLossMaxUnrealizedLossPct).toBe(DEFAULTS.stopLossMaxUnrealizedLossPct);
    });

    it('uses user-configured stopLossPct over default', () => {
      const limits = buildAgentRiskLimits(
        { ...EMPTY_SOURCE, stopLossPct: 5 },
        DEFAULTS,
      );
      expect(limits.stopLossMaxUnrealizedLossPct).toBe(5);
    });
  });

  describe('overrides integration', () => {
    it('applies agent override when no creator value is present', () => {
      const limits = buildAgentRiskLimits(EMPTY_SOURCE, DEFAULTS, { maxOpenPositions: 7 });
      expect(limits.maxOpenPositions).toBe(7);
    });

    it('ignores override when creator value is present', () => {
      const limits = buildAgentRiskLimits(
        { ...EMPTY_SOURCE, maxOpenPositions: 5 },
        DEFAULTS,
        { maxOpenPositions: 3 },
      );
      expect(limits.maxOpenPositions).toBe(5);
    });

    it('caps override at operator ceiling', () => {
      const limits = buildAgentRiskLimits(EMPTY_SOURCE, DEFAULTS, { maxOpenPositions: 50 });
      expect(limits.maxOpenPositions).toBe(10); // operator ceiling
    });

    it('applies stopLossPct override', () => {
      const limits = buildAgentRiskLimits(EMPTY_SOURCE, DEFAULTS, { stopLossPct: 5 });
      expect(limits.stopLossMaxUnrealizedLossPct).toBe(5);
    });

    it('applies stopLossCooldownMs override', () => {
      const limits = buildAgentRiskLimits(EMPTY_SOURCE, DEFAULTS, { stopLossCooldownMs: 60_000 });
      expect(limits.stopLossCooldownMs).toBe(60_000);
    });
  });
});

describe('resolveContract()', () => {
  it('resolves full contract with correct source attribution', () => {
    const source: AgentRiskLimitSource = {
      capital: '10000',
      dailyLossLimit: '500',
      maxOpenPositions: 5,
      maxPositionSizePct: null,
      stopLossPct: null,
      stopLossCooldownMs: null,
    };
    const overrides = { stopLossPct: 7 };

    const contract = resolveContract(source, DEFAULTS, overrides);

    expect(contract.maxOpenPositions.source).toBe('user');
    expect(contract.maxOpenPositions.mutable).toBe(false);
    expect(contract.maxOpenPositions.effectiveValue).toBe(5);

    expect(contract.maxPositionSizePct.source).toBe('default');
    expect(contract.maxPositionSizePct.mutable).toBe(true);
    expect(contract.maxPositionSizePct.effectiveValue).toBe(100);

    expect(contract.stopLossPct.source).toBe('agent_override');
    expect(contract.stopLossPct.mutable).toBe(true);
    expect(contract.stopLossPct.effectiveValue).toBe(7);

    expect(contract.stopLossCooldownMs.source).toBe('default');
    expect(contract.stopLossCooldownMs.mutable).toBe(true);
  });
});

describe('extractCeilings()', () => {
  it('maps AgentRiskDefaultsConfig fields to ceilings', () => {
    const ceilings = extractCeilings(DEFAULTS);
    expect(ceilings.maxOpenPositions).toBe(10);
    expect(ceilings.maxPositionSizePct).toBe(100);
    expect(ceilings.stopLossPct).toBe(10);
    expect(ceilings.stopLossCooldownMs).toBe(300_000);
  });
});

describe('extractCreatorInput()', () => {
  it('preserves non-null creator values and nulls null fields', () => {
    const input = extractCreatorInput({
      capital: '1000',
      dailyLossLimit: '100',
      maxOpenPositions: 5,
      maxPositionSizePct: '25',
      stopLossPct: null,
      stopLossCooldownMs: null,
    });
    expect(input.maxOpenPositions).toBe(5);
    expect(input.maxPositionSizePct).toBe(25);
    expect(input.stopLossPct).toBeNull();
    expect(input.stopLossCooldownMs).toBeNull();
  });
});
