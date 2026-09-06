import { describe, expect, it } from 'vitest';

import { defaultTechnicalConfigFormState, technicalConfigToFormState, technicalFormStateToPayload, presetParamsToFormState } from './technical-config-helpers.js';

// ---------------------------------------------------------------------------
// presetParamsToFormState — converts PresetFromApi.strategy.params to form state
// ---------------------------------------------------------------------------

describe('presetParamsToFormState', () => {
  it('maps candle settings from flat params to form state', () => {
    const result = presetParamsToFormState({
      candleInterval: '4h',
      candleLimit: 72,
      signalBias: 'mean-reverting',
      indicators: {},
    });

    expect(result.candles.interval).toBe('4h');
    expect(result.candles.limit).toBe('72');
    expect(result.signalBias).toBe('mean-reverting');
  });

  it('maps scanIntervalMs to scanIntervalMins', () => {
    const result = presetParamsToFormState({
      scanIntervalMs: 300_000, // 5 minutes
      indicators: {},
    });

    expect(result.scanIntervalMins).toBe('5');
  });

  it('defaults scanIntervalMins to 1 when scanIntervalMs is absent', () => {
    const result = presetParamsToFormState({ indicators: {} });

    expect(result.scanIntervalMins).toBe('1');
  });

  it('maps RSI indicator params correctly', () => {
    const result = presetParamsToFormState({
      indicators: {
        rsi: { enabled: true, period: 14, healthyMin: 40, healthyMax: 70, overbought: 80, weakBelow: 30 },
      },
    });

    expect(result.indicators.rsi).toEqual({
      enabled: true,
      period: '14',
      healthyMin: '40',
      healthyMax: '70',
      overbought: '80',
      weakBelow: '30',
    });
  });

  it('maps MACD indicator params correctly', () => {
    const result = presetParamsToFormState({
      indicators: {
        macd: { enabled: true, fast: 6, slow: 13, signal: 5 },
      },
    });

    expect(result.indicators.macd).toEqual({
      enabled: true,
      fast: '6',
      slow: '13',
      signal: '5',
    });
  });

  it('maps volume indicator params correctly', () => {
    const result = presetParamsToFormState({
      indicators: {
        volume: { enabled: true, strongRatio: 1.8, recentBars: 3, avgBars: 10 },
      },
    });

    expect(result.indicators.volume.enabled).toBe(true);
    expect(result.indicators.volume.strongRatio).toBe('1.8');
    expect(result.indicators.volume.recentBars).toBe('3');
    expect(result.indicators.volume.avgBars).toBe('10');
  });

  it('maps CHOCH indicator params correctly', () => {
    const result = presetParamsToFormState({
      indicators: {
        choch: { enabled: true, swingLookback: 3, minSwingPct: 0.015, rejectOnBearish: true },
      },
    });

    expect(result.indicators.choch.enabled).toBe(true);
    expect(result.indicators.choch.swingLookback).toBe('3');
    expect(result.indicators.choch.minSwingPct).toBe('0.015');
    expect(result.indicators.choch.rejectOnBearish).toBe(true);
  });

  it('maps support/resistance indicator params correctly', () => {
    const result = presetParamsToFormState({
      indicators: {
        supportResistance: { enabled: true, lookback: 24, breakoutThreshold: 0.008 },
      },
    });

    expect(result.indicators.supportResistance).toEqual({
      enabled: true,
      lookback: '24',
      breakoutThreshold: '0.008',
    });
  });

  it('maps confidence weights from nested indicators.confidence', () => {
    const result = presetParamsToFormState({
      indicators: {
        confidence: {
          rsiWeight: 0.35,
          macdCrossoverWeight: 0.15,
          macdIncreasingWeight: 0.10,
          volumeWeight: 0.20,
          breakoutWeight: 0.20,
          priceActionWeight: 0.10,
          chochBullishWeight: 0.10,
          chochBearishPenalty: 0.05,
          minConfidence: 0.40,
          minReasons: 2,
        },
      },
    });

    expect(result.confidence).toEqual({
      rsiWeight: '0.35',
      macdCrossoverWeight: '0.15',
      macdIncreasingWeight: '0.1',
      volumeWeight: '0.2',
      breakoutWeight: '0.2',
      priceActionWeight: '0.1',
      chochBullishWeight: '0.1',
      chochBearishPenalty: '0.05',
      minConfidence: '0.4',
      minReasons: '2',
    });
  });

  it('handles a full contrarian preset shape end-to-end', () => {
    const contrarian = {
      candleInterval: '1h',
      candleLimit: 48,
      minCandleCount: 20,
      stopLossPct: 5,
      takeProfitPct: 12,
      signalBias: 'mean-reverting',
      positionSize: '5',
      positionSizeMode: 'percent_equity',
      indicators: {
        rsi: { enabled: true, period: 14, overbought: 70, weakBelow: 30 },
        macd: { enabled: true, fast: 12, slow: 26, signal: 9 },
        volume: { enabled: true, strongRatio: 1.5 },
        supportResistance: { enabled: true, lookback: 24, breakoutThreshold: 0.008 },
        vwap: { enabled: false },
        priceAction: { enabled: true, minChange24hPct: 10, maxChange24hPct: 40 },
        choch: { enabled: true, swingLookback: 3, minSwingPct: 0.01, rejectOnBearish: false },
        confidence: {
          rsiWeight: 0.35,
          macdCrossoverWeight: 0.15,
          macdIncreasingWeight: 0.10,
          volumeWeight: 0.20,
          breakoutWeight: 0.20,
          priceActionWeight: 0.10,
          chochBullishWeight: 0.10,
          chochBearishPenalty: 0.05,
          minConfidence: 0.40,
          minReasons: 2,
        },
      },
    };

    const result = presetParamsToFormState(contrarian);

    // Candles
    expect(result.candles.interval).toBe('1h');
    expect(result.candles.limit).toBe('48');
    expect(result.signalBias).toBe('mean-reverting');

    // Indicators picked up
    expect(result.indicators.rsi.enabled).toBe(true);
    expect(result.indicators.macd.enabled).toBe(true);
    expect(result.indicators.volume.enabled).toBe(true);
    expect(result.indicators.supportResistance.enabled).toBe(true);
    expect(result.indicators.choch.enabled).toBe(true);
    expect(result.indicators.choch.rejectOnBearish).toBe(false);

    // Confidence
    expect(result.confidence.rsiWeight).toBe('0.35');
    expect(result.confidence.minConfidence).toBe('0.4');
    expect(result.confidence.minReasons).toBe('2');
  });

  it('provides sensible defaults when indicators object is missing', () => {
    const result = presetParamsToFormState({});

    expect(result.candles.interval).toBe('15m');
    expect(result.candles.limit).toBe('100');
    expect(result.signalBias).toBe('trend-following');
    expect(result.indicators.rsi.enabled).toBe(true);
    expect(result.indicators.choch.enabled).toBe(false);
    expect(result.indicators.supportResistance.enabled).toBe(false);
  });

  it('leaves discovery filters empty since presets do not include them', () => {
    const result = presetParamsToFormState({
      candleInterval: '15m',
      indicators: {},
    });

    expect(result.filters.venue).toBe('');
    expect(result.filters.venueType).toBe('');
    expect(result.filters.symbols).toEqual([]);
    expect(result.filters.networks).toEqual([]);
  });
});


