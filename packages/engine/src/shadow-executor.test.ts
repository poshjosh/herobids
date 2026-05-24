import { describe, it, expect, beforeEach } from 'vitest';
import { ShadowExecutor } from './shadow-executor.js';
import type { MarketDataFeed, TickerSnapshot, TradeHandler } from './market-data-feed.js';
import type { ExecutionPlan } from './planner.js';
import type { OrderId, FillId, TradingInstanceId } from '@herobids/domain';
import { price, quantity } from '@herobids/domain';

// Minimal market data feed stub
class StubMarketDataFeed implements MarketDataFeed {
  private ticker: TickerSnapshot | null = null;
  private handlers = new Map<string, Set<TradeHandler>>();

  setTicker(t: TickerSnapshot) { this.ticker = t; }

  getTicker(_symbol: string): TickerSnapshot | null {
    return this.ticker;
  }

  onTrade(symbol: string, handler: TradeHandler): () => void {
    let set = this.handlers.get(symbol);
    if (!set) { set = new Set(); this.handlers.set(symbol, set); }
    set.add(handler);
    return () => { set!.delete(handler); };
  }

  // Simulate a trade print for limit-order heuristic testing
  emitTrade(symbol: string, tradePrice: ReturnType<typeof price>, side: 'buy' | 'sell') {
    const handlers = this.handlers.get(symbol);
    if (!handlers) return;
    for (const h of handlers) {
      h({ symbol, side, price: tradePrice, quantity: tradePrice, timestamp: new Date().toISOString() });
    }
  }

  start() {}
  stop() {}
}

function makeIdGen() {
  let orderCounter = 0;
  let fillCounter = 0;
  return {
    orderId: () => `order-${++orderCounter}` as OrderId,
    fillId: () => `fill-${++fillCounter}` as FillId,
  };
}

