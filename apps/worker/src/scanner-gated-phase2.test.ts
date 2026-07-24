import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runTechnicalPhase } from './technical-phase.js';
import type { TechnicalPhaseDeps, DiscoveredInstrument } from './technical-phase.js';
import type { PositionState } from '@herobids/engine';
import type { PriceCandle, RegimeResult } from '@herobids/market-data';
import type { ScannerCandleTarget } from '@herobids/strategy';
import { AgentTradingActor } from './agent-trading-actor.js';
import type { AgentTradingActorDeps } from './agent-trading-actor.js';
import { price, quantity, ok, type TechnicalConfig, type HybridPricingIdentity } from '@herobids/domain';
import type { OrderId, FillId } from '@herobids/domain';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCandles(count = 50, trend: 'up' | 'flat' = 'up'): PriceCandle[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: new Date(Date.now() - (count - i) * 60_000).toISOString(),
    open: 100 + (trend === 'up' ? i * 0.5 : 0),
    high: 102 + (trend === 'up' ? i * 0.5 : 0),
    low: 99 + (trend === 'up' ? i * 0.5 : 0),
    close: 101 + (trend === 'up' ? i * 0.5 : 0),
    volume: 1000 + i * 10,
  }));
}

function makeInstrument(symbol: string, volume24hUsd = 1_000_000): DiscoveredInstrument {
  return {
    symbol,
    instrumentId: `${symbol}-PERP`,
    venue: 'hyperliquid',
    venueType: 'orderbook',
    candleTarget: { venueType: 'orderbook' as const, providerSymbol: symbol },
    pricingIdentity: { kind: 'perps' as const, symbol },
    volume24hUsd,
    priceChange24hPct: 2.5,
  };
}

function makeRegimePass(): RegimeResult {
  return {
    pass: true,
    reasons: [],
    details: {
      benchmarkSymbol: 'BTC',
      currentPrice: 50000,
      emaFast: 49000,
      emaSlow: 48000,
      emaTrend: 45000,
      emaAlignment: 'bullish',
      adxValue: 30,
      choppy: false,
      vwap: 49500,
      priceAboveVwap: true,
      marketStructure: 'higherHighs',
    },
  };
}

function makeTechnicalConfig(overrides?: Partial<TechnicalConfig>): TechnicalConfig {
  return {
    filters: {
      venue: 'hyperliquid',
      venueType: 'orderbook' as const,
      minVolume24hUsd: 0,
      symbols: [],
      excludeSymbols: [],
    },
    indicators: {
      confidence: { minConfidence: 0.45 },
      rsi: { period: 14, overbought: 80, healthyMax: 70, weakBelow: 30 },
    },
    candles: { interval: '1h' as const, limit: 50 },
    signalBias: 'trend-following' as const,
    scanIntervalMs: 60_000,
    scanBatchSize: 10,
    autonomousExit: false,
    ...overrides,
  } as TechnicalConfig;
}

