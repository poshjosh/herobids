import { describe, expect, it } from 'vitest';
import { resolveStyleDefaults, STYLE_CONFIG, formatStyleSummary, type AgentStyleValue } from './style-mapping.js';

describe('resolveStyleDefaults', () => {
  const validCostPresets = ['minimal', 'standard', 'premium'] as const;

  it('returns correct config for careful style', () => {
    const config = resolveStyleDefaults('careful');
    expect(config.costPreset).toBe('minimal');
    expect(config.tickIntervalMins).toBe('90');
    expect(config.dailySpendBudgetUsd).toBe('3');
    expect(config.scoutMaxTurns).toBe(10);
    expect(config.judgeMaxTurns).toBe(25);
    expect(config.maxHistoryTokens).toBe(20_000);
    expect(config.weekendPause).toBe(true);
    expect(config.allowedHoursUtc).toEqual([14, 15, 16, 17, 18, 19, 20]);
  });

  it('returns correct config for balanced style', () => {
    const config = resolveStyleDefaults('balanced');
    expect(config.costPreset).toBe('standard');
    expect(config.tickIntervalMins).toBe('30');
    expect(config.dailySpendBudgetUsd).toBe('10');
    expect(config.scoutMaxTurns).toBe(30);
    expect(config.judgeMaxTurns).toBe(75);
    expect(config.maxHistoryTokens).toBe(40_000);
    expect(config.weekendPause).toBe(true);
  });

  it('returns correct config for bold style', () => {
    const config = resolveStyleDefaults('bold');
    expect(config.costPreset).toBe('premium');
    expect(config.tickIntervalMins).toBe('10');
    expect(config.dailySpendBudgetUsd).toBe('30');
    expect(config.scoutMaxTurns).toBe(100);
    expect(config.judgeMaxTurns).toBe(300);
    expect(config.maxHistoryTokens).toBe(80_000);
    expect(config.weekendPause).toBe(false);
    expect(config.allowedHoursUtc).toEqual([]);
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

      it(`${style} has valid openPositionEscalationToJudgePolicy`, () => {
        const config = STYLE_CONFIG[style];
        expect(['never', 'uncovered_or_triggered', 'always']).toContain(config.openPositionEscalationToJudgePolicy);
      });

      it(`${style} has positive scoutMaxTurns`, () => {
        const config = STYLE_CONFIG[style];
        expect(config.scoutMaxTurns).toBeGreaterThan(0);
      });

      it(`${style} has positive judgeMaxTurns`, () => {
        const config = STYLE_CONFIG[style];
        expect(config.judgeMaxTurns).toBeGreaterThan(0);
      });

      it(`${style} has positive scoutMaxTokens`, () => {
        const config = STYLE_CONFIG[style];
        expect(config.scoutMaxTokens).toBeGreaterThan(0);
      });

      it(`${style} has maxHistoryMessages in range`, () => {
        const config = STYLE_CONFIG[style];
        expect(config.maxHistoryMessages).toBeGreaterThan(0);
        expect(config.maxHistoryMessages).toBeLessThanOrEqual(80);
      });

      it(`${style} has maxHoldDurationMs in range`, () => {
        const config = STYLE_CONFIG[style];
        expect(config.maxHoldDurationMs).toBeGreaterThan(0);
        expect(config.maxHoldDurationMs).toBeLessThanOrEqual(86_400_000);
      });

      it(`${style} weekendPause is boolean`, () => {
        const config = STYLE_CONFIG[style];
        expect(typeof config.weekendPause).toBe('boolean');
      });

      it(`${style} allowedHoursUtc is an array of valid hours`, () => {
        const config = STYLE_CONFIG[style];
        expect(Array.isArray(config.allowedHoursUtc)).toBe(true);
        for (const h of config.allowedHoursUtc) {
          expect(h).toBeGreaterThanOrEqual(0);
          expect(h).toBeLessThanOrEqual(23);
          expect(Number.isInteger(h)).toBe(true);
        }
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

  describe('runtime policy defaults', () => {
    it('bold has highest tool turn and token limits', () => {
      const careful = STYLE_CONFIG.careful;
      const bold = STYLE_CONFIG.bold;
      expect(bold.scoutMaxTurns).toBeGreaterThan(careful.scoutMaxTurns);
      expect(bold.judgeMaxTurns).toBeGreaterThan(careful.judgeMaxTurns);
      expect(bold.scoutMaxTokens).toBeGreaterThan(careful.scoutMaxTokens);
      expect(bold.judgeMaxTokens).toBeGreaterThan(careful.judgeMaxTokens);
      expect(bold.maxHistoryTokens).toBeGreaterThan(careful.maxHistoryTokens);
    });

    it('bold has the shortest maxHoldDurationMs (most aggressive hold timeout)', () => {
      // Careful has 180min hold → highest value (most patient); bold has 30min → lowest (most aggressive)
      expect(STYLE_CONFIG.bold.maxHoldDurationMs).toBeLessThan(STYLE_CONFIG.careful.maxHoldDurationMs);
    });

    it('balanced has empty allowedHoursUtc (always allowed)', () => {
      expect(STYLE_CONFIG.balanced.allowedHoursUtc).toEqual([]);
      expect(STYLE_CONFIG.bold.allowedHoursUtc).toEqual([]);
    });

    it('careful has restricted US overlap hours', () => {
      expect(STYLE_CONFIG.careful.allowedHoursUtc.length).toBeGreaterThan(0);
      expect(STYLE_CONFIG.careful.allowedHoursUtc).toContain(14);
      expect(STYLE_CONFIG.careful.allowedHoursUtc).toContain(20);
    });
  });

  describe('formatStyleSummary', () => {
    it('produces a summary string for careful', () => {
      const summary = formatStyleSummary('careful');
      expect(summary).toContain('10/25 turns');
      expect(summary).toContain('$3/day');
    });

    it('produces a summary string for balanced', () => {
      const summary = formatStyleSummary('balanced');
      expect(summary).toContain('30/75 turns');
      expect(summary).toContain('4K tokens');
      expect(summary).toContain('$10/day');
    });

    it('produces a summary string for bold', () => {
      const summary = formatStyleSummary('bold');
      expect(summary).toContain('100/300 turns');
      expect(summary).toContain('$30/day');
    });
  });
});
