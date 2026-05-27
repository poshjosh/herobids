import { describe, it, expect } from 'vitest';
import { SimulatedClock } from './simulated-clock.js';
import { ArrayHistoricalDataFeed } from './historical-data-feed.js';
import { runBacktest } from './replay-runner.js';
import { price, quantity, ok } from '@herobids/domain';
import type { Strategy, MarketSnapshot, Decision, DecisionId, TradingInstanceId, InstrumentId } from '@herobids/domain';
import { vi } from 'vitest';

function makeFrames(count: number, startPrice = 50000, step = 100) {
  const base = new Date('2026-01-01T00:00:00.000Z').getTime();
  return Array.from({ length: count }, (_, i) => ({
    timestamp: new Date(base + i * 60_000).toISOString(),
    symbol: 'BTC/USD:USD',
    price: price(String(startPrice + i * step)),
  }));
}

describe('SimulatedClock', () => {
  it('returns the initial timestamp', () => {
    const clock = new SimulatedClock('2026-01-01T00:00:00.000Z');
    expect(clock.now()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('advances to the new timestamp', () => {
    const clock = new SimulatedClock('2026-01-01T00:00:00.000Z');
    clock.advance('2026-01-01T01:00:00.000Z');
    expect(clock.now()).toBe('2026-01-01T01:00:00.000Z');
  });
});

describe('ArrayHistoricalDataFeed', () => {
  it('provides frames by index', () => {
    const frames = makeFrames(5);
    const feed = new ArrayHistoricalDataFeed(frames);
    expect(feed.length).toBe(5);
    expect(feed.frame(0).price.toString()).toBe('50000');
    expect(feed.frame(4).price.toString()).toBe('50400');
  });

  it('throws on empty frames', () => {
    expect(() => new ArrayHistoricalDataFeed([])).toThrow('at least one frame');
  });

  it('throws on out-of-order frames', () => {
    const frames = makeFrames(3);
    // Swap last two
    const swapped = [frames[0]!, frames[2]!, frames[1]!];
    expect(() => new ArrayHistoricalDataFeed(swapped)).toThrow('ordered by timestamp');
  });

  it('throws on out-of-bounds index', () => {
    const feed = new ArrayHistoricalDataFeed(makeFrames(3));
    expect(() => feed.frame(5)).toThrow('out of bounds');
  });
});

describe('runBacktest', () => {
  const alwaysLong: Strategy = {
    id: 'always-long',
    name: 'Always Long',
    evaluate: async (snapshot: MarketSnapshot): Promise<any> => ok({
      id: 'test-d' as DecisionId,
      tradingInstanceId: '' as TradingInstanceId,
      instrumentId: 'BTC/USD:USD' as InstrumentId,
      intent: 'go_long',
      targetSize: quantity('1'),
      timestamp: snapshot.timestamp,
    } satisfies Decision),
  };

  const holdStrategy: Strategy = {
    id: 'hold',
    name: 'Hold',
    evaluate: async () => ok(null),
  };

  it('skips warm-up frames and processes remaining', async () => {
    const frames = makeFrames(10);
    const feed = new ArrayHistoricalDataFeed(frames);

    const report = await runBacktest(feed, {
      runId: 'test-run-1',
      tradingInstanceId: 'inst-bt-1',
      venue: 'hyperliquid',
      symbol: 'BTC/USD:USD',
      venueAccountId: 'va-1',
      strategy: holdStrategy,
      strategyConfig: {},
      riskLimits: { maxPositionSize: quantity('100'), maxOpenPositions: 5, maxDrawdown: price('10000') },
      warmUpFrames: 3,
    });

    expect(report.totalFrames).toBe(7); // 10 - 3 warm-up
    expect(report.warmUpFrames).toBe(3);
    expect(report.totalDecisions).toBe(0);
    expect(report.finalPosition.side).toBe('flat');
  });

  it('produces fills and updates position on go_long decision', async () => {
    const frames = makeFrames(6);
    const feed = new ArrayHistoricalDataFeed(frames);

    const report = await runBacktest(feed, {
      runId: 'test-run-2',
      tradingInstanceId: 'inst-bt-2',
      venue: 'hyperliquid',
      symbol: 'BTC/USD:USD',
      venueAccountId: 'va-1',
      strategy: alwaysLong,
      strategyConfig: {},
      riskLimits: { maxPositionSize: quantity('100'), maxOpenPositions: 5, maxDrawdown: price('10000') },
      warmUpFrames: 0,
    });

    expect(report.totalDecisions).toBeGreaterThan(0);
    expect(report.totalFills).toBeGreaterThan(0);
    expect(report.finalPosition.side).toBe('long');
    expect(report.startTimestamp).toBe(frames[0]!.timestamp);
    expect(report.endTimestamp).toBe(frames[5]!.timestamp);
  });

  it('throws when warmUpFrames >= feed length', async () => {
    const frames = makeFrames(3);
    const feed = new ArrayHistoricalDataFeed(frames);

    await expect(runBacktest(feed, {
      runId: 'test-run-3',
      tradingInstanceId: 'inst-bt-3',
      venue: 'hyperliquid',
      symbol: 'BTC/USD:USD',
      venueAccountId: 'va-1',
      strategy: holdStrategy,
      strategyConfig: {},
      riskLimits: { maxPositionSize: quantity('100'), maxOpenPositions: 5, maxDrawdown: price('10000') },
      warmUpFrames: 3,
    })).rejects.toThrow('warmUpFrames');
  });

  it('deterministic: same feed + strategy produces same report', async () => {
    const frames = makeFrames(8);

    const run = async () => {
      const feed = new ArrayHistoricalDataFeed(frames);
      return runBacktest(feed, {
        runId: 'det-run',
        tradingInstanceId: 'inst-bt-det',
        venue: 'hyperliquid',
        symbol: 'BTC/USD:USD',
        venueAccountId: 'va-1',
        strategy: alwaysLong,
        strategyConfig: {},
        riskLimits: { maxPositionSize: quantity('100'), maxOpenPositions: 5, maxDrawdown: price('10000') },
        warmUpFrames: 2,
      });
    };

    const r1 = await run();
    const r2 = await run();

    expect(r1.totalDecisions).toBe(r2.totalDecisions);
    expect(r1.totalFills).toBe(r2.totalFills);
    expect(r1.finalPosition.side).toBe(r2.finalPosition.side);
    expect(r1.finalPosition.size.toString()).toBe(r2.finalPosition.size.toString());
    expect(r1.realizedPnl).toBe(r2.realizedPnl);
  });

  it('uses custom persistence hooks to persist decisions and replay contexts', async () => {
    const frames = makeFrames(6);
    const feed = new ArrayHistoricalDataFeed(frames);
    const persistence = {
      persistDecision: vi.fn().mockResolvedValue(undefined),
      persistDecisionContext: vi.fn().mockResolvedValue(undefined),
      persistPlan: vi.fn().mockResolvedValue(undefined),
      markPlanExecuting: vi.fn().mockResolvedValue(undefined),
      markPlanCompleted: vi.fn().mockResolvedValue(undefined),
      markPlanFailed: vi.fn().mockResolvedValue(undefined),
      persistFill: vi.fn().mockResolvedValue(undefined),
      persistPosition: vi.fn().mockResolvedValue(undefined),
      persistOrder: vi.fn().mockResolvedValue(undefined),
    };

    await runBacktest(feed, {
      runId: 'persist-run',
      tradingInstanceId: 'inst-bt-persist',
      venue: 'hyperliquid',
      symbol: 'BTC/USD:USD',
      venueAccountId: 'va-1',
      strategy: alwaysLong,
      strategyConfig: { lookbackPeriod: 3 },
      riskLimits: { maxPositionSize: quantity('100'), maxOpenPositions: 5, maxDrawdown: price('10000') },
      warmUpFrames: 0,
      persistence,
    });

    expect(persistence.persistDecision).toHaveBeenCalled();
    expect(persistence.persistDecisionContext).toHaveBeenCalled();
    const persistedContext = persistence.persistDecisionContext.mock.calls[0]![0];
    expect(persistedContext.snapshot.symbol).toBe('BTC/USD:USD');
    expect(persistedContext.strategyParams).toEqual({ lookbackPeriod: 3 });
  });
});
