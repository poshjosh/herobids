import { describe, expect, it } from 'vitest';
import { defaultTechnicalConfigFormState, technicalConfigToFormState, technicalFormStateToPayload } from './technical-config-helpers.js';

describe('technical config helpers', () => {
  it('returns null when the venue is missing', () => {
    expect(technicalFormStateToPayload(defaultTechnicalConfigFormState())).toBeNull();
  });

  it('preserves explicit zero-valued confidence inputs', () => {
    const state = defaultTechnicalConfigFormState();
    state.filters.venue = 'hyperliquid';
    state.filters.venueType = 'orderbook';
    state.confidence.priceActionWeight = '0';
    state.confidence.minConfidence = '0';

    const payload = technicalFormStateToPayload(state);

    expect(payload).not.toBeNull();
    expect(payload?.indicators.confidence.priceActionWeight).toBe(0);
    expect(payload?.indicators.confidence.minConfidence).toBe(0);
  });

  it('hydrates saved technical config into editable form state without losing zero values', () => {
    const formState = technicalConfigToFormState({
      filters: {
        venue: 'hyperliquid',
        venueType: 'orderbook',
        minVolume24hUsd: 0,
        minLiquidityUsd: 0,
        networks: ['arbitrum'],
      },
      indicators: {
        rsi: { enabled: false, period: 7, healthyMin: 0, healthyMax: 55, overbought: 90, weakBelow: 0 },
        macd: { enabled: true, fast: 5, slow: 13, signal: 4 },
        volume: { enabled: true, strongRatio: 0, weakRatio: 0, recentBars: 3, avgBars: 10 },
        choch: { enabled: true, swingLookback: 6, minSwingPct: 0, confirmBars: 1, rejectOnBearish: true },
        supportResistance: { enabled: true, lookback: 20, breakoutThreshold: 0 },
        confidence: {
          rsiWeight: 0,
          macdCrossoverWeight: 0,
          macdIncreasingWeight: 0,
          volumeWeight: 0,
          breakoutWeight: 0,
          chochBullishWeight: 0,
          chochBearishPenalty: 0,
          priceActionWeight: 0,
          minConfidence: 0,
          minReasons: 0,
        },
      },
      candles: { interval: '1H', limit: 250 },
      signalBias: 'mean-reverting',
      scanIntervalMs: 120_000,
      scanBatchSize: 0,
    });

    expect(formState.filters.minVolume24hUsd).toBe('0');
    expect(formState.filters.minLiquidityUsd).toBe('0');
    expect(formState.filters.networks).toEqual(['arbitrum']);
    expect(formState.indicators.rsi.enabled).toBe(false);
    expect(formState.indicators.rsi.healthyMin).toBe('0');
    expect(formState.indicators.volume.strongRatio).toBe('0');
    expect(formState.indicators.choch.rejectOnBearish).toBe(true);
    expect(formState.indicators.supportResistance.breakoutThreshold).toBe('0');
    expect(formState.confidence.priceActionWeight).toBe('0');
    expect(formState.confidence.minConfidence).toBe('0');
    expect(formState.confidence.minReasons).toBe('0');
    expect(formState.candles.interval).toBe('1H');
    expect(formState.candles.limit).toBe('250');
    expect(formState.signalBias).toBe('mean-reverting');
    expect(formState.scanIntervalMins).toBe('2');
    expect(formState.scanBatchSize).toBe('0');
  });

  it('round-trips form state through payload and back without precision loss', () => {
    const state = defaultTechnicalConfigFormState();
    state.filters.venue = 'hyperliquid';
    state.filters.venueType = 'orderbook';

    const payload1 = technicalFormStateToPayload(state);
    expect(payload1).not.toBeNull();

    const roundTripped = technicalConfigToFormState(payload1 as Record<string, unknown>);
    const payload2 = technicalFormStateToPayload(roundTripped);

    expect(payload2).toEqual(payload1);
  });
});
