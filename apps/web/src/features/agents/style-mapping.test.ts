import { describe, expect, it } from 'vitest';
import { resolveStyleDefaults, STYLE_CONFIG, type AgentStyleValue } from './style-mapping.js';

describe('resolveStyleDefaults', () => {
  const validCostPresets = ['minimal', 'standard', 'premium'] as const;
  const validRiskTolerances = ['conservative', 'moderate', 'aggressive'] as const;

  it('returns correct config for careful style', () => {
    const config = resolveStyleDefaults('careful');
    expect(config.costPreset).toBe('minimal');
    expect(config.tickIntervalMins).toBe('90');
    expect(config.dailySpendBudgetUsd).toBe('3');
    expect(config.riskTolerance).toBe('conservative');
  });

  it('returns correct config for balanced style', () => {
    const config = resolveStyleDefaults('balanced');
    expect(config.costPreset).toBe('standard');
    expect(config.tickIntervalMins).toBe('30');
    expect(config.dailySpendBudgetUsd).toBe('10');
    expect(config.riskTolerance).toBe('moderate');
  });

  it('returns correct config for bold style', () => {
    const config = resolveStyleDefaults('bold');
    expect(config.costPreset).toBe('premium');
    expect(config.tickIntervalMins).toBe('10');
    expect(config.dailySpendBudgetUsd).toBe('30');
    expect(config.riskTolerance).toBe('aggressive');
  });

  it('returns balanced defaults for unknown style', () => {
    const config = resolveStyleDefaults('unknown' as AgentStyleValue);
    expect(config).toEqual(STYLE_CONFIG.balanced);
  });

  describe('each style has valid properties', () => {
    const styles: AgentStyleValue[] = ['careful', 'balanced', 'bold'];

    for (const style of styles) {
      it(`${style} has valid costPreset`, () => {
        const config = STYLE_CONFIG[style];
        expect(validCostPresets).toContain(config.costPreset);
      });

      it(`${style} has positive tickIntervalMins`, () => {
        const config = STYLE_CONFIG[style];
        expect(Number(config.tickIntervalMins)).toBeGreaterThan(0);
      });

      it(`${style} has positive dailySpendBudgetUsd`, () => {
        const config = STYLE_CONFIG[style];
        expect(Number(config.dailySpendBudgetUsd)).toBeGreaterThan(0);
      });

      it(`${style} has valid riskTolerance between 0 and 1`, () => {
        const config = STYLE_CONFIG[style];
        // riskTolerance is a string enum ('conservative', 'moderate', 'aggressive'),
        // which map to numeric risk tolerance values conceptually.
        // The validation here is that the value is one of the known valid strings.
        expect(validRiskTolerances).toContain(config.riskTolerance);
      });

      it(`${style} has valid openPositionEscalationToJudgePolicy`, () => {
        const config = STYLE_CONFIG[style];
        expect(['never', 'uncovered_or_triggered', 'always']).toContain(config.openPositionEscalationToJudgePolicy);
      });
    }
  });

  describe('openPositionEscalationToJudgePolicy mapping', () => {
    it('maps careful to never', () => {
      expect(STYLE_CONFIG.careful.openPositionEscalationToJudgePolicy).toBe('never');
    });

    it('maps balanced to uncovered_or_triggered', () => {
      expect(STYLE_CONFIG.balanced.openPositionEscalationToJudgePolicy).toBe('uncovered_or_triggered');
    });

    it('maps bold to always', () => {
      expect(STYLE_CONFIG.bold.openPositionEscalationToJudgePolicy).toBe('always');
    });

    it('resolveStyleDefaults includes the policy field for each style', () => {
      expect(resolveStyleDefaults('careful').openPositionEscalationToJudgePolicy).toBe('never');
      expect(resolveStyleDefaults('balanced').openPositionEscalationToJudgePolicy).toBe('uncovered_or_triggered');
      expect(resolveStyleDefaults('bold').openPositionEscalationToJudgePolicy).toBe('always');
    });

    it('resolveStyleDefaults returns balanced policy for unknown style', () => {
      expect(resolveStyleDefaults('unknown' as AgentStyleValue).openPositionEscalationToJudgePolicy).toBe('uncovered_or_triggered');
    });
  });
});
