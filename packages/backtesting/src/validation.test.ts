import { describe, it, expect } from 'vitest';
import { runValidation } from './validation-runner.js';
import { replayContexts, normalizeForReplay, normalizeForReplayBatch } from './context-replay.js';
import type { StoredDecisionContext, PersistedDecisionContext } from './context-replay.js';
import { ArrayHistoricalDataFeed } from './historical-data-feed.js';
import type { BacktestConfig } from './replay-runner.js';
import { price, quantity, ok, err } from '@herobids/domain';
import type { Strategy, DecisionId, VenueAccountId, InstrumentId } from '@herobids/domain';

function makeFrames(count: number, startPrice = 50000, step = 100) {
  const base = new Date('2026-01-01T00:00:00.000Z').getTime();
  return Array.from({ length: count }, (_, i) => ({
    timestamp: new Date(base + i * 60_000).toISOString(),
    symbol: 'BTC/USD:USD',
    price: price(String(startPrice + i * step)),
  }));
}

/** Strategy that always goes long */
function alwaysLongStrategy(): Strategy {
  let counter = 0;
  return {
    id: 'always-long',
    name: 'Always Long',
    async evaluate(snapshot) {
      return ok({
        id: `d-${++counter}` as DecisionId,
        venueAccountId: '' as VenueAccountId,
      actorType: 'system',
      actorId: 'test',
        instrumentId: snapshot.symbol as InstrumentId,
        intent: 'go_long' as const,
        targetSize: quantity('1'),
        timestamp: snapshot.timestamp,
      });
    },
  };
}

/** Strategy that alternates between long and short */
function alternatingStrategy(): Strategy {
  let counter = 0;
  return {
    id: 'alternating',
    name: 'Alternating',
    async evaluate(snapshot) {
      counter++;
      const intent = counter % 2 === 0 ? 'go_short' : 'go_long';
      return ok({
        id: `d-${counter}` as DecisionId,
        venueAccountId: '' as VenueAccountId,
      actorType: 'system',
      actorId: 'test',
        instrumentId: snapshot.symbol as InstrumentId,
        intent: intent as 'go_long' | 'go_short',
        targetSize: quantity('1'),
        timestamp: snapshot.timestamp,
      });
    },
  };
}

/** Strategy that always holds (returns null) */
function holdStrategy(): Strategy {
  return {
    id: 'hold',
    name: 'Hold',
    async evaluate() {
      return ok(null);
    },
  };
}

function baseConfig(strategy: Strategy): BacktestConfig {
  return {
    runId: 'test-run',
    botId: 'inst-1',
    venue: 'hyperliquid',
    symbol: 'BTC/USD:USD',
    venueAccountId: 'va-1',
    strategy,
    strategyConfig: {},
    riskLimits: { maxPositionSize: quantity('100'), maxOpenPositions: 5, maxDrawdown: price('10000') },
    warmUpFrames: 2,
    venueType: 'orderbook',
  };
}

describe('runValidation', () => {
  it('reports zero divergence for identical strategies', async () => {
    const frames = makeFrames(10);
    const feed = new ArrayHistoricalDataFeed(frames);

    const result = await runValidation(
      feed,
      baseConfig(alwaysLongStrategy()),
      baseConfig(alwaysLongStrategy()),
      { maxDecisionDivergencePct: 50, maxPnlRegressionPct: 50 },
    );

    expect(result.passed).toBe(true);
    expect(result.comparison.intentDivergences).toBe(0);
    expect(result.comparison.intentDivergencePct).toBe(0);
    expect(result.comparison.diffs).toHaveLength(0);
  });

  it('detects intent divergences between strategies', async () => {
    const frames = makeFrames(10);
    const feed = new ArrayHistoricalDataFeed(frames);

    const result = await runValidation(
      feed,
      baseConfig(alwaysLongStrategy()),
      baseConfig(alternatingStrategy()),
      { maxDecisionDivergencePct: 100, maxPnlRegressionPct: 100 },
    );

    // Alternating starts with go_long then go_short, so some frames diverge
    expect(result.comparison.intentDivergences).toBeGreaterThan(0);
    expect(result.comparison.diffs.length).toBeGreaterThan(0);
    // Each diff has both baseline and candidate data
    const diff = result.comparison.diffs[0]!;
    expect(diff.baseline.intent).toBeDefined();
    expect(diff.candidate.intent).toBeDefined();
    expect(diff.timestamp).toBeDefined();
  });

  it('fails when divergence exceeds threshold', async () => {
    const frames = makeFrames(10);
    const feed = new ArrayHistoricalDataFeed(frames);

    const result = await runValidation(
      feed,
      baseConfig(alwaysLongStrategy()),
      baseConfig(alternatingStrategy()),
      { maxDecisionDivergencePct: 1, maxPnlRegressionPct: 100 },
    );

    expect(result.passed).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures[0]).toContain('Intent divergence');
  });

  it('tracks go_flat divergences', async () => {
    let counter = 0;
    const flatOnThird: Strategy = {
      id: 'flat-on-third',
      name: 'Flat on Third',
      async evaluate(snapshot) {
        counter++;
        const intent = counter % 3 === 0 ? 'go_flat' : 'go_long';
        return ok({
          id: `d-${counter}` as DecisionId,
          venueAccountId: '' as VenueAccountId,
      actorType: 'system',
      actorId: 'test',
          instrumentId: snapshot.symbol as InstrumentId,
          intent: intent as 'go_long' | 'go_flat',
          targetSize: intent === 'go_flat' ? quantity('0') : quantity('1'),
          timestamp: snapshot.timestamp,
        });
      },
    };

    const frames = makeFrames(12);
    const feed = new ArrayHistoricalDataFeed(frames);

    const result = await runValidation(
      feed,
      baseConfig(alwaysLongStrategy()),
      baseConfig(flatOnThird),
      { maxDecisionDivergencePct: 100, maxPnlRegressionPct: 100 },
    );

    // The flat-on-third strategy produces go_flat on some frames where baseline stays long
    expect(result.comparison.candidateOnlyFlats).toBeGreaterThan(0);
    expect(result.comparison.baselineOnlyFlats).toBe(0);
  });

  it('compares P&L between strategies', async () => {
    const frames = makeFrames(10);
    const feed = new ArrayHistoricalDataFeed(frames);

    const result = await runValidation(
      feed,
      baseConfig(alwaysLongStrategy()),
      baseConfig(holdStrategy()),
      { maxDecisionDivergencePct: 100, maxPnlRegressionPct: 100 },
    );

    // Both strategies will have reported PnL (hold has 0)
    expect(result.comparison.pnl.baseline).toBeDefined();
    expect(result.comparison.pnl.candidate).toBeDefined();
    expect(result.comparison.pnl.delta).toBeDefined();
  });
});

