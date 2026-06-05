import type { Result } from '@herobids/domain';
import type { OrderId } from '@herobids/domain';
import type { Price } from '@herobids/domain';
import { ok } from '@herobids/domain';
import { quantity, Decimal } from '@herobids/domain';
import type { SwapVenuePort } from '@herobids/domain';
import type { Executor, ExecutionResult, EngineError } from './executor.js';
import type { ExecutionPlan } from './planner.js';
import type { ManagedOrder, FillEvent } from './order-state.js';
import type { MarketDataFeed, TradeEvent } from './market-data-feed.js';
import type { IdGenerator } from './paper-executor.js';

/**
 * Shadow executor — validates strategy decisions against real market conditions
 * without capital risk. Uses live ticker data for fill simulation.
 *
 * Market orders: immediate fill at best bid/ask from live ticker.
 * Swap orders: real quote from SwapVenuePort (no execution) — uses quoted price for shadow fill.
 * Limit orders: heuristic fill — fill if trade stream shows a print at or through the limit price.
 *
 * Limitations (Phase 2b):
 * - No queue-position simulation for resting limit orders (Phase 3+)
 * - No pessimistic fill modeling — partial fills, latency, adverse selection (Phase 3+)
 * - No detailed book capture for replay (Phase 3+)
 */
export class ShadowExecutor implements Executor {
  private pendingLimits: PendingLimit[] = [];
  private unsubscribers: Array<() => void> = [];

  constructor(
    private readonly idGen: IdGenerator,
    private readonly feed: MarketDataFeed,
    private readonly swapVenue?: SwapVenuePort,
  ) {}

