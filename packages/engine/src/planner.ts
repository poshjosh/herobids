import type { Decision } from '@herobids/domain';
import type { OrderSide, OrderType } from '@herobids/domain';
import type { Price, Quantity } from '@herobids/domain';
import type { Position } from '@herobids/domain';
import { Decimal } from '@herobids/domain';

/**
 * An execution plan bridges a Decision to concrete order commands.
 * The planner determines *what* to do; the executor determines *how* (paper vs live).
 */
export interface ExecutionPlan {
  id: string;
  decisionId: string;
  tradingInstanceId: string;
  venue: string;
  symbol: string;
  action: PlanAction;
  orders: PlannedOrder[];
  status: 'pending' | 'executing' | 'completed' | 'failed';
  createdAt: string;
  completedAt?: string;
}

export type PlanAction = 'open_long' | 'open_short' | 'close' | 'increase' | 'reduce' | 'reverse';

export interface PlannedOrder {
  side: OrderSide;
  type: OrderType;
  quantity: Quantity;
  price?: Price;
  /** Explicit swap routing params — populated when venueType is 'swap' and swapAssets are configured */
  swapParams?: { inputAsset: string; outputAsset: string; amount: Quantity };
}

export interface PlannerDeps {
  /** Current position for the instrument (null if flat) */
  currentPosition: Position | null;
  /** Venue + symbol context */
  venue: string;
  symbol: string;
  /** Venue type — determines order type emitted. Default: 'orderbook' */
  venueType?: 'orderbook' | 'swap';
  /** Explicit swap asset identifiers for routing (avoids fragile symbol parsing) */
  swapAssets?: { baseAsset: string; quoteAsset: string };
}

/**
 * Plan a Decision into an ExecutionPlan.
 * Pure function — no side effects, no I/O.
 */
export function planDecision(decision: Decision, deps: PlannerDeps): ExecutionPlan {
  const { currentPosition, venue, symbol, venueType } = deps;
  const currentSize = currentPosition ? currentPosition.size : new Decimal(0);
  const currentSide = currentPosition?.side ?? 'flat';
  const targetSize = decision.targetSize;

  /** Determine order type based on venue type and decision hints */
  const resolveOrderType = (): OrderType => {
    if (venueType === 'swap') return 'swap';
    return decision.limitPrice ? 'limit' : 'market';
  };

  const orderType = resolveOrderType();
  const orders: PlannedOrder[] = [];
  let action: PlanAction;

  switch (decision.intent) {
    case 'go_flat': {
      action = 'close';
      if (currentSide !== 'flat' && currentSize.gt(0)) {
        orders.push({
          side: currentSide === 'long' ? 'sell' : 'buy',
          type: orderType,
          quantity: currentSize,
          price: decision.limitPrice,
        });
      }
      break;
    }

    case 'go_long': {
      if (currentSide === 'short') {
        // Close short first, then open long
        action = 'reverse';
        orders.push({
          side: 'buy',
          type: orderType,
          quantity: currentSize,
          price: decision.limitPrice,
        });
        if (targetSize.gt(0)) {
          orders.push({
            side: 'buy',
            type: orderType,
            quantity: targetSize,
            price: decision.limitPrice,
          });
        }
      } else {
        action = currentSide === 'flat' ? 'open_long' : 'increase';
        const deficit = targetSize.minus(currentSize);
        if (deficit.gt(0)) {
          orders.push({
            side: 'buy',
            type: orderType,
            quantity: deficit,
            price: decision.limitPrice,
          });
        }
      }
      break;
    }

    case 'go_short': {
      if (venueType === 'swap') {
        action = 'close';
        // Spot swap venues can reduce or close existing base holdings,
        // but they cannot open or reverse into a borrowed short.
        if (currentSide === 'long' && currentSize.gt(0)) {
          orders.push({
            side: 'sell',
            type: orderType,
            quantity: currentSize,
            price: decision.limitPrice,
          });
        }
        break;
      }

      if (currentSide === 'long') {
        // Close long first, then open short
        action = 'reverse';
        orders.push({
          side: 'sell',
          type: orderType,
          quantity: currentSize,
          price: decision.limitPrice,
        });
        if (targetSize.gt(0)) {
          orders.push({
            side: 'sell',
            type: orderType,
            quantity: targetSize,
            price: decision.limitPrice,
          });
        }
      } else {
        action = currentSide === 'flat' ? 'open_short' : 'increase';
        const deficit = targetSize.minus(currentSize);
        if (deficit.gt(0)) {
          orders.push({
            side: 'sell',
            type: orderType,
            quantity: deficit,
            price: decision.limitPrice,
          });
        }
      }
      break;
    }

    case 'increase': {
      action = 'increase';
      const deficit = targetSize.minus(currentSize);
      if (deficit.gt(0)) {
        const side: OrderSide = currentSide === 'short' ? 'sell' : 'buy';
        orders.push({
          side,
          type: orderType,
          quantity: deficit,
          price: decision.limitPrice,
        });
      }
      break;
    }

    case 'decrease': {
      action = 'reduce';
      const excess = currentSize.minus(targetSize);
      if (excess.gt(0)) {
        const side: OrderSide = currentSide === 'short' ? 'buy' : 'sell';
        orders.push({
          side,
          type: orderType,
          quantity: excess,
          price: decision.limitPrice,
        });
      }
      break;
    }

    default:
      action = 'close';
  }

  // Populate swapParams on each order when configured for swap venues
  if (venueType === 'swap' && deps.swapAssets) {
    const { baseAsset, quoteAsset } = deps.swapAssets;
    for (const order of orders) {
      // Buy = spend quote to acquire base; Sell = spend base to acquire quote
      const [inputAsset, outputAsset] = order.side === 'buy'
        ? [quoteAsset, baseAsset]
        : [baseAsset, quoteAsset];
      order.swapParams = { inputAsset, outputAsset, amount: order.quantity };
    }
  }

  return {
    id: '',
    decisionId: decision.id,
    tradingInstanceId: decision.tradingInstanceId,
    venue,
    symbol,
    action,
    orders,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
}
