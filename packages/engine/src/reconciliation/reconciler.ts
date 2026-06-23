import { Decimal } from '@herobids/domain';
import type { Journal } from '../journal.js';
import { reconcileWithThresholds } from './reconcile.js';
import type { LocalState, VenueState, ReconciliationResult } from './reconcile.js';

export interface ReconcilerHealth {
  lastPassAt: Date | null;
  consecutiveNullPasses: number;
  healthy: boolean;
}

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
  /** Swap venue balance drift threshold (%). Alerts if expected vs actual > this. Default: 1.0 */
  swapDriftThresholdPct?: number;
}

/**
 * Canonical venue-state loader function.
 * Implementations translate venue-specific data (orderbook or swap) into the common VenueState shape.
 */
export type VenueStateLoader = (since: Date | null) => Promise<VenueState | null>;

export interface ReconcilerDeps {
  /** Loads venue state in canonical form for comparison. Replaces direct OrderbookVenuePort dependency. */
  fetchVenueState: VenueStateLoader;
  /** Loads local state for comparison */
  loadLocalState: () => Promise<LocalState>;
  /** Persists reconciliation results with full state snapshots */
  persistResult: (result: ReconciliationResult, localState: LocalState, venueState: VenueState) => Promise<void>;
  /** Journal for audit logging */
  journal: Journal;
  /** Venue account ID */
  venueAccountId: string;
  /** Actor type for journal attribution */
  actorType?: string;
  /** Actor ID for journal attribution */
  actorId?: string;
  /** Logger */
  logger: { info(obj: Record<string, unknown>, msg: string): void; warn(obj: Record<string, unknown>, msg: string): void; error(obj: Record<string, unknown>, msg: string): void };
  /** Optional: callback on reconciliation pass completion */
  onReconciled?: (result: ReconciliationResult) => void;
  /** Returns the last reconciliation timestamp for fill cursor alignment */
  getLastReconciledAt?: () => Promise<Date | null>;
  /** Whether balance mismatches should be treated as authoritative drift or observational telemetry. */
  balanceDiffMode?: 'authoritative' | 'observational';
  /**
   * If true, position-only drift is expected (simulated fills, no real venue positions)
   * and is logged at INFO instead of WARN. Used by shadow/paper mode agents.
   */
  isShadowOrPaper?: boolean;
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
  private static readonly NULL_PASS_ALERT_THRESHOLD = 10;

  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private passing = false;
  private consecutiveNullPasses = 0;
  private lastPassAt: Date | null = null;

  constructor(
    private readonly config: ReconcilerConfig,
    private readonly deps: ReconcilerDeps,
  ) {}

  /** Start the periodic reconciliation loop (does not run the first pass — call runPass() explicitly) */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.consecutiveNullPasses = 0;
    this.lastPassAt = null;
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
      if (!venueState) {
        this.consecutiveNullPasses++;
        this.deps.logger.warn(
          { venueAccountId: this.deps.venueAccountId, consecutiveNullPasses: this.consecutiveNullPasses },
          'Reconciliation skipped — venue state unavailable',
        );
        if (this.consecutiveNullPasses >= Reconciler.NULL_PASS_ALERT_THRESHOLD) {
          const alertDurationMs = this.config.intervalMs * Reconciler.NULL_PASS_ALERT_THRESHOLD;
          const alertDurationMin = Math.round(alertDurationMs / 60000);
          this.deps.logger.error(
            { venueAccountId: this.deps.venueAccountId, consecutiveNullPasses: this.consecutiveNullPasses, alertDurationMin },
            `ALERT: Reconciliation has been unable to reach venue for ${alertDurationMin}+ minutes — possible network/API outage`,
          );
        }
        return null;
      }
      // Reset staleness counter on successful venue state fetch
      this.consecutiveNullPasses = 0;

      // 2. Load local state
      const localState = await this.deps.loadLocalState();

