import type { Price, Quantity } from '@herobids/domain';
import type { VenueOrder, VenueFill, Position, BalanceSnapshot } from '@herobids/domain';
import { Decimal } from '@herobids/domain';

// --- Input types ---

/** Local state snapshot for reconciliation comparison */
export interface LocalState {
  positions: LocalPosition[];
  balances: LocalBalance[];
  recentFills: LocalFill[];
  openOrders: LocalOrder[];
}

/** Venue state snapshot for reconciliation comparison */
export interface VenueState {
  positions: Position[];
  balances: BalanceSnapshot;
  recentFills: VenueFill[];
  openOrders: VenueOrder[];
}

export interface LocalPosition {
  symbol: string;
  side: 'long' | 'short' | 'flat';
  size: Quantity;
  entryPrice: Price;
}

export interface LocalBalance {
  asset: string;
  total: Quantity;
}

export interface LocalFill {
  venueRefId?: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: Quantity;
  price: Price;
  filledAt: string;
}

export interface LocalOrder {
  venueRefId?: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: string;
  status: string;
  quantity: Quantity;
  price?: Price;
}

// --- Output types ---

export type ReconciliationStatus = 'match' | 'drift_detected';

export interface ReconciliationResult {
  status: ReconciliationStatus;
  diffs: Diff[];
  reconciledAt: string;
}

export type DiffType = 'position_mismatch' | 'balance_mismatch' | 'unknown_fill' | 'orphaned_order';

export interface Diff {
  type: DiffType;
  symbol?: string;
  asset?: string;
  description: string;
  local: unknown;
  venue: unknown;
}

// --- Tolerance for floating point comparison ---
const DEFAULT_TOLERANCE = new Decimal('0.0000001');

/**
 * Compare local state against venue state and detect drift.
 * Pure function — no side effects, no I/O.
 */
export function reconcile(local: LocalState, venue: VenueState): ReconciliationResult {
  const diffs: Diff[] = [];

  // 1. Compare positions
  diffs.push(...reconcilePositions(local.positions, venue.positions));

  // 2. Compare balances
  diffs.push(...reconcileBalances(local.balances, venue.balances));

  // 3. Detect unknown fills (fills on venue not in local)
  diffs.push(...reconcileFills(local.recentFills, venue.recentFills));

  // 4. Detect orphaned orders (orders on venue not tracked locally)
  diffs.push(...reconcileOrders(local.openOrders, venue.openOrders));

  return {
    status: diffs.length === 0 ? 'match' : 'drift_detected',
    diffs,
    reconciledAt: new Date().toISOString(),
  };
}

function reconcilePositions(local: LocalPosition[], venue: Position[]): Diff[] {
  const diffs: Diff[] = [];

  // Build venue position map by symbol
  const venueMap = new Map<string, Position>();
  for (const vp of venue) {
    if (vp.side !== 'flat') {
      venueMap.set(vp.symbol, vp);
    }
  }

  // Check local positions against venue
  for (const lp of local) {
    if (lp.side === 'flat') continue;

    const vp = venueMap.get(lp.symbol);
    if (!vp) {
      diffs.push({
        type: 'position_mismatch',
        symbol: lp.symbol,
        description: `Local has ${lp.side} position but venue has no position`,
        local: { side: lp.side, size: lp.size.toString() },
        venue: null,
      });
      continue;
    }

    // Compare side
    if (lp.side !== vp.side) {
      diffs.push({
        type: 'position_mismatch',
        symbol: lp.symbol,
        description: `Position side mismatch: local=${lp.side}, venue=${vp.side}`,
        local: { side: lp.side, size: lp.size.toString() },
        venue: { side: vp.side, size: vp.size.toString() },
      });
    } else if (!lp.size.minus(vp.size).abs().lte(DEFAULT_TOLERANCE)) {
      // Same side but size differs
      diffs.push({
        type: 'position_mismatch',
        symbol: lp.symbol,
        description: `Position size mismatch: local=${lp.size.toString()}, venue=${vp.size.toString()}`,
        local: { side: lp.side, size: lp.size.toString() },
        venue: { side: vp.side, size: vp.size.toString() },
      });
    }

    venueMap.delete(lp.symbol);
  }

  // Remaining venue positions not in local
  for (const [symbol, vp] of venueMap) {
    diffs.push({
      type: 'position_mismatch',
      symbol,
      description: `Venue has ${vp.side} position but local has no position`,
      local: null,
      venue: { side: vp.side, size: vp.size.toString() },
    });
  }

  return diffs;
}

