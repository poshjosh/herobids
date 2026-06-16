import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MechanicalStrategy } from './mechanical-strategy.js';
import type { MarketSnapshot, CandleFetcher, SentimentProvider, PriceCandle } from '@herobids/domain';
import { price, ok } from '@herobids/domain';
import * as scanEngine from './scan-engine.js';

// Mock scoreCandidate so tests control signal output without real indicator math
vi.mock('./scan-engine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./scan-engine.js')>();
  return { ...actual, scoreCandidate: vi.fn() };
});

const mockScoreCandidate = vi.mocked(scanEngine.scoreCandidate);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCandles(n = 25): PriceCandle[] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: new Date(i * 60_000).toISOString(),
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1_000,
  }));
}

const SYMBOL = 'BTC/USDT';

const BASE_SNAPSHOT: MarketSnapshot = {
  symbol: SYMBOL,
  price: price('50000'),
  timestamp: '2026-01-01T00:00:00Z',
};

// NOTE: When spreading BASE_SNAPSHOT in tests, add new fields after the spread
// (e.g. { ...BASE_SNAPSHOT, playbook: {...}, data: {...} }). This ensures
// explicit fields override BASE_SNAPSHOT defaults. Reversing the order would
// cause the spread of BASE_SNAPSHOT to overwrite the explicit fields.

// Minimum valid MechanicalParamsSchema config (positionSize is required)
const BASE_CONFIG = {
  positionSize: '100',
};

let idSeq = 0;
const idGen = () => `dec-${++idSeq}`;

function makeFetcher(candles: PriceCandle[] = makeCandles()): CandleFetcher {
  return { fetchCandles: vi.fn().mockResolvedValue(candles) };
}