describe('replayContexts', () => {
  it('reports 100% match when strategy reproduces same decisions', async () => {
    const contexts: StoredDecisionContext[] = [
      {
        decisionId: 'd-1',
        contextHash: 'hash1',
        context: { symbol: 'BTC/USD:USD', price: '50000', timestamp: '2026-01-01T00:00:00Z' },
        originalIntent: 'go_long',
        originalTargetSize: '1',
      },
      {
        decisionId: 'd-2',
        contextHash: 'hash2',
        context: { symbol: 'BTC/USD:USD', price: '51000', timestamp: '2026-01-01T01:00:00Z' },
        originalIntent: 'go_long',
        originalTargetSize: '1',
      },
    ];

    const summary = await replayContexts(alwaysLongStrategy(), contexts, {}, price);

    expect(summary.total).toBe(2);
    expect(summary.intentMatches).toBe(2);
    expect(summary.sizeMatches).toBe(2);
    expect(summary.errors).toBe(0);
    expect(summary.intentMatchPct).toBe(100);
    expect(summary.divergences).toHaveLength(0);
  });

  it('detects divergences when strategy changed behavior', async () => {
    const contexts: StoredDecisionContext[] = [
      {
        decisionId: 'd-1',
        contextHash: 'hash1',
        context: { symbol: 'BTC/USD:USD', price: '50000', timestamp: '2026-01-01T00:00:00Z' },
        originalIntent: 'go_short',
        originalTargetSize: '2',
      },
    ];

    const summary = await replayContexts(alwaysLongStrategy(), contexts, {}, price);

    expect(summary.intentMatches).toBe(0);
    expect(summary.sizeMatches).toBe(0);
    expect(summary.intentMatchPct).toBe(0);
    expect(summary.divergences).toHaveLength(1);
    expect(summary.divergences[0]!.originalIntent).toBe('go_short');
    expect(summary.divergences[0]!.replayedIntent).toBe('go_long');
  });

  it('handles strategy errors gracefully', async () => {
    const errorStrategy: Strategy = {
      id: 'error',
      name: 'Error Strategy',
      async evaluate() {
        return err({ code: 'strategy.test_error', message: 'Intentional failure' });
      },
    };

    const contexts: StoredDecisionContext[] = [
      {
        decisionId: 'd-1',
        contextHash: 'hash1',
        context: { symbol: 'BTC/USD:USD', price: '50000', timestamp: '2026-01-01T00:00:00Z' },
        originalIntent: 'go_long',
        originalTargetSize: '1',
      },
    ];

    const summary = await replayContexts(errorStrategy, contexts, {}, price);

    expect(summary.errors).toBe(1);
    expect(summary.divergences).toHaveLength(1);
    expect(summary.divergences[0]!.error).toBe('Intentional failure');
  });

  it('matches null intents for hold decisions', async () => {
    const contexts: StoredDecisionContext[] = [
      {
        decisionId: 'd-1',
        contextHash: 'hash1',
        context: { symbol: 'BTC/USD:USD', price: '50000', timestamp: '2026-01-01T00:00:00Z' },
        originalIntent: null,
        originalTargetSize: null,
      },
    ];

    const summary = await replayContexts(holdStrategy(), contexts, {}, price);

    expect(summary.intentMatches).toBe(1);
    expect(summary.sizeMatches).toBe(1);
    expect(summary.divergences).toHaveLength(0);
  });

  it('passes strategy config through to evaluate', async () => {
    let receivedConfig: Record<string, unknown> = {};
    const configCapture: Strategy = {
      id: 'capture',
      name: 'Config Capture',
      async evaluate(_snapshot, config) {
        receivedConfig = config;
        return ok(null);
      },
    };

    const contexts: StoredDecisionContext[] = [
      {
        decisionId: 'd-1',
        contextHash: 'hash1',
        context: { symbol: 'BTC/USD:USD', price: '50000', timestamp: '2026-01-01T00:00:00Z' },
        originalIntent: null,
        originalTargetSize: null,
      },
    ];

    await replayContexts(configCapture, contexts, { myParam: 42 }, price);

    expect(receivedConfig).toEqual({ myParam: 42 });
  });

  it('handles empty contexts array', async () => {
    const summary = await replayContexts(alwaysLongStrategy(), [], {}, price);

    expect(summary.total).toBe(0);
    expect(summary.intentMatchPct).toBe(0);
    expect(summary.sizeMatchPct).toBe(0);
    expect(summary.divergences).toHaveLength(0);
  });
});

