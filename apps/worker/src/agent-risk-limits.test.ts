import { describe, it, expect } from 'vitest';
import { buildAgentRiskLimits, type AgentRiskLimitSource } from './agent-risk-limits.js';
import type { AgentRiskDefaultsConfig } from '@herobids/domain';

const DEFAULTS: AgentRiskDefaultsConfig = {
  maxOpenPositions: 10,
  maxPositionSizePct: 100,
  maxPositionSize: 1_000_000,
  stopLossMaxUnrealizedLossPct: 10,
  dailyMaxLossPct: 20,
  stopLossCooldownMs: 300_000,
  maxOrderNotionalMultiplier: 1,
};

const EMPTY_SOURCE: AgentRiskLimitSource = {
  capital: null,
  dailyLossLimit: null,
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
});
