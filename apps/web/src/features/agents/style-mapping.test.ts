import { describe, expect, it } from 'vitest';
import {
  applyAutoMaxHoldOverride,
  deriveStyleMaxHoldDurationMs,
  formatStyleSummary,
  resolveModelPricing,
  resolveStyleDefaults,
  resolveStyleTickIntervalMs,
  STYLE_CONFIG,
  type AgentStyleValue,
} from './style-mapping.js';

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
      // careful: 450min (5× tick), balanced: 90min (3×), bold: 10min (1×)
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

  describe('derived cadence helpers', () => {
    it('uses the style tick interval when no override is given', () => {
      expect(resolveStyleTickIntervalMs('balanced')).toBe(1_800_000);
    });

    it('uses an explicit tick interval override when present', () => {
      expect(resolveStyleTickIntervalMs('balanced', 900_000)).toBe(900_000);
    });

    it('derives max hold from the effective tick interval', () => {
      expect(deriveStyleMaxHoldDurationMs('balanced', 900_000)).toBe(2_700_000);
    });

    it('clears the max-hold override when the derived value matches the style default', () => {
      expect(applyAutoMaxHoldOverride('balanced', { scoutMaxTurns: 50 })).toEqual({ scoutMaxTurns: 50 });
    });

    it('stores an auto max-hold override when cadence differs from the style default', () => {
      expect(applyAutoMaxHoldOverride('balanced', { scoutMaxTurns: 50 }, 900_000)).toEqual({
        scoutMaxTurns: 50,
        maxHoldDurationMs: 2_700_000,
      });
    });
  });

  describe('formatStyleSummary', () => {
    it('produces a fallback summary for careful (no pricing)', () => {
      const summary = formatStyleSummary('careful');
      expect(summary).toContain('~$3/day target');
      expect(summary).toContain('every 90 min');
      expect(summary).not.toContain('turns');
    });

    it('produces a fallback summary for balanced (no pricing)', () => {
      const summary = formatStyleSummary('balanced');
      expect(summary).toContain('~$10/day target');
      expect(summary).toContain('every 30 min');
    });

    it('produces a fallback summary for bold (no pricing)', () => {
      const summary = formatStyleSummary('bold');
      expect(summary).toContain('~$30/day target');
      expect(summary).toContain('every 10 min');
    });

    it('computes estimated cost when full pricing is provided', () => {
      // economy input=$0.08, output=$0.15; premium input=$1.00, output=$2.00 (per 1M tokens)
      const summary = formatStyleSummary('careful', {
        economyInputUsdPer1M: 0.08,
        economyOutputUsdPer1M: 0.15,
        premiumInputUsdPer1M: 1.00,
        premiumOutputUsdPer1M: 2.00,
      });
      expect(summary).toContain('~$');
      expect(summary).toContain('/day');
      expect(summary).toContain('every 90 min');
      expect(summary).not.toContain('target');
      expect(summary).not.toContain('turns');
    });

    it('computes higher cost for bold with same pricing', () => {
      // bold has 10min ticks → 144 ticks/day + higher escalation rate (60% vs 5%)
      const pricing = {
        economyInputUsdPer1M: 0.08,
        economyOutputUsdPer1M: 0.15,
        premiumInputUsdPer1M: 1.00,
        premiumOutputUsdPer1M: 2.00,
      };
      const boldSummary = formatStyleSummary('bold', pricing);
      const carefulSummary = formatStyleSummary('careful', pricing);
      // Bold should cost more than careful
      const boldCost = Number(boldSummary.match(/\$([\d.]+)\/day/)![1]);
      const carefulCost = Number(carefulSummary.match(/\$([\d.]+)\/day/)![1]);
      expect(boldCost).toBeGreaterThan(carefulCost);
    });

    it('uses an explicit cadence override in the summary text and cost math', () => {
      const summary = formatStyleSummary('balanced', {
        economyInputUsdPer1M: 0.08,
        economyOutputUsdPer1M: 0.15,
        premiumInputUsdPer1M: 1.00,
        premiumOutputUsdPer1M: 2.00,
      }, 900_000);
      expect(summary).toContain('every 15 min');
      expect(summary).not.toContain('every 30 min');
    });

    it('shows legacy non-whole-minute cadence precisely when overridden', () => {
      const summary = formatStyleSummary('balanced', undefined, 90_000);
      expect(summary).toContain('every 1.5 min');
    });

    it('falls back when economy input price is 0', () => {
      const summary = formatStyleSummary('careful', {
        economyInputUsdPer1M: 0,
        economyOutputUsdPer1M: 0.15,
        premiumInputUsdPer1M: 1.00,
        premiumOutputUsdPer1M: 2.00,
      });
      expect(summary).toContain('~$3/day target');
    });

    it('falls back when economy output price is 0', () => {
      const summary = formatStyleSummary('careful', {
        economyInputUsdPer1M: 0.08,
        economyOutputUsdPer1M: 0,
        premiumInputUsdPer1M: 1.00,
        premiumOutputUsdPer1M: 2.00,
      });
      expect(summary).toContain('~$3/day target');
    });

    it('falls back when premium input price is 0', () => {
      const summary = formatStyleSummary('careful', {
        economyInputUsdPer1M: 0.08,
        economyOutputUsdPer1M: 0.15,
        premiumInputUsdPer1M: 0,
        premiumOutputUsdPer1M: 2.00,
      });
      expect(summary).toContain('~$3/day target');
    });

    it('falls back when premium output price is 0', () => {
      const summary = formatStyleSummary('careful', {
        economyInputUsdPer1M: 0.08,
        economyOutputUsdPer1M: 0.15,
        premiumInputUsdPer1M: 1.00,
        premiumOutputUsdPer1M: 0,
      });
      expect(summary).toContain('~$3/day target');
    });
  });

  describe('resolveModelPricing', () => {
    const providers = [
      {
        provider: 'openrouter',
        models: [
          { id: 'economy-1', pricing: { inputUsdPer1M: '0.08', outputUsdPer1M: '0.15' } },
          { id: 'premium-1', pricing: { inputUsdPer1M: '1.00', outputUsdPer1M: '2.00' } },
        ],
      },
    ];

    it('returns full pricing for known models', () => {
      const pricing = resolveModelPricing(providers, 'openrouter', 'economy-1', 'premium-1');
      expect(pricing).toEqual({
        economyInputUsdPer1M: 0.08,
        economyOutputUsdPer1M: 0.15,
        premiumInputUsdPer1M: 1.00,
        premiumOutputUsdPer1M: 2.00,
      });
    });

    it('returns undefined when provider is empty', () => {
      expect(resolveModelPricing(providers, '', 'economy-1', 'premium-1')).toBeUndefined();
    });

    it('returns undefined when models not found', () => {
      expect(resolveModelPricing(providers, 'openrouter', 'unknown', 'premium-1')).toBeUndefined();
    });

    it('returns undefined when output pricing is missing', () => {
      const noPricing = [
        {
          provider: 'openrouter',
          models: [
            { id: 'economy-1', pricing: undefined },
            { id: 'premium-1', pricing: { inputUsdPer1M: '1.00', outputUsdPer1M: '2.00' } },
          ],
        },
      ];
      expect(resolveModelPricing(noPricing, 'openrouter', 'economy-1', 'premium-1')).toBeUndefined();
    });

    it('returns undefined when input pricing is missing', () => {
      const missingInput = [
        {
          provider: 'openrouter',
          models: [
            { id: 'economy-1', pricing: { outputUsdPer1M: '0.15' } },
            { id: 'premium-1', pricing: { inputUsdPer1M: '1.00', outputUsdPer1M: '2.00' } },
          ],
        },
      ];
      expect(resolveModelPricing(missingInput, 'openrouter', 'economy-1', 'premium-1')).toBeUndefined();
    });

    it('returns undefined when provider not found', () => {
      expect(resolveModelPricing(providers, 'other', 'economy-1', 'premium-1')).toBeUndefined();
    });
  });
});
