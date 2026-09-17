import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createPresetScorecardRunner,
  type PresetScorecardRunner,
  type PresetScorecardRunnerDeps,
  type ScoreCandidateBoundary,
} from './preset-scorecard-runner.js';
import type { PriceCandle } from '@herobids/domain';
import type { MarketAssessmentIdentity, PresetEntry, TradertonReadResult } from '@herobids/domain';

// NOTE (Slice 4 Plan B, intentional divergence): the former
// `vi.mock('@herobids/strategy')` + `scoreCandidate` spy assertions are removed
// — the local strategy package was deleted and in-process scoring no longer
// exists in herobids. The isolation property this mock used to verify ("ALL
// scoring routes over the boundary, none in-process") is now STRUCTURAL: there
// is no in-process scoreCandidate to call. The boundary-backed payload-shape
// and scorecard-mapping assertions below are unchanged and remain meaningful.

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

  describe('generateScorecards (swap/dex — boundary path)', () => {
    it('routes swap scoring over the boundary with a swap token payload (network + tokenAddress), not in-process', async () => {
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
      // swap path DOES call the boundary with a swap token payload
      expect(invoke).toHaveBeenCalledTimes(1);
      const call = invoke.mock.calls[0]![0] as { toolName: string; payload: Record<string, unknown> };
      expect(call.toolName).toBe('score_candidate');
      expect(call.payload.venueType).toBe('swap');
      expect(call.payload.network).toBe('solana');
      expect(call.payload.tokenAddress).toBe('0xabc');
      expect(call.payload.symbol).toBe('solana:0xabc');
      expect(call.payload.instrumentId).toBe('solana:0xabc');
      expect(call.payload.venue).toBe('jupiter');
      // no pool address is passed — the boundary resolves it
      expect(call.payload.poolAddress).toBeUndefined();
    });

    it('routes dex identities over the boundary too (venueType=swap payload)', async () => {
      const { boundary, invoke } = stubBoundary({ kind: 'success', data: { signal: null, candlesEvaluated: 0 } });
      const runner = makeRunner({ scoreCandidateBoundary: boundary });
      const identity: MarketAssessmentIdentity = {
        instrumentKind: 'dex',
        venueFamily: 'uniswap',
        styleTier: 'standard',
        network: 'ethereum',
        address: '0xdef',
      };
      const presets = [{ key: 'momentum_v1', entry: makeMockPresetEntry('momentum_v1', 'momentum', 'trend-following') }];

      await runner.generateScorecards({ identity, presets, candles: [] });

      const call = invoke.mock.calls[0]![0] as { toolName: string; payload: Record<string, unknown> };
      expect(call.payload.venueType).toBe('swap');
      expect(call.payload.network).toBe('ethereum');
      expect(call.payload.tokenAddress).toBe('0xdef');
    });

    it('maps a boundary signal to scanHealth=healthy with topConfidence for swap', async () => {
      const { boundary } = stubBoundary({
        kind: 'success',
        data: { signal: { confidence: 0.6, action: 'go_long' }, candlesEvaluated: 200 },
      });
      const runner = makeRunner({ scoreCandidateBoundary: boundary });
      const identity: MarketAssessmentIdentity = {
        instrumentKind: 'swap',
        venueFamily: 'jupiter',
        styleTier: 'economy',
        network: 'solana',
        address: '0xabc',
      };
      const presets = [{ key: 'momentum_v1', entry: makeMockPresetEntry('momentum_v1', 'momentum', 'trend-following') }];

      const result = await runner.generateScorecards({ identity, presets, candles: [] });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected ok');
      const entry = result.data[0]!;
      expect(entry.scanHealth).toBe('healthy');
      expect(entry.topConfidence).toBe(0.6);
    });

    it('propagates a swap boundary failure as an error Result (no synthesized stale)', async () => {
      const { boundary } = stubBoundary({
        kind: 'failure',
        code: 'swap_pool_unresolved',
        message: 'no pool for token',
        retryable: false,
      });
      const runner = makeRunner({ scoreCandidateBoundary: boundary });
      const identity: MarketAssessmentIdentity = {
        instrumentKind: 'swap',
        venueFamily: 'jupiter',
        styleTier: 'economy',
        network: 'solana',
        address: '0xabc',
      };
      const presets = [{ key: 'momentum_v1', entry: makeMockPresetEntry('momentum_v1', 'momentum', 'trend-following') }];

      const result = await runner.generateScorecards({ identity, presets, candles: [] });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected err');
      expect(result.error.code).toBe('assessment.scorecard_failed');
    });

    it('returns an error when the boundary is not configured (swap)', async () => {
      const runner = makeRunner({}); // no boundary
      const identity: MarketAssessmentIdentity = {
        instrumentKind: 'swap',
        venueFamily: 'jupiter',
        styleTier: 'economy',
        network: 'solana',
        address: '0xabc',
      };
      const presets = [{ key: 'momentum_v1', entry: makeMockPresetEntry('momentum_v1', 'momentum', 'trend-following') }];

      const result = await runner.generateScorecards({ identity, presets, candles: [] });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected err');
      expect(result.error.code).toBe('assessment.scorecard_boundary_unavailable');
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