      // 3. Reconcile (always use threshold-aware version — zero thresholds produce same result as basic reconcile)
      const rawResult = reconcileWithThresholds(localState, venueState, {
        positionSize: this.config.positionDriftThreshold
          ? new Decimal(this.config.positionDriftThreshold)
          : undefined,
        balance: this.config.balanceDriftThreshold
          ? new Decimal(this.config.balanceDriftThreshold)
          : undefined,
        venueAccountingMode: this.deps.balanceDiffMode,
      });
      const result = this.classifyResult(rawResult);

      // 4. Persist + journal
      await this.deps.persistResult(result, localState, venueState);
      this.lastPassAt = new Date();
      const journalType = result.status === 'match'
        ? 'reconciliation.match'
        : result.status === 'observed_variance'
          ? 'reconciliation.observed_variance'
        : result.status === 'drift_within_threshold'
          ? 'reconciliation.drift_within_threshold'
          : 'reconciliation.drift_detected';
      await this.deps.journal.append({
        actorType: this.deps.actorType,
        actorId: this.deps.actorId,
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
          { venueAccountId: this.deps.venueAccountId },
          'Reconciliation pass: match',
        );
      } else if (result.status === 'observed_variance') {
        this.deps.logger.info(
          { venueAccountId: this.deps.venueAccountId, diffCount: result.diffs.length, diffs: result.diffs },
          'Reconciliation pass: observed balance variance',
        );
      } else if (result.status === 'drift_within_threshold') {
        this.deps.logger.info(
          { venueAccountId: this.deps.venueAccountId, diffCount: result.diffs.length, diffs: result.diffs },
          'Reconciliation pass: drift within acceptable threshold',
        );
      } else {
        // This branch fires only when classifyResult returned 'drift_detected'.
        // classifyResult may downgrade certain patterns (e.g. balance-only diffs
        // → observed_variance), so by the time we reach here all higher-level
        // classifications have been exhausted and the remaining diffs are genuine.
        //
        // Shadow/paper modes produce simulated fills that never land on the venue,
        // so position-only drift is expected. Log at INFO to avoid noise.
        const isPositionOnly = this.deps.isShadowOrPaper &&
          result.diffs.length > 0 &&
          result.diffs.every((d) => d.type === 'position_mismatch');
        if (isPositionOnly) {
          this.deps.logger.info(
            { venueAccountId: this.deps.venueAccountId, diffCount: result.diffs.length, diffs: result.diffs },
            'Reconciliation pass: drift detected (shadow/paper — position-only, expected)',
          );
        } else {
          this.deps.logger.warn(
            { venueAccountId: this.deps.venueAccountId, diffCount: result.diffs.length, diffs: result.diffs },
            'Reconciliation pass: drift detected',
          );
        }
      }

      // 6. Notify
      this.deps.onReconciled?.(result);

      return result;
    } catch (err) {
      this.deps.logger.error(
        { err, venueAccountId: this.deps.venueAccountId },
        'Reconciliation pass failed',
      );

      // Journal the failure so operators can alert on repeated failures
      try {
        await this.deps.journal.append({
          actorType: this.deps.actorType,
          actorId: this.deps.actorId,
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
      : null;
    return this.deps.fetchVenueState(since);
  }

  private classifyResult(result: ReconciliationResult): ReconciliationResult {
    if (this.deps.balanceDiffMode !== 'observational') {
      return result;
    }

    if (result.status === 'match' || result.diffs.length === 0) {
      return result;
    }

    const balanceOnly = result.diffs.every((diff) => diff.type === 'balance_mismatch');
    if (!balanceOnly) {
      return result;
    }

    return {
      ...result,
      status: 'observed_variance',
      diffs: result.diffs.map((diff) => ({
        ...diff,
        category: diff.type === 'balance_mismatch' ? 'observed_balance_variance' : diff.category,
      })),
    };
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Returns reconciliation health for heartbeat inclusion */
  getHealth(): ReconcilerHealth {
    return {
      lastPassAt: this.lastPassAt,
      consecutiveNullPasses: this.consecutiveNullPasses,
      healthy: this.consecutiveNullPasses < Reconciler.NULL_PASS_ALERT_THRESHOLD,
    };
  }
}