const HIGH_CONFIDENCE_SIGNAL: scanEngine.ScoredSignal = {
  symbol: SYMBOL,
  instrumentId: SYMBOL,
  confidence: 0.75,
  reasons: ['RSI in healthy range', 'MACD bullish crossover', 'Strong volume'],
  intent: 'go_long',
  indicators: { rsi: 55, macdHistogram: 0.5, volumeRatio: 2.0 },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MechanicalStrategy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns go_long when all signals align', async () => {
    const strat = new MechanicalStrategy(makeFetcher(), null, idGen);
    mockScoreCandidate.mockReturnValue(HIGH_CONFIDENCE_SIGNAL);

    const result = await strat.evaluate(BASE_SNAPSHOT, BASE_CONFIG);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data?.intent).toBe('go_long');
      expect(result.data?.targetSize.toString()).toBe('100');
      expect(result.data?.actorId).toBe('mechanical-v1');
    }
  });

  it('returns null when signal score is below threshold and no open position', async () => {
    const strat = new MechanicalStrategy(makeFetcher(), null, idGen);
    // scoreCandidate returns null when RSI is overbought or confidence too low
    mockScoreCandidate.mockReturnValue(null);

    const result = await strat.evaluate(BASE_SNAPSHOT, BASE_CONFIG);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBeNull();
    }
  });

  it('returns go_flat when open position and signal is gone', async () => {
    const strat = new MechanicalStrategy(makeFetcher(), null, idGen);
    mockScoreCandidate.mockReturnValue(null);

    const snapshot: MarketSnapshot = {
      ...BASE_SNAPSHOT,
      data: { hasOpenPosition: true },
    };

    const result = await strat.evaluate(snapshot, BASE_CONFIG);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data?.intent).toBe('go_flat');
      expect(result.data?.targetSize.toString()).toBe('0');
    }
  });

  it('returns null when not enough candles (< 20)', async () => {
    const strat = new MechanicalStrategy(makeFetcher(makeCandles(10)), null, idGen);

    const result = await strat.evaluate(BASE_SNAPSHOT, BASE_CONFIG);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBeNull();
    }
    expect(mockScoreCandidate).not.toHaveBeenCalled();
  });

  it('skips entry when avoidParabolicMovePct is breached', async () => {
    // Last candle has 10% move; avoidParabolicMovePct = 5
    const candles = makeCandles(25);
    candles[candles.length - 1] = { ...candles[candles.length - 1]!, open: 100, high: 110, close: 110 };
    const strat = new MechanicalStrategy(makeFetcher(candles), null, idGen);
    mockScoreCandidate.mockReturnValue(HIGH_CONFIDENCE_SIGNAL);

    const snapshot: MarketSnapshot = {
      ...BASE_SNAPSHOT,
      playbook: { avoidParabolicMovePct: 5 },
    };

    const result = await strat.evaluate(snapshot, BASE_CONFIG);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBeNull();
    }
  });

  it('returns go_flat when avoidParabolicMovePct is breached and there is an open position', async () => {
    const candles = makeCandles(25);
    candles[candles.length - 1] = { ...candles[candles.length - 1]!, open: 100, high: 110, close: 110 };
    const strat = new MechanicalStrategy(makeFetcher(candles), null, idGen);
    mockScoreCandidate.mockReturnValue(HIGH_CONFIDENCE_SIGNAL);

    const snapshot: MarketSnapshot = {
      ...BASE_SNAPSHOT,
      playbook: { avoidParabolicMovePct: 5 },
      data: { openPositionSize: '100' },
    };

    const result = await strat.evaluate(snapshot, BASE_CONFIG);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data?.intent).toBe('go_flat');
    }
  });

  it('skips entry when maxNewPositionsPerDay is reached', async () => {
    const strat = new MechanicalStrategy(makeFetcher(), null, idGen);
    mockScoreCandidate.mockReturnValue(HIGH_CONFIDENCE_SIGNAL);

    const snapshot: MarketSnapshot = {
      ...BASE_SNAPSHOT,
      playbook: { maxNewPositionsPerDay: 3 },
      data: { newPositionsToday: 3 },
    };

    const result = await strat.evaluate(snapshot, BASE_CONFIG);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBeNull();
    }
  });

  it('returns go_long when newPositionsToday is below maxNewPositionsPerDay', async () => {
    const strat = new MechanicalStrategy(makeFetcher(), null, idGen);
    mockScoreCandidate.mockReturnValue(HIGH_CONFIDENCE_SIGNAL);

    const snapshot: MarketSnapshot = {
      ...BASE_SNAPSHOT,
      playbook: { maxNewPositionsPerDay: 3 },
      data: { newPositionsToday: 2 },
    };

    const result = await strat.evaluate(snapshot, BASE_CONFIG);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data?.intent).toBe('go_long');
    }
  });

  it('suppresses go_long and returns go_flat when negative sentiment drops confidence below threshold', async () => {
    const sentimentProvider: SentimentProvider = {
      getScore: vi.fn().mockResolvedValue(
        ok({ symbol: SYMBOL, score: -1, confidence: 1, source: 'test', fetchedAt: Date.now() }),
      ),
    };

    const strat = new MechanicalStrategy(makeFetcher(), sentimentProvider, idGen);
    // Signal has borderline confidence of 0.46; minConfidence default is 0.45
    // Negative sentiment: boost = -1 * 1 * 0.1 = -0.1 → adjusted = 0.36 < 0.45 → suppress
    mockScoreCandidate.mockReturnValue({
      ...HIGH_CONFIDENCE_SIGNAL,
      confidence: 0.46,
    });

    const config = { ...BASE_CONFIG, sentiment: { enabled: true } };
    const snapshot: MarketSnapshot = {
      ...BASE_SNAPSHOT,
      data: { hasOpenPosition: true },
    };

    const result = await strat.evaluate(snapshot, config);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Sentiment suppressed signal + open position → go_flat
      expect(result.data?.intent).toBe('go_flat');
    }
  });

  it('returns error when config is invalid', async () => {
    const strat = new MechanicalStrategy(makeFetcher(), null, idGen);

    // Missing required positionSize
    const result = await strat.evaluate(BASE_SNAPSHOT, {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('strategy.config_invalid');
    }
  });

  it('returns error when candle fetch fails', async () => {
    const failingFetcher: CandleFetcher = {
      fetchCandles: vi.fn().mockRejectedValue(new Error('network timeout')),
    };
    const strat = new MechanicalStrategy(failingFetcher, null, idGen);

    const result = await strat.evaluate(BASE_SNAPSHOT, BASE_CONFIG);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('strategy.candle_fetch_failed');
    }
  });

  it('calls debug callback once when playbook is absent but position state exists', async () => {
    const debug = vi.fn();
    const strat = new MechanicalStrategy(makeFetcher(), null, idGen, debug);
    // Must return a signal so we don't early-exit before the debug check
    mockScoreCandidate.mockReturnValue(HIGH_CONFIDENCE_SIGNAL);

    const snapshot: MarketSnapshot = {
      ...BASE_SNAPSHOT,
      playbook: undefined,
      data: { hasOpenPosition: true },
    };

    await strat.evaluate(snapshot, BASE_CONFIG);

    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith(
      'snapshot.playbook absent — playbook guards skipped (TradingActor may need updating)',
      { symbol: SYMBOL },
    );
  });

  it('does not fire playbook-absent debug more than once across multiple ticks', async () => {
    const debug = vi.fn();
    const strat = new MechanicalStrategy(makeFetcher(), null, idGen, debug);
    mockScoreCandidate.mockReturnValue(HIGH_CONFIDENCE_SIGNAL);

    const snapshot: MarketSnapshot = {
      ...BASE_SNAPSHOT,
      playbook: undefined,
      data: { hasOpenPosition: true },
    };

    await strat.evaluate(snapshot, BASE_CONFIG);
    await strat.evaluate(snapshot, BASE_CONFIG);
    await strat.evaluate(snapshot, BASE_CONFIG);

    expect(debug).toHaveBeenCalledTimes(1);
  });
});
