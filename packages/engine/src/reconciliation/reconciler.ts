import type { OrderbookVenuePort } from '@herobids/domain';
import { Decimal } from '@herobids/domain';
import type { Journal } from '../journal.js';
import { reconcileWithThresholds } from './reconcile.js';
import type { LocalState, VenueState, ReconciliationResult } from './reconcile.js';

export interface ReconcilerConfig {
  /** Interval between reconciliation passes in milliseconds */
  intervalMs: number;
  /** If true, only log drift without auto-correcting */
  driftAlertOnly: boolean;
  /** Position size drift threshold (absolute). Diffs within this are 'acceptable'. Default: '0' */
  positionDriftThreshold?: string;
  /** Balance drift threshold (absolute). Diffs within this are 'acceptable'. Default: '0' */
  balanceDriftThreshold?: string;
  /** If true, attempt to auto-correct acceptable drift by syncing local state to venue */
  autoCorrect?: boolean;
}

export interface ReconcilerDeps {
  /** The venue port to fetch state from */
  venue: OrderbookVenuePort;
  /** Loads local state for comparison */
  loadLocalState: () => Promise<LocalState>;
  /** Persists reconciliation results with full state snapshots */
  persistResult: (result: ReconciliationResult, localState: LocalState, venueState: VenueState) => Promise<void>;
  /** Journal for audit logging */
  journal: Journal;
  /** Trading instance ID this reconciler is for */
  tradingInstanceId: string;
  /** Venue account ID */
  venueAccountId: string;
  /** Logger */
  logger: { info(obj: Record<string, unknown>, msg: string): void; warn(obj: Record<string, unknown>, msg: string): void; error(obj: Record<string, unknown>, msg: string): void };
  /** Optional: callback on reconciliation pass completion */
  onReconciled?: (result: ReconciliationResult) => void;
  /** Returns the last reconciliation timestamp for fill cursor alignment */
  getLastReconciledAt?: () => Promise<Date | null>;
}

/**
 * Reconciler — periodic venue-state comparison that detects drift.
 * Runs on a configurable interval. Each pass:
 * 1. Fetches venue state (positions, balances, fills, orders)
 * 2. Loads local state from DB
 * 3. Compares via reconcile()
 * 4. Persists result + journals
 */
export class Reconciler {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private passing = false;

  constructor(
    private readonly config: ReconcilerConfig,
    private readonly deps: ReconcilerDeps,
  ) {}

  /** Start the periodic reconciliation loop (does not run the first pass — call runPass() explicitly) */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => void this.runPass(), this.config.intervalMs);
  }

  /** Stop the reconciliation loop */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Run a single reconciliation pass (exposed for on-demand use, e.g. on startup) */
  async runPass(): Promise<ReconciliationResult | null> {
    if (!this.running) return null;
    if (this.passing) return null; // prevent concurrent passes
    this.passing = true;

    try {
      // 1. Fetch venue state
      const venueState = await this.fetchVenueState();
      if (!venueState) return null;

      // 2. Load local state
      const localState = await this.deps.loadLocalState();

      // 3. Reconcile (always use threshold-aware version — zero thresholds produce same result as basic reconcile)
      const result = reconcileWithThresholds(localState, venueState, {
        positionSize: this.config.positionDriftThreshold
          ? new Decimal(this.config.positionDriftThreshold)
          : undefined,
        balance: this.config.balanceDriftThreshold
          ? new Decimal(this.config.balanceDriftThreshold)
          : undefined,
      });

      // 4. Persist + journal
      await this.deps.persistResult(result, localState, venueState);
      const journalType = result.status === 'match'
        ? 'reconciliation.match'
        : result.status === 'drift_within_threshold'
          ? 'reconciliation.drift_within_threshold'
          : 'reconciliation.drift_detected';
      await this.deps.journal.append({
        tradingInstanceId: this.deps.tradingInstanceId,
        type: journalType,
        payload: {
          venueAccountId: this.deps.venueAccountId,
          status: result.status,
          diffCount: result.diffs.length,
          diffs: result.diffs,
          reconciledAt: result.reconciledAt,
        },
      });

      // 5. Log result
      if (result.status === 'match') {
        this.deps.logger.info(
          { tradingInstanceId: this.deps.tradingInstanceId },
          'Reconciliation pass: match',
        );
      } else if (result.status === 'drift_within_threshold') {
        this.deps.logger.info(
          { tradingInstanceId: this.deps.tradingInstanceId, diffCount: result.diffs.length, diffs: result.diffs },
          'Reconciliation pass: drift within acceptable threshold',
        );
      } else {
        this.deps.logger.warn(
          { tradingInstanceId: this.deps.tradingInstanceId, diffCount: result.diffs.length, diffs: result.diffs },
          'Reconciliation pass: drift detected',
        );
      }

      // 6. Notify
      this.deps.onReconciled?.(result);

      return result;
    } catch (err) {
      this.deps.logger.error(
        { err, tradingInstanceId: this.deps.tradingInstanceId },
        'Reconciliation pass failed',
      );

      // Journal the failure so operators can alert on repeated failures
      try {
        await this.deps.journal.append({
          tradingInstanceId: this.deps.tradingInstanceId,
          type: 'reconciliation.drift_detected',
          payload: {
            venueAccountId: this.deps.venueAccountId,
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
          },
        });
      } catch { /* best-effort */ }

      return null;
    } finally {
      this.passing = false;
    }
  }

  private async fetchVenueState(): Promise<VenueState | null> {
    const since = this.deps.getLastReconciledAt
      ? await this.deps.getLastReconciledAt()
      : undefined;
    const [posResult, balResult, fillResult, orderResult] = await Promise.all([
      this.deps.venue.fetchPositions(),
      this.deps.venue.fetchBalances(),
      this.deps.venue.fetchRecentFills(since ?? undefined),
      this.deps.venue.fetchOpenOrders(),
    ]);

    if (!posResult.ok) {
      this.deps.logger.error({ err: posResult.error }, 'Failed to fetch venue positions');
      return null;
    }
    if (!balResult.ok) {
      this.deps.logger.error({ err: balResult.error }, 'Failed to fetch venue balances');
      return null;
    }
    if (!fillResult.ok) {
      this.deps.logger.error({ err: fillResult.error }, 'Failed to fetch venue fills');
      return null;
    }
    if (!orderResult.ok) {
      this.deps.logger.error({ err: orderResult.error }, 'Failed to fetch venue orders');
      return null;
    }

    return {
      positions: posResult.data,
      balances: balResult.data,
      recentFills: fillResult.data,
      openOrders: orderResult.data,
    };
  }

  get isRunning(): boolean {
    return this.running;
  }
}
