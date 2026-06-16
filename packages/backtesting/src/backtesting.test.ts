import { describe, it, expect } from 'vitest';
import { SimulatedClock } from './simulated-clock.js';
import { ArrayHistoricalDataFeed } from './historical-data-feed.js';
import { runBacktest } from './replay-runner.js';
import { price, quantity, ok, err } from '@herobids/domain';
import type { Strategy, MarketSnapshot, Decision, DecisionId, VenueAccountId, InstrumentId } from '@herobids/domain';
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
      venueAccountId: '' as VenueAccountId,
      actorType: 'system',
      actorId: 'test',
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
      botId: 'inst-bt-1',
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
      botId: 'inst-bt-2',
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
      botId: 'inst-bt-3',
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
        botId: 'inst-bt-det',
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
      botId: 'inst-bt-persist',
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

  it('rejects non-zero warmUpFrames for LLM strategies', async () => {
    const llmStrategy: Strategy = {
      id: 'llm-v1',
      name: 'LLM Strategy',
      evaluate: async () => ok(null),
    };
    const frames = makeFrames(10);
    const feed = new ArrayHistoricalDataFeed(frames);

    await expect(runBacktest(feed, {
      runId: 'test-llm-warmup',
      botId: 'inst-bt-llm',
      venue: 'hyperliquid',
      symbol: 'BTC/USD:USD',
      venueAccountId: 'va-1',
      strategy: llmStrategy,
      strategyConfig: { provider: 'openai', model: 'gpt-4' },
      riskLimits: { maxPositionSize: quantity('100'), maxOpenPositions: 5, maxDrawdown: price('10000') },
      warmUpFrames: 3,
    })).rejects.toThrow('warmUpFrames must be 0 for LLM strategies');
  });

  it('allows zero warmUpFrames for LLM strategies', async () => {
    const llmStrategy: Strategy = {
      id: 'llm-v1',
      name: 'LLM Strategy',
      evaluate: async () => ok(null),
    };
    const frames = makeFrames(5);
    const feed = new ArrayHistoricalDataFeed(frames);

    const report = await runBacktest(feed, {
      runId: 'test-llm-no-warmup',
      botId: 'inst-bt-llm-ok',
      venue: 'hyperliquid',
      symbol: 'BTC/USD:USD',
      venueAccountId: 'va-1',
      strategy: llmStrategy,
      strategyConfig: { provider: 'openai', model: 'gpt-4' },
      riskLimits: { maxPositionSize: quantity('100'), maxOpenPositions: 5, maxDrawdown: price('10000') },
      warmUpFrames: 0,
    });

    expect(report.totalFrames).toBe(5);
  });

  it('surfaces strategy errors during warm-up instead of swallowing them', async () => {
    let callCount = 0;
    const failsOnSecondCall: Strategy = {
      id: 'fragile',
      name: 'Fragile Strategy',
      evaluate: async () => {
        callCount++;
        if (callCount === 2) return err({ code: 'strategy.broken', message: 'config invalid' });
        return ok(null);
      },
    };
    const frames = makeFrames(10);
    const feed = new ArrayHistoricalDataFeed(frames);

    await expect(runBacktest(feed, {
      runId: 'test-warmup-error',
      botId: 'inst-bt-warmup-err',
      venue: 'hyperliquid',
      symbol: 'BTC/USD:USD',
      venueAccountId: 'va-1',
      strategy: failsOnSecondCall,
      strategyConfig: {},
      riskLimits: { maxPositionSize: quantity('100'), maxOpenPositions: 5, maxDrawdown: price('10000') },
      warmUpFrames: 5,
    })).rejects.toThrow('Strategy error during warm-up frame 1');
  });

  it('forwards riskPlaybook to snapshot during warm-up and trading frames', async () => {
    const receivedPlaybooks: Array<{ phase: string; playbook: unknown }> = [];
    const playbookAware: Strategy = {
      id: 'playbook-aware',
      name: 'Playbook Aware',
      evaluate: async (snapshot: MarketSnapshot): Promise<any> => {
        receivedPlaybooks.push({ phase: 'trading', playbook: snapshot.playbook });
        return ok(null);
      },
    };

    // Override the warm-up path: use a spy that also records warm-up snapshots.
    // We can't easily spy on internal warm-up calls, so instead we set warmUpFrames=0
    // and verify trading frames receive the playbook. For warm-up coverage, set
    // warmUpFrames>0 and check that the trading frames that follow also get it.
    const frames = makeFrames(5);
    const feed = new ArrayHistoricalDataFeed(frames);

    await runBacktest(feed, {
      runId: 'test-playbook-forward',
      venue: 'hyperliquid',
      symbol: 'BTC/USD:USD',
      venueAccountId: 'va-1',
      strategy: playbookAware,
      strategyConfig: {},
      riskLimits: { maxPositionSize: quantity('100'), maxOpenPositions: 5, maxDrawdown: price('10000') },
      warmUpFrames: 0,
      riskPlaybook: { avoidParabolicMovePct: 7, maxNewPositionsPerDay: 3 },
    });

    expect(receivedPlaybooks.length).toBe(5);
    for (const entry of receivedPlaybooks) {
      expect(entry.phase).toBe('trading');
      expect(entry.playbook).toEqual({ avoidParabolicMovePct: 7, maxNewPositionsPerDay: 3 });
    }
  });

  it('forwards riskPlaybook during warm-up frames (verified via strategy that records all calls)', async () => {
    const allSnapshots: MarketSnapshot[] = [];
    const recordingStrategy: Strategy = {
      id: 'recording',
      name: 'Recording',
      evaluate: async (snapshot: MarketSnapshot): Promise<any> => {
        allSnapshots.push(snapshot);
        return ok(null);
      },
    };

    const frames = makeFrames(6);
    const feed = new ArrayHistoricalDataFeed(frames);

    await runBacktest(feed, {
      runId: 'test-playbook-warmup',
      venue: 'hyperliquid',
      symbol: 'BTC/USD:USD',
      venueAccountId: 'va-1',
      strategy: recordingStrategy,
      strategyConfig: {},
      riskLimits: { maxPositionSize: quantity('100'), maxOpenPositions: 5, maxDrawdown: price('10000') },
      warmUpFrames: 2,
      riskPlaybook: { maxNewPositionsPerDay: 5 },
    });

    // 2 warm-up + 4 trading = 6 calls
    expect(allSnapshots.length).toBe(6);
    // All snapshots should carry the playbook
    for (const snap of allSnapshots) {
      expect(snap.playbook).toEqual({ maxNewPositionsPerDay: 5 });
    }
  });
});

/**
 * Regression: bug 2026-05-31-001 — package.json used "main": "./src/index.ts"
 * causing Node.js to attempt to load TS source at runtime, which failed with
 * ERR_MODULE_NOT_FOUND because .js extension imports don't exist in src/.
 * Fix: replaced with a conditional `exports` field pointing to ./dist/index.js.
 */
describe('@herobids/backtesting package.json exports (bug 2026-05-31-001 regression)', () => {
  it('uses conditional exports pointing to dist/index.js, not src/index.ts', () => {
    const pkgPath = new URL('../package.json', import.meta.url).pathname;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = JSON.parse(require('node:fs').readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;

    // Must NOT have a "main" pointing to TypeScript source
    expect(pkg['main']).toBeUndefined();

    // Must have conditional exports with import -> dist
    const exports = pkg['exports'] as Record<string, unknown> | undefined;
    expect(exports).toBeDefined();
    const root = (exports as Record<string, Record<string, string>>)['.'];
    expect(root).toBeDefined();
    expect(root!['import']).toBe('./dist/index.js');
    expect(root!['types']).toBe('./dist/index.d.ts');
  });
});
