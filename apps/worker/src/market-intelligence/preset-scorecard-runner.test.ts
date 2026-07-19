import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPresetScorecardRunner, type PresetScorecardRunner, type PresetScorecardRunnerDeps } from './preset-scorecard-runner.js';
import { scoreCandidate } from '@herobids/strategy';
import type { PriceCandle } from '@herobids/market-data';
import type { MarketAssessmentIdentity, PresetEntry } from '@herobids/domain';

// Mock scoreCandidate so we can inspect candidate context for symbol-resolution tests.
vi.mock('@herobids/strategy', async () => {
  const actual = await vi.importActual<typeof import('@herobids/strategy')>('@herobids/strategy');
  return { ...actual, scoreCandidate: vi.fn() };
});

// ── Helpers ────────────────────────────────────────────────────────────────

function makeMockCandles(count: number): PriceCandle[] {
  const candles: PriceCandle[] = [];
  let price = 50000;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price + (Math.random() - 0.5) * 200;
    const high = Math.max(open, close) + Math.random() * 100;
    const low = Math.min(open, close) - Math.random() * 100;
    candles.push({
      timestamp: new Date(Date.now() - (count - i) * 3600000).toISOString(),
      open,
      high,
      low,
      close,
      volume: Math.random() * 100,
    });
    price = close;
  }
  return candles;
}

function makeMockPresetEntry(
  key: string,
  strategyType: string,
  signalBias: string,
  overrides?: Partial<PresetEntry>,
): PresetEntry {
  return {
    name: key,
    description: `Test preset ${key}`,
    strategy: {
      type: strategyType,
      decisionMode: 'mechanical',
      params: {
        indicators: { rsi: { enabled: true }, macd: { enabled: true } },
        signalBias,
        candleInterval: '15m',
        candleLimit: 48,
      },
    },
    ...overrides,
  };
}

