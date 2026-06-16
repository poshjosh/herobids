import { describe, expect, it } from 'vitest';
import { TECHNICAL_PRESETS, getTechnicalPresetConfig, type TechnicalPresetId } from './technical-presets.js';
import { applyPreset, defaultTechnicalConfigFormState, technicalFormStateToPayload } from './technical-config-helpers.js';

const BASE_STATE = {
  ...defaultTechnicalConfigFormState(),
  filters: {
    ...defaultTechnicalConfigFormState().filters,
    venue: 'hyperliquid',
    venueType: 'orderbook' as const,
  },
};

describe('TECHNICAL_PRESETS', () => {
  it('contains all four preset ids in order', () => {
    expect(TECHNICAL_PRESETS.map((p) => p.id)).toEqual(['momentum-breakout', 'mean-reversion', 'conservative', 'custom']);
  });

  it('all non-custom presets have non-null patches', () => {
    for (const preset of TECHNICAL_PRESETS.filter((p) => p.id !== 'custom')) {
      expect(preset.patch, `${preset.id} patch should not be null`).not.toBeNull();
    }
  });

  it('custom preset has null patch', () => {
    const custom = TECHNICAL_PRESETS.find((p) => p.id === 'custom');
    expect(custom?.patch).toBeNull();
  });
});

describe('getTechnicalPresetConfig', () => {
  it('returns the patch for a named preset', () => {
    const patch = getTechnicalPresetConfig('momentum-breakout');
    expect(patch).not.toBeNull();
    expect(patch?.signalBias).toBe('trend-following');
  });

  it('returns null for custom preset', () => {
    expect(getTechnicalPresetConfig('custom')).toBeNull();
  });

  it('returns null for unknown preset id', () => {
    expect(getTechnicalPresetConfig('unknown' as TechnicalPresetId)).toBeNull();
  });
});

const EXPECTED_BIAS: Record<string, 'trend-following' | 'mean-reverting'> = {
  'momentum-breakout': 'trend-following',
  'mean-reversion': 'mean-reverting',
  'conservative': 'trend-following',
};

describe('applying presets produces valid TechnicalConfig', () => {
  it.each(['momentum-breakout', 'mean-reversion', 'conservative'] as TechnicalPresetId[])(
    '%s preset converts to a non-null TechnicalConfig',
    (presetId) => {
      const state = applyPreset(presetId, BASE_STATE);
      const config = technicalFormStateToPayload(state);
      expect(config).not.toBeNull();
      expect(config?.signalBias).toBe(EXPECTED_BIAS[presetId]);
      expect(config?.indicators.confidence.minConfidence).toBeGreaterThan(0);
    },
  );

  it('momentum-breakout sets trend-following bias, 60s scan, RSI healthy range, and S/R breakout', () => {
    const config = technicalFormStateToPayload(applyPreset('momentum-breakout', BASE_STATE));
    expect(config?.signalBias).toBe('trend-following');
    expect(config?.scanIntervalMs).toBe(60_000);
    expect(config?.candles.interval).toBe('15m');
    expect(config?.indicators.rsi.period).toBe(14);
    expect(config?.indicators.rsi.healthyMin).toBe(40);
    expect(config?.indicators.rsi.healthyMax).toBe(70);
    expect(config?.indicators.rsi.overbought).toBe(80);
    expect(config?.indicators.supportResistance.enabled).toBe(true);
    expect(config?.indicators.supportResistance.lookback).toBe(50);
    expect(config?.indicators.supportResistance.breakoutThreshold).toBe(0.005);
    expect(config?.indicators.confidence.minConfidence).toBe(0.5);
  });

  it('mean-reversion sets mean-reverting bias, enables CHOCH, and 45% min confidence', () => {
    const config = technicalFormStateToPayload(applyPreset('mean-reversion', BASE_STATE));
    expect(config?.signalBias).toBe('mean-reverting');
    expect(config?.scanIntervalMs).toBe(60_000);
    expect(config?.indicators.choch.enabled).toBe(true);
    expect(config?.indicators.choch.rejectOnBearish).toBe(false);
    expect(config?.indicators.confidence.minConfidence).toBe(0.45);
  });

  it('conservative sets high confidence threshold, slow scan, hourly candles, and strongRatio 1.8', () => {
    const config = technicalFormStateToPayload(applyPreset('conservative', BASE_STATE));
    expect(config?.signalBias).toBe('trend-following');
    expect(config?.scanIntervalMs).toBe(300_000);
    expect(config?.candles.interval).toBe('1H');
    expect(config?.indicators.rsi.healthyMin).toBe(45);
    expect(config?.indicators.rsi.healthyMax).toBe(65);
    expect(config?.indicators.volume.strongRatio).toBe(1.8);
    expect(config?.indicators.choch.enabled).toBe(true);
    expect(config?.indicators.choch.confirmBars).toBe(3);
    expect(config?.indicators.confidence.minConfidence).toBe(0.6);
    expect(config?.indicators.confidence.minReasons).toBe(3);
  });

  it('custom preset preserves current form state unchanged', () => {
    const customBase = { ...BASE_STATE, signalBias: 'mean-reverting' as const };
    const state = applyPreset('custom', customBase);
    expect(state.signalBias).toBe('mean-reverting');
    expect(state.indicators).toStrictEqual(customBase.indicators);
    expect(state.confidence).toStrictEqual(customBase.confidence);
    const config = technicalFormStateToPayload(state);
    expect(config?.signalBias).toBe('mean-reverting');
  });
});
