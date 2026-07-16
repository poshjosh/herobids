import { describe, it, expect, vi } from 'vitest';
import { completeTechnicalScan, type CompleteTechnicalScanParams } from './complete-technical-scan.js';
import type { TechnicalPhaseResult } from './technical-phase.js';
import type { TechnicalConfig } from '@herobids/domain';

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

  // ── Test 4: Data unhealthy (fetched=0, eligible>0) → journal event ─────────

  it('calls onJournalEvent with scanner.data_unhealthy when fetched=0 and eligible>0', async () => {
    const onTechnicalScanComplete = vi.fn();
    const emitAgentWake = vi.fn().mockResolvedValue(undefined);
    const onJournalEvent = vi.fn();

    const phaseResult = makePhaseResult({
      signals: [],
      signalsGenerated: 0,
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
      type: 'scanner.data_unhealthy',
      payload: expect.objectContaining({
        agentId: 'agent-test-1',
        eligible: 2,
        fetched: 0,
        unsupported: 3,
        discovered: 5,
      }),
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

  // ── Test 7: Capacity skip (same as overlap skip) → overlapSkipped, no wake ─

  it('produces overlapSkipped=true and does NOT wake when phaseResult has overlapSkipped (capacity scenario)', async () => {
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

    // No journal event because fetched=0 but eligible=0 (not unhealthy, just skipped)
    expect(onJournalEvent).not.toHaveBeenCalled();
  });

  // ── Edge case: data unhealthy but no journal callback registered ────────────

  it('does not throw when data unhealthy but onJournalEvent is undefined', async () => {
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
});