function makeRunner(deps?: Partial<PresetScorecardRunnerDeps>): PresetScorecardRunner {
  return createPresetScorecardRunner(deps ?? {});
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PresetScorecardRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock: return null (no signal) so tests that don't care about signal
    // output still produce deterministic results.
    vi.mocked(scoreCandidate).mockReturnValue(null);
  });

  describe('generateScorecards', () => {
    it('returns empty array for empty presets list', () => {
      const runner = makeRunner();
      const identity: MarketAssessmentIdentity = {
        instrumentKind: 'perp',
        venueFamily: 'hyperliquid-orderbook',
        styleTier: 'standard',
        symbol: 'BTC',
      };

      const result = runner.generateScorecards({ identity, presets: [], candles: [] });

      expect(result).toEqual([]);
    });

    it('skips DCA presets', () => {
      const runner = makeRunner();
      const identity: MarketAssessmentIdentity = {
        instrumentKind: 'perp',
        venueFamily: 'hyperliquid-orderbook',
        styleTier: 'standard',
        symbol: 'BTC',
      };
      const presets = [
        { key: 'dca_v1', entry: makeMockPresetEntry('dca_v1', 'dca', 'neutral') },
        { key: 'momentum_v1', entry: makeMockPresetEntry('momentum_v1', 'momentum', 'trend-following') },
      ];
      const candles = makeMockCandles(100);

      const result = runner.generateScorecards({ identity, presets, candles });

      expect(result).toHaveLength(1);
      expect(result[0]!.presetKey).toBe('momentum_v1');
    });

    it('correctly resolves symbol from orderbook identity', () => {
      const runner = makeRunner();
      const identity: MarketAssessmentIdentity = {
        instrumentKind: 'orderbook',
        venueFamily: 'hyperliquid-orderbook',
        styleTier: 'standard',
        symbol: 'BTC',
      };
      const presets = [
        { key: 'momentum_v1', entry: makeMockPresetEntry('momentum_v1', 'momentum', 'trend-following') },
      ];
      const candles = makeMockCandles(100);

      runner.generateScorecards({ identity, presets, candles });

      expect(scoreCandidate).toHaveBeenCalledTimes(1);
      const candidateArg = vi.mocked(scoreCandidate).mock.calls[0]![0]!;
      expect(candidateArg.symbol).toBe('BTC');
    });

    it('correctly resolves symbol from swap identity', () => {
      const runner = makeRunner();
      const identity: MarketAssessmentIdentity = {
        instrumentKind: 'swap',
        venueFamily: 'jupiter',
        styleTier: 'economy',
        network: 'solana',
        address: '0xabc',
      };
      const presets = [
        { key: 'momentum_v1', entry: makeMockPresetEntry('momentum_v1', 'momentum', 'trend-following') },
      ];
      const candles = makeMockCandles(100);

      runner.generateScorecards({ identity, presets, candles });

      expect(scoreCandidate).toHaveBeenCalledTimes(1);
      const candidateArg = vi.mocked(scoreCandidate).mock.calls[0]![0]!;
      expect(candidateArg.symbol).toBe('solana:0xabc');
    });

    it('derives correct presetBehaviorVersion — different params → different versions', () => {
      const runner = makeRunner();
      const identity: MarketAssessmentIdentity = {
        instrumentKind: 'perp',
        venueFamily: 'hyperliquid-orderbook',
        styleTier: 'standard',
        symbol: 'BTC',
      };
      const presetA = makeMockPresetEntry('p1', 'momentum', 'trend-following', {
        strategy: {
          type: 'momentum',
          decisionMode: 'mechanical',
          params: {
            indicators: { rsi: { enabled: true } },
            signalBias: 'trend-following',
            candleInterval: '15m',
            candleLimit: 48,
          },
        },
      });
      const presetB = makeMockPresetEntry('p2', 'momentum', 'trend-following', {
        strategy: {
          type: 'momentum',
          decisionMode: 'mechanical',
          params: {
            indicators: { macd: { enabled: true } },
            signalBias: 'trend-following',
            candleInterval: '15m',
            candleLimit: 48,
          },
        },
      });
      const presets = [
        { key: 'p1', entry: presetA },
        { key: 'p2', entry: presetB },
      ];
      const candles = makeMockCandles(100);

      const result = runner.generateScorecards({ identity, presets, candles });

      expect(result).toHaveLength(2);
      expect(result[0]!.presetBehaviorVersion).not.toBe('');
      expect(result[1]!.presetBehaviorVersion).not.toBe('');
      expect(result[0]!.presetBehaviorVersion).not.toBe(result[1]!.presetBehaviorVersion);
    });

    it('handles unknown instrumentKind gracefully', () => {
      const runner = makeRunner();
      const identity = {
        instrumentKind: 'invalid-kind',
        venueFamily: 'test',
        styleTier: 'standard',
        symbol: 'BTC',
      } as unknown as MarketAssessmentIdentity;
      const presets = [
        { key: 'p1', entry: makeMockPresetEntry('p1', 'momentum', 'trend-following') },
      ];
      const candles = makeMockCandles(100);

      expect(() => runner.generateScorecards({ identity, presets, candles })).toThrow(
        /Unsupported instrumentKind/,
      );
    });
  });

  describe('proof of no side effects', () => {
    it('does not import forbidden symbols (actors, DB, wake, decisions, metrics)', async () => {
      const mod = await import('./preset-scorecard-runner.js');

      const exports = Object.keys(mod);
      const forbiddenPatterns = [
        'AgentTradingActor',
        'db',
        'Database',
        'insert',
        'update',
        'delete',
        'scanMetric',
        'ScanMetric',
        'wake',
        'Wake',
        'decision',
        'Decision',
        'submit',
      ];

      for (const key of exports) {
        for (const pattern of forbiddenPatterns) {
          expect(key.toLowerCase()).not.toContain(pattern.toLowerCase());
        }
      }
    });
  });
});
