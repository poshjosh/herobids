import { describe, it, expect, vi } from 'vitest';
import { completeTechnicalScan, type CompleteTechnicalScanParams } from './complete-technical-scan.js';
import { deriveScannerHealth } from './complete-technical-scan.js';
import { computeSignalFingerprint, bucketConfidence } from './complete-technical-scan.js';
import { buildPersistableCandidates } from './complete-technical-scan.js';
import type { TechnicalPhaseResult } from './technical-phase.js';
import type { TechnicalConfig } from '@herobids/domain';
import type { ScoredSignal } from '@herobids/strategy';

// ─── Fixture helpers ─────────────────────────────────────────────────────────

function makePhaseResult(overrides?: Partial<TechnicalPhaseResult>): TechnicalPhaseResult {
  return {
    candidatesDiscovered: 5,
    symbolsSelected: 3,
    candidatesScored: 3,
    signalsGenerated: 2,
    entriesSubmitted: 0,
    exitsSubmitted: 0,
    regimeBlocked: false,
    errors: [],
    signals: [
      {
        symbol: 'ETH-PERP',
        instrumentId: 'ETH-PERP',
        confidence: 0.72,
        reasons: ['RSI healthy', 'MACD crossover'],
        intent: 'go_long',
        indicators: { rsi: 55, macdHistogram: 0.5, volumeRatio: 2.1 },
      },
      {
        symbol: 'SOL-PERP',
        instrumentId: 'SOL-PERP',
        confidence: 0.58,
        reasons: ['RSI healthy', 'MACD positive'],
        intent: 'go_long',
        indicators: { rsi: 48, macdHistogram: 0.2, volumeRatio: 1.6 },
      },
    ],
    regimeResult: {
      pass: true,
      reasons: ['ADX strong', 'bullish alignment'],
      details: {
        benchmarkSymbol: 'BTC',
        currentPrice: 65000,
        adxValue: 32,
        emaAlignment: 'bullish',
        marketStructure: 'higherHighs',
        priceAboveVwap: true,
        choppy: false,
      },
    },
    positionIndicators: [],
    summary: { scanned: 5, rejected: 2, passed: 3 },
    symbolOutcomes: [
      { symbol: 'ETH-PERP', status: 'eligible_fetched', candleCount: 100 },
      { symbol: 'SOL-PERP', status: 'eligible_fetched', candleCount: 100 },
      { symbol: 'ARB-PERP', status: 'eligible_fetched', candleCount: 100 },
    ],
    unsupportedCount: 0,
    fetchFailures: 0,
    eligibleCount: 3,
    fetchedCount: 3,
    ...overrides,
  };
}

function makeTechnicalConfig(overrides?: Partial<TechnicalConfig>): TechnicalConfig {
  return {
    filters: { venue: 'hyperliquid', venueType: 'orderbook' },
    indicators: {
      rsi: { enabled: true, period: 14, healthyMin: 40, healthyMax: 70, overbought: 80, weakBelow: 30 },
      macd: { enabled: true, fast: 12, slow: 26, signal: 9 },
      volume: { enabled: true, strongRatio: 1.5, weakRatio: 0.5, recentBars: 4, avgBars: 20 },
      choch: { enabled: false, swingLookback: 5, minSwingPct: 0.01, minSwings: 4, confirmBars: 2, rejectOnBearish: false },
      supportResistance: { enabled: false, lookback: 50, breakoutThreshold: 0.005 },
      confidence: {
        rsiWeight: 0.15, macdCrossoverWeight: 0.20, macdIncreasingWeight: 0.10,
        volumeWeight: 0.15, breakoutWeight: 0.15, chochBullishWeight: 0.15,
        chochBearishPenalty: 0.10, priceActionWeight: 0.10,
        minConfidence: 0.45, minReasons: 2,
      },
    },
    candles: { interval: '15m', limit: 100 },
    signalBias: 'trend-following',
    scanIntervalMs: 60_000,
    scanBatchSize: 5,
    ...overrides,
  };
}