  async execute(plan: ExecutionPlan, _currentPrice: Price): Promise<Result<ExecutionResult, EngineError>> {
    const now = new Date().toISOString();
    const orders: ManagedOrder[] = [];
    const fills: FillEvent[] = [];

    for (const planned of plan.orders) {
      const orderId = this.idGen.orderId();

      if (planned.type === 'market') {
        // Market orders: fill immediately at best bid/ask from live ticker
        const ticker = this.feed.getTicker(plan.symbol);
        const fillPrice = this.determineFillPrice(planned.side, ticker, _currentPrice);
        const fillId = this.idGen.fillId();

        const order: ManagedOrder = {
          id: orderId,
          venueAccountId: plan.venueAccountId,
          actorType: plan.actorType,
          actorId: plan.actorId,
          executionPlanId: plan.id,
          venueRefId: `shadow-${orderId}`,
          clientOrderId: undefined,
          venue: plan.venue,
          symbol: plan.symbol,
          side: planned.side,
          type: planned.type,
          quantity: planned.quantity,
          price: planned.price,
          status: 'filled',
          filledQuantity: planned.quantity,
          avgFillPrice: fillPrice,
          createdAt: now,
          updatedAt: now,
        };
        orders.push(order);

        const fill: FillEvent = {
          id: fillId,
          orderId,
          venueAccountId: plan.venueAccountId,
          actorType: plan.actorType,
          actorId: plan.actorId,
          venueRefId: `shadow-${fillId}`,
          venue: plan.venue,
          symbol: plan.symbol,
          side: planned.side,
          quantity: planned.quantity,
          price: fillPrice,
          fee: quantity('0'),
          feeCurrency: 'USD',
          filledAt: now,
        };
        fills.push(fill);
      } else if (planned.type === 'swap') {
        // Swap orders: fetch real quote from swap venue if available, else fall back to ticker
        let fillPrice: Price;
        let filledQuantity = planned.quantity;
        if (this.swapVenue) {
          const [inputAsset, outputAsset] = planned.swapParams
            ? [planned.swapParams.inputAsset, planned.swapParams.outputAsset]
            : this.resolveSwapAssets(plan.symbol, planned.side);
          // For buys, planned.quantity is in base-asset units but the swap API expects
          // the input amount (quote-asset). Estimate using the current ticker price.
          let quoteAmount = planned.quantity;
          if (planned.side === 'buy') {
            const ticker = this.feed.getTicker(plan.symbol);
            const estimatePrice = ticker?.ask ?? ticker?.last ?? _currentPrice;
            if (estimatePrice) {
              const estimated = new Decimal(planned.quantity.toString()).mul(new Decimal(estimatePrice.toString()));
              quoteAmount = estimated.toString() as unknown as typeof planned.quantity;
            }
          }
          const quoteResult = await this.swapVenue.quote({
            inputAsset,
            outputAsset,
            amount: quoteAmount,
            slippageBps: 50, // default slippage for shadow
          });
          if (quoteResult.ok) {
            // Effective price = expectedOutputAmount / inputAmount
            const outAmt = new Decimal(quoteResult.data.expectedOutputAmount.toString());
            const inAmt = new Decimal(quoteResult.data.inputAmount.toString());
            // For a buy: price = inputAmount / outputAmount (cost per unit acquired)
            // For a sell: price = outputAmount / inputAmount (proceeds per unit sold)
            const effectivePrice = planned.side === 'buy'
              ? inAmt.div(outAmt)
              : outAmt.div(inAmt);
            fillPrice = effectivePrice as unknown as Price;
            // Position/P&L must use the actually executed base amount from the quote,
            // not the requested target size — but cap at planned.quantity so the
            // tracked position never exceeds what was risk-approved.
            const rawFilled = planned.side === 'buy'
              ? quoteResult.data.expectedOutputAmount
              : quoteResult.data.inputAmount;
            filledQuantity = new Decimal(rawFilled.toString()).gt(new Decimal(planned.quantity.toString()))
              ? planned.quantity
              : rawFilled;
          } else {
            // Quote failed — fall back to ticker price
            const ticker = this.feed.getTicker(plan.symbol);
            fillPrice = this.determineFillPrice(planned.side, ticker, _currentPrice);
          }
        } else {
          // No swap venue provided — fall back to ticker price
          const ticker = this.feed.getTicker(plan.symbol);
          fillPrice = this.determineFillPrice(planned.side, ticker, _currentPrice);
        }

        const fillId = this.idGen.fillId();
        const order: ManagedOrder = {
          id: orderId,
          venueAccountId: plan.venueAccountId,
          actorType: plan.actorType,
          actorId: plan.actorId,
          executionPlanId: plan.id,
          venueRefId: `shadow-${orderId}`,
          clientOrderId: undefined,
          venue: plan.venue,
          symbol: plan.symbol,
          side: planned.side,
          type: planned.type,
          quantity: planned.quantity,
          price: planned.price,
          status: 'filled',
          filledQuantity,
          avgFillPrice: fillPrice,
          createdAt: now,
          updatedAt: now,
        };
        orders.push(order);

        const fill: FillEvent = {
          id: fillId,
          orderId,
          venueAccountId: plan.venueAccountId,
          actorType: plan.actorType,
          actorId: plan.actorId,
          venueRefId: `shadow-${fillId}`,
          venue: plan.venue,
          symbol: plan.symbol,
          side: planned.side,
          quantity: filledQuantity,
          price: fillPrice,
          fee: quantity('0'),
          feeCurrency: 'USD',
          filledAt: now,
        };
        fills.push(fill);
      } else {
        // Limit orders: register pending fill — will be triggered by trade stream heuristic
        // For synchronous execution within a single tick, check immediately if price is through
        const limitPrice = planned.price ?? _currentPrice;
        const ticker = this.feed.getTicker(plan.symbol);

        // Check if already through the limit (can happen if market moved)
        const immediatelyFilled = this.isLimitTriggered(planned.side, limitPrice, ticker);

        if (immediatelyFilled) {
          const fillId = this.idGen.fillId();
          const order: ManagedOrder = {
            id: orderId,
            venueAccountId: plan.venueAccountId,
            actorType: plan.actorType,
            actorId: plan.actorId,
            executionPlanId: plan.id,
            venueRefId: `shadow-${orderId}`,
            clientOrderId: undefined,
            venue: plan.venue,
            symbol: plan.symbol,
            side: planned.side,
            type: planned.type,
            quantity: planned.quantity,
            price: limitPrice,
            status: 'filled',
            filledQuantity: planned.quantity,
            avgFillPrice: limitPrice,
            createdAt: now,
            updatedAt: now,
          };
          orders.push(order);

          const fill: FillEvent = {
            id: fillId,
            orderId,
            venueAccountId: plan.venueAccountId,
            actorType: plan.actorType,
            actorId: plan.actorId,
            venueRefId: `shadow-${fillId}`,
            venue: plan.venue,
            symbol: plan.symbol,
            side: planned.side,
            quantity: planned.quantity,
            price: limitPrice,
            fee: quantity('0'),
            feeCurrency: 'USD',
            filledAt: now,
          };
          fills.push(fill);
        } else {
          // Register pending limit order — will be resolved asynchronously via trade stream
          const pending: PendingLimit = {
            orderId,
            plan,
            side: planned.side,
            quantity: planned.quantity,
            limitPrice,
            createdAt: now,
            resolved: false,
          };
          this.pendingLimits.push(pending);

          // Register trade handler for heuristic fill
          const unsub = this.feed.onTrade(plan.symbol, (trade: TradeEvent) => {
            if (pending.resolved) return;
            if (this.isTradeThrough(planned.side, limitPrice, trade.price)) {
              pending.resolved = true;
              pending.resolvedFill = {
                price: limitPrice,
                timestamp: trade.timestamp,
              };
            }
          });
          this.unsubscribers.push(unsub);

          // For now, treat as open order (pending fill will be picked up on next tick or reconciliation)
          const order: ManagedOrder = {
            id: orderId,
            venueAccountId: plan.venueAccountId,
            actorType: plan.actorType,
            actorId: plan.actorId,
            executionPlanId: plan.id,
            venueRefId: `shadow-${orderId}`,
            clientOrderId: undefined,
            venue: plan.venue,
            symbol: plan.symbol,
            side: planned.side,
            type: planned.type,
            quantity: planned.quantity,
            price: limitPrice,
            status: 'open',
            filledQuantity: quantity('0'),
            avgFillPrice: undefined,
            createdAt: now,
            updatedAt: now,
          };
          orders.push(order);
        }
      }
    }

    const completedPlan: ExecutionPlan = {
      ...plan,
      status: fills.length === plan.orders.length ? 'completed' : 'executing',
      completedAt: fills.length === plan.orders.length ? now : undefined,
    };

    return ok({ plan: completedPlan, orders, fills });
  }

