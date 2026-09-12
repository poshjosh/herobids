import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createPresetScorecardRunner,
  type PresetScorecardRunner,
  type PresetScorecardRunnerDeps,
  type ScoreCandidateBoundary,
} from './preset-scorecard-runner.js';
import { scoreCandidate } from '@herobids/strategy';
import type { PriceCandle } from '@herobids/market-data';
import type { MarketAssessmentIdentity, PresetEntry, TradertonReadResult } from '@herobids/domain';

// Mock scoreCandidate so we can inspect candidate context for the swap (in-process)
// path. Orderbook/perp scoring routes over the boundary and never calls this.
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

/** A stubbed score_candidate boundary whose invoke returns a fixed result + records calls. */
function stubBoundary(result: TradertonReadResult): { boundary: ScoreCandidateBoundary; invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn(async () => result);
  return { boundary: { invoke }, invoke };
}

function makeRunner(deps?: Partial<PresetScorecardRunnerDeps>): PresetScorecardRunner {
  return createPresetScorecardRunner(deps ?? {});
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PresetScorecardRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default in-process mock: no signal (swap path only).
    vi.mocked(scoreCandidate).mockReturnValue(null);
  });

  describe('generateScorecards (orderbook/perp — boundary path)', () => {
    it('returns empty array for empty presets list', async () => {
      const { boundary } = stubBoundary({ kind: 'success', data: { signal: null, candlesEvaluated: 0 } });
      const runner = makeRunner({ scoreCandidateBoundary: boundary });
      const identity: MarketAssessmentIdentity = {
        instrumentKind: 'perp',
        venueFamily: 'hyperliquid-orderbook',
        styleTier: 'standard',
        symbol: 'BTC',
      };

      const result = await runner.generateScorecards({ identity, presets: [], candles: [] });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.data).toEqual([]);
    });

    it('skips DCA presets', async () => {
      const { boundary } = stubBoundary({ kind: 'success', data: { signal: null, candlesEvaluated: 48 } });
      const runner = makeRunner({ scoreCandidateBoundary: boundary });
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

      const result = await runner.generateScorecards({ identity, presets, candles: [] });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.data).toHaveLength(1);
      expect(result.data[0]!.presetKey).toBe('momentum_v1');
    });

    it('forwards identity.symbol as symbol + providerSymbol for an orderbook identity', async () => {
      const { boundary, invoke } = stubBoundary({ kind: 'success', data: { signal: null, candlesEvaluated: 48 } });
      const runner = makeRunner({ scoreCandidateBoundary: boundary });
      const identity: MarketAssessmentIdentity = {
        instrumentKind: 'orderbook',
        venueFamily: 'hyperliquid-orderbook',
        styleTier: 'standard',
        symbol: 'BTC',
      };
      const presets = [
        { key: 'momentum_v1', entry: makeMockPresetEntry('momentum_v1', 'momentum', 'trend-following') },
      ];

      await runner.generateScorecards({ identity, presets, candles: [] });

      expect(invoke).toHaveBeenCalledTimes(1);
      const call = invoke.mock.calls[0]![0] as { toolName: string; payload: Record<string, unknown> };
      expect(call.toolName).toBe('score_candidate');
      expect(call.payload.symbol).toBe('BTC');
      expect(call.payload.providerSymbol).toBe('BTC');
      expect(call.payload.instrumentId).toBe('BTC');
      expect(call.payload.venueType).toBe('orderbook');
      // in-process scoreCandidate is NOT used on the boundary path
      expect(scoreCandidate).not.toHaveBeenCalled();
    });

    it('maps a boundary signal to scanHealth=healthy with topConfidence', async () => {
      const { boundary } = stubBoundary({
        kind: 'success',
        data: { signal: { confidence: 0.82, action: 'go_long' }, candlesEvaluated: 200 },
      });
      const runner = makeRunner({ scoreCandidateBoundary: boundary });
      const identity: MarketAssessmentIdentity = {
        instrumentKind: 'perp',
        venueFamily: 'hyperliquid-orderbook',
        styleTier: 'standard',
        symbol: 'BTC',
      };
      const presets = [
        { key: 'momentum_v1', entry: makeMockPresetEntry('momentum_v1', 'momentum', 'trend-following') },
      ];

      const result = await runner.generateScorecards({ identity, presets, candles: [] });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      const entry = result.data[0]!;
      expect(entry.scanHealth).toBe('healthy');
      expect(entry.signalsGenerated).toBe(1);
      expect(entry.topConfidence).toBe(0.82);
    });

    it('maps null signal with candles evaluated to scanHealth=no_signal', async () => {
      const { boundary } = stubBoundary({ kind: 'success', data: { signal: null, candlesEvaluated: 200 } });
      const runner = makeRunner({ scoreCandidateBoundary: boundary });
      const identity: MarketAssessmentIdentity = {
        instrumentKind: 'perp',
        venueFamily: 'hyperliquid-orderbook',
        styleTier: 'standard',
        symbol: 'BTC',
      };
      const presets = [{ key: 'momentum_v1', entry: makeMockPresetEntry('momentum_v1', 'momentum', 'trend-following') }];

      const result = await runner.generateScorecards({ identity, presets, candles: [] });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      const entry = result.data[0]!;
      expect(entry.scanHealth).toBe('no_signal');
      expect(entry.signalsGenerated).toBe(0);
      expect(entry.topConfidence).toBeNull();
    });

    it('maps null signal with zero candles evaluated to scanHealth=stale', async () => {
      const { boundary } = stubBoundary({ kind: 'success', data: { signal: null, candlesEvaluated: 0 } });
      const runner = makeRunner({ scoreCandidateBoundary: boundary });
      const identity: MarketAssessmentIdentity = {
        instrumentKind: 'perp',
        venueFamily: 'hyperliquid-orderbook',
        styleTier: 'standard',
        symbol: 'BTC',
      };
      const presets = [{ key: 'momentum_v1', entry: makeMockPresetEntry('momentum_v1', 'momentum', 'trend-following') }];

      const result = await runner.generateScorecards({ identity, presets, candles: [] });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      expect(result.data[0]!.scanHealth).toBe('stale');
    });

    it('propagates a boundary failure as an error Result (no synthesized stale)', async () => {
      const { boundary } = stubBoundary({
        kind: 'failure',
        code: 'upstream.transient',
        message: 'candle provider down',
        retryable: true,
      });
      const runner = makeRunner({ scoreCandidateBoundary: boundary });
      const identity: MarketAssessmentIdentity = {
        instrumentKind: 'perp',
        venueFamily: 'hyperliquid-orderbook',
        styleTier: 'standard',
        symbol: 'BTC',
      };
      const presets = [{ key: 'momentum_v1', entry: makeMockPresetEntry('momentum_v1', 'momentum', 'trend-following') }];

      const result = await runner.generateScorecards({ identity, presets, candles: [] });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected err');
      expect(result.error.code).toBe('assessment.scorecard_failed');
    });

    it('propagates a boundary transport_error as an error Result', async () => {
      const { boundary } = stubBoundary({ kind: 'transport_error', message: 'unreachable', retryable: true });
      const runner = makeRunner({ scoreCandidateBoundary: boundary });
      const identity: MarketAssessmentIdentity = {
        instrumentKind: 'perp',
        venueFamily: 'hyperliquid-orderbook',
        styleTier: 'standard',
        symbol: 'BTC',
      };
      const presets = [{ key: 'momentum_v1', entry: makeMockPresetEntry('momentum_v1', 'momentum', 'trend-following') }];

      const result = await runner.generateScorecards({ identity, presets, candles: [] });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected err');
      expect(result.error.code).toBe('assessment.scorecard_boundary_unreachable');
    });

    it('returns an error when the boundary is not configured', async () => {
      const runner = makeRunner({}); // no boundary
      const identity: MarketAssessmentIdentity = {
        instrumentKind: 'perp',
        venueFamily: 'hyperliquid-orderbook',
        styleTier: 'standard',
        symbol: 'BTC',
      };
      const presets = [{ key: 'momentum_v1', entry: makeMockPresetEntry('momentum_v1', 'momentum', 'trend-following') }];

      const result = await runner.generateScorecards({ identity, presets, candles: [] });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected err');
      expect(result.error.code).toBe('assessment.scorecard_boundary_unavailable');
    });
  });

  describe('generateScorecards (swap/dex — in-process carve-out)', () => {
    it('scores swap identities in-process via scoreCandidate (deferred re-point)', async () => {
      const { boundary, invoke } = stubBoundary({ kind: 'success', data: { signal: null, candlesEvaluated: 0 } });
      const runner = makeRunner({ scoreCandidateBoundary: boundary });
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

      const result = await runner.generateScorecards({ identity, presets, candles });

      expect(result.ok).toBe(true);
      // swap path does NOT call the boundary
      expect(invoke).not.toHaveBeenCalled();
      // swap path DOES call in-process scoreCandidate with the resolved symbol + candles
      expect(scoreCandidate).toHaveBeenCalledTimes(1);
      const candidateArg = vi.mocked(scoreCandidate).mock.calls[0]![0]!;
      expect(candidateArg.symbol).toBe('solana:0xabc');
      expect(candidateArg.candles).toBe(candles);
      expect(candidateArg.venueType).toBeUndefined();
    });

    it('maps an in-process signal to scanHealth=healthy for swap', async () => {
      vi.mocked(scoreCandidate).mockReturnValue({ confidence: 0.6 } as unknown as ReturnType<typeof scoreCandidate>);
      const runner = makeRunner({});
      const identity: MarketAssessmentIdentity = {
        instrumentKind: 'swap',
        venueFamily: 'jupiter',
        styleTier: 'economy',
        network: 'solana',
        address: '0xabc',
      };
      const presets = [{ key: 'momentum_v1', entry: makeMockPresetEntry('momentum_v1', 'momentum', 'trend-following') }];
      const candles = makeMockCandles(100);

      const result = await runner.generateScorecards({ identity, presets, candles });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      const entry = result.data[0]!;
      expect(entry.scanHealth).toBe('healthy');
      expect(entry.topConfidence).toBe(0.6);
    });

    it('handles unknown instrumentKind gracefully', async () => {
      const runner = makeRunner({});
      const identity = {
        instrumentKind: 'invalid-kind',
        venueFamily: 'test',
        styleTier: 'standard',
        symbol: 'BTC',
      } as unknown as MarketAssessmentIdentity;
      const presets = [{ key: 'p1', entry: makeMockPresetEntry('p1', 'momentum', 'trend-following') }];
      const candles = makeMockCandles(100);

      await expect(runner.generateScorecards({ identity, presets, candles })).rejects.toThrow(
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
