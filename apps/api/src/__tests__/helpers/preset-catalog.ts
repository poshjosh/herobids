// Shared test fixture: seed the domain preset catalog with a realistic 7-preset
// catalog (mirrors the traderton strategy-presets YAML content). The loader is
// boundary-seeded in production (D2-a); tests seed it directly so the
// synchronous `getPreset` / `listPresets` call sites resolve without a boundary.
import { seedPresetCatalog } from '@herobids/domain/config/presets-loader';
import type { PresetEntry } from '@herobids/domain';

function momentum(stopLossPct: number, positionSize: string, minConfidence: number): PresetEntry {
  return {
    name: 'Momentum — Day',
    description: 'Day-trend following on 15m candles.',
    strategy: {
      type: 'momentum',
      decisionMode: 'mechanical',
      params: {
        candleInterval: '15m',
        candleLimit: 48,
        minCandleCount: 20,
        stopLossPct,
        takeProfitPct: 8,
        signalBias: 'trend-following',
        positionSize,
        positionSizeMode: 'percent_equity',
        indicators: {
          rsi: { enabled: true, period: 14 },
          macd: { enabled: true },
          confidence: { minConfidence },
        },
      },
    },
    risk: { maxPositionSizePct: 20 },
    execution: { mode: 'paper' },
  };
}

function simple(type: string, name: string, description: string, params: Record<string, unknown> = {}): PresetEntry {
  return {
    name,
    description,
    strategy: { type, decisionMode: 'mechanical', params },
    risk: { maxPositionSizePct: 20 },
    execution: { mode: 'paper' },
  };
}

function tier(stopLossPct: number, positionSize: string, minConfidence: number): Array<{ key: string; entry: PresetEntry }> {
  return [
    { key: 'momentum', entry: momentum(stopLossPct, positionSize, minConfidence) },
    { key: 'momentum-position', entry: simple('momentum', 'Momentum — Position', 'Longer-term trend following', { candleInterval: '4h', candleLimit: 72, stopLossPct: 8, positionSize: '5', signalBias: 'trend-following', indicators: {} }) },
    { key: 'dca', entry: simple('dca', 'DCA', 'Dollar-cost averaging', { intervalMs: 86_400_000, amountPerBuy: '2' }) },
    { key: 'range', entry: simple('range', 'Range Trading', 'Mean-reverting within ranges', { candleInterval: '1h', stopLossPct: 4, signalBias: 'mean-reverting', indicators: {} }) },
    { key: 'swing', entry: simple('swing', 'Swing Trading', 'Swing trading', { candleInterval: '4h', stopLossPct: 6, signalBias: 'trend-following', indicators: {} }) },
    { key: 'scalper', entry: simple('scalper', 'Scalping', 'Scalping', { candleInterval: '1m', stopLossPct: 1, signalBias: 'trend-following', indicators: {} }) },
    { key: 'contrarian', entry: simple('contrarian', 'Contrarian', 'Contrarian', { candleInterval: '1h', stopLossPct: 5, signalBias: 'mean-reverting', indicators: {} }) },
  ];
}

/** Seed the domain preset catalog with a realistic 7-preset, 3-tier catalog. */
export function seedTestPresetCatalog(): void {
  seedPresetCatalog({
    presets: {
      economy: tier(2, '2', 0.7),
      standard: tier(3, '5', 0.4),
      premium: tier(5, '10', 0.3),
    },
  });
}