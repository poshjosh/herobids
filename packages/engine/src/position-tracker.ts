import type { Price, Quantity } from '@herobids/domain';
import { Decimal, price } from '@herobids/domain';
import type { FillEvent } from './order-state.js';

/**
 * In-memory position state derived from fills.
 * The single source of truth for "where are we right now?"
 */
export interface PositionState {
  venue: string;
  symbol: string;
  side: 'long' | 'short' | 'flat';
  size: Quantity;
  entryPrice: Price;
  realizedPnl: Price;
}

/** Create a flat (empty) position */
export function flatPosition(venue: string, symbol: string): PositionState {
  return {
    venue,
    symbol,
    side: 'flat',
    size: new Decimal(0),
    entryPrice: new Decimal(0),
    realizedPnl: new Decimal(0),
  };
}

/**
 * Apply a fill to a position state, returning the new state.
 * Handles opening, increasing, reducing, closing, and reversing.
 * Pure function — no side effects.
 */
export function applyFill(position: PositionState, fill: FillEvent): PositionState {
  const fillSize = fill.quantity;
  const fillPrice = fill.price;
  const fillSide = fill.side; // buy or sell
  const isLong = fillSide === 'buy';

  const currentSize = position.size;
  const currentSide = position.side;

  // Opening from flat
  if (currentSide === 'flat') {
    return {
      ...position,
      side: isLong ? 'long' : 'short',
      size: fillSize,
      entryPrice: fillPrice,
    };
  }

  // Increasing existing position (same direction)
  const sameDirection =
    (currentSide === 'long' && isLong) ||
    (currentSide === 'short' && !isLong);

  if (sameDirection) {
    // Weighted average entry price
    const totalCost = position.entryPrice.mul(currentSize).plus(fillPrice.mul(fillSize));
    const newSize = currentSize.plus(fillSize);
    const newEntry = totalCost.div(newSize);
    return {
      ...position,
      size: newSize,
      entryPrice: newEntry,
    };
  }

  // Reducing or closing or reversing (opposite direction)
  const remaining = currentSize.minus(fillSize);

  if (remaining.gt(0)) {
    // Partial close — position shrinks
    const pnlPerUnit = currentSide === 'long'
      ? fillPrice.minus(position.entryPrice)
      : position.entryPrice.minus(fillPrice);
    const realizedFromClose = pnlPerUnit.mul(fillSize);

    return {
      ...position,
      size: remaining,
      realizedPnl: position.realizedPnl.plus(realizedFromClose),
    };
  }

  if (remaining.isZero()) {
    // Exact close — go flat
    const pnlPerUnit = currentSide === 'long'
      ? fillPrice.minus(position.entryPrice)
      : position.entryPrice.minus(fillPrice);
    const realizedFromClose = pnlPerUnit.mul(fillSize);

    return {
      ...position,
      side: 'flat',
      size: new Decimal(0),
      entryPrice: new Decimal(0),
      realizedPnl: position.realizedPnl.plus(realizedFromClose),
    };
  }

  // Reversal — close entire position + open in opposite direction
  const pnlPerUnit = currentSide === 'long'
    ? fillPrice.minus(position.entryPrice)
    : position.entryPrice.minus(fillPrice);
  const realizedFromClose = pnlPerUnit.mul(currentSize);
  const reversalSize = remaining.abs();

  return {
    ...position,
    side: isLong ? 'long' : 'short',
    size: reversalSize,
    entryPrice: fillPrice,
    realizedPnl: position.realizedPnl.plus(realizedFromClose),
  };
}

/**
 * Compute unrealized P&L for a single position at the given mark price.
 * Returns 0 for flat positions.
 */
export function unrealizedPnl(position: PositionState, markPrice: Price): Price {
  if (position.side === 'flat') return price('0');
  if (position.side === 'long') {
    return markPrice.minus(position.entryPrice).mul(position.size);
  }
  // short
  return position.entryPrice.minus(markPrice).mul(position.size);
}

/**
 * Compute total unrealized P&L across multiple positions at their respective mark prices.
 */
export function totalUnrealizedPnl(positions: PositionState[], markPrice: Price): Price {
  return positions
    .filter(p => p.side !== 'flat')
    .reduce((sum, p) => sum.plus(unrealizedPnl(p, markPrice)), price('0'));
}