describe('normalizeForReplay', () => {
  it('maps nested DB shape to flat StoredDecisionContext', () => {
    const decision = { id: 'd-1', intent: 'go_long', targetSize: '1.5' };
    const contextRow = {
      contextHash: 'abc123',
      context: {
        snapshot: { symbol: 'BTC/USD:USD', price: '50000', timestamp: '2026-01-01T00:00:00.000Z', data: { source: 'ws' } },
        position: { side: 'long', size: '1', entryPrice: '49500', realizedPnl: '0' },
        referenceMark: { price: '50100', source: 'binance' },
        balanceSnapshot: { balances: [{ asset: 'USDC', free: '10000', locked: '0', total: '10000' }] },
        strategyParams: { lookbackPeriod: 5 },
      } satisfies PersistedDecisionContext,
    };

    const result = normalizeForReplay(decision, contextRow);

    expect(result.decisionId).toBe('d-1');
    expect(result.contextHash).toBe('abc123');
    expect(result.originalIntent).toBe('go_long');
    expect(result.originalTargetSize).toBe('1.5');
    // Flat fields extracted from snapshot
    expect(result.context.symbol).toBe('BTC/USD:USD');
    expect(result.context.price).toBe('50000');
    expect(result.context.timestamp).toBe('2026-01-01T00:00:00.000Z');
    // Enrichment fields merged into data so they reach strategy via snapshot.data
    expect(result.context.data).toEqual({
      source: 'ws',
      position: contextRow.context.position,
      referenceMark: contextRow.context.referenceMark,
      balanceSnapshot: contextRow.context.balanceSnapshot,
      strategyParams: { lookbackPeriod: 5 },
    });
  });

  it('handles null optional fields', () => {
    const decision = { id: 'd-2', intent: 'go_short', targetSize: '0.5' };
    const contextRow = {
      contextHash: 'def456',
      context: {
        snapshot: { symbol: 'ETH/USD:USD', price: '3000', timestamp: '2026-01-02T00:00:00.000Z' },
        position: null,
        referenceMark: null,
        balanceSnapshot: null,
        strategyParams: {},
      } satisfies PersistedDecisionContext,
    };

    const result = normalizeForReplay(decision, contextRow);

    expect(result.context.symbol).toBe('ETH/USD:USD');
    // No original snapshot.data, so data only contains enrichment fields
    expect(result.context.data).toEqual({
      position: null,
      referenceMark: null,
      balanceSnapshot: null,
      strategyParams: {},
    });
  });
});

describe('normalizeForReplayBatch', () => {
  it('normalizes multiple rows', () => {
    const rows = [
      {
        decision: { id: 'd-1', intent: 'go_long', targetSize: '1' },
        context: {
          contextHash: 'h1',
          context: {
            snapshot: { symbol: 'BTC/USD:USD', price: '50000', timestamp: '2026-01-01T00:00:00.000Z' },
            position: null, referenceMark: null, balanceSnapshot: null, strategyParams: {},
          } satisfies PersistedDecisionContext,
        },
      },
      {
        decision: { id: 'd-2', intent: 'go_short', targetSize: '2' },
        context: {
          contextHash: 'h2',
          context: {
            snapshot: { symbol: 'ETH/USD:USD', price: '3000', timestamp: '2026-01-02T00:00:00.000Z' },
            position: null, referenceMark: null, balanceSnapshot: null, strategyParams: {},
          } satisfies PersistedDecisionContext,
        },
      },
    ];

    const results = normalizeForReplayBatch(rows);

    expect(results).toHaveLength(2);
    expect(results[0]!.decisionId).toBe('d-1');
    expect(results[0]!.context.symbol).toBe('BTC/USD:USD');
    expect(results[1]!.decisionId).toBe('d-2');
    expect(results[1]!.context.symbol).toBe('ETH/USD:USD');
  });

  it('returns empty array for empty input', () => {
    expect(normalizeForReplayBatch([])).toEqual([]);
  });
});