// ---------------------------------------------------------------------------
// technicalFormStateToPayload & technicalConfigToFormState
// ---------------------------------------------------------------------------

describe('technicalFormStateToPayload', () => {
  it('returns null when venue is missing', () => {
    const result = technicalFormStateToPayload(defaultTechnicalConfigFormState());
    expect(result).toBeNull();
  });

  it('preserves explicit zero-valued confidence inputs', () => {
    const state = defaultTechnicalConfigFormState();
    state.confidence.priceActionWeight = '0';
    const result = technicalFormStateToPayload(state, 'hyperliquid', 'orderbook');
    expect(result!.indicators.confidence.priceActionWeight).toBe(0);
  });
});

describe('technicalConfigToFormState', () => {
  it('hydrates saved config into form state without losing zero values', () => {
    const config = {
      filters: { venue: 'hyperliquid', venueType: 'orderbook' },
      indicators: {
        rsi: { enabled: true, period: 14, healthyMin: 40, healthyMax: 70, overbought: 80, weakBelow: 30 },
        macd: { enabled: true, fast: 12, slow: 26, signal: 9 },
        volume: { enabled: true, strongRatio: 1.5, weakRatio: 0.5, recentBars: 4, avgBars: 20 },
        choch: { enabled: false, swingLookback: 5, minSwingPct: 0.01, confirmBars: 2, rejectOnBearish: false },
        supportResistance: { enabled: false, lookback: 50, breakoutThreshold: 0.005 },
        confidence: {
          rsiWeight: 0.15,
          macdCrossoverWeight: 0.20,
          macdIncreasingWeight: 0.10,
          volumeWeight: 0.15,
          breakoutWeight: 0.15,
          chochBullishWeight: 0.15,
          chochBearishPenalty: 0.10,
          priceActionWeight: 0,
          minConfidence: 0.45,
          minReasons: 2,
        },
      },
      candles: { interval: '15m', limit: 100 },
      signalBias: 'trend-following',
      scanIntervalMs: 60_000,
      scanBatchSize: 5,
    };

    const result = technicalConfigToFormState(config);
    expect(result.confidence.priceActionWeight).toBe('0');
  });

  it('round-trips form state through payload and back without precision loss', () => {
    const state = defaultTechnicalConfigFormState();
    state.filters.venue = 'hyperliquid';
    state.filters.venueType = 'orderbook';

    const payload = technicalFormStateToPayload(state);
    expect(payload).not.toBeNull();
    if (payload === null) throw new Error('expected non-null payload');

    const restored = technicalConfigToFormState({ ...payload });

    expect(restored.candles.interval).toBe(state.candles.interval);
    expect(restored.signalBias).toBe(state.signalBias);
    expect(restored.indicators.rsi.period).toBe(state.indicators.rsi.period);
    expect(restored.confidence.minReasons).toBe(state.confidence.minReasons);
  });
});