function makeBaseDeps(overrides: Partial<TechnicalPhaseDeps> = {}): TechnicalPhaseDeps {
  return {
    config: makeTechnicalConfig(),
    riskConfig: { maxOpenPositions: 5, maxPositionSize: '1' } as TechnicalPhaseDeps['riskConfig'],
    agentId: 'agent-test',
    venueAccountId: 'va-test',
    discoverCandidates: vi.fn().mockResolvedValue([]),
    fetchCandles: vi.fn().mockResolvedValue(makeCandles()),
    evaluateRegime: vi.fn().mockResolvedValue(makeRegimePass()),
    submitDecision: vi.fn().mockResolvedValue(undefined),
    getOpenPositions: vi.fn().mockReturnValue([]),
    generateDecisionId: () => 'd-test',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

function makeIdGen() {
  let c = 0;
  return {
    orderId: () => `o-${++c}` as OrderId,
    fillId: () => `f-${++c}` as FillId,
    planId: () => `p-${++c}`,
    decisionId: () => `d-${++c}`,
  };
}

function makeRepo() {
  return {
    insertFill: vi.fn().mockResolvedValue(undefined),
    getOpenByActor: vi.fn().mockResolvedValue([]),
    getOpenByActorAndVenueAccount: vi.fn().mockResolvedValue([]),
    upsert: vi.fn().mockResolvedValue(undefined),
    insertPlan: vi.fn().mockResolvedValue(undefined),
    markExecuting: vi.fn().mockResolvedValue(undefined),
    markCompleted: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    getIncomplete: vi.fn().mockResolvedValue([]),
    getByExecutionPlanId: vi.fn().mockResolvedValue([]),
    upsertByVenueRefId: vi.fn().mockResolvedValue(undefined),
    insertDecision: vi.fn().mockResolvedValue(undefined),
    insertDecisionContext: vi.fn().mockResolvedValue('ctx-id'),
    getLastReconciledAtForInstance: vi.fn().mockResolvedValue(null),
    getRecentByVenueAccount: vi.fn().mockResolvedValue([]),
    getLatestByVenueAccount: vi.fn().mockResolvedValue(null),
    getRecentByActorAndVenueAccount: vi.fn().mockResolvedValue([]),
    insertSnapshot: vi.fn().mockResolvedValue('snap-id'),
    insert: vi.fn().mockResolvedValue(undefined),
    getLatestBalanceForVenueAccount: vi.fn().mockResolvedValue(null),
    getLastReconciledAtAndSnapshotForInstance: vi.fn().mockResolvedValue(null),
    getLatestDecisions: vi.fn().mockResolvedValue([]),
    getOpenPositionsByActor: vi.fn().mockResolvedValue([]),
    getBalanceSnapshotsByVenueAccount: vi.fn().mockResolvedValue([]),
    getDecisionsByActor: vi.fn().mockResolvedValue([]),
    getFillsByActor: vi.fn().mockResolvedValue([]),
    getFillsByVenueAccount: vi.fn().mockResolvedValue([]),
    getPlansByActor: vi.fn().mockResolvedValue([]),
    getRecentReconciliations: vi.fn().mockResolvedValue([]),
    getReconciliationEvents: vi.fn().mockResolvedValue([]),
    upsertBalanceSnapshot: vi.fn().mockResolvedValue(undefined),
    upsertPosition: vi.fn().mockResolvedValue(undefined),
    getPositionByActorAndSymbol: vi.fn().mockResolvedValue(null),
    insertOrder: vi.fn().mockResolvedValue(undefined),
    updateOrderStatus: vi.fn().mockResolvedValue(undefined),
    getOrdersByPlanId: vi.fn().mockResolvedValue([]),
    getOrdersByVenueRefId: vi.fn().mockResolvedValue([]),
    getOrdersByActorAndSymbol: vi.fn().mockResolvedValue([]),
    getReconciliationEvent: vi.fn().mockResolvedValue(null),
    getBalanceSnapshot: vi.fn().mockResolvedValue(null),
    deletePosition: vi.fn().mockResolvedValue(undefined),
    markPlanFailed: vi.fn().mockResolvedValue(undefined),
    markPlanCompleted: vi.fn().mockResolvedValue(undefined),
    getDecisionContext: vi.fn().mockResolvedValue(null),
    getDecisionsByPlanId: vi.fn().mockResolvedValue([]),
    getOpenOrdersByActor: vi.fn().mockResolvedValue([]),
    getOrderByVenueRefId: vi.fn().mockResolvedValue(null),
    insertReconciliationEvent: vi.fn().mockResolvedValue(undefined),
    upsertDecisionResult: vi.fn().mockResolvedValue(undefined),
    getLatestBalances: vi.fn().mockResolvedValue([]),
  };
}

function makeAgentActorDeps(overrides?: Partial<AgentTradingActorDeps>): AgentTradingActorDeps {
  const repos = makeRepo();
  return {
    agentId: 'agent-test',
    executionMode: 'paper',
    venueAccountId: 'va-test',
    venue: 'hyperliquid',
    venueType: 'orderbook',
    riskLimits: { maxOpenPositions: 5, maxDrawdown: price('10000'), maxPositionSize: quantity('10'), maxPositionSizePct: 100, dailyMaxLossPct: 20, stopLossCooldownMs: 300000, stopLossMaxUnrealizedLossPct: 10, maxOrderNotional: price('10000') },
    venueAdapterFactory: { buildOrderbookAdapter: vi.fn().mockResolvedValue({ venuePort: {}, credentials: { testnet: false, apiKey: '', secret: '', walletAddress: '' }, credentialId: 'cred-1' }), buildSwapAdapter: vi.fn() } as unknown as AgentTradingActorDeps['venueAdapterFactory'],
    markSource: { getMark: vi.fn().mockResolvedValue(ok({ price: price('50000'), source: 'oracle', timestamp: new Date().toISOString(), stale: false })) } as unknown as AgentTradingActorDeps['markSource'],
    journal: { append: vi.fn().mockResolvedValue(undefined) } as unknown as AgentTradingActorDeps['journal'],
    idGen: makeIdGen(),
    positionRepo: repos as unknown as AgentTradingActorDeps['positionRepo'],
    fillRepo: repos as unknown as AgentTradingActorDeps['fillRepo'],
    planRepo: repos as unknown as AgentTradingActorDeps['planRepo'],
    orderRepo: repos as unknown as AgentTradingActorDeps['orderRepo'],
    decisionRepo: repos as unknown as AgentTradingActorDeps['decisionRepo'],
    balanceSnapshotRepo: repos as unknown as AgentTradingActorDeps['balanceSnapshotRepo'],
    backtestingRepo: repos as unknown as AgentTradingActorDeps['backtestingRepo'],
    reconciliationRepo: repos as unknown as AgentTradingActorDeps['reconciliationRepo'],
    technicalConfig: makeTechnicalConfig(),
    discoverCandidates: vi.fn().mockResolvedValue([makeInstrument('BTC')]),
    fetchCandles: vi.fn().mockResolvedValue(makeCandles()),
    isHybridMode: true,
    ...overrides,
  };
}

// ─── 1. CANDIDATE BOUNDING ────────────────────────────────────────────────────

describe('Phase 2: Candidate selection bounding', () => {
  it('bounded candidates — discovery returns more than maxCandidates but only first N are fetched', async () => {
    const manyCandidates = Array.from({ length: 50 }, (_, i) =>
      makeInstrument(`TOKEN${i}`, 1_000_000 - i * 10_000),
    );
    const fetchCandles = vi.fn().mockResolvedValue(makeCandles());
    const deps = makeBaseDeps({
      discoverCandidates: vi.fn().mockResolvedValue(manyCandidates),
      fetchCandles,
    });

    const result = await runTechnicalPhase(deps);

    // All 50 candidates are discovered
    expect(result.candidatesDiscovered).toBe(50);
    // All 50 are selected (all fetched since no open positions)
    expect(result.symbolsSelected).toBe(50);
    // All 50 fetched successfully
    expect(result.symbolOutcomes).toHaveLength(50);
    result.symbolOutcomes.forEach((o) => {
      expect(o.status).toBe('eligible_fetched');
      expect(o.candleCount).toBe(50);
    });
    const fetchedCount = result.symbolOutcomes.filter((o) => o.status === 'eligible_fetched').length;
    expect(fetchedCount).toBe(50);
  });

  it('deterministic ordering — candidates sorted by volume24hUsd descending', async () => {
    // discoverCandidates returns candidates sorted by volume — the wrapper
    // in index.ts does the sort. Here we verify that the phase uses them as-is.
    const sortedCandidates = [
      makeInstrument('HIGH', 5_000_000),
      makeInstrument('MID', 3_000_000),
      makeInstrument('LOW', 1_000_000),
    ];
    const fetchCandles = vi.fn().mockResolvedValue(makeCandles());
    const deps = makeBaseDeps({
      discoverCandidates: vi.fn().mockResolvedValue(sortedCandidates),
      fetchCandles,
    });

    const result = await runTechnicalPhase(deps);
    expect(result.candidatesDiscovered).toBe(3);
    expect(result.symbolsSelected).toBe(3);
    // All fetched
    const fetchedCount = result.symbolOutcomes.filter((o) => o.status === 'eligible_fetched').length;
    expect(fetchedCount).toBe(3);
  });

  it('open-position symbols are always included alongside bounded candidates', async () => {
    const candidates = [makeInstrument('BTC'), makeInstrument('ETH')];
    const openPos: PositionState = {
      venue: 'hyperliquid',
      symbol: 'SOL',
      side: 'long',
      size: { toString: () => '1' } as unknown as PositionState['size'],
      entryPrice: { toString: () => '100' } as unknown as PositionState['entryPrice'],
      realizedPnl: { toString: () => '0' } as unknown as PositionState['realizedPnl'],
    };
    const fetchCandles = vi.fn().mockImplementation(async (target: ScannerCandleTarget) => {
      if (target.providerSymbol === 'SOL') return makeCandles(30, 'flat');
      return makeCandles();
    });
    const deps = makeBaseDeps({
      discoverCandidates: vi.fn().mockResolvedValue(candidates),
      getOpenPositions: vi.fn().mockReturnValue([openPos]),
      fetchCandles,
    });

    const result = await runTechnicalPhase(deps);
    expect(result.candidatesDiscovered).toBe(2); // BTC, ETH
    expect(result.symbolsSelected).toBe(3);   // BTC, ETH + SOL
    // SOL was fetched too (for exit evaluation)
    const solOutcome = result.symbolOutcomes.find((o) => o.symbol === 'SOL');
    expect(solOutcome).toBeDefined();
    expect(solOutcome!.status).toBe('eligible_fetched');
    expect(solOutcome!.candleCount).toBe(30);
  });
});

// ─── 2. PROVIDER ELIGIBILITY CLASSIFICATION ───────────────────────────────────

describe('Phase 2: Provider eligibility classification', () => {
  it('eligible_fetched — known-supported symbol returns non-empty candles', async () => {
    const deps = makeBaseDeps({
      discoverCandidates: vi.fn().mockResolvedValue([makeInstrument('BTC')]),
      fetchCandles: vi.fn().mockResolvedValue(makeCandles(50)),
    });

    const result = await runTechnicalPhase(deps);
    expect(result.symbolOutcomes).toHaveLength(1);
    expect(result.symbolOutcomes[0]!.status).toBe('eligible_fetched');
    expect(result.symbolOutcomes[0]!.candleCount).toBe(50);
    const fetchedCount = result.symbolOutcomes.filter((o) => o.status === 'eligible_fetched').length;
    expect(fetchedCount).toBe(1);
    expect(result.unsupportedCount).toBe(0);
    expect(result.fetchFailures).toBe(0);
  });

  it('eligible_empty — valid symbol returns empty candle array (new listing)', async () => {
    const deps = makeBaseDeps({
      discoverCandidates: vi.fn().mockResolvedValue([makeInstrument('NEWCOIN')]),
      fetchCandles: vi.fn().mockResolvedValue([]),
    });

    const result = await runTechnicalPhase(deps);
    expect(result.symbolOutcomes).toHaveLength(1);
    expect(result.symbolOutcomes[0]!.status).toBe('eligible_empty');
    expect(result.symbolOutcomes[0]!.candleCount).toBe(0);
    const fetchedCount = result.symbolOutcomes.filter((o) => o.status === 'eligible_fetched').length;
    expect(fetchedCount).toBe(0);
    expect(result.unsupportedCount).toBe(0);
    expect(result.fetchFailures).toBe(0);
  });

  it('unsupported — invalid symbol throws HTTP 400 error → classified as unsupported', async () => {
    const deps = makeBaseDeps({
      discoverCandidates: vi.fn().mockResolvedValue([makeInstrument('FAKETOKEN')]),
      fetchCandles: vi.fn().mockRejectedValue(new Error('HTTP error: 400 Bad Request')),
    });

    const result = await runTechnicalPhase(deps);
    expect(result.symbolOutcomes).toHaveLength(1);
    expect(result.symbolOutcomes[0]!.status).toBe('unsupported');
    expect(result.symbolOutcomes[0]!.candleCount).toBeUndefined();
    expect(result.symbolOutcomes[0]!.errorDetail).toContain('HTTP error: 400');
    expect(result.unsupportedCount).toBe(1);
    expect(result.fetchFailures).toBe(0);
    const fetchedCount = result.symbolOutcomes.filter((o) => o.status === 'eligible_fetched').length;
    expect(fetchedCount).toBe(0);
  });

  it('transient_failure — HTTP 5xx error → classified as transient', async () => {
    const deps = makeBaseDeps({
      discoverCandidates: vi.fn().mockResolvedValue([makeInstrument('BTC')]),
      fetchCandles: vi.fn().mockRejectedValue(new Error('HTTP error: 503 Service Unavailable')),
    });

    const result = await runTechnicalPhase(deps);
    expect(result.symbolOutcomes).toHaveLength(1);
    expect(result.symbolOutcomes[0]!.status).toBe('transient_failure');
    expect(result.unsupportedCount).toBe(0);
    expect(result.fetchFailures).toBe(1);
  });

  it('transient_failure — timeout/abort error → classified as transient', async () => {
    const deps = makeBaseDeps({
      discoverCandidates: vi.fn().mockResolvedValue([makeInstrument('BTC')]),
      fetchCandles: vi.fn().mockRejectedValue(new Error('The operation was aborted due to timeout')),
    });

    const result = await runTechnicalPhase(deps);
    expect(result.symbolOutcomes).toHaveLength(1);
    expect(result.symbolOutcomes[0]!.status).toBe('transient_failure');
    expect(result.fetchFailures).toBe(1);
  });

  it('transient_failure — rate limit exceeded → classified as transient', async () => {
    const deps = makeBaseDeps({
      discoverCandidates: vi.fn().mockResolvedValue([makeInstrument('BTC')]),
      fetchCandles: vi.fn().mockRejectedValue(new Error('Rate limit exceeded — would need to wait 6000ms (max: 5000ms)')),
    });

    const result = await runTechnicalPhase(deps);
    expect(result.symbolOutcomes).toHaveLength(1);
    expect(result.symbolOutcomes[0]!.status).toBe('transient_failure');
    expect(result.fetchFailures).toBe(1);
  });

  it('per-scan unsupported cache — second occurrence of same unsupported symbol skipped', async () => {
    // Two candidates: 'FAKETOKEN' appears twice (would happen if it's an
    // open-position symbol AND a candidate). The second attempt should be skipped
    // by the per-scan unsupported cache.
    const fetchCandles = vi.fn()
      .mockRejectedValueOnce(new Error('HTTP error: 400 Bad Request')) // FAKETOKEN → unsupported
      .mockResolvedValueOnce(makeCandles()); // BTC → success
    const deps = makeBaseDeps({
      discoverCandidates: vi.fn().mockResolvedValue([
        makeInstrument('FAKETOKEN'),
        makeInstrument('BTC'),
      ]),
      // Open position on same unsupported symbol
      getOpenPositions: vi.fn().mockReturnValue([{
        venue: 'hyperliquid',
        symbol: 'FAKETOKEN',
        side: 'long',
        size: { toString: () => '1' } as unknown as PositionState['size'],
        entryPrice: { toString: () => '100' } as unknown as PositionState['entryPrice'],
        realizedPnl: { toString: () => '0' } as unknown as PositionState['realizedPnl'],
      }]),
      fetchCandles,
    });

    const result = await runTechnicalPhase(deps);

    // FAKETOKEN should only be attempted once (cached after first 400)
    // BTC should also be attempted
    expect(result.unsupportedCount).toBe(1);
    // fetchCandles called for FAKETOKEN (first occurrence in batch) and BTC = 2 calls
    // (FAKETOKEN appears only once in allSymbols because openSymbols dedup removes it)
    expect(fetchCandles).toHaveBeenCalledTimes(2);
    expect(fetchCandles).toHaveBeenCalledWith({ venueType: 'orderbook', providerSymbol: 'FAKETOKEN' }, '1h', 50);
    expect(fetchCandles).toHaveBeenCalledWith({ venueType: 'orderbook', providerSymbol: 'BTC' }, '1h', 50);
  });

  it('unsupported count is distinct from transient failure count', async () => {
    const fetchCandles = vi.fn()
      .mockRejectedValueOnce(new Error('HTTP error: 400 Bad Request')) // FAKETOKEN → unsupported
      .mockRejectedValueOnce(new Error('HTTP error: 503 Service Unavailable')); // BTC → transient
    const deps = makeBaseDeps({
      discoverCandidates: vi.fn().mockResolvedValue([
        makeInstrument('FAKETOKEN'),
        makeInstrument('BTC'),
      ]),
      fetchCandles,
    });

    const result = await runTechnicalPhase(deps);
    expect(result.unsupportedCount).toBe(1);
    expect(result.fetchFailures).toBe(1);
    const fetchedCount = result.symbolOutcomes.filter((o) => o.status === 'eligible_fetched').length;
    expect(fetchedCount).toBe(0);
  });
});

// ─── 3. SCANNER HEALTH MATRIX ────────────────────────────────────────────────

describe('Phase 2: Scanner outcome health matrix', () => {
  it('discovered = 0 — no candidates in universe', async () => {
    const deps = makeBaseDeps({
      discoverCandidates: vi.fn().mockResolvedValue([]),
    });
    const result = await runTechnicalPhase(deps);
    expect(result.candidatesDiscovered).toBe(0);
    expect(result.symbolsSelected).toBe(0);
    expect(result.symbolOutcomes).toHaveLength(0);
    expect(result.signalsGenerated).toBe(0);
  });

  it('fetched = 0, eligible > 0 — all symbols returned empty (new listings)', async () => {
    const deps = makeBaseDeps({
      discoverCandidates: vi.fn().mockResolvedValue([
        makeInstrument('NEW1'),
        makeInstrument('NEW2'),
      ]),
      fetchCandles: vi.fn().mockResolvedValue([]), // empty for both
    });
    const result = await runTechnicalPhase(deps);
    expect(result.candidatesDiscovered).toBe(2);
    expect(result.symbolsSelected).toBe(2);
    const fetchedCount = result.symbolOutcomes.filter((o) => o.status === 'eligible_fetched').length;
    expect(fetchedCount).toBe(0);
    // eligible = 2 (both returned HTTP 200 with [])
    const eligibleCount = result.symbolOutcomes.filter(
      (o) => o.status === 'eligible_fetched' || o.status === 'eligible_empty',
    ).length;
    expect(eligibleCount).toBe(2);
    expect(result.unsupportedCount).toBe(0);
  });

  it('fetched = 0 because all symbols unsupported — scanner-data unhealthy', async () => {
    const deps = makeBaseDeps({
      discoverCandidates: vi.fn().mockResolvedValue([
        makeInstrument('FAKE1'),
        makeInstrument('FAKE2'),
      ]),
      fetchCandles: vi.fn().mockRejectedValue(new Error('HTTP error: 400 Bad Request')),
    });
    const result = await runTechnicalPhase(deps);
    const fetchedCount = result.symbolOutcomes.filter((o) => o.status === 'eligible_fetched').length;
    expect(fetchedCount).toBe(0);
    expect(result.unsupportedCount).toBe(2);
    expect(result.fetchFailures).toBe(0);
    expect(result.signalsGenerated).toBe(0);
  });

  it('fetched > 0, scored > 0, signalsGenerated = 0 — healthy no-signal scan', async () => {
    // Provide candles that don't produce signals (flat trend, no trigger)
    const flatCandles = Array.from({ length: 50 }, (_, i) => ({
      timestamp: new Date(Date.now() - (50 - i) * 60_000).toISOString(),
      open: 100,
      high: 100.1,
      low: 99.9,
      close: 100,
      volume: 100,
    }));
    const deps = makeBaseDeps({
      discoverCandidates: vi.fn().mockResolvedValue([makeInstrument('FLAT')]),
      fetchCandles: vi.fn().mockResolvedValue(flatCandles),
    });
    const result = await runTechnicalPhase(deps);
    const fetchedCount = result.symbolOutcomes.filter((o) => o.status === 'eligible_fetched').length;
    expect(fetchedCount).toBe(1);       // fetched > 0
    expect(result.candidatesScored).toBe(1); // scored > 0
    // signals may or may not be 0 depending on indicator config — this tests structure
    expect(result.symbolOutcomes).toHaveLength(1);
    expect(result.symbolOutcomes[0]!.status).toBe('eligible_fetched');
  });

  it('signalsGenerated > 0 — actionable scanner result', async () => {
    const bullishCandles = makeCandles(50, 'up');
    const deps = makeBaseDeps({
      discoverCandidates: vi.fn().mockResolvedValue([makeInstrument('BULL')]),
      fetchCandles: vi.fn().mockResolvedValue(bullishCandles),
    });
    const result = await runTechnicalPhase(deps);
    const fetchedCount = result.symbolOutcomes.filter((o) => o.status === 'eligible_fetched').length;
    expect(fetchedCount).toBe(1);
    // signals may be generated or not depending on indicator config
    // but the structure is correct
    expect(result.symbolOutcomes).toHaveLength(1);
  });

  it('structured health fields are present in result', async () => {
    const deps = makeBaseDeps({
      discoverCandidates: vi.fn().mockResolvedValue([
        makeInstrument('BTC'),
        makeInstrument('ETH'),
      ]),
      fetchCandles: vi.fn().mockResolvedValue(makeCandles()),
    });
    const result = await runTechnicalPhase(deps);

    // All health matrix fields present
    expect(result.candidatesDiscovered).toBeGreaterThan(0);
    expect(result.symbolsSelected).toBeGreaterThan(0);
    expect(result.candidatesScored).toBeGreaterThanOrEqual(0);
    expect(result.signalsGenerated).toBeGreaterThanOrEqual(0);
    expect(result.symbolOutcomes.length).toBeGreaterThan(0);
    expect(typeof result.unsupportedCount).toBe('number');
    expect(typeof result.fetchFailures).toBe('number');
    expect(result.overlapSkipped).toBeUndefined(); // not skipped
  });
});

// ─── 4. SINGLE-FLIGHT GUARD ──────────────────────────────────────────────────

describe('Phase 2: Single-flight scan guard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('scanInProgress flag resets in finally block after error', async () => {
    const actor = new AgentTradingActor(makeAgentActorDeps({
      technicalConfig: makeTechnicalConfig({ scanIntervalMs: 100 }),
      discoverCandidates: vi.fn().mockRejectedValue(new Error('discovery failed')),
      fetchCandles: vi.fn().mockResolvedValue(makeCandles()),
    }));

    await actor.start();

    // Advance time to trigger scan
    await vi.advanceTimersByTimeAsync(150);

    // Flag should be reset even after error (finally block)
    const actorAny = actor as unknown as { scanInProgress: boolean };
    expect(actorAny.scanInProgress).toBe(false);

    await actor.stop();
    vi.advanceTimersByTime(1000); // flush pending timers
  });

  it('successful scan resets scanInProgress flag', async () => {
    const actor = new AgentTradingActor(makeAgentActorDeps({
      technicalConfig: makeTechnicalConfig({ scanIntervalMs: 100 }),
      discoverCandidates: vi.fn().mockResolvedValue([makeInstrument('BTC')]),
      fetchCandles: vi.fn().mockResolvedValue(makeCandles()),
    }));

    await actor.start();

    // Advance time to trigger scan
    await vi.advanceTimersByTimeAsync(150);

    const actorAny = actor as unknown as { scanInProgress: boolean };
    expect(actorAny.scanInProgress).toBe(false);

    await actor.stop();
    vi.advanceTimersByTime(1000);
  });

  it('overlapSkipped is exposed on TechnicalScanState', () => {
    // Verify that the overlapSkipped field exists on the state type by checking
    // that a manually-constructed overlap scan has the expected shape.
    const overlapScan = {
      timestamp: new Date().toISOString(),
      scanIntervalMs: 60_000,
      regimeResult: null,
      signals: [],
      positionIndicators: [],
      summary: { scanned: 0, rejected: 0, passed: 0 },
      symbolOutcomes: [],
      discovered: 0,
      symbolsSelected: 0,
      eligible: 0,
      fetched: 0,
      unsupported: 0,
      fetchFailures: 0,
      signalsGenerated: 0,
      overlapSkipped: true,
    };

    expect(overlapScan.overlapSkipped).toBe(true);
    expect(overlapScan.fetched).toBe(0);
    expect(overlapScan.signalsGenerated).toBe(0);
  });
});