function makeParams(overrides?: Partial<CompleteTechnicalScanParams>): CompleteTechnicalScanParams {
  return {
    phaseResult: makePhaseResult(),
    technicalConfig: makeTechnicalConfig(),
    agentId: 'agent-test-1',
    isHybridMode: true,
    onTechnicalScanComplete: vi.fn(),
    emitAgentWake: vi.fn().mockResolvedValue(undefined),
    onJournalEvent: vi.fn(),
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('completeTechnicalScan', () => {
  // ── Test 1: Actionable signals → scan_completed + wake emitted ──────────────

  it('calls onTechnicalScanComplete and emitAgentWake when signals are present and hybrid mode is on', async () => {
    const onTechnicalScanComplete = vi.fn();
    const emitAgentWake = vi.fn().mockResolvedValue(undefined);

    const scan = await completeTechnicalScan(makeParams({
      onTechnicalScanComplete,
      emitAgentWake,
    }));

    expect(onTechnicalScanComplete).toHaveBeenCalledTimes(1);
    expect(onTechnicalScanComplete).toHaveBeenCalledWith('agent-test-1', expect.objectContaining({
      signalsGenerated: 2,
    }));

    expect(emitAgentWake).toHaveBeenCalledTimes(1);
    expect(emitAgentWake).toHaveBeenCalledWith('agent-test-1', expect.objectContaining({
      source: 'scanner',
      priority: 'normal',
      context: expect.objectContaining({
        scannerKind: 'signal_scoring',
        signalCount: 2,
        topSymbol: 'ETH-PERP',
        topConfidence: 0.72,
        regimePass: true,
      }),
    }));

    expect(scan.signalsGenerated).toBe(2);
    expect(scan.symbolOutcomes).toHaveLength(3);
    expect(scan.discovered).toBe(5);
  });

  // ── Test 2: Exit advisories only → wake emitted with high priority ─────────

  it('calls onTechnicalScanComplete and emitAgentWake with priority=high when exit advisories present', async () => {
    const onTechnicalScanComplete = vi.fn();
    const emitAgentWake = vi.fn().mockResolvedValue(undefined);

    const phaseResult = makePhaseResult({
      signals: [],
      signalsGenerated: 0,
      positionIndicators: [
        {
          symbol: 'ARB-PERP',
          side: 'long',
          entryPrice: 1.2,
          rsi: 78,
          signalNote: 'Overbought',
          exitAdvisory: true,
        },
        {
          symbol: 'BTC-PERP',
          side: 'long',
          entryPrice: 65000,
          rsi: 82,
          signalNote: 'Overbought',
          exitAdvisory: true,
        },
      ],
    });

    const scan = await completeTechnicalScan(makeParams({
      phaseResult,
      onTechnicalScanComplete,
      emitAgentWake,
    }));

    expect(onTechnicalScanComplete).toHaveBeenCalledTimes(1);
    expect(emitAgentWake).toHaveBeenCalledTimes(1);
    expect(emitAgentWake).toHaveBeenCalledWith('agent-test-1', expect.objectContaining({
      source: 'scanner',
      priority: 'high',
      context: expect.objectContaining({
        signalCount: 0,
      }),
    }));

    // Reason should mention exit advisories
    const wakeCall = emitAgentWake.mock.calls[0]?.[1];
    expect(wakeCall?.reason).toContain('exit advisory');
    expect(wakeCall?.reason).toContain('ARB-PERP');
    expect(wakeCall?.reason).toContain('BTC-PERP');

    expect(scan.signalsGenerated).toBe(0);
    expect(scan.positionIndicators).toHaveLength(2);
  });

  // ── Test 3: No signals, no exit advisories, data healthy → scan_completed but NO wake

  it('calls onTechnicalScanComplete but NOT emitAgentWake when no signals and no exit advisories', async () => {
    const onTechnicalScanComplete = vi.fn();
    const emitAgentWake = vi.fn().mockResolvedValue(undefined);

    const phaseResult = makePhaseResult({
      signals: [],
      signalsGenerated: 0,
      positionIndicators: [],
    });

    const scan = await completeTechnicalScan(makeParams({
      phaseResult,
      onTechnicalScanComplete,
      emitAgentWake,
    }));

    expect(onTechnicalScanComplete).toHaveBeenCalledTimes(1);
    expect(onTechnicalScanComplete).toHaveBeenCalledWith('agent-test-1', expect.objectContaining({
      signalsGenerated: 0,
      fetched: 3,
    }));

    expect(emitAgentWake).not.toHaveBeenCalled();
    expect(scan.signalsGenerated).toBe(0);
  });

  // ── Test 4: Data-path failure (fetched=0, eligible>0) → scanner.data_path_failure

  it('classifies fetched=0 eligible>0 as data_path_failure and journals scanner.data_path_failure', async () => {
    const onTechnicalScanComplete = vi.fn();
    const emitAgentWake = vi.fn().mockResolvedValue(undefined);
    const onJournalEvent = vi.fn();

    const phaseResult = makePhaseResult({
      signals: [],
      signalsGenerated: 0,
      candidatesScored: 0,
      symbolOutcomes: [
        { symbol: 'ETH-PERP', status: 'eligible_empty', candleCount: 0 },
        { symbol: 'SOL-PERP', status: 'eligible_empty', candleCount: 0 },
      ],
      fetchedCount: 0,
      eligibleCount: 2,
      unsupportedCount: 3,
    });

    const scan = await completeTechnicalScan(makeParams({
      phaseResult,
      onTechnicalScanComplete,
      emitAgentWake,
      onJournalEvent,
    }));

    expect(onJournalEvent).toHaveBeenCalledTimes(1);
    expect(onJournalEvent).toHaveBeenCalledWith({
      type: 'scanner.data_path_failure',
      payload: expect.objectContaining({
        agentId: 'agent-test-1',
        eligible: 2,
        fetched: 0,
        unsupported: 3,
        discovered: 5,
        signalsGenerated: 0,
        scored: 0,
      }),
    });

    expect(scan.scannerHealth).toEqual({
      status: 'data_path_failure',
      reason: 'fetched=0, eligible=2 — candle data unavailable',
    });

    expect(onTechnicalScanComplete).toHaveBeenCalledTimes(1);
    expect(emitAgentWake).not.toHaveBeenCalled();
    expect(scan.fetched).toBe(0);
    expect(scan.eligible).toBe(2);
  });

  // ── Test 5: Overlap skipped → scan_completed with overlapSkipped, no wake ──

  it('calls onTechnicalScanComplete with overlapSkipped=true and does NOT wake when overlapSkipped', async () => {
    const onTechnicalScanComplete = vi.fn();
    const emitAgentWake = vi.fn().mockResolvedValue(undefined);

    const phaseResult = makePhaseResult({
      signals: [],
      signalsGenerated: 0,
      overlapSkipped: true,
      candidatesDiscovered: 0,
      symbolsSelected: 0,
      eligibleCount: 0,
      fetchedCount: 0,
      symbolOutcomes: [],
    });

    const scan = await completeTechnicalScan(makeParams({
      phaseResult,
      onTechnicalScanComplete,
      emitAgentWake,
    }));

    expect(onTechnicalScanComplete).toHaveBeenCalledTimes(1);
    expect(scan.overlapSkipped).toBe(true);
    expect(scan.discovered).toBe(0);
    expect(scan.fetched).toBe(0);

    expect(emitAgentWake).not.toHaveBeenCalled();
  });

  // ── Test 6: Non-hybrid mode → onTechnicalScanComplete called but NO wake ────

  it('calls onTechnicalScanComplete but NOT emitAgentWake when isHybridMode is false', async () => {
    const onTechnicalScanComplete = vi.fn();
    const emitAgentWake = vi.fn().mockResolvedValue(undefined);

    const scan = await completeTechnicalScan(makeParams({
      isHybridMode: false,
      onTechnicalScanComplete,
      emitAgentWake,
    }));

    expect(onTechnicalScanComplete).toHaveBeenCalledTimes(1);
    expect(onTechnicalScanComplete).toHaveBeenCalledWith('agent-test-1', expect.objectContaining({
      signalsGenerated: 2,
    }));

    expect(emitAgentWake).not.toHaveBeenCalled();
    expect(scan.signalsGenerated).toBe(2);
  });

  // ── Test 7: Capacity skip (same as overlap skip) → overlap_skipped journal + scannerHealth

  it('produces overlapSkipped=true with scannerHealth=overlap_skipped and journals scanner.overlap_skipped', async () => {
    const onTechnicalScanComplete = vi.fn();
    const emitAgentWake = vi.fn().mockResolvedValue(undefined);
    const onJournalEvent = vi.fn();

    const phaseResult = makePhaseResult({
      signals: [],
      signalsGenerated: 0,
      overlapSkipped: true,
      candidatesDiscovered: 0,
      symbolsSelected: 0,
      eligibleCount: 0,
      fetchedCount: 0,
      symbolOutcomes: [],
      positionIndicators: [],
    });

    const scan = await completeTechnicalScan(makeParams({
      phaseResult,
      onTechnicalScanComplete,
      emitAgentWake,
      onJournalEvent,
    }));

    expect(onTechnicalScanComplete).toHaveBeenCalledTimes(1);
    expect(scan.overlapSkipped).toBe(true);
    expect(scan.discovered).toBe(0);

    // No wake for skipped scans
    expect(emitAgentWake).not.toHaveBeenCalled();

    // overlap_skipped health classification is journaled
    expect(onJournalEvent).toHaveBeenCalledTimes(1);
    expect(onJournalEvent).toHaveBeenCalledWith({
      type: 'scanner.overlap_skipped',
      payload: expect.objectContaining({
        agentId: 'agent-test-1',
        eligible: 0,
        fetched: 0,
        discovered: 0,
      }),
    });

    expect(scan.scannerHealth).toEqual({
      status: 'overlap_skipped',
      reason: 'Scan skipped — previous scan still in progress',
    });
  });

  // ── Edge case: data unhealthy but no journal callback registered ────────────

  it('does not throw when data path failure but onJournalEvent is undefined', async () => {
    const phaseResult = makePhaseResult({
      signals: [],
      signalsGenerated: 0,
      fetchedCount: 0,
      eligibleCount: 3,
      symbolOutcomes: [
        { symbol: 'ETH-PERP', status: 'eligible_empty', candleCount: 0 },
      ],
    });

    const scan = await completeTechnicalScan(makeParams({
      phaseResult,
      onJournalEvent: undefined,
      emitAgentWake: undefined,
    }));

    expect(scan.fetched).toBe(0);
    expect(scan.eligible).toBe(3);
  });

  // ── Edge case: handles missing optional callbacks gracefully ───────────────

  it('completes successfully when all callbacks are undefined', async () => {
    const scan = await completeTechnicalScan(makeParams({
      onTechnicalScanComplete: undefined,
      emitAgentWake: undefined,
      onJournalEvent: undefined,
    }));

    expect(scan.signalsGenerated).toBe(2);
    expect(scan.timestamp).toBeTruthy();
  });

  // ── Pricing identity preservation ──────────────────────────────────────────

  it('preserves Bybit pricing identities from signals into scan.pricingIdentities', async () => {
    const bybitSignal: ScoredSignal = {
      symbol: 'BTC',
      instrumentId: 'BTCUSDT',
      confidence: 0.88,
      reasons: ['RSI healthy'],
      intent: 'go_long',
      indicators: { rsi: 55 },
      pricingIdentity: { kind: 'perps', symbol: 'BTCUSDT', chain: 'bybit' },
    };
    const phaseResult = makePhaseResult({
      signals: [bybitSignal],
      signalsGenerated: 1,
    });
    const scan = await completeTechnicalScan(makeParams({ phaseResult }));
    expect(scan.pricingIdentities).toEqual({
      'BTCUSDT': { kind: 'perps', symbol: 'BTCUSDT', chain: 'bybit' },
    });
  });

  it('preserves Hyperliquid pricing identities from signals into scan.pricingIdentities', async () => {
    const hlSignal: ScoredSignal = {
      symbol: 'BTC',
      instrumentId: 'BTC-PERP',
      confidence: 0.92,
      reasons: ['volume strong'],
      intent: 'go_long',
      indicators: { rsi: 60 },
      pricingIdentity: { kind: 'perps', symbol: 'BTC', chain: 'hyperliquid' },
    };
    const phaseResult = makePhaseResult({
      signals: [hlSignal],
      signalsGenerated: 1,
    });
    const scan = await completeTechnicalScan(makeParams({ phaseResult }));
    expect(scan.pricingIdentities).toEqual({
      'BTC-PERP': { kind: 'perps', symbol: 'BTC', chain: 'hyperliquid' },
    });
  });

  it('excludes signals lacking pricingIdentity from scan.pricingIdentities', async () => {
    const noIdentitySignal: ScoredSignal = {
      symbol: 'ETH',
      instrumentId: 'ETH-PERP',
      confidence: 0.65,
      reasons: ['MACD bullish'],
      intent: 'go_long',
      indicators: { rsi: 52 },
      // pricingIdentity intentionally omitted — fail-closed
    };
    const phaseResult = makePhaseResult({
      signals: [noIdentitySignal],
      signalsGenerated: 1,
    });
    const scan = await completeTechnicalScan(makeParams({ phaseResult }));
    expect(scan.pricingIdentities).toEqual({});
  });

  it('includes only signals with pricingIdentity when mixed', async () => {
    const withIdentity: ScoredSignal = {
      symbol: 'BTC',
      instrumentId: 'BTC-PERP',
      confidence: 0.88,
      reasons: ['strong'],
      intent: 'go_long',
      indicators: { rsi: 55 },
      pricingIdentity: { kind: 'perps', symbol: 'BTC', chain: 'hyperliquid' },
    };
    const withoutIdentity: ScoredSignal = {
      symbol: 'ETH',
      instrumentId: 'ETH-PERP',
      confidence: 0.65,
      reasons: ['moderate'],
      intent: 'go_long',
      indicators: { rsi: 52 },
      // no pricingIdentity
    };
    const phaseResult = makePhaseResult({
      signals: [withIdentity, withoutIdentity],
      signalsGenerated: 2,
    });
    const scan = await completeTechnicalScan(makeParams({ phaseResult }));
    expect(scan.pricingIdentities).toEqual({
      'BTC-PERP': { kind: 'perps', symbol: 'BTC', chain: 'hyperliquid' },
    });
  });
});

// ─── Scanner health classification ───────────────────────────────────────────

describe('deriveScannerHealth', () => {
  it('classifies overlap_skipped when overlapSkipped is true', () => {
    const result = deriveScannerHealth(makePhaseResult({
      overlapSkipped: true,
      candidatesDiscovered: 5,
    }));
    expect(result).toEqual({
      status: 'overlap_skipped',
      reason: 'Scan skipped — previous scan still in progress',
    });
  });

  it('classifies no_candidates when candidatesDiscovered is 0', () => {
    const result = deriveScannerHealth(makePhaseResult({
      candidatesDiscovered: 0,
      symbolsSelected: 0,
    }));
    expect(result).toEqual({
      status: 'no_candidates',
      reason: 'No candidates discovered — check venue binding and filters',
    });
  });

  it('classifies data_path_failure when fetchedCount is 0', () => {
    const result = deriveScannerHealth(makePhaseResult({
      candidatesDiscovered: 5,
      fetchedCount: 0,
      eligibleCount: 3,
    }));
    expect(result).toEqual({
      status: 'data_path_failure',
      reason: 'fetched=0, eligible=3 — candle data unavailable',
    });
  });

  it('classifies data_path_failure when eligibleCount is 0', () => {
    const result = deriveScannerHealth(makePhaseResult({
      candidatesDiscovered: 5,
      fetchedCount: 5,
      eligibleCount: 0,
    }));
    expect(result).toEqual({
      status: 'data_path_failure',
      reason: 'fetched=5, eligible=0 — candle data unavailable',
    });
  });

  it('classifies healthy_no_signal when data is healthy but no signals generated', () => {
    const result = deriveScannerHealth(makePhaseResult({
      candidatesDiscovered: 5,
      eligibleCount: 3,
      fetchedCount: 3,
      candidatesScored: 3,
      signalsGenerated: 0,
      signals: [],
      positionIndicators: [],
    }));
    expect(result).toEqual({
      status: 'healthy_no_signal',
      reason: 'Data available, candidates scored, no signals generated — conservative strategy',
    });
  });

  it('classifies healthy_signals when signals are present', () => {
    const result = deriveScannerHealth(makePhaseResult({
      candidatesDiscovered: 5,
      eligibleCount: 3,
      fetchedCount: 3,
      candidatesScored: 3,
      signalsGenerated: 2,
    }));
    expect(result).toEqual({
      status: 'healthy_signals',
      reason: '2 signal(s) generated',
    });
  });

  it('overlap_skipped takes precedence over other classifications', () => {
    const result = deriveScannerHealth(makePhaseResult({
      overlapSkipped: true,
      candidatesDiscovered: 0, // would be no_candidates, but overlap wins
    }));
    expect(result.status).toBe('overlap_skipped');
  });

  it('no_candidates takes precedence over data_path_failure', () => {
    const result = deriveScannerHealth(makePhaseResult({
      candidatesDiscovered: 0,
      fetchedCount: 0,
      eligibleCount: 0,
    }));
    expect(result.status).toBe('no_candidates');
  });
});

// ─── Fingerprint helpers ──────────────────────────────────────────────────────

describe('bucketConfidence', () => {
  it('buckets confidence to the nearest band', () => {
    expect(bucketConfidence(0.40, 0.05)).toBe('0.40');
    expect(bucketConfidence(0.42, 0.05)).toBe('0.40'); // same bucket as 0.40
    expect(bucketConfidence(0.43, 0.05)).toBe('0.45'); // rounds to 0.45
    expect(bucketConfidence(0.48, 0.05)).toBe('0.50');
    expect(bucketConfidence(0.90, 0.05)).toBe('0.90');
    expect(bucketConfidence(0.94, 0.05)).toBe('0.95');
  });

  it('handles edge values correctly', () => {
    expect(bucketConfidence(0.00, 0.05)).toBe('0.00');
    expect(bucketConfidence(1.00, 0.05)).toBe('1.00');
    expect(bucketConfidence(0.999, 0.05)).toBe('1.00');
  });

  it('works with different bucket sizes', () => {
    expect(bucketConfidence(0.40, 0.10)).toBe('0.40');
    expect(bucketConfidence(0.42, 0.10)).toBe('0.40');
    expect(bucketConfidence(0.46, 0.10)).toBe('0.50');
    expect(bucketConfidence(0.33, 0.02)).toBe('0.34');
  });
});

describe('computeSignalFingerprint', () => {
  const defaultBucketSize = 0.05;
  const defaultTopN = 5;

  function makeSignal(instrumentId: string, confidence: number): ScoredSignal {
    return {
      symbol: instrumentId,
      instrumentId,
      confidence,
      reasons: [],
      intent: 'go_long',
      indicators: {},
    };
  }

  it('produces same fingerprint for identical signals', () => {
    const signals = [makeSignal('LIT-PERP', 0.90), makeSignal('ETH-PERP', 0.40)];
    const fp1 = computeSignalFingerprint(signals, [], true, defaultTopN, defaultBucketSize);
    const fp2 = computeSignalFingerprint(signals, [], true, defaultTopN, defaultBucketSize);
    expect(fp1).toBe(fp2);
  });

  it('produces same fingerprint when confidence is within same bucket (noise absorption)', () => {
    const signals1 = [makeSignal('ETH-PERP', 0.40)];
    const signals2 = [makeSignal('ETH-PERP', 0.42)];
    const fp1 = computeSignalFingerprint(signals1, [], true, defaultTopN, defaultBucketSize);
    const fp2 = computeSignalFingerprint(signals2, [], true, defaultTopN, defaultBucketSize);
    expect(fp1).toBe(fp2);
  });

  it('produces different fingerprint when confidence crosses bucket boundary', () => {
    const signals1 = [makeSignal('ETH-PERP', 0.40)];
    const signals2 = [makeSignal('ETH-PERP', 0.52)];
    const fp1 = computeSignalFingerprint(signals1, [], true, defaultTopN, defaultBucketSize);
    const fp2 = computeSignalFingerprint(signals2, [], true, defaultTopN, defaultBucketSize);
    expect(fp1).not.toBe(fp2);
  });

  it('produces same fingerprint regardless of ranking order (rank-insensitive)', () => {
    const signals1 = [makeSignal('A-PERP', 0.90), makeSignal('B-PERP', 0.50)];
    const signals2 = [makeSignal('B-PERP', 0.50), makeSignal('A-PERP', 0.90)];
    const fp1 = computeSignalFingerprint(signals1, [], true, defaultTopN, defaultBucketSize);
    const fp2 = computeSignalFingerprint(signals2, [], true, defaultTopN, defaultBucketSize);
    expect(fp1).toBe(fp2);
  });

  it('produces different fingerprint when a new instrument enters the top set', () => {
    const signals1 = [makeSignal('A-PERP', 0.90), makeSignal('B-PERP', 0.50)];
    const signals2 = [makeSignal('A-PERP', 0.90), makeSignal('C-PERP', 0.50)];
    const fp1 = computeSignalFingerprint(signals1, [], true, defaultTopN, defaultBucketSize);
    const fp2 = computeSignalFingerprint(signals2, [], true, defaultTopN, defaultBucketSize);
    expect(fp1).not.toBe(fp2);
  });

  it('produces different fingerprint when an instrument drops out of the top set', () => {
    const signals1 = [makeSignal('A-PERP', 0.90), makeSignal('B-PERP', 0.50), makeSignal('C-PERP', 0.40)];
    const signals2 = [makeSignal('A-PERP', 0.90), makeSignal('B-PERP', 0.50)];
    const fp1 = computeSignalFingerprint(signals1, [], true, defaultTopN, defaultBucketSize);
    const fp2 = computeSignalFingerprint(signals2, [], true, defaultTopN, defaultBucketSize);
    expect(fp1).not.toBe(fp2);
  });

  it('produces different fingerprint when exit advisory appears', () => {
    const signals = [makeSignal('A-PERP', 0.90)];
    const fp1 = computeSignalFingerprint(signals, [], true, defaultTopN, defaultBucketSize);
    const fp2 = computeSignalFingerprint(signals, ['HYPE-PERP'], true, defaultTopN, defaultBucketSize);
    expect(fp1).not.toBe(fp2);
  });

  it('produces different fingerprint when exit advisory resolves (goes back to none)', () => {
    const signals = [makeSignal('A-PERP', 0.90)];
    const fp1 = computeSignalFingerprint(signals, ['HYPE-PERP'], true, defaultTopN, defaultBucketSize);
    const fp2 = computeSignalFingerprint(signals, [], true, defaultTopN, defaultBucketSize);
    expect(fp1).not.toBe(fp2);
  });

  it('produces different fingerprint when regime flips', () => {
    const signals = [makeSignal('A-PERP', 0.90)];
    const fp1 = computeSignalFingerprint(signals, [], true, defaultTopN, defaultBucketSize);
    const fp2 = computeSignalFingerprint(signals, [], false, defaultTopN, defaultBucketSize);
    expect(fp1).not.toBe(fp2);
  });

  it('includes regime:unavailable when regimePass is null', () => {
    const signals = [makeSignal('A-PERP', 0.90)];
    const fp = computeSignalFingerprint(signals, [], null, defaultTopN, defaultBucketSize);
    expect(fp).toContain('regime:unavailable');
  });

  it('includes regime:pass when regimePass is true', () => {
    const signals = [makeSignal('A-PERP', 0.90)];
    const fp = computeSignalFingerprint(signals, [], true, defaultTopN, defaultBucketSize);
    expect(fp).toContain('regime:pass');
  });

  it('includes regime:block when regimePass is false', () => {
    const signals = [makeSignal('A-PERP', 0.90)];
    const fp = computeSignalFingerprint(signals, [], false, defaultTopN, defaultBucketSize);
    expect(fp).toContain('regime:block');
  });

  it('produces exit:none when no exit advisories', () => {
    const signals = [makeSignal('A-PERP', 0.90)];
    const fp = computeSignalFingerprint(signals, [], true, defaultTopN, defaultBucketSize);
    expect(fp).toContain('exit:none');
  });

  it('sorts exit advisory symbols alphabetically', () => {
    const signals = [makeSignal('A-PERP', 0.90)];
    const fp = computeSignalFingerprint(signals, ['Z-PERP', 'A-PERP'], true, defaultTopN, defaultBucketSize);
    expect(fp).toContain('exit:A-PERP,Z-PERP');
  });

  it('only includes top N signals in the fingerprint', () => {
    const signals = [
      makeSignal('A-PERP', 0.90),
      makeSignal('B-PERP', 0.80),
      makeSignal('C-PERP', 0.70),
      makeSignal('D-PERP', 0.60),
      makeSignal('E-PERP', 0.50),
    ];
    const fp = computeSignalFingerprint(signals, [], true, 3, defaultBucketSize);
    // D-PERP and E-PERP should not be in the fingerprint
    expect(fp).not.toContain('D-PERP');
    expect(fp).not.toContain('E-PERP');
    expect(fp).toContain('A-PERP');
    expect(fp).toContain('B-PERP');
    expect(fp).toContain('C-PERP');
  });

  it('handles empty signals gracefully', () => {
    const fp = computeSignalFingerprint([], [], true, defaultTopN, defaultBucketSize);
    expect(fp).toBe('exit:none|regime:pass');
  });
});

// ─── Phase 4: Swap signal identity validation ────────────────────────────────

describe('Phase 4 — swap signal identity validation', () => {
  it('removes a swap signal that is missing pricingIdentity from scan signals', async () => {
    const swapSignal: ScoredSignal = {
      symbol: 'BONK',
      instrumentId: 'BONK:ADDR/USDC:ADDR',
      venueType: 'swap',
      confidence: 0.78,
      reasons: ['volume strong'],
      intent: 'go_long',
      indicators: { rsi: 48 },
      // pricingIdentity intentionally omitted — should be dropped
    };
    const phaseResult = makePhaseResult({
      signals: [swapSignal],
      signalsGenerated: 1,
    });
    const onJournalEvent = vi.fn();

    const scan = await completeTechnicalScan(makeParams({
      phaseResult,
      onJournalEvent,
    }));

    // The swap signal should be filtered out
    expect(scan.signals).toHaveLength(0);
    expect(scan.signalsGenerated).toBe(0);
    expect(scan.pricingIdentities).toEqual({});

    // A journal event should be emitted
    expect(onJournalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'scanner.incomplete_swap_identity',
        payload: expect.objectContaining({
          symbol: 'BONK',
          hasPricingIdentity: false,
        }),
      }),
    );
  });

  it('removes a swap signal with pricingIdentity but missing chain', async () => {
    const swapSignal: ScoredSignal = {
      symbol: 'BONK',
      instrumentId: 'BONK:ADDR/USDC:ADDR',
      venueType: 'swap',
      confidence: 0.78,
      reasons: ['volume strong'],
      intent: 'go_long',
      indicators: { rsi: 48 },
      pricingIdentity: { kind: 'dex', symbol: 'BONK', chain: '', address: '0xaddr' },
      swapExecutionIdentity: {
        network: 'solana',
        baseSymbol: 'BONK',
        baseAddress: '0xbonk',
        quoteSymbol: 'USDC',
        quoteAddress: '0xusdc',
      },
    };
    const phaseResult = makePhaseResult({
      signals: [swapSignal],
      signalsGenerated: 1,
    });

    const scan = await completeTechnicalScan(makeParams({ phaseResult }));
    expect(scan.signals).toHaveLength(0);
    expect(scan.signalsGenerated).toBe(0);
  });

  it('removes a swap signal with pricingIdentity but missing address', async () => {
    const swapSignal: ScoredSignal = {
      symbol: 'BONK',
      instrumentId: 'BONK:ADDR/USDC:ADDR',
      venueType: 'swap',
      confidence: 0.78,
      reasons: ['volume strong'],
      intent: 'go_long',
      indicators: { rsi: 48 },
      pricingIdentity: { kind: 'dex', symbol: 'BONK', chain: 'solana', address: '' },
      swapExecutionIdentity: {
        network: 'solana',
        baseSymbol: 'BONK',
        baseAddress: '0xbonk',
        quoteSymbol: 'USDC',
        quoteAddress: '0xusdc',
      },
    };
    const phaseResult = makePhaseResult({
      signals: [swapSignal],
      signalsGenerated: 1,
    });

    const scan = await completeTechnicalScan(makeParams({ phaseResult }));
    expect(scan.signals).toHaveLength(0);
  });

  it('removes a swap signal missing swapExecutionIdentity', async () => {
    const swapSignal: ScoredSignal = {
      symbol: 'BONK',
      instrumentId: 'BONK:ADDR/USDC:ADDR',
      venueType: 'swap',
      confidence: 0.78,
      reasons: ['volume strong'],
      intent: 'go_long',
      indicators: { rsi: 48 },
      pricingIdentity: { kind: 'dex', symbol: 'BONK', chain: 'solana', address: '0xbonk' },
      // swapExecutionIdentity intentionally omitted
    };
    const phaseResult = makePhaseResult({
      signals: [swapSignal],
      signalsGenerated: 1,
    });

    const scan = await completeTechnicalScan(makeParams({ phaseResult }));
    expect(scan.signals).toHaveLength(0);
  });

  it('preserves a valid swap signal with complete identity', async () => {
    const validSwapSignal: ScoredSignal = {
      symbol: 'BONK',
      instrumentId: 'BONK:0xbonk/USDC:0xusdc',
      venueType: 'swap',
      confidence: 0.78,
      reasons: ['volume strong'],
      intent: 'go_long',
      indicators: { rsi: 48 },
      pricingIdentity: { kind: 'dex', symbol: 'BONK', chain: 'solana', address: '0xbonk' },
      swapExecutionIdentity: {
        network: 'solana',
        baseSymbol: 'BONK',
        baseAddress: '0xbonk',
        quoteSymbol: 'USDC',
        quoteAddress: '0xusdc',
      },
    };
    const phaseResult = makePhaseResult({
      signals: [validSwapSignal],
      signalsGenerated: 1,
    });

    const scan = await completeTechnicalScan(makeParams({ phaseResult }));
    expect(scan.signals).toHaveLength(1);
    expect(scan.signals[0]?.instrumentId).toBe('BONK:0xbonk/USDC:0xusdc');
    expect(scan.pricingIdentities).toEqual({
      'BONK:0xbonk/USDC:0xusdc': { kind: 'dex', symbol: 'BONK', chain: 'solana', address: '0xbonk' },
    });
  });

  it('preserves orderbook signals alongside filtered swap signals', async () => {
    const validOrderbookSignal: ScoredSignal = {
      symbol: 'BTC',
      instrumentId: 'BTC-PERP',
      venueType: 'orderbook',
      confidence: 0.92,
      reasons: ['RSI healthy'],
      intent: 'go_long',
      indicators: { rsi: 58 },
      pricingIdentity: { kind: 'perps', symbol: 'BTC', chain: 'hyperliquid' },
    };
    const invalidSwapSignal: ScoredSignal = {
      symbol: 'BONK',
      instrumentId: 'BONK:ADDR/USDC:ADDR',
      venueType: 'swap',
      confidence: 0.78,
      reasons: ['volume strong'],
      intent: 'go_long',
      indicators: { rsi: 48 },
      // missing pricingIdentity → should be dropped
    };
    const phaseResult = makePhaseResult({
      signals: [validOrderbookSignal, invalidSwapSignal],
      signalsGenerated: 2,
    });

    const scan = await completeTechnicalScan(makeParams({ phaseResult }));
    expect(scan.signals).toHaveLength(1);
    expect(scan.signals[0]?.instrumentId).toBe('BTC-PERP');
    expect(scan.signalsGenerated).toBe(1);
    expect(scan.pricingIdentities).toEqual({
      'BTC-PERP': { kind: 'perps', symbol: 'BTC', chain: 'hyperliquid' },
    });
  });

  it('does not emit a wake for swap signals that were filtered out', async () => {
    const invalidSwapSignal: ScoredSignal = {
      symbol: 'BONK',
      instrumentId: 'BONK:ADDR/USDC:ADDR',
      venueType: 'swap',
      confidence: 0.78,
      reasons: ['volume strong'],
      intent: 'go_long',
      indicators: { rsi: 48 },
      // missing pricingIdentity
    };
    const phaseResult = makePhaseResult({
      signals: [invalidSwapSignal],
      signalsGenerated: 1,
    });
    const emitAgentWake = vi.fn().mockResolvedValue(undefined);

    await completeTechnicalScan(makeParams({
      phaseResult,
      emitAgentWake,
      isHybridMode: true,
    }));

    // No wake should be emitted because the only signal was filtered out
    expect(emitAgentWake).not.toHaveBeenCalled();
  });

  it('classifies as healthy_no_signal when all swap signals are filtered out', async () => {
    // Three swap signals — all with incomplete identity so they get filtered.
    const swapSignals: ScoredSignal[] = [
      {
        symbol: 'BONK',
        instrumentId: 'BONK:0xbonk/USDC:0xusdc',
        venueType: 'swap',
        confidence: 0.78,
        reasons: ['volume strong'],
        intent: 'go_long',
        indicators: { rsi: 48 },
        // missing pricingIdentity
      },
      {
        symbol: 'WIF',
        instrumentId: 'WIF:0xwif/USDC:0xusdc',
        venueType: 'swap',
        confidence: 0.65,
        reasons: ['trend strong'],
        intent: 'go_long',
        indicators: { rsi: 52 },
        pricingIdentity: { kind: 'dex', symbol: 'WIF', chain: 'solana' },
        // has pricingIdentity but missing swapExecutionIdentity
      },
      {
        symbol: 'JUP',
        instrumentId: 'JUP:0xjup/USDC:0xusdc',
        venueType: 'swap',
        confidence: 0.72,
        reasons: ['breakout'],
        intent: 'go_long',
        indicators: { rsi: 58 },
        pricingIdentity: { kind: 'dex', symbol: 'JUP', chain: 'solana', address: '0xjup' },
        swapExecutionIdentity: {
          network: 'solana', baseSymbol: 'JUP', baseAddress: '0xjup',
          quoteSymbol: 'USDC', quoteAddress: '0xusdc',
        },
        // has complete identity — this one passes
      },
    ];
    const phaseResult = makePhaseResult({
      signals: swapSignals,
      signalsGenerated: 3,
      candidatesScored: 3,
      eligibleCount: 3,
      fetchedCount: 3,
      candidatesDiscovered: 5,
    });

    const scan = await completeTechnicalScan(makeParams({
      phaseResult,
      isHybridMode: true,
    }));

    // Only 1 of 3 swap signals had complete identity → scannerHealth should
    // use the post-filter count, not the pre-filter 3.
    expect(scan.signalsGenerated).toBe(1);
    expect(scan.scannerHealth).toEqual({
      status: 'healthy_signals',
      reason: '1 signal(s) generated',
    });
  });

  it('classifies as healthy_no_signal when all swap signals are filtered out (zero pass)', async () => {
    // All swap signals have incomplete identity — zero pass filtering.
    const swapSignals: ScoredSignal[] = [
      {
        symbol: 'BONK',
        instrumentId: 'BONK:0xbonk/USDC:0xusdc',
        venueType: 'swap',
        confidence: 0.78,
        reasons: ['volume strong'],
        intent: 'go_long',
        indicators: { rsi: 48 },
        // missing pricingIdentity
      },
      {
        symbol: 'WIF',
        instrumentId: 'WIF:0xwif/USDC:0xusdc',
        venueType: 'swap',
        confidence: 0.65,
        reasons: ['trend strong'],
        intent: 'go_long',
        indicators: { rsi: 52 },
        pricingIdentity: { kind: 'dex', symbol: 'WIF', chain: 'solana' },
        // has pricingIdentity but missing swapExecutionIdentity
      },
    ];
    const phaseResult = makePhaseResult({
      signals: swapSignals,
      signalsGenerated: 2,
      candidatesScored: 2,
      eligibleCount: 2,
      fetchedCount: 2,
      candidatesDiscovered: 5,
    });

    const scan = await completeTechnicalScan(makeParams({
      phaseResult,
      isHybridMode: true,
    }));

    // All swap signals filtered out → post-filter count is 0 → healthy_no_signal.
    expect(scan.signalsGenerated).toBe(0);
    expect(scan.scannerHealth).toEqual({
      status: 'healthy_no_signal',
      reason: 'Data available, candidates scored, no signals generated — conservative strategy',
    });
  });
});