function makePlan(overrides?: Partial<ExecutionPlan>): ExecutionPlan {
  return {
    id: 'plan-1',
    decisionId: 'dec-1',
    tradingInstanceId: 'inst-1' as string,
    venue: 'hyperliquid',
    symbol: 'BTC/USD:USD',
    action: 'open_long',
    orders: [
      { side: 'buy', type: 'market', quantity: quantity('1'), price: undefined },
    ],
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('ShadowExecutor', () => {
  let feed: StubMarketDataFeed;
  let executor: ShadowExecutor;

  beforeEach(() => {
    feed = new StubMarketDataFeed();
    executor = new ShadowExecutor(makeIdGen(), feed);
  });

  describe('market orders', () => {
    it('fills at ask price for buy orders when ticker available', async () => {
      feed.setTicker({
        symbol: 'BTC/USD:USD',
        last: price('100000'),
        bid: price('99990'),
        ask: price('100010'),
        timestamp: new Date().toISOString(),
      });

      const plan = makePlan();
      const result = await executor.execute(plan, price('100000'));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.fills).toHaveLength(1);
      expect(result.data.fills[0].price.toString()).toBe('100010');
      expect(result.data.orders[0].status).toBe('filled');
    });

    it('fills at bid price for sell orders when ticker available', async () => {
      feed.setTicker({
        symbol: 'BTC/USD:USD',
        last: price('100000'),
        bid: price('99990'),
        ask: price('100010'),
        timestamp: new Date().toISOString(),
      });

      const plan = makePlan({
        action: 'close',
        orders: [{ side: 'sell', type: 'market', quantity: quantity('1') }],
      });
      const result = await executor.execute(plan, price('100000'));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.fills[0].price.toString()).toBe('99990');
    });

    it('falls back to currentPrice when no ticker', async () => {
      const plan = makePlan();
      const result = await executor.execute(plan, price('50000'));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.fills[0].price.toString()).toBe('50000');
    });
  });

  describe('limit orders', () => {
    it('fills immediately when market is already through the limit price', async () => {
      feed.setTicker({
        symbol: 'BTC/USD:USD',
        last: price('99000'),
        bid: price('98990'),
        ask: price('99010'),
        timestamp: new Date().toISOString(),
      });

      // Buy limit at 99050 — ask is 99010 which is below limit → immediate fill
      const plan = makePlan({
        orders: [{ side: 'buy', type: 'limit', quantity: quantity('1'), price: price('99050') }],
      });
      const result = await executor.execute(plan, price('99000'));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.fills).toHaveLength(1);
      expect(result.data.orders[0].status).toBe('filled');
      expect(result.data.fills[0].price.toString()).toBe('99050');
    });

    it('remains open when limit is not triggered', async () => {
      feed.setTicker({
        symbol: 'BTC/USD:USD',
        last: price('100000'),
        bid: price('99990'),
        ask: price('100010'),
        timestamp: new Date().toISOString(),
      });

      // Buy limit at 99000 — ask is 100010 which is above limit → not triggered
      const plan = makePlan({
        orders: [{ side: 'buy', type: 'limit', quantity: quantity('1'), price: price('99000') }],
      });
      const result = await executor.execute(plan, price('100000'));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.fills).toHaveLength(0);
      expect(result.data.orders[0].status).toBe('open');
    });

    it('resolves pending limit when trade stream shows print through price', async () => {
      feed.setTicker({
        symbol: 'BTC/USD:USD',
        last: price('100000'),
        bid: price('99990'),
        ask: price('100010'),
        timestamp: new Date().toISOString(),
      });

      // Buy limit at 99500 — not immediately triggered
      const plan = makePlan({
        orders: [{ side: 'buy', type: 'limit', quantity: quantity('2'), price: price('99500') }],
      });
      await executor.execute(plan, price('100000'));

      // Now simulate a trade print at 99400 (below limit → triggers fill)
      feed.emitTrade('BTC/USD:USD', price('99400'), 'sell');

      const resolved = executor.resolvePendingLimits();
      expect(resolved).toHaveLength(1);
      expect(resolved[0].price.toString()).toBe('99500');
      expect(resolved[0].quantity.toString()).toBe('2');
    });

    it('does not resolve pending limit for trade print above limit', async () => {
      feed.setTicker({
        symbol: 'BTC/USD:USD',
        last: price('100000'),
        bid: price('99990'),
        ask: price('100010'),
        timestamp: new Date().toISOString(),
      });

      const plan = makePlan({
        orders: [{ side: 'buy', type: 'limit', quantity: quantity('1'), price: price('99000') }],
      });
      await executor.execute(plan, price('100000'));

      // Trade at 99500 — still above 99000 limit → no fill
      feed.emitTrade('BTC/USD:USD', price('99500'), 'sell');

      const resolved = executor.resolvePendingLimits();
      expect(resolved).toHaveLength(0);
    });
  });

  describe('plan status', () => {
    it('marks plan as completed when all orders filled', async () => {
      feed.setTicker({
        symbol: 'BTC/USD:USD',
        last: price('100000'),
        ask: price('100010'),
        bid: price('99990'),
        timestamp: new Date().toISOString(),
      });

      const plan = makePlan();
      const result = await executor.execute(plan, price('100000'));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.plan.status).toBe('completed');
    });

    it('marks plan as executing when some orders are pending', async () => {
      feed.setTicker({
        symbol: 'BTC/USD:USD',
        last: price('100000'),
        ask: price('100010'),
        bid: price('99990'),
        timestamp: new Date().toISOString(),
      });

      // Two orders: one market (fills immediately), one limit (remains open)
      const plan = makePlan({
        orders: [
          { side: 'buy', type: 'market', quantity: quantity('1') },
          { side: 'buy', type: 'limit', quantity: quantity('1'), price: price('95000') },
        ],
      });
      const result = await executor.execute(plan, price('100000'));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.plan.status).toBe('executing');
      expect(result.data.fills).toHaveLength(1); // only market order filled
    });
  });

  describe('dispose', () => {
    it('cleans up trade handlers and pending limits', async () => {
      feed.setTicker({
        symbol: 'BTC/USD:USD',
        last: price('100000'),
        ask: price('100010'),
        bid: price('99990'),
        timestamp: new Date().toISOString(),
      });

      const plan = makePlan({
        orders: [{ side: 'buy', type: 'limit', quantity: quantity('1'), price: price('99000') }],
      });
      await executor.execute(plan, price('100000'));

      executor.dispose();

      // After dispose, trade events shouldn't resolve anything
      feed.emitTrade('BTC/USD:USD', price('98000'), 'sell');
      const resolved = executor.resolvePendingLimits();
      expect(resolved).toHaveLength(0);
    });
  });
});