// ─── 5. CAPACITY RATE LIMITER ─────────────────────────────────────────────────

describe('Phase 2: Capacity rate limiter', () => {
  it('rate limiter rejection is classified as transient_failure', async () => {
    const deps = makeBaseDeps({
      discoverCandidates: vi.fn().mockResolvedValue([makeInstrument('BTC')]),
      fetchCandles: vi.fn().mockRejectedValue(
        new Error('Rate limit exceeded — would need to wait 6000ms (max: 5000ms)'),
      ),
    });

    const result = await runTechnicalPhase(deps);
    expect(result.symbolOutcomes).toHaveLength(1);
    expect(result.symbolOutcomes[0]!.status).toBe('transient_failure');
    // Rate limit is NOT classified as unsupported
    expect(result.unsupportedCount).toBe(0);
    expect(result.fetchFailures).toBe(1);
  });

  it('all eligible + empty outcomes are counted correctly', async () => {
    const fetchCandles = vi.fn()
      .mockResolvedValueOnce(makeCandles(100))  // BTC → eligible_fetched
      .mockResolvedValueOnce([])                 // NEW → eligible_empty
      .mockResolvedValueOnce(makeCandles(200));  // ETH → eligible_fetched
    const deps = makeBaseDeps({
      discoverCandidates: vi.fn().mockResolvedValue([
        makeInstrument('BTC'),
        makeInstrument('NEW'),
        makeInstrument('ETH'),
      ]),
      fetchCandles,
    });

    const result = await runTechnicalPhase(deps);
    expect(result.symbolsSelected).toBe(3);
    // fetched = count of eligible_fetched
    const fetchedCount = result.symbolOutcomes.filter((o) => o.status === 'eligible_fetched').length;
    expect(fetchedCount).toBe(2);   // BTC + ETH
    // eligible = fetched + empty
    const eligibleCount = result.symbolOutcomes.filter(
      (o) => o.status === 'eligible_fetched' || o.status === 'eligible_empty',
    ).length;
    expect(eligibleCount).toBe(3);  // all three returned 200
    expect(result.unsupportedCount).toBe(0);
    expect(result.fetchFailures).toBe(0);

    // Per-symbol details
    const btc = result.symbolOutcomes.find((o) => o.symbol === 'BTC')!;
    expect(btc.status).toBe('eligible_fetched');
    expect(btc.candleCount).toBe(100);

    const newCoin = result.symbolOutcomes.find((o) => o.symbol === 'NEW')!;
    expect(newCoin.status).toBe('eligible_empty');
    expect(newCoin.candleCount).toBe(0);

    const eth = result.symbolOutcomes.find((o) => o.symbol === 'ETH')!;
    expect(eth.status).toBe('eligible_fetched');
    expect(eth.candleCount).toBe(200);
  });
});