function reconcileBalances(local: LocalBalance[], venue: BalanceSnapshot): Diff[] {
  const diffs: Diff[] = [];

  const venueMap = new Map<string, Decimal>();
  for (const vb of venue.balances) {
    const total = vb.total instanceof Decimal ? vb.total : new Decimal(vb.total.toString());
    if (total.gt(0)) {
      venueMap.set(vb.asset, total);
    }
  }

  for (const lb of local) {
    const localTotal = lb.total instanceof Decimal ? lb.total : new Decimal(lb.total.toString());
    const venueTotal = venueMap.get(lb.asset);

    if (!venueTotal) {
      if (localTotal.gt(DEFAULT_TOLERANCE)) {
        diffs.push({
          type: 'balance_mismatch',
          asset: lb.asset,
          description: `Local has balance ${localTotal.toString()} but venue has no balance`,
          local: localTotal.toString(),
          venue: '0',
        });
      }
      continue;
    }

    if (!localTotal.minus(venueTotal).abs().lte(DEFAULT_TOLERANCE)) {
      diffs.push({
        type: 'balance_mismatch',
        asset: lb.asset,
        description: `Balance mismatch: local=${localTotal.toString()}, venue=${venueTotal.toString()}`,
        local: localTotal.toString(),
        venue: venueTotal.toString(),
      });
    }

    venueMap.delete(lb.asset);
  }

  // Venue balances not tracked locally — this is informational but not necessarily drift
  // Only flag if the balance is significant
  for (const [asset, venueTotal] of venueMap) {
    if (venueTotal.gt(DEFAULT_TOLERANCE)) {
      diffs.push({
        type: 'balance_mismatch',
        asset,
        description: `Venue has balance ${venueTotal.toString()} but local has no record`,
        local: '0',
        venue: venueTotal.toString(),
      });
    }
  }

  return diffs;
}

/**
 * Reconcile fills by comparing venue ref IDs.
 *
 * Limitation: Local fills without a venueRefId (e.g. paper fills or fills that
 * haven't received venue acknowledgement yet) cannot be matched against venue fills.
 * A venue fill whose local counterpart has no ref ID will appear as an "unknown_fill" drift.
 * Future enhancement: secondary matching heuristic on symbol+side+quantity+timestamp proximity.
 */
function reconcileFills(local: LocalFill[], venue: VenueFill[]): Diff[] {
  const diffs: Diff[] = [];

  // Build a set of local fill venue ref IDs for fast lookup
  const localRefIds = new Set<string>();
  for (const lf of local) {
    if (lf.venueRefId) localRefIds.add(lf.venueRefId);
  }

  // Any venue fill not in local is an unknown fill
  for (const vf of venue) {
    if (!localRefIds.has(vf.venueRefId)) {
      diffs.push({
        type: 'unknown_fill',
        symbol: vf.symbol,
        description: `Venue fill ${vf.venueRefId} not found in local records`,
        local: null,
        venue: {
          venueRefId: vf.venueRefId,
          side: vf.side,
          quantity: vf.quantity.toString(),
          price: vf.price.toString(),
          filledAt: vf.filledAt,
        },
      });
    }
  }

  return diffs;
}

function reconcileOrders(local: LocalOrder[], venue: VenueOrder[]): Diff[] {
  const diffs: Diff[] = [];

  // Build a set of local order venue ref IDs
  const localRefIds = new Set<string>();
  for (const lo of local) {
    if (lo.venueRefId) localRefIds.add(lo.venueRefId);
  }

  // Any venue open order not tracked locally is orphaned
  for (const vo of venue) {
    if (!localRefIds.has(vo.venueRefId)) {
      diffs.push({
        type: 'orphaned_order',
        symbol: vo.symbol,
        description: `Venue order ${vo.venueRefId} not tracked locally`,
        local: null,
        venue: {
          venueRefId: vo.venueRefId,
          side: vo.side,
          type: vo.type,
          quantity: vo.quantity.toString(),
          price: vo.price?.toString(),
        },
      });
    }
  }

  return diffs;
}
