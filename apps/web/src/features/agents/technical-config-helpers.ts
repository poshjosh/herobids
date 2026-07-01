import type { TechnicalConfigFormState, IndicatorFormState } from './technical-types.js';

export type { TechnicalConfigFormState, IndicatorFormState } from './technical-types.js';

// ---- Local type mirroring the domain TechnicalConfig ----
// The web app doesn't depend on @herobids/domain — these interfaces match schema.ts.

export interface TechnicalConfig {
  filters: {
    venue: string;
    venueType: 'orderbook' | 'swap';
    minVolume24hUsd?: number;
    minLiquidityUsd?: number;
    networks?: string[];
    symbols?: string[];
    excludeSymbols?: string[];
  };
  indicators: {
    rsi: { enabled: boolean; period: number; healthyMin: number; healthyMax: number; overbought: number; weakBelow: number };
    macd: { enabled: boolean; fast: number; slow: number; signal: number };
    volume: { enabled: boolean; strongRatio: number; weakRatio: number; recentBars: number; avgBars: number };
    choch: { enabled: boolean; swingLookback: number; minSwingPct: number; confirmBars: number; rejectOnBearish: boolean };
    supportResistance: { enabled: boolean; lookback: number; breakoutThreshold: number };
    confidence: {
      rsiWeight: number;
      macdCrossoverWeight: number;
      macdIncreasingWeight: number;
      volumeWeight: number;
      breakoutWeight: number;
      chochBullishWeight: number;
      chochBearishPenalty: number;
      priceActionWeight: number;
      minConfidence: number;
      minReasons: number;
    };
  };
  candles: { interval: '5m' | '15m' | '1H' | '4H' | '1D'; limit: number };
  signalBias: 'trend-following' | 'mean-reverting';
  scanIntervalMs: number;
  scanBatchSize: number;
}

// ---- Form state — all numerics are strings for controlled inputs — imported from technical-types.ts ----

// (IndicatorFormState and TechnicalConfigFormState are now in ./technical-types.js)

const DEFAULT_INDICATORS: IndicatorFormState = {
  rsi: { enabled: true, period: '14', healthyMin: '40', healthyMax: '70', overbought: '80', weakBelow: '30' },
  macd: { enabled: true, fast: '12', slow: '26', signal: '9' },
  volume: { enabled: true, strongRatio: '1.5', weakRatio: '0.5', recentBars: '4', avgBars: '20' },
  choch: { enabled: false, swingLookback: '5', minSwingPct: '0.01', confirmBars: '2', rejectOnBearish: false },
  supportResistance: { enabled: false, lookback: '50', breakoutThreshold: '0.005' },
};

const DEFAULT_CONFIDENCE = {
  rsiWeight: '0.15',
  macdCrossoverWeight: '0.20',
  macdIncreasingWeight: '0.10',
  volumeWeight: '0.15',
  breakoutWeight: '0.15',
  chochBullishWeight: '0.15',
  chochBearishPenalty: '0.10',
  priceActionWeight: '0.10',
  minConfidence: '0.45',
  minReasons: '2',
};

function hasNumericInput(value: string): boolean {
  return value.trim() !== '' && !Number.isNaN(Number(value.trim()));
}

