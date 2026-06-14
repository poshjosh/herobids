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

export type ReconciliationStatus = 'match' | 'drift_detected' | 'drift_within_threshold' | 'observed_variance';

export interface ReconciliationResult {
  status: ReconciliationStatus;
  diffs: Diff[];
  reconciledAt: string;
}

export type DiffType = 'position_mismatch' | 'balance_mismatch' | 'unknown_fill' | 'orphaned_order';

export type DiffSeverity = 'critical' | 'acceptable';

/**
 * Live-mode drift classification — helps operators distinguish root causes of balance/position discrepancies.
 * Optional: only set when the reconciler can infer the category from available data.
 */
export type DriftCategory =
  | 'fee_funding_adjustment'
  | 'observed_balance_variance'
  | 'open_order_drift'
  | 'position_size_drift';

export interface Diff {
  type: DiffType;
  symbol?: string;
  asset?: string;
  description: string;
  local: unknown;
  venue: unknown;
  /** Severity classification. 'acceptable' means within configured threshold. */
  severity?: DiffSeverity;
  /** Live-mode drift category for operator diagnostics. */
  category?: DriftCategory;
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

export interface DriftThresholds {
  /** Position size drift threshold (absolute). Default: 0 (exact match). */
  positionSize?: Decimal;
  /** Balance drift threshold (absolute). Default: 0. */
  balance?: Decimal;
  /**
   * Venue accounting mode. When 'observational' (shared-wallet swap venues),
   * balance mismatches are classified as observed_balance_variance.
   * When 'authoritative' (orderbook venues), balance mismatches get no category
   * since they represent real drift requiring investigation.
   * Default: 'observational' for backward compatibility.
   */
  venueAccountingMode?: 'authoritative' | 'observational';
}

/**
 * Reconcile with threshold classification.
 * Diffs within threshold are marked 'acceptable'; diffs exceeding threshold are 'critical'.
 * Returns 'drift_within_threshold' when all diffs are acceptable.
 */
export function reconcileWithThresholds(
  local: LocalState,
  venue: VenueState,
  thresholds: DriftThresholds,
): ReconciliationResult {
  const baseResult = reconcile(local, venue);
  if (baseResult.status === 'match') return baseResult;

  const posThreshold = thresholds.positionSize ?? new Decimal(0);
  const balThreshold = thresholds.balance ?? new Decimal(0);
  const accountingMode = thresholds.venueAccountingMode ?? 'observational';

  const classifiedDiffs: Diff[] = baseResult.diffs.map((diff) => {
    const severity = classifyDiffSeverity(diff, posThreshold, balThreshold);
    const category = classifyDriftCategory(diff, accountingMode);
    return { ...diff, severity, category };
  });

  const hasCritical = classifiedDiffs.some((d) => d.severity === 'critical');

  return {
    status: hasCritical ? 'drift_detected' : 'drift_within_threshold',
    diffs: classifiedDiffs,
    reconciledAt: baseResult.reconciledAt,
  };
}

function classifyDiffSeverity(diff: Diff, posThreshold: Decimal, balThreshold: Decimal): DiffSeverity {
  if (diff.type === 'position_mismatch' && posThreshold.gt(0)) {
    // If both local and venue have a size, check if the magnitude of difference is within threshold
    const localObj = diff.local as { side?: string; size?: string } | null;
    const venueObj = diff.venue as { side?: string; size?: string } | null;

    if (localObj?.size && venueObj?.size && localObj.side === venueObj.side) {
      const sizeDiff = new Decimal(localObj.size).minus(new Decimal(venueObj.size)).abs();
      if (sizeDiff.lte(posThreshold)) return 'acceptable';
    }
    // Side mismatch or missing position entirely = critical
    return 'critical';
  }

  if (diff.type === 'balance_mismatch' && balThreshold.gt(0)) {
    const localVal = new Decimal(String(diff.local ?? '0'));
    const venueVal = new Decimal(String(diff.venue ?? '0'));
    const balDiff = localVal.minus(venueVal).abs();
    if (balDiff.lte(balThreshold)) return 'acceptable';
    return 'critical';
  }

  // unknown_fill and orphaned_order are always critical — they indicate state not tracked
  return 'critical';
}

/**
 * Classify a diff into a drift category for operator diagnostics.
 * Conservative: only assigns a category when the diff shape unambiguously matches.
 * Defaults to undefined (no category) rather than guessing.
 */
function classifyDriftCategory(diff: Diff, accountingMode: 'authoritative' | 'observational'): DriftCategory | undefined {
  if (diff.type === 'position_mismatch') {
    // Only classify as size drift when both local and venue positions exist
    // with matching side — side flips or missing positions are more serious
    // and should not be lumped under "size drift".
    const localObj = diff.local as { side?: string; size?: string } | null;
    const venueObj = diff.venue as { side?: string; size?: string } | null;
    if (localObj?.side && venueObj?.side && localObj.side === venueObj.side) {
      return 'position_size_drift';
    }
    return undefined;
  }
  if (diff.type === 'orphaned_order') {
    return 'open_order_drift';
  }
  if (diff.type === 'balance_mismatch') {
    // Only classify as observational variance for shared-wallet/observational venues.
    // Authoritative venues (orderbook) leave balance mismatches uncategorized since
    // they represent real drift that requires investigation.
    return accountingMode === 'observational' ? 'observed_balance_variance' : undefined;
  }
  return undefined;
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
    const total = new Decimal(vb.total.toString());
    if (total.gt(0)) {
      venueMap.set(vb.asset, total);
    }
  }

  for (const lb of local) {
    const localTotal = new Decimal(lb.total.toString());
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
