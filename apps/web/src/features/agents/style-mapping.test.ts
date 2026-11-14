import { describe, expect, it } from 'vitest';
import { deriveStyleMaxHoldDurationMs } from '@herobids/domain';
import {
  applyAutoMaxHoldOverride,
  formatStyleSummary,
  reconcileMaxHoldOverride,
  resolveModelPricing,
  resolveStyleDefaults,
  resolveStyleTickIntervalMs,
  resolveStyleTickIntervalMins,
  resolveDefaultSkipUnchangedTicks,
  resolveEffectiveSkipUnchangedTicks,
  NON_TRADING_DEFAULT_TICK_INTERVAL_MINS,
  STYLE_CONFIG,
  type AgentStyleValue,
} from './style-mapping.js';

describe('resolveStyleDefaults', () => {
  const validCostPresets = ['minimal', 'standard', 'premium'] as const;

  it('returns correct config for careful style', () => {
    const config = resolveStyleDefaults('careful');
    expect(config.costPreset).toBe('standard');
    expect(config.tickIntervalMins).toBe('30');
    expect(config.dailySpendBudgetUsd).toBe('10');
    expect(config.scoutMaxTurns).toBe(499);
    expect(config.judgeMaxTurns).toBe(9_999);
    expect(config.maxHistoryTokens).toBe(40_000);
    expect(config.weekendPause).toBe(false);
    expect(config.allowedHoursUtc).toEqual([]);  // careful no longer restricts hours
  });

  it('returns correct config for balanced style', () => {
    const config = resolveStyleDefaults('balanced');
    expect(config.costPreset).toBe('premium');
    expect(config.tickIntervalMins).toBe('10');
    expect(config.dailySpendBudgetUsd).toBe('30');
    expect(config.scoutMaxTurns).toBe(499);
    expect(config.judgeMaxTurns).toBe(9_999);
    expect(config.maxHistoryTokens).toBe(80_000);
    expect(config.weekendPause).toBe(false);
  });

  it('returns correct config for bold style', () => {
    const config = resolveStyleDefaults('bold');
    expect(config.costPreset).toBe('premium');
    expect(config.tickIntervalMins).toBe('10');
    expect(config.dailySpendBudgetUsd).toBe('30');
    expect(config.scoutMaxTurns).toBe(499);
    expect(config.judgeMaxTurns).toBe(9_999);
    expect(config.maxHistoryTokens).toBe(160_000);
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
    it('maps careful to uncovered_or_triggered', () => {
      expect(STYLE_CONFIG.careful.openPositionEscalationToJudgePolicy).toBe('uncovered_or_triggered');
    });

    it('maps balanced to always', () => {
      expect(STYLE_CONFIG.balanced.openPositionEscalationToJudgePolicy).toBe('always');
    });

    it('maps bold to always', () => {
      expect(STYLE_CONFIG.bold.openPositionEscalationToJudgePolicy).toBe('always');
    });

    it('resolveStyleDefaults includes the policy field for each style', () => {
      expect(resolveStyleDefaults('careful').openPositionEscalationToJudgePolicy).toBe('uncovered_or_triggered');
      expect(resolveStyleDefaults('balanced').openPositionEscalationToJudgePolicy).toBe('always');
      expect(resolveStyleDefaults('bold').openPositionEscalationToJudgePolicy).toBe('always');
    });

    it('resolveStyleDefaults returns balanced policy for unknown style', () => {
      expect(resolveStyleDefaults('unknown' as AgentStyleValue).openPositionEscalationToJudgePolicy).toBe('always');
    });
  });

  describe('runtime policy defaults', () => {
    it('bold has highest tool turn and token limits', () => {
      const careful = STYLE_CONFIG.careful;
      const bold = STYLE_CONFIG.bold;
      // Turn budgets are intentionally uniform across styles (all set to near-ceiling);
      // only token/history budgets remain graduated.
      expect(bold.scoutMaxTurns).toBeGreaterThanOrEqual(careful.scoutMaxTurns);
      expect(bold.judgeMaxTurns).toBeGreaterThanOrEqual(careful.judgeMaxTurns);
      expect(bold.scoutMaxTokens).toBeGreaterThan(careful.scoutMaxTokens);
      expect(bold.judgeMaxTokens).toBeGreaterThan(careful.judgeMaxTokens);
      expect(bold.maxHistoryTokens).toBeGreaterThan(careful.maxHistoryTokens);
    });

    it('bold has the shortest maxHoldDurationMs (most aggressive hold timeout)', () => {
      // careful: 90min (3× tick), balanced: 10min (1×), bold: 10min (1×)
      expect(STYLE_CONFIG.bold.maxHoldDurationMs).toBeLessThan(STYLE_CONFIG.careful.maxHoldDurationMs);
    });

    it('all styles have empty allowedHoursUtc (always allowed)', () => {
      // After the ladder rescale, careful no longer restricts to US-overlap hours.
      expect(STYLE_CONFIG.careful.allowedHoursUtc).toEqual([]);
      expect(STYLE_CONFIG.balanced.allowedHoursUtc).toEqual([]);
      expect(STYLE_CONFIG.bold.allowedHoursUtc).toEqual([]);
    });
  });

  describe('derived cadence helpers', () => {
    it('uses the style tick interval when no override is given', () => {
      // balanced tick is now 10 min (600_000 ms) after the ladder rescale.
      expect(resolveStyleTickIntervalMs('balanced')).toBe(600_000);
    });

    it('uses an explicit tick interval override when present', () => {
      expect(resolveStyleTickIntervalMs('balanced', 900_000)).toBe(900_000);
    });

    it('derives max hold from the effective tick interval', () => {
      // balanced max-hold multiplier is now 1× its tick, so max hold tracks the tick 1:1.
      expect(deriveStyleMaxHoldDurationMs('balanced', 900_000)).toBe(900_000);
    });

    it('clears the max-hold override when the derived value matches the style default', () => {
      expect(applyAutoMaxHoldOverride('balanced', { scoutMaxTurns: 50 })).toEqual({ scoutMaxTurns: 50 });
    });

    it('stores an auto max-hold override when cadence differs from the style default', () => {
      expect(applyAutoMaxHoldOverride('balanced', { scoutMaxTurns: 50 }, 900_000)).toEqual({
        scoutMaxTurns: 50,
        maxHoldDurationMs: 900_000,
      });
    });
  });

  describe('reconcileMaxHoldOverride', () => {
    it('keeps a stored max hold that still covers the tick', () => {
      expect(reconcileMaxHoldOverride('balanced', { maxHoldDurationMs: 7_200_000 }, 1_800_000)).toEqual({
        maxHoldDurationMs: 7_200_000,
      });
    });

    it('re-derives max hold when the tick outgrows a stored max hold', () => {
      // balanced max-hold multiplier is 1×, so re-derivation tracks the tick 1:1.
      expect(reconcileMaxHoldOverride('balanced', { scoutMaxTurns: 50, maxHoldDurationMs: 600_000 }, 3_600_000)).toEqual({
        scoutMaxTurns: 50,
        maxHoldDurationMs: 3_600_000,
      });
    });

    it('stores no max-hold override when the style default already covers the tick', () => {
      // balanced's default max hold (10 min) matches its 10-min tick, so it covers the style tick exactly.
      expect(reconcileMaxHoldOverride('balanced', null, 600_000)).toBeNull();
    });

    it('leaves overrides unchanged when the tick is unknown', () => {
      expect(reconcileMaxHoldOverride('balanced', { scoutMaxTurns: 50 }, null)).toEqual({ scoutMaxTurns: 50 });
    });
  });

  describe('formatStyleSummary', () => {
    it('returns just the style name (no cost clause) for careful without pricing', () => {
      const summary = formatStyleSummary('careful', 'Careful');
      expect(summary).toBe('Careful');
      expect(summary).not.toContain('/day');
      expect(summary).not.toContain('turns');
    });

    it('returns just the style name (no cost clause) for balanced without pricing', () => {
      const summary = formatStyleSummary('balanced', 'Balanced');
      expect(summary).toBe('Balanced');
      expect(summary).not.toContain('/day');
    });

    it('returns just the style name (no cost clause) for bold without pricing', () => {
      const summary = formatStyleSummary('bold', 'Bold');
      expect(summary).toBe('Bold');
      expect(summary).not.toContain('/day');
    });

    it('computes an estimated cost (not an enforced limit) when full pricing is provided', () => {
      // economy input=$0.08, output=$0.15; premium input=$1.00, output=$2.00 (per 1M tokens)
      const summary = formatStyleSummary('careful', 'Careful', {
        economyInputUsdPer1M: 0.08,
        economyOutputUsdPer1M: 0.15,
        premiumInputUsdPer1M: 1.00,
        premiumOutputUsdPer1M: 2.00,
      });
      expect(summary).toMatch(/^Careful, ~\$[\d.]+\/day estimated$/);
      expect(summary).not.toContain('enforces a limit');
      expect(summary).not.toContain('turns');
    });

    it('computes higher cost for bold with same pricing', () => {
      // bold has 10min ticks → 144 ticks/day + higher escalation rate (60% vs careful's 20%)
      const pricing = {
        economyInputUsdPer1M: 0.08,
        economyOutputUsdPer1M: 0.15,
        premiumInputUsdPer1M: 1.00,
        premiumOutputUsdPer1M: 2.00,
      };
      const boldSummary = formatStyleSummary('bold', 'Bold', pricing);
      const carefulSummary = formatStyleSummary('careful', 'Careful', pricing);
      // Bold should cost more than careful
      const boldCost = Number(boldSummary.match(/~\$([\d.]+)\/day/)![1]);
      const carefulCost = Number(carefulSummary.match(/~\$([\d.]+)\/day/)![1]);
      expect(boldCost).toBeGreaterThan(carefulCost);
    });

    it('uses an explicit cadence override in cost math', () => {
      const summary = formatStyleSummary('balanced', 'Balanced', {
        economyInputUsdPer1M: 0.08,
        economyOutputUsdPer1M: 0.15,
        premiumInputUsdPer1M: 1.00,
        premiumOutputUsdPer1M: 2.00,
      }, 900_000);
      // 15-min cadence (96 ticks/day) yields a different cost than default 10-min (144 ticks/day)
      expect(summary).toMatch(/^Balanced, ~\$[\d.]+\/day estimated$/);
    });

    it('handles non-whole-minute cadence override without pricing without crashing', () => {
      const summary = formatStyleSummary('balanced', 'Balanced', undefined, 90_000);
      expect(summary).toBe('Balanced');
    });

    it('falls back to the bare style name when economy input price is 0', () => {
      const summary = formatStyleSummary('careful', 'Careful', {
        economyInputUsdPer1M: 0,
        economyOutputUsdPer1M: 0.15,
        premiumInputUsdPer1M: 1.00,
        premiumOutputUsdPer1M: 2.00,
      });
      expect(summary).toBe('Careful');
    });

    it('falls back to the bare style name when economy output price is 0', () => {
      const summary = formatStyleSummary('careful', 'Careful', {
        economyInputUsdPer1M: 0.08,
        economyOutputUsdPer1M: 0,
        premiumInputUsdPer1M: 1.00,
        premiumOutputUsdPer1M: 2.00,
      });
      expect(summary).toBe('Careful');
    });

    it('falls back to the bare style name when premium input price is 0', () => {
      const summary = formatStyleSummary('careful', 'Careful', {
        economyInputUsdPer1M: 0.08,
        economyOutputUsdPer1M: 0.15,
        premiumInputUsdPer1M: 0,
        premiumOutputUsdPer1M: 2.00,
      });
      expect(summary).toBe('Careful');
    });

    it('falls back to the bare style name when premium output price is 0', () => {
      const summary = formatStyleSummary('careful', 'Careful', {
        economyInputUsdPer1M: 0.08,
        economyOutputUsdPer1M: 0.15,
        premiumInputUsdPer1M: 1.00,
        premiumOutputUsdPer1M: 0,
      });
      expect(summary).toBe('Careful');
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

// ── Adaptive reasoning defaults ─────────────────────────────────────────────

describe('adaptive reasoning style defaults', () => {
  it('STYLE_CONFIG has adaptScoutReasoning true for all styles', () => {
    for (const style of ['careful', 'balanced', 'bold'] as const) {
      expect(STYLE_CONFIG[style].adaptScoutReasoning).toBe(true);
    }
  });

  it('STYLE_CONFIG has adaptJudgeReasoning true for all styles', () => {
    for (const style of ['careful', 'balanced', 'bold'] as const) {
      expect(STYLE_CONFIG[style].adaptJudgeReasoning).toBe(true);
    }
  });

  it('resolveStyleDefaults returns adaptive flags for careful', () => {
    const config = resolveStyleDefaults('careful');
    expect(config.adaptScoutReasoning).toBe(true);
    expect(config.adaptJudgeReasoning).toBe(true);
  });

  it('resolveStyleDefaults returns adaptive flags for balanced', () => {
    const config = resolveStyleDefaults('balanced');
    expect(config.adaptScoutReasoning).toBe(true);
    expect(config.adaptJudgeReasoning).toBe(true);
  });

  it('resolveStyleDefaults returns adaptive flags for bold', () => {
    const config = resolveStyleDefaults('bold');
    expect(config.adaptScoutReasoning).toBe(true);
    expect(config.adaptJudgeReasoning).toBe(true);
  });
});

// ── D10/D9: non-trading tick default and skip-unchanged default ──────────────

describe('resolveStyleTickIntervalMins (D10)', () => {
  it('keeps the style interval for a trading agent', () => {
    expect(resolveStyleTickIntervalMins('careful', true)).toBe('30');
    expect(resolveStyleTickIntervalMins('balanced', true)).toBe('10');
    expect(resolveStyleTickIntervalMins('bold', true)).toBe('10');
  });

  it('uses the 24 h (1440 min) default for a non-trading agent regardless of style', () => {
    expect(resolveStyleTickIntervalMins('careful', false)).toBe(NON_TRADING_DEFAULT_TICK_INTERVAL_MINS);
    expect(resolveStyleTickIntervalMins('balanced', false)).toBe('1440');
    expect(resolveStyleTickIntervalMins('bold', false)).toBe('1440');
  });
});

describe('skip-unchanged defaults (D9)', () => {
  it('defaults to true for a trading agent and false otherwise', () => {
    expect(resolveDefaultSkipUnchangedTicks(true)).toBe(true);
    expect(resolveDefaultSkipUnchangedTicks(false)).toBe(false);
  });

  it('follows the skills-derived default when no override is set', () => {
    expect(resolveEffectiveSkipUnchangedTicks(null, true)).toBe(true);
    expect(resolveEffectiveSkipUnchangedTicks(undefined, false)).toBe(false);
  });

  it('lets an explicit override win over the skills default', () => {
    expect(resolveEffectiveSkipUnchangedTicks(false, true)).toBe(false);
    expect(resolveEffectiveSkipUnchangedTicks(true, false)).toBe(true);
  });
});