// ─── Phase 4: DEX instrumentKind persistence ─────────────────────────────────

describe('buildPersistableCandidates — DEX instrumentKind', () => {
  const basePhaseResult = makePhaseResult({
    signals: [],
    signalsGenerated: 0,
    positionIndicators: [],
  });
  const techConfig = makeTechnicalConfig();

  it('sets instrumentKind to dex for swap signals', () => {
    const phaseResult = {
      ...basePhaseResult,
      signals: [
        {
          symbol: 'BONK',
          instrumentId: 'BONK:0xbonk/USDC:0xusdc',
          venueType: 'swap' as const,
          confidence: 0.78,
          reasons: ['volume strong'],
          intent: 'go_long' as const,
          indicators: { rsi: 48 },
          swapExecutionIdentity: {
            network: 'solana',
            baseSymbol: 'BONK',
            baseAddress: '0xbonk',
            quoteSymbol: 'USDC',
            quoteAddress: '0xusdc',
          },
        },
      ],
    };

    const candidates = buildPersistableCandidates('agent-1', '2026-01-01T00:00:00Z', phaseResult, techConfig);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.instrumentKind).toBe('dex');
  });

  it('sets network and address from swapExecutionIdentity for dex signals', () => {
    const phaseResult = {
      ...basePhaseResult,
      signals: [
        {
          symbol: 'BONK',
          instrumentId: 'BONK:0xbonk/USDC:0xusdc',
          venueType: 'swap' as const,
          confidence: 0.78,
          reasons: ['volume strong'],
          intent: 'go_long' as const,
          indicators: { rsi: 48 },
          swapExecutionIdentity: {
            network: 'solana',
            baseSymbol: 'BONK',
            baseAddress: '0xbonk',
            quoteSymbol: 'USDC',
            quoteAddress: '0xusdc',
          },
        },
      ],
    };

    const candidates = buildPersistableCandidates('agent-1', '2026-01-01T00:00:00Z', phaseResult, techConfig);

    expect(candidates[0]?.network).toBe('solana');
    expect(candidates[0]?.address).toBe('0xbonk');
  });

  it('keeps instrumentKind as orderbook for non-swap signals', () => {
    const phaseResult = {
      ...basePhaseResult,
      signals: [
        {
          symbol: 'BTC',
          instrumentId: 'BTC-PERP',
          venueType: 'orderbook' as const,
          confidence: 0.92,
          reasons: ['RSI healthy'],
          intent: 'go_long' as const,
          indicators: { rsi: 58 },
        },
      ],
    };

    const candidates = buildPersistableCandidates('agent-1', '2026-01-01T00:00:00Z', phaseResult, techConfig);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.instrumentKind).toBe('orderbook');
    expect(candidates[0]?.network).toBeUndefined();
    expect(candidates[0]?.address).toBeUndefined();
  });

  it('uses instrumentId as rawCandidateId for swap signals', () => {
    const phaseResult = {
      ...basePhaseResult,
      signals: [
        {
          symbol: 'BONK',
          instrumentId: 'BONK:0xbonk/USDC:0xusdc',
          venueType: 'swap' as const,
          confidence: 0.78,
          reasons: ['volume strong'],
          intent: 'go_long' as const,
          indicators: { rsi: 48 },
          swapExecutionIdentity: {
            network: 'solana',
            baseSymbol: 'BONK',
            baseAddress: '0xbonk',
            quoteSymbol: 'USDC',
            quoteAddress: '0xusdc',
          },
        },
      ],
    };

    const candidates = buildPersistableCandidates('agent-1', '2026-01-01T00:00:00Z', phaseResult, techConfig);

    expect(candidates[0]?.rawCandidateId).toBe('BONK:0xbonk/USDC:0xusdc');
  });
});
