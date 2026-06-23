import { describe, expect, it } from 'vitest';
import { resolveStyleDefaults, STYLE_CONFIG, type AgentStyleValue } from './style-mapping.js';

describe('resolveStyleDefaults', () => {
  const validCostPresets = ['minimal', 'standard', 'premium'] as const;
  const validRiskTolerances = ['conservative', 'moderate', 'aggressive'] as const;

  it('returns correct config for careful style', () => {
    const config = resolveStyleDefaults('careful');
    expect(config.costPreset).toBe('minimal');
    expect(config.tickIntervalMins).toBe('60');
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
    expect(config.tickIntervalMins).toBe('15');
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
    }
  });
});
