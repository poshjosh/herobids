import type { OrderbookVenuePort, SwapVenuePort } from '@herobids/domain';
import { quantity } from '@herobids/domain';
import type { VenueState } from './reconcile.js';
import type { VenueStateLoader } from './reconciler.js';

/**
 * Creates a VenueStateLoader for orderbook venues.
 * Translates OrderbookVenuePort calls into the canonical VenueState shape.
 */
export function createOrderbookVenueStateLoader(
  venue: OrderbookVenuePort,
  logger: { error(obj: Record<string, unknown>, msg: string): void },
): VenueStateLoader {
  return async (since: Date | null): Promise<VenueState | null> => {
    const [posResult, balResult, fillResult, orderResult] = await Promise.all([
      venue.fetchPositions(),
      venue.fetchBalances(),
      venue.fetchRecentFills(since ?? undefined),
      venue.fetchOpenOrders(),
    ]);

    if (!posResult.ok) {
      logger.error({ err: posResult.error }, 'Failed to fetch venue positions');
      return null;
    }
    if (!balResult.ok) {
      logger.error({ err: balResult.error }, 'Failed to fetch venue balances');
      return null;
    }
    if (!fillResult.ok) {
      logger.error({ err: fillResult.error }, 'Failed to fetch venue fills');
      return null;
    }
    if (!orderResult.ok) {
      logger.error({ err: orderResult.error }, 'Failed to fetch venue orders');
      return null;
    }

    return {
      positions: posResult.data,
      balances: balResult.data,
      recentFills: fillResult.data,
      openOrders: orderResult.data,
    };
  };
}

/**
 * Creates a VenueStateLoader for swap venues.
 * Translates SwapVenuePort data into the canonical VenueState shape:
 * - Shared-wallet balance snapshots are observational telemetry.
 * - No synthetic positions are derived from fill projections.
 * - Recent fills: always empty — swap venues in shadow mode never execute real swaps,
 *   and external wallet transactions should not be flagged as "unknown fills" by the reconciler.
 * - No open orders (swaps are atomic)
 */
export function createSwapVenueStateLoader(
  venue: SwapVenuePort,
  logger: { error(obj: Record<string, unknown>, msg: string): void },
): VenueStateLoader {
  return async (_since: Date | null): Promise<VenueState | null> => {
    const balResult = await venue.fetchBalances();

    if (!balResult.ok) {
      logger.error({ err: balResult.error }, 'Failed to fetch swap venue balances');
      return null;
    }

    // Map swap balances to the BalanceSnapshot shape expected by reconciler
    const balances = {
      balances: balResult.data.balances.map((b) => ({
        asset: b.asset,
        free: quantity(b.amount.toString()),
        locked: quantity('0'),
        total: quantity(b.amount.toString()),
      })),
      timestamp: balResult.data.timestamp,
    };

    return {
      positions: [],
      balances,
      // Swap venues in shadow mode don't execute real swaps. Returning external wallet
      // transactions here would cause the reconciler to raise false "unknown fill" diffs
      // because no corresponding local fill exists (ShadowExecutor uses synthetic fills).
      recentFills: [],
      openOrders: [], // Swaps are atomic — no resting orders
    };
  };
}