  /** Resolve any pending limit orders that have been triggered by trade stream */
  resolvePendingLimits(): FillEvent[] {
    const fills: FillEvent[] = [];
    for (const pending of this.pendingLimits) {
      if (pending.resolved && pending.resolvedFill) {
        const fillId = this.idGen.fillId();
        fills.push({
          id: fillId,
          orderId: pending.orderId,
          venueAccountId: pending.plan.venueAccountId,
          actorType: pending.plan.actorType,
          actorId: pending.plan.actorId,
          venueRefId: `shadow-${fillId}`,
          venue: pending.plan.venue,
          symbol: pending.plan.symbol,
          side: pending.side,
          quantity: pending.quantity,
          price: pending.resolvedFill.price,
          fee: quantity('0'),
          feeCurrency: 'USD',
          filledAt: pending.resolvedFill.timestamp,
        });
      }
    }
    // Remove resolved entries
    this.pendingLimits = this.pendingLimits.filter((p) => !p.resolved);
    return fills;
  }

  /** Clean up trade stream subscriptions */
  dispose(): void {
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
    this.pendingLimits = [];
  }

  private determineFillPrice(side: string, ticker: { bid?: Price; ask?: Price; last: Price } | null, fallback: Price): Price {
    if (!ticker) return fallback;
    // Buy at ask, sell at bid (taker execution)
    if (side === 'buy') return ticker.ask ?? ticker.last;
    return ticker.bid ?? ticker.last;
  }

  private isLimitTriggered(side: string, limitPrice: Price, ticker: { bid?: Price; ask?: Price; last: Price } | null): boolean {
    if (!ticker) return false;
    // Buy limit triggers when ask <= limit price
    if (side === 'buy') {
      const relevant = ticker.ask ?? ticker.last;
      return relevant.lte(limitPrice);
    }
    // Sell limit triggers when bid >= limit price
    const relevant = ticker.bid ?? ticker.last;
    return relevant.gte(limitPrice);
  }

  private isTradeThrough(side: string, limitPrice: Price, tradePrice: Price): boolean {
    // Buy limit: fill if trade prints at or below limit
    if (side === 'buy') return tradePrice.lte(limitPrice);
    // Sell limit: fill if trade prints at or above limit
    return tradePrice.gte(limitPrice);
  }

  /**
   * Resolve swap asset pair from symbol and side.
   * Convention: symbol is "BASE/QUOTE" — buy = sell QUOTE to get BASE, sell = sell BASE to get QUOTE.
   */
  private resolveSwapAssets(symbol: string, side: string): [string, string] {
    const [base, quote] = symbol.split('/').map((s) => s.split(':')[0]);
    if (side === 'buy') return [quote ?? 'USD', base ?? symbol];
    return [base ?? symbol, quote ?? 'USD'];
  }
}

interface PendingLimit {
  orderId: OrderId;
  plan: ExecutionPlan;
  side: 'buy' | 'sell';
  quantity: Price;
  limitPrice: Price;
  createdAt: string;
  resolved: boolean;
  resolvedFill?: {
    price: Price;
    timestamp: string;
  };
}
