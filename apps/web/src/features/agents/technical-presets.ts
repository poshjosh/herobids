import type { TechnicalConfigFormState } from './technical-config-helpers.js';

export type TechnicalPresetId = 'momentum-breakout' | 'mean-reversion' | 'conservative' | 'custom';

export interface TechnicalPreset {
  id: TechnicalPresetId;
  /** i18n key for the label */
  labelKey: string;
  /** i18n key for the description */
  descriptionKey: string;
  /**
   * Partial form state applied when preset is selected. Custom presets leave values as-is.
   * Indicator sub-object patches are deep-merged: only the provided indicator keys are replaced,
   * preserving unspecified fields within each indicator (partial indicator sub-objects are supported).
   */
  patch: Partial<TechnicalConfigFormState> | null;
}

export const TECHNICAL_PRESETS: TechnicalPreset[] = [
  {
    id: 'momentum-breakout',
    labelKey: 'agents.technical.preset.momentumBreakout.label',
    descriptionKey: 'agents.technical.preset.momentumBreakout.description',
    patch: {
      signalBias: 'trend-following',
      scanIntervalMins: '1',
      candles: { interval: '15m', limit: '100' },
      indicators: {
        rsi: { enabled: true, period: '14', healthyMin: '40', healthyMax: '70', overbought: '80', weakBelow: '30' },
        macd: { enabled: true, fast: '12', slow: '26', signal: '9' },
        volume: { enabled: true, strongRatio: '1.5', weakRatio: '0.5', recentBars: '4', avgBars: '20' },
        choch: { enabled: false, swingLookback: '5', minSwingPct: '0.01', confirmBars: '2', rejectOnBearish: false },
        supportResistance: { enabled: true, lookback: '50', breakoutThreshold: '0.005' },
      },
      confidence: {
        rsiWeight: '0.15',
        macdCrossoverWeight: '0.20',
        macdIncreasingWeight: '0.10',
        volumeWeight: '0.15',
        breakoutWeight: '0.15',
        chochBullishWeight: '0.15',
        chochBearishPenalty: '0.10',
        priceActionWeight: '0.10',
        minConfidence: '0.50',
        minReasons: '2',
      },
    },
  },
  {
    id: 'mean-reversion',
    labelKey: 'agents.technical.preset.meanReversion.label',
    descriptionKey: 'agents.technical.preset.meanReversion.description',
    patch: {
      signalBias: 'mean-reverting',
      scanIntervalMins: '1',
      candles: { interval: '15m', limit: '100' },
      indicators: {
        rsi: { enabled: true, period: '14', healthyMin: '35', healthyMax: '65', overbought: '75', weakBelow: '30' },
        macd: { enabled: true, fast: '12', slow: '26', signal: '9' },
        volume: { enabled: true, strongRatio: '1.3', weakRatio: '0.5', recentBars: '4', avgBars: '20' },
        choch: { enabled: true, swingLookback: '5', minSwingPct: '0.01', confirmBars: '2', rejectOnBearish: false },
        supportResistance: { enabled: false, lookback: '50', breakoutThreshold: '0.005' },
      },
      confidence: {
        rsiWeight: '0.20',
        macdCrossoverWeight: '0.15',
        macdIncreasingWeight: '0.10',
        volumeWeight: '0.15',
        breakoutWeight: '0.05',
        chochBullishWeight: '0.20',
        chochBearishPenalty: '0.05',
        priceActionWeight: '0.10',
        minConfidence: '0.45',
        minReasons: '2',
      },
    },
  },
  {
    id: 'conservative',
    labelKey: 'agents.technical.preset.conservative.label',
    descriptionKey: 'agents.technical.preset.conservative.description',
    patch: {
      signalBias: 'trend-following',
      scanIntervalMins: '5',
      candles: { interval: '1H', limit: '100' },
      indicators: {
        rsi: { enabled: true, period: '14', healthyMin: '45', healthyMax: '65', overbought: '75', weakBelow: '35' },
        macd: { enabled: true, fast: '12', slow: '26', signal: '9' },
        volume: { enabled: true, strongRatio: '1.8', weakRatio: '0.5', recentBars: '4', avgBars: '20' },
        choch: { enabled: true, swingLookback: '5', minSwingPct: '0.01', confirmBars: '3', rejectOnBearish: false },
        supportResistance: { enabled: true, lookback: '50', breakoutThreshold: '0.005' },
      },
      confidence: {
        rsiWeight: '0.15',
        macdCrossoverWeight: '0.20',
        macdIncreasingWeight: '0.10',
        volumeWeight: '0.20',
        breakoutWeight: '0.15',
        chochBullishWeight: '0.10',
        chochBearishPenalty: '0.10',
        priceActionWeight: '0.00',
        minConfidence: '0.60',
        minReasons: '3',
      },
    },
  },
  {
    id: 'custom',
    labelKey: 'agents.technical.preset.custom.label',
    descriptionKey: 'agents.technical.preset.custom.description',
    patch: null,
  },
];

/** Returns the form-state patch for a preset, or null for 'custom'. */
export function getTechnicalPresetConfig(id: TechnicalPresetId): Partial<TechnicalConfigFormState> | null {
  return TECHNICAL_PRESETS.find((p) => p.id === id)?.patch ?? null;
}