function parseFloatOrFallback(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function parseIntOrFallback(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export function defaultTechnicalConfigFormState(): TechnicalConfigFormState {
  return {
    filters: { venue: '', venueType: '', minVolume24hUsd: '', minLiquidityUsd: '', networks: [], symbols: [], excludeSymbols: [] },
    candles: { interval: '15m', limit: '100' },
    signalBias: 'trend-following',
    scanIntervalMins: '1',
    scanBatchSize: '5',
    indicators: DEFAULT_INDICATORS,
    confidence: DEFAULT_CONFIDENCE,
  };
}

/**
 * Convert form state to API payload. Returns null if venue is not set (incomplete).
 * When externalVenue/externalVenueType are provided, they override the form state values.
 * This allows the trading setup section to inject venue derived from the connection.
 */
export function technicalFormStateToPayload(
  state: TechnicalConfigFormState,
  externalVenue?: string,
  externalVenueType?: 'orderbook' | 'swap',
): TechnicalConfig | null {
  const venue = (externalVenue ?? state.filters.venue).trim();
  const venueType = (externalVenueType ?? state.filters.venueType) as 'orderbook' | 'swap' | '';
  if (!venue || !venueType) return null;

  const scanIntervalMs = Math.max(10_000, parseFloatOrFallback(state.scanIntervalMins, 1) * 60_000);

  return {
    filters: {
      venue,
      venueType: venueType as 'orderbook' | 'swap',
      ...(hasNumericInput(state.filters.minVolume24hUsd) ? { minVolume24hUsd: parseFloatOrFallback(state.filters.minVolume24hUsd, 0) } : {}),
      ...(hasNumericInput(state.filters.minLiquidityUsd) ? { minLiquidityUsd: parseFloatOrFallback(state.filters.minLiquidityUsd, 0) } : {}),
      ...(state.filters.networks.length > 0 ? { networks: state.filters.networks } : {}),
      ...(state.filters.symbols.length > 0 ? { symbols: state.filters.symbols } : {}),
      ...(state.filters.excludeSymbols.length > 0 ? { excludeSymbols: state.filters.excludeSymbols } : {}),
    },
    indicators: {
      rsi: {
        enabled: state.indicators.rsi.enabled,
        period: parseIntOrFallback(state.indicators.rsi.period, 14),
        healthyMin: parseFloatOrFallback(state.indicators.rsi.healthyMin, 40),
        healthyMax: parseFloatOrFallback(state.indicators.rsi.healthyMax, 70),
        overbought: parseFloatOrFallback(state.indicators.rsi.overbought, 80),
        weakBelow: parseFloatOrFallback(state.indicators.rsi.weakBelow, 30),
      },
      macd: {
        enabled: state.indicators.macd.enabled,
        fast: parseIntOrFallback(state.indicators.macd.fast, 12),
        slow: parseIntOrFallback(state.indicators.macd.slow, 26),
        signal: parseIntOrFallback(state.indicators.macd.signal, 9),
      },
      volume: {
        enabled: state.indicators.volume.enabled,
        strongRatio: parseFloatOrFallback(state.indicators.volume.strongRatio, 1.5),
        weakRatio: parseFloatOrFallback(state.indicators.volume.weakRatio, 0.5),
        recentBars: parseIntOrFallback(state.indicators.volume.recentBars, 4),
        avgBars: parseIntOrFallback(state.indicators.volume.avgBars, 20),
      },
      choch: {
        enabled: state.indicators.choch.enabled,
        swingLookback: parseIntOrFallback(state.indicators.choch.swingLookback, 5),
        minSwingPct: parseFloatOrFallback(state.indicators.choch.minSwingPct, 0.01),
        confirmBars: parseIntOrFallback(state.indicators.choch.confirmBars, 2),
        rejectOnBearish: state.indicators.choch.rejectOnBearish,
      },
      supportResistance: {
        enabled: state.indicators.supportResistance.enabled,
        lookback: parseIntOrFallback(state.indicators.supportResistance.lookback, 50),
        breakoutThreshold: parseFloatOrFallback(state.indicators.supportResistance.breakoutThreshold, 0.005),
      },
      confidence: {
        rsiWeight: parseFloatOrFallback(state.confidence.rsiWeight, 0.15),
        macdCrossoverWeight: parseFloatOrFallback(state.confidence.macdCrossoverWeight, 0.20),
        macdIncreasingWeight: parseFloatOrFallback(state.confidence.macdIncreasingWeight, 0.10),
        volumeWeight: parseFloatOrFallback(state.confidence.volumeWeight, 0.15),
        breakoutWeight: parseFloatOrFallback(state.confidence.breakoutWeight, 0.15),
        chochBullishWeight: parseFloatOrFallback(state.confidence.chochBullishWeight, 0.15),
        chochBearishPenalty: parseFloatOrFallback(state.confidence.chochBearishPenalty, 0.10),
        priceActionWeight: parseFloatOrFallback(state.confidence.priceActionWeight, 0.10),
        minConfidence: parseFloatOrFallback(state.confidence.minConfidence, 0.45),
        minReasons: parseIntOrFallback(state.confidence.minReasons, 2),
      },
    },
    candles: { interval: state.candles.interval, limit: parseIntOrFallback(state.candles.limit, 100) },
    signalBias: state.signalBias,
    scanIntervalMs,
    scanBatchSize: parseIntOrFallback(state.scanBatchSize, 5),
  };
}

/**
 * Convert an existing TechnicalConfig (from the API) back into form state for editing.
 */
export function technicalConfigToFormState(config: Record<string, unknown>): TechnicalConfigFormState {
  const filters = (config['filters'] as Record<string, unknown> | undefined) ?? {};
  const ind = (config['indicators'] as Record<string, unknown> | undefined) ?? {};
  const rsi = (ind['rsi'] as Record<string, unknown> | undefined) ?? {};
  const macd = (ind['macd'] as Record<string, unknown> | undefined) ?? {};
  const volume = (ind['volume'] as Record<string, unknown> | undefined) ?? {};
  const choch = (ind['choch'] as Record<string, unknown> | undefined) ?? {};
  const sr = (ind['supportResistance'] as Record<string, unknown> | undefined) ?? {};
  const conf = (ind['confidence'] as Record<string, unknown> | undefined) ?? {};
  const candles = (config['candles'] as Record<string, unknown> | undefined) ?? {};
  const scanIntervalMs = (config['scanIntervalMs'] as number | undefined) ?? 60_000;

  return {
    filters: {
      venue: String(filters['venue'] ?? ''),
      venueType: (filters['venueType'] as 'orderbook' | 'swap' | '') ?? '',
      minVolume24hUsd: filters['minVolume24hUsd'] != null ? String(filters['minVolume24hUsd']) : '',
      minLiquidityUsd: filters['minLiquidityUsd'] != null ? String(filters['minLiquidityUsd']) : '',
      networks: (filters['networks'] as string[] | undefined) ?? [],
      symbols: (filters['symbols'] as string[] | undefined) ?? [],
      excludeSymbols: (filters['excludeSymbols'] as string[] | undefined) ?? [],
    },
    candles: {
      interval: (candles['interval'] as '5m' | '15m' | '1H' | '4H' | '1D' | undefined) ?? '15m',
      limit: String(candles['limit'] ?? 100),
    },
    signalBias: (config['signalBias'] as 'trend-following' | 'mean-reverting' | undefined) ?? 'trend-following',
    scanIntervalMins: String(Math.round(scanIntervalMs / 60_000)),
    scanBatchSize: String(config['scanBatchSize'] ?? 5),
    indicators: {
      rsi: {
        enabled: Boolean(rsi['enabled'] ?? true),
        period: String(rsi['period'] ?? 14),
        healthyMin: String(rsi['healthyMin'] ?? 40),
        healthyMax: String(rsi['healthyMax'] ?? 70),
        overbought: String(rsi['overbought'] ?? 80),
        weakBelow: String(rsi['weakBelow'] ?? 30),
      },
      macd: {
        enabled: Boolean(macd['enabled'] ?? true),
        fast: String(macd['fast'] ?? 12),
        slow: String(macd['slow'] ?? 26),
        signal: String(macd['signal'] ?? 9),
      },
      volume: {
        enabled: Boolean(volume['enabled'] ?? true),
        strongRatio: String(volume['strongRatio'] ?? 1.5),
        weakRatio: String(volume['weakRatio'] ?? 0.5),
        recentBars: String(volume['recentBars'] ?? 4),
        avgBars: String(volume['avgBars'] ?? 20),
      },
      choch: {
        enabled: Boolean(choch['enabled'] ?? false),
        swingLookback: String(choch['swingLookback'] ?? 5),
        minSwingPct: String(choch['minSwingPct'] ?? 0.01),
        confirmBars: String(choch['confirmBars'] ?? 2),
        rejectOnBearish: Boolean(choch['rejectOnBearish'] ?? false),
      },
      supportResistance: {
        enabled: Boolean(sr['enabled'] ?? false),
        lookback: String(sr['lookback'] ?? 50),
        breakoutThreshold: String(sr['breakoutThreshold'] ?? 0.005),
      },
    },
    confidence: {
      rsiWeight: String(conf['rsiWeight'] ?? 0.15),
      macdCrossoverWeight: String(conf['macdCrossoverWeight'] ?? 0.20),
      macdIncreasingWeight: String(conf['macdIncreasingWeight'] ?? 0.10),
      volumeWeight: String(conf['volumeWeight'] ?? 0.15),
      breakoutWeight: String(conf['breakoutWeight'] ?? 0.15),
      chochBullishWeight: String(conf['chochBullishWeight'] ?? 0.15),
      chochBearishPenalty: String(conf['chochBearishPenalty'] ?? 0.10),
      priceActionWeight: String(conf['priceActionWeight'] ?? 0.10),
      minConfidence: String(conf['minConfidence'] ?? 0.45),
      minReasons: String(conf['minReasons'] ?? 2),
    },
  };
}
