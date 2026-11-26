import { describe, expect, it } from 'vitest';
import { deriveStyleMaxHoldDurationMs } from '@herobids/domain';
import {
  findModelOutputLimitShortfalls,
  formatStyleSummary,
  resolveModelPricing,
  resolveStyleDefaults,
  resolveStyleTickIntervalMs,
  resolveDefaultSkipUnchangedTicks,
  STYLE_CONFIG,
  type AgentStyleValue,
} from './style-mapping.js';

describe('resolveStyleDefaults', () => {
  const validCostPresets = ['minimal', 'standard', 'premium'] as const;

  it('returns correct config for careful style', () => {
    const config = resolveStyleDefaults('careful');
    expect(config.costPreset).toBe('minimal');
    expect(config.tickIntervalMins).toBe('90');
    expect(config.dailySpendBudgetUsd).toBe('1');
    expect(config.scoutMaxTurns).toBe(50);
    expect(config.judgeMaxTurns).toBe(500);
    expect(config.maxHistoryTokens).toBe(40_000);
    expect(config.weekendPause).toBe(false);
    expect(config.allowedHoursUtc).toEqual([]);  // careful no longer restricts hours
  });

  it('returns correct config for balanced style', () => {
    const config = resolveStyleDefaults('balanced');
    expect(config.costPreset).toBe('standard');
    expect(config.tickIntervalMins).toBe('30');
    expect(config.dailySpendBudgetUsd).toBe('5');
    expect(config.scoutMaxTurns).toBe(50);
    expect(config.judgeMaxTurns).toBe(500);
    expect(config.maxHistoryTokens).toBe(80_000);
    expect(config.weekendPause).toBe(false);
  });

  it('returns correct config for bold style', () => {
    const config = resolveStyleDefaults('bold');
    expect(config.costPreset).toBe('premium');
    expect(config.tickIntervalMins).toBe('10');
    expect(config.dailySpendBudgetUsd).toBe('30');
    expect(config.scoutMaxTurns).toBe(50);
    expect(config.judgeMaxTurns).toBe(500);
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
      // balanced tick is 30 min (1_800_000 ms).
      expect(resolveStyleTickIntervalMs('balanced')).toBe(1_800_000);
    });

    it('uses an explicit tick interval override when present', () => {
      expect(resolveStyleTickIntervalMs('balanced', 900_000)).toBe(900_000);
    });

    it('derives max hold from the effective tick interval', () => {
      // balanced max-hold multiplier is 3× its tick.
      expect(deriveStyleMaxHoldDurationMs('balanced', 900_000)).toBe(2_700_000);
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

// ── D9: skip-unchanged default ───────────────────────────────────────────────

describe('skip-unchanged defaults (D9)', () => {
  it('defaults to true for a trading agent and false otherwise', () => {
    expect(resolveDefaultSkipUnchangedTicks(true)).toBe(true);
    expect(resolveDefaultSkipUnchangedTicks(false)).toBe(false);
  });
});

describe('style reasoning defaults (D22)', () => {
  it('exposes the per-style scout and judge reasoning the runtime uses when no level is set', () => {
    expect(resolveStyleDefaults('careful')).toMatchObject({ scoutReasoning: 'none', judgeReasoning: 'low' });
    expect(resolveStyleDefaults('balanced')).toMatchObject({ scoutReasoning: 'low', judgeReasoning: 'medium' });
    expect(resolveStyleDefaults('bold')).toMatchObject({ scoutReasoning: 'medium', judgeReasoning: 'high' });
  });
});

describe('findModelOutputLimitShortfalls (D21 C)', () => {
  const opus4 = 'anthropic/claude-opus-4'; // 32,000 output tokens

  it('warns about a judge model that cannot fit the deep thinking budget plus the judge reserve at high reasoning', () => {
    // bold: deep 32,768 + judge reserve 16,384
    expect(findModelOutputLimitShortfalls({
      style: 'bold',
      overrides: { judgeReasoning: 'high' },
      lightModel: 'xiaomi/mimo-v2.6-flash',
      heavyModel: opus4,
    })).toEqual([{ role: 'judge', reasoning: 'high', maxOutputTokens: 32_000, requiredTokens: 49_152 }]);
  });

  it('uses the style default reasoning level when none is chosen', () => {
    expect(findModelOutputLimitShortfalls({ style: 'bold', overrides: null, lightModel: '', heavyModel: opus4 }))
      .toEqual([{ role: 'judge', reasoning: 'high', maxOutputTokens: 32_000, requiredTokens: 49_152 }]);
  });

  it('does not warn when the chosen lower level fits the model', () => {
    // bold judge low: light 8,192 + judge reserve 16,384 = 24,576 <= 32,000
    expect(findModelOutputLimitShortfalls({
      style: 'bold',
      overrides: { judgeReasoning: 'low' },
      lightModel: '',
      heavyModel: opus4,
    })).toEqual([]);
  });

  it('sizes medium reasoning at the midpoint of the light and deep budgets', () => {
    // balanced scout medium: round((4,096 + 20,480) / 2) + scout reserve 4,096 = 16,384
    expect(findModelOutputLimitShortfalls({
      style: 'balanced',
      overrides: { scoutReasoning: 'medium' },
      lightModel: 'anthropic/claude-3.5-haiku',
      heavyModel: 'anthropic/claude-haiku-5.5',
    })).toEqual([{ role: 'scout', reasoning: 'medium', maxOutputTokens: 8_192, requiredTokens: 16_384 }]);
  });

  it('counts no thinking at reasoning none, only the reserve', () => {
    // careful scout none: 0 + scout reserve 4,096 fits a 4,096-token model; low adds light 2,048
    expect(findModelOutputLimitShortfalls({
      style: 'careful',
      overrides: null,
      lightModel: 'claude-3-haiku-20240307',
      heavyModel: '',
    })).toEqual([]);
    expect(findModelOutputLimitShortfalls({
      style: 'careful',
      overrides: { scoutReasoning: 'low' },
      lightModel: 'claude-3-haiku-20240307',
      heavyModel: '',
    })).toEqual([{ role: 'scout', reasoning: 'low', maxOutputTokens: 4_096, requiredTokens: 6_144 }]);
  });

  it('reports nothing for the default models on any style', () => {
    for (const style of ['careful', 'balanced', 'bold'] as const) {
      expect(findModelOutputLimitShortfalls({
        style,
        overrides: null,
        lightModel: 'xiaomi/mimo-v2.6-flash',
        heavyModel: 'anthropic/claude-haiku-5.5',
      })).toEqual([]);
    }
  });

  it('uses the override thinking budget instead of the style budget', () => {
    // bold judge high with deep 8,192: 8,192 + 16,384 = 24,576 <= 32,000
    expect(findModelOutputLimitShortfalls({
      style: 'bold',
      overrides: { deepThinkingTokens: 8_192 },
      lightModel: '',
      heavyModel: opus4,
    })).toEqual([]);
  });

  it('does not warn for a model that is not in the table, or when no model is selected', () => {
    expect(findModelOutputLimitShortfalls({
      style: 'bold',
      overrides: null,
      lightModel: 'qwen3:8b',
      heavyModel: '',
    })).toEqual([]);
  });
});
