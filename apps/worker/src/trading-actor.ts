import pino from 'pino';
import type { Strategy, MarketSnapshot, OrderbookVenuePort, Subscription, SubscriptionState, PrivateStreamFill, PrivateStreamOrder, PrivateStreamPosition, SwapVenuePort, MarkSource } from '@herobids/domain';
import type { TradingInstanceId } from '@herobids/domain';
import type { InstanceActor } from './runtime.js';
import {
  PaperExecutor,
  ShadowExecutor,
  LiveExecutor,
  PollingMarketDataFeed,
  StreamMarketDataFeed,
  flatPosition,
  applyFill,
  fillEvent,
  Reconciler,
  createOrderbookVenueStateLoader,
  createSwapVenueStateLoader,
  runTradingCycle,
  realClock,
  credentialUsedEvent,
} from '@herobids/engine';
import type {
  Executor,
  Journal,
  PositionState,
  RiskLimits,
  IdGenerator,
  ReconcilerConfig,
  LocalState,
  MarketDataFeed,
  TickerSnapshot,
  StreamPoolHandle,
  Diff,
  TradingCyclePersistence,
} from '@herobids/engine';
import type {
  FillRepository,
  PositionRepository,
  ExecutionPlanRepository,
  OrderRepository,
  BalanceSnapshotRepository,
  ReconciliationEventRepository,
  DecisionRepository,
  BacktestingRepository,
} from '@herobids/db';
import { price, quantity, Decimal } from '@herobids/domain';

export interface StreamConfig {
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  maxReconnectAttempts: number;
}

export interface TradingActorDeps {
  strategy: Strategy;
  journal: Journal;
  fillRepo: FillRepository;
  positionRepo: PositionRepository;
  planRepo: ExecutionPlanRepository;
  orderRepo: OrderRepository;
  decisionRepo: DecisionRepository;
  backtestingRepo: BacktestingRepository;
  balanceSnapshotRepo: BalanceSnapshotRepository;
  reconciliationRepo: ReconciliationEventRepository;
  riskLimits: RiskLimits;
  idGen: IdGenerator & { planId(): string; decisionId(): string };
  /** Function to get current market price for the instrument */
  fetchPrice: () => Promise<MarketSnapshot | null>;
  /** Venue port for reconciliation and private streams */
  venuePort?: OrderbookVenuePort;
  /** Reconciliation config */
  reconciliationConfig?: ReconcilerConfig;
  /** Execution mode: paper (default), shadow, live */
  executionMode?: 'paper' | 'shadow' | 'live';
  /** Private stream config (reconnection parameters) */
  streamConfig?: StreamConfig;
  /** Polling interval for shadow market data feed (ms). Defaults to 2000. */
  shadowPollIntervalMs?: number;
  venue: string;
  symbol: string;
  venueAccountId: string;
  /** Venue type for planner order-type resolution */
  venueType?: 'orderbook' | 'swap';
  /** Explicit swap asset identifiers for routing (avoids fragile symbol parsing) */
  swapAssets?: { baseAsset: string; quoteAsset: string; baseDecimals: number; quoteDecimals: number };
  /** Optional swap venue port for shadow quote simulation */
  swapVenue?: SwapVenuePort;
  /** Worker-scoped public stream pool for real-time market data (Phase 2c) */
  streamPool?: StreamPoolHandle;
  /** Canonical mark source for P&L/risk valuation (Phase 2c §8.4) */
  markSource?: MarkSource;
  /** Optional live market-data recorder hook for replay corpora */
  recordMarketSnapshot?: (snapshot: MarketSnapshot) => Promise<void>;
  /** Optional reference-mark recorder hook for replay corpora */
  recordReferenceMark?: (mark: { symbol: string; price: string; source: string; timestamp: string }) => Promise<void>;
  /** Callback invoked when the actor crashes (e.g. max reconnect reached). Used to persist crashed status. */
  onCrashed?: (tradingInstanceId: string) => Promise<void>;
  /** Credential ID used by this actor (for audit trail). Set when credentials resolved from DB. */
  credentialId?: string;
}

/**
 * TradingActor — one per running trading instance.
 * Owns the scan loop timer, position state, and selects executor based on config.
 *
 * Lifecycle: start → rehydrate → venue-state reconciliation → open private stream → begin scan loop
 */
export class TradingActor implements InstanceActor {
  readonly tradingInstanceId: string;
  private readonly logger;
  private timer?: ReturnType<typeof setInterval>;
  private position: PositionState;
  private readonly executor: Executor;
  private readonly marketDataFeed?: MarketDataFeed;
  private reconciler?: Reconciler;
  private privateStream?: Subscription;
  private running = false;
  private paused = false;
  private stopping = false;
  /** Serializes async position mutations to prevent stale-read overwrites from concurrent fills */
  private positionMutex: Promise<void> = Promise.resolve();
  /** Cached mark result to avoid redundant oracle calls during fill bursts */
  private cachedMark: { result: Awaited<ReturnType<MarkSource['fetchMark']>>; fetchedAt: number } | undefined;

  constructor(
    tradingInstanceId: string,
    private readonly strategyConfig: Record<string, unknown>,
    private readonly deps: TradingActorDeps,
    private readonly scanIntervalMs: number = 5000,
  ) {
    this.tradingInstanceId = tradingInstanceId;
    this.logger = pino({ name: `actor-${tradingInstanceId}` });
    this.position = flatPosition(deps.venue, deps.symbol);

    // Executor selection based on execution mode
    const mode = deps.executionMode ?? 'paper';
    if (mode === 'live') {
      if (!deps.venuePort) {
        throw new Error('Live execution mode requires a venue port (OrderbookVenuePort).');
      }
      this.executor = new LiveExecutor({
        venuePort: deps.venuePort,
        idGen: deps.idGen,
        clientOrderId: (planId, idx) => `${tradingInstanceId}:${planId}:${idx}`,
      });
    } else if (mode === 'shadow' && (deps.venuePort || deps.swapVenue)) {
      // Prefer stream pool (Phase 2c) over polling (Phase 2b) for market data.
      // Only use stream pool for orderbook venues — swap venues have no registered
      // stream connector and their price discovery is via quotes, not WS streams.
      let feed: MarketDataFeed;
      if (deps.streamPool && deps.venueType !== 'swap') {
        feed = new StreamMarketDataFeed([deps.symbol], deps.venue, deps.streamPool, {
          onConnectError: (err) => {
            this.logger.warn({ err }, 'Stream pool subscribe failed — falling back to polling feed');
          },
          fallbackFetcher: async (symbol: string) => {
            if (!deps.venuePort) return null;
            const result = await deps.venuePort.fetchTicker(symbol);
            if (!result.ok) return null;
            return {
              symbol,
              last: result.data.last,
              bid: result.data.bid,
              ask: result.data.ask,
              timestamp: result.data.timestamp,
            };
          },
          fallbackIntervalMs: deps.shadowPollIntervalMs ?? 2000,
        });
      } else {
        feed = this.createPollingFeed();
      }
      this.marketDataFeed = feed;
      this.executor = new ShadowExecutor(deps.idGen, feed, deps.swapVenue);
    } else {
      this.executor = new PaperExecutor(deps.idGen);
    }
  }

  private createPollingFeed(): PollingMarketDataFeed {
    return new PollingMarketDataFeed(
      [this.deps.symbol],
      async (symbol: string): Promise<TickerSnapshot | null> => {
        // Orderbook venues: use ticker endpoint
        if (this.deps.venuePort) {
          const result = await this.deps.venuePort.fetchTicker(symbol);
          if (!result.ok) return null;
          return {
            symbol,
            last: result.data.last,
            bid: result.data.bid,
            ask: result.data.ask,
            timestamp: result.data.timestamp,
          };
        }
        // Swap venues: derive price from a 1-unit quote
        if (this.deps.swapVenue && this.deps.swapAssets) {
          const { baseAsset, quoteAsset } = this.deps.swapAssets;
          const quoteResult = await this.deps.swapVenue.quote({
            inputAsset: quoteAsset,
            outputAsset: baseAsset,
            amount: quantity('1'),
            slippageBps: 50,
          });
          if (quoteResult.ok) {
            const inAmt = new Decimal(quoteResult.data.inputAmount.toString());
            const outAmt = new Decimal(quoteResult.data.expectedOutputAmount.toString());
            const effectivePrice = inAmt.div(outAmt);
            return {
              symbol,
              last: effectivePrice,
              timestamp: new Date().toISOString(),
            };
          }
        }
        return null;
      },
      this.deps.shadowPollIntervalMs ?? 2000,
    );
  }

  /** Fetch mark with short-lived cache (5s) to avoid redundant oracle calls during fill bursts */
  private async fetchCachedMark() {
    if (!this.deps.markSource) return undefined;
    const now = Date.now();
    if (this.cachedMark && now - this.cachedMark.fetchedAt < 5_000) {
      return this.cachedMark.result;
    }
    const result = await this.deps.markSource.fetchMark(this.deps.symbol);
    this.cachedMark = { result, fetchedAt: now };
    return result;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Rehydrate position from DB before scanning
    await this.rehydratePosition();

    // Run initial reconciliation pass and start periodic loop (awaits first pass)
    await this.startReconciler();

    // Open private stream for real-time fill/order updates (shadow/live mode)
    await this.openPrivateStream();

    // Start market data feed if shadow mode
    this.marketDataFeed?.start();

    // Guard: if stop() was called during the async startup steps above, bail without arming the scan loop.
    if (!this.running) {
      this.marketDataFeed?.stop();
      return;
    }

    this.logger.info({ position: this.position.side, mode: this.deps.executionMode ?? 'paper' }, 'Actor started');
    // First tick immediately, then on interval
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.scanIntervalMs);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.reconciler) {
      this.reconciler.stop();
      this.reconciler = undefined;
    }
    // Close private stream gracefully
    if (this.privateStream) {
      await this.privateStream.unsubscribe();
      this.privateStream = undefined;
    }
    // Stop market data feed
    this.marketDataFeed?.stop();
    // Dispose shadow executor resources
    if (this.executor instanceof ShadowExecutor) {
      this.executor.dispose();
    }
    this.logger.info('Actor stopped');
  }

  /**
   * Crash the actor — stop trading and persist crashed status.
   * Called when unrecoverable errors occur (e.g. max reconnect attempts exhausted).
   */
  async crash(): Promise<void> {
    this.logger.error('Actor crashing — persisting crashed status');
    await this.stop();
    if (this.deps.onCrashed) {
      await this.deps.onCrashed(this.tradingInstanceId);
    }
  }

  /**
   * Load the last known position from DB and reconcile incomplete execution plans
   * so the actor resumes from the correct state after a crash or reassignment.
   *
   * Design contract (003-design-decisions.md §3.5):
   * - Positions rebuilt from DB
   * - Incomplete execution plans detected and reconciled
   * - No trading occurs until rehydration + reconciliation pass completes
   */
  private async rehydratePosition(): Promise<void> {
    try {
      // 1. Reconcile incomplete execution plans (write-ahead recovery)
      await this.reconcileIncompletePlans();

      // 2. Rebuild position state from DB
      const openPositions = await this.deps.positionRepo.getOpenByInstance(this.tradingInstanceId);
      // Find the position matching this actor's symbol
      const match = openPositions.find((p) => p.symbol === this.deps.symbol && p.venue === this.deps.venue);
      if (match && match.side !== 'flat') {
        this.position = {
          venue: match.venue,
          symbol: match.symbol,
          side: match.side as 'long' | 'short',
          size: new Decimal(match.size ?? '0'),
          entryPrice: new Decimal(match.entryPrice ?? '0'),
          realizedPnl: new Decimal(match.realizedPnl ?? '0'),
        };
        this.logger.info({ side: match.side, size: match.size, symbol: match.symbol }, 'Rehydrated position from DB');
      }
    } catch (err) {
      this.logger.error({ err }, 'Failed to rehydrate position — starting flat');
    }
  }

  /**
   * Detect execution plans that were in-flight when the previous worker died.
   * In paper mode: mark them as failed (paper fills are ephemeral — no venue to reconcile against).
   * In shadow/live mode: query venue for actual order/fill status and reconcile.
   */
  private async reconcileIncompletePlans(): Promise<void> {
    const incomplete = await this.deps.planRepo.getIncomplete(this.tradingInstanceId);
    if (incomplete.length === 0) return;

    this.logger.warn(
      { count: incomplete.length, planIds: incomplete.map((p) => p.id) },
      'Found incomplete execution plans from previous run — reconciling',
    );

    const mode = this.deps.executionMode ?? 'paper';
    const venuePort = this.deps.venuePort;

    // Fetch venue state once before the loop — bail early if unreachable
    let openOrdersData: Awaited<ReturnType<OrderbookVenuePort['fetchOpenOrders']>> | null = null;
    let recentFillsData: Awaited<ReturnType<OrderbookVenuePort['fetchRecentFills']>> | null = null;

    if (mode !== 'paper' && venuePort) {
      const [oor, rfr] = await Promise.all([
        venuePort.fetchOpenOrders(),
        venuePort.fetchRecentFills(),
      ]);
      openOrdersData = oor.ok ? oor : null;
      recentFillsData = rfr.ok ? rfr : null;

      if (!openOrdersData || !recentFillsData) {
        this.logger.warn('Could not fetch venue state for plan reconciliation — marking all incomplete plans failed');
        for (const plan of incomplete) {
          await this.deps.planRepo.markFailed(plan.id);
        }
        return;
      }
    }

    for (const plan of incomplete) {
      if (mode === 'paper' || !venuePort) {
        // Paper mode: no venue state to check — mark as failed
        await this.deps.planRepo.markFailed(plan.id);
        this.logger.info({ planId: plan.id, status: plan.status }, 'Marked incomplete plan as failed (paper mode)');
      } else {
        // Shadow/live mode: use pre-fetched venue state
        try {
          // Look up persisted orders for this plan (they carry venueRefId when submitted to venue)
          const planOrders = await this.deps.orderRepo.getByExecutionPlanId(plan.id);

          if (planOrders.length === 0) {
            // Plan was persisted write-ahead but orders never submitted — mark failed
            await this.deps.planRepo.markFailed(plan.id);
            this.logger.info({ planId: plan.id }, 'No orders were submitted for incomplete plan — marked failed');
            continue;
          }

          // Check if any of this plan's orders are still open on venue
          const openVenueOrderIds = new Set(openOrdersData!.data.map((o) => o.venueRefId));
          const hasOpenOrders = planOrders.some((o) => o.venueRefId && openVenueOrderIds.has(o.venueRefId));

          if (hasOpenOrders) {
            // Orders still open — keep as executing (will be resolved by normal reconciliation)
            this.logger.info({ planId: plan.id }, 'Plan has orders still open on venue — will be resolved by reconciliation');
          } else {
            // No open orders — check if fills exist for the plan's orders.
            // Match by fill.orderId (parent order ref on venue) against order.venueRefId,
            // since fill.venueRefId is the trade ID, not the order ID.
            const matchedFills = recentFillsData!.data.filter((f) =>
              planOrders.some((o) => o.venueRefId && (f.orderId === o.venueRefId || f.venueRefId === o.venueRefId)),
            );

            if (matchedFills.length > 0) {
              // Fills exist — mark completed
              await this.deps.planRepo.markCompleted(plan.id);
              this.logger.info({ planId: plan.id, fillCount: matchedFills.length }, 'Incomplete plan had fills on venue — marked completed');
            } else {
              // No open orders and no fills — mark failed
              await this.deps.planRepo.markFailed(plan.id);
              this.logger.info({ planId: plan.id }, 'No open orders or fills found on venue for incomplete plan — marked failed');
            }
          }
        } catch (err) {
          await this.deps.planRepo.markFailed(plan.id);
          this.logger.error({ err, planId: plan.id }, 'Error reconciling incomplete plan against venue');
        }
      }
    }
  }

  /**
   * Start the periodic reconciler if a venue port is provided.
   * Awaits the first reconciliation pass to ensure no trading occurs
   * until local == venue state is confirmed (or drift is within threshold).
   * Throws if drift is detected and driftAlertOnly is false.
   */
  private async startReconciler(): Promise<void> {
    if (!this.running) return;
    const { venuePort, reconciliationConfig, swapVenue } = this.deps;
    if ((!venuePort && !swapVenue) || !reconciliationConfig) return;

    // Build venue state loader based on venue type
    const fetchVenueState = venuePort
      ? createOrderbookVenueStateLoader(venuePort, this.logger)
      : createSwapVenueStateLoader(swapVenue!, this.logger);

    this.reconciler = new Reconciler(reconciliationConfig, {
      fetchVenueState,
      loadLocalState: () => this.loadLocalState(),
      persistResult: async (result, localState, venueState) => {
        // Serialize state snapshots for structured persistence
        const serializedLocal = {
          positions: localState.positions.map((p) => ({ symbol: p.symbol, side: p.side, size: p.size.toString(), entryPrice: p.entryPrice.toString() })),
          balances: localState.balances.map((b) => ({ asset: b.asset, total: b.total.toString() })),
          recentFills: localState.recentFills.map((f) => ({ venueRefId: f.venueRefId, symbol: f.symbol, side: f.side, quantity: f.quantity.toString(), price: f.price.toString(), filledAt: f.filledAt })),
          openOrders: localState.openOrders.map((o) => ({ venueRefId: o.venueRefId, symbol: o.symbol, side: o.side, type: o.type, status: o.status, quantity: o.quantity.toString(), price: o.price?.toString() })),
        };
        const serializedVenue = {
          positions: venueState.positions.map((p) => ({ symbol: p.symbol, side: p.side, size: p.size.toString(), entryPrice: p.entryPrice.toString() })),
          balances: venueState.balances.balances.map((b) => ({ asset: b.asset, free: b.free.toString(), locked: b.locked.toString(), total: b.total.toString() })),
          recentFills: venueState.recentFills.map((f) => ({ venueRefId: f.venueRefId, symbol: f.symbol, side: f.side, quantity: f.quantity.toString(), price: f.price.toString(), filledAt: f.filledAt })),
          openOrders: venueState.openOrders.map((o) => ({ venueRefId: o.venueRefId, symbol: o.symbol, side: o.side, type: o.type, status: o.status, quantity: o.quantity.toString(), price: o.price?.toString() })),
        };

        await this.deps.reconciliationRepo.insert({
          tradingInstanceId: this.tradingInstanceId,
          venueAccountId: this.deps.venueAccountId,
          result: result.status,
          localState: serializedLocal,
          venueState: serializedVenue,
          diff: result.diffs as unknown as Array<Record<string, unknown>>,
        });

        // Only promote venue balances to local baseline when reconciliation confirms
        // a match or when auto-correction was applied. Unconditionally overwriting
        // would hide external transfers after a single drift alert.
        if (result.status === 'match' || (result.status === 'drift_within_threshold' && reconciliationConfig.autoCorrect)) {
          const mark = await this.fetchCachedMark();
          await this.deps.balanceSnapshotRepo.insertSnapshot({
            venueAccountId: this.deps.venueAccountId,
            venue: this.deps.venue,
            balances: serializedVenue.balances,
            markSource: mark?.ok ? mark.data.source : undefined,
            snapshotAt: new Date(venueState.balances.timestamp),
          });
        }
      },
      journal: this.deps.journal,
      tradingInstanceId: this.tradingInstanceId,
      venueAccountId: this.deps.venueAccountId,
      logger: this.logger,
      getLastReconciledAt: () => this.deps.reconciliationRepo.getLastReconciledAtForInstance(this.tradingInstanceId),
    });

    // Run the first pass synchronously before starting ticks — no trading until reconciled
    // Seed initial balance snapshot on first boot to prevent false drift from empty local state
    const existingSnapshot = await this.deps.balanceSnapshotRepo.getLatestByVenueAccount(this.deps.venueAccountId, this.deps.venue);
    if (!existingSnapshot) {
      const initialVenueState = await fetchVenueState(null);
      if (initialVenueState) {
        const mark = await this.fetchCachedMark();
        await this.deps.balanceSnapshotRepo.insertSnapshot({
          venueAccountId: this.deps.venueAccountId,
          venue: this.deps.venue,
          balances: initialVenueState.balances.balances.map((b) => ({
            asset: b.asset,
            free: b.free.toString(),
            locked: b.locked.toString(),
            total: b.total.toString(),
          })),
          markSource: mark?.ok ? mark.data.source : undefined,
          snapshotAt: new Date(initialVenueState.balances.timestamp),
        });
      }
    }

    this.reconciler.start();
    // Await the first pass explicitly to block startup
    const result = await this.reconciler.runPass();

    // If the first pass returned null, venue state could not be confirmed — block trading
    if (result === null) {
      this.logger.error(
        'Reconciliation first pass inconclusive (venue fetch failed) — blocking trading',
      );
      throw new Error('Reconciliation first pass failed: venue state could not be confirmed. Trading blocked.');
    }

    // If drift is within acceptable threshold, apply correction if configured, then proceed
    if (result.status === 'drift_within_threshold') {
      if (reconciliationConfig.autoCorrect) {
        await this.applyDriftCorrection(result.diffs);
        this.logger.info(
          { diffCount: result.diffs.length },
          'Drift within threshold — auto-corrected local state to match venue',
        );
      } else {
        this.logger.info(
          { diffCount: result.diffs.length },
          'Drift within threshold — proceeding without correction',
        );
      }
      // Trading is allowed — drift is acceptable
      return;
    }

    // If drift is detected (exceeds threshold) and we are NOT in alert-only mode, block trading
    if (result.status === 'drift_detected' && !reconciliationConfig.driftAlertOnly) {
      this.logger.error(
        { diffCount: result.diffs.length, diffs: result.diffs },
        'Reconciliation drift detected on startup — blocking trading',
      );
      throw new Error(`Reconciliation drift detected: ${result.diffs.length} diff(s). Trading blocked.`);
    }
  }

  /**
   * Open a private WebSocket stream for real-time fill/order updates.
   * Only opens in shadow/live mode when a venue port is available.
   * If connection fails, throws to block startup (no trading until stream ready).
   * On disconnect: pauses scan loop, attempts reconnect, resumes on success.
   * On max reconnect failures: crashes the actor.
   */
  private async openPrivateStream(): Promise<void> {
    if (!this.running) return;
    const mode = this.deps.executionMode ?? 'paper';
    if (mode === 'paper' || !this.deps.venuePort) return;

    const result = await this.deps.venuePort.subscribePrivate({
      onFill: (fill) => {
        this.logger.info({ venueRefId: fill.venueRefId, symbol: fill.symbol, side: fill.side }, 'Private stream fill received');
        // Persist fill from private stream
        void this.persistPrivateStreamFill(fill);
      },
      onOrderUpdate: (order) => {
        this.logger.info({ venueRefId: order.venueRefId, status: order.status }, 'Private stream order update');
        // Persist order update from private stream
        void this.persistPrivateStreamOrder(order);
      },
      onPositionUpdate: (pos) => {
        this.logger.info({ symbol: pos.symbol, side: pos.side, size: pos.size }, 'Private stream position update');
        // Update in-memory position from private stream
        void this.persistPrivateStreamPosition(pos);
      },
      onError: (error) => {
        this.logger.error({ err: error.message }, 'Private stream error');
      },
    });

    if (!result.ok) {
      // Both shadow and live modes require the private stream for the no-trading-until-ready invariant
      throw new Error(`Private stream connection failed: ${result.error.message}. Trading blocked (${mode} mode).`);
    }

    this.privateStream = result.data;

    // Monitor connection state for pause/resume behavior
    this.privateStream.onStateChange((state: SubscriptionState) => {
      if (state === 'disconnected' || state === 'reconnecting') {
        if (!this.paused) {
          this.paused = true;
          this.logger.warn('Private stream disconnected — pausing scan loop');
          void this.deps.journal.append({
            tradingInstanceId: this.tradingInstanceId,
            type: 'stream.disconnect',
            payload: { state, venue: this.deps.venue, symbol: this.deps.symbol },
          }).catch((e: unknown) => this.logger.warn({ err: e }, 'Failed to append stream.disconnect journal event'));
        }
      } else if (state === 'connected') {
        if (this.paused) {
          this.paused = false;
          this.logger.info('Private stream reconnected — resuming scan loop');
        }
      } else if (state === 'closed') {
        // Only crash if this wasn't a graceful shutdown
        if (!this.stopping) {
          this.logger.error('Private stream closed (max reconnect attempts) — crashing actor');
          void this.deps.journal.append({
            tradingInstanceId: this.tradingInstanceId,
            type: 'instance.crashed',
            payload: { reason: 'max_reconnect_attempts_exhausted', venue: this.deps.venue, symbol: this.deps.symbol },
          }).catch((e: unknown) => this.logger.warn({ err: e }, 'Failed to append instance.crashed journal event'));
          void this.crash();
        }
      }
    });
  }

  /**
   * Load local state from DB for reconciliation comparison.
   * Reads positions, balances, recent fills, and open orders.
   */
  private async loadLocalState(): Promise<LocalState> {
    // Read per-instance cursor so sibling instances sharing a venue account don't skip each other's fills
    const lastReconciledAt = await this.deps.reconciliationRepo.getLastReconciledAtForInstance(this.tradingInstanceId);

    const [openPositions, recentFills, openOrders, balanceSnapshot] = await Promise.all([
      this.deps.positionRepo.getOpenByInstance(this.tradingInstanceId),
      // Fetch fills across ALL instances sharing this venue account so that venue fills
      // from sibling/predecessor instances are matched and not flagged as unknown_fill drift.
      this.deps.fillRepo.getRecentByVenueAccount(this.deps.venueAccountId, lastReconciledAt ?? undefined),
      this.deps.orderRepo.getOpenByInstance(this.tradingInstanceId),
      this.deps.balanceSnapshotRepo.getLatestByVenueAccount(this.deps.venueAccountId, this.deps.venue),
    ]);

    return {
      // Swap venues don't have directional positions on-venue. Including local
      // strategy positions here would cause permanent false drift because the
      // swap venue loader always returns an empty position set.
      positions: this.deps.venueType === 'swap' ? [] : openPositions
        .filter((p) => p.side !== 'flat')
        .map((p) => ({
          symbol: p.symbol,
          side: p.side as 'long' | 'short',
          size: new Decimal(p.size ?? '0'),
          entryPrice: new Decimal(p.entryPrice ?? '0'),
        })),
      balances: balanceSnapshot
        ? (balanceSnapshot.balances as Array<{ asset: string; total: string }>).map((b) => ({
            asset: b.asset,
            total: new Decimal(b.total),
          }))
        : [],
      recentFills: recentFills.map((f) => ({
        venueRefId: f.venueRefId ?? undefined,
        symbol: f.symbol,
        side: f.side as 'buy' | 'sell',
        quantity: new Decimal(f.quantity ?? '0'),
        price: new Decimal(f.price ?? '0'),
        filledAt: f.filledAt?.toISOString() ?? new Date().toISOString(),
      })),
      openOrders: openOrders.map((o) => ({
        venueRefId: o.venueRefId ?? undefined,
        symbol: o.symbol,
        side: o.side as 'buy' | 'sell',
        type: o.type,
        status: o.status,
        quantity: new Decimal(o.quantity ?? '0'),
        price: o.price ? new Decimal(o.price) : undefined,
      })),
    };
  }

  /**
   * Apply drift correction for acceptable diffs.
   * Syncs local state to match venue state for position/balance drifts within threshold.
   * This avoids the need for manual intervention when small rounding diffs accumulate.
   */
  private async applyDriftCorrection(diffs: Diff[]): Promise<void> {
    for (const diff of diffs) {
      if (diff.severity !== 'acceptable') continue;

      if (diff.type === 'position_mismatch' && diff.venue) {
        const venuePos = diff.venue as Record<string, unknown>;
        const side = typeof venuePos['side'] === 'string' ? venuePos['side'] : undefined;
        const size = typeof venuePos['size'] === 'string' ? venuePos['size'] : undefined;
        if (!side || !size) {
          this.logger.warn({ diff }, 'Cannot apply position drift correction — venue data missing side/size');
          continue;
        }
        // Update local position to match venue
        this.position = {
          venue: this.deps.venue,
          symbol: diff.symbol ?? this.deps.symbol,
          side: side as 'long' | 'short',
          size: new Decimal(size),
          entryPrice: this.position.entryPrice, // preserve — venue doesn't report this consistently
          realizedPnl: this.position.realizedPnl,
        };
        await this.deps.positionRepo.upsert({
          tradingInstanceId: this.tradingInstanceId,
          venueAccountId: this.deps.venueAccountId,
          venue: this.deps.venue,
          symbol: diff.symbol ?? this.deps.symbol,
          side,
          size,
          entryPrice: this.position.entryPrice.toString(),
          realizedPnl: this.position.realizedPnl.toString(),
        });
        const localPos = diff.local as Record<string, unknown> | null;
        this.logger.info({ symbol: diff.symbol, oldSize: localPos?.['size'], newSize: size }, 'Auto-corrected position size to venue value');
      }

      if (diff.type === 'balance_mismatch') {
        // Balance corrections are recorded via journal only — no local balance store to update
        // (balance_snapshots are read from venue; local tracking is informational)
        await this.deps.journal.append({
          tradingInstanceId: this.tradingInstanceId,
          type: 'reconciliation.correction',
          payload: {
            correctionType: 'balance',
            asset: diff.asset,
            localValue: diff.local,
            venueValue: diff.venue,
          },
        });
        this.logger.info({ asset: diff.asset, local: diff.local, venue: diff.venue }, 'Logged balance drift correction');
      }
    }
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    if (this.paused) return; // Private stream disconnected — skip tick
    try {
      // Resolve any pending shadow limit orders that were triggered by trade stream
      if (this.executor instanceof ShadowExecutor) {
        const resolvedFills = this.executor.resolvePendingLimits();
        for (const fill of resolvedFills) {
          this.position = applyFill(this.position, fill);
          await this.deps.journal.append(fillEvent(fill));
          await this.deps.fillRepo.insertFill({
            orderId: fill.orderId,
            tradingInstanceId: this.tradingInstanceId,
            venue: this.deps.venue,
            symbol: this.deps.symbol,
            side: fill.side,
            quantity: fill.quantity.toString(),
            price: fill.price.toString(),
            fee: fill.fee?.toString(),
            feeCurrency: fill.feeCurrency,
            filledAt: new Date(fill.filledAt),
          });
        }
        if (resolvedFills.length > 0) {
          // Mark the corresponding orders as filled and plans as completed
          for (const fill of resolvedFills) {
            await this.deps.orderRepo.upsertByVenueRefId({
              id: fill.orderId as unknown as string,
              tradingInstanceId: this.tradingInstanceId,
              venueRefId: `shadow-${fill.orderId}`,
              venue: this.deps.venue,
              symbol: this.deps.symbol,
              side: fill.side,
              type: 'limit',
              quantity: fill.quantity.toString(),
              price: fill.price.toString(),
              status: 'filled',
              filledQuantity: fill.quantity.toString(),
              avgFillPrice: fill.price.toString(),
            });
          }
          // In shadow mode each order belongs to exactly one plan; mark all executing plans
          // that have no remaining pending limits as completed
          const executingPlans = await this.deps.planRepo.getIncomplete(this.tradingInstanceId);
          for (const plan of executingPlans) {
            if (plan.status !== 'executing') continue;
            const planOrders = await this.deps.orderRepo.getByExecutionPlanId(plan.id);
            const allFilled = planOrders.length > 0 && planOrders.every((o) => o.status === 'filled');
            if (allFilled) {
              await this.deps.planRepo.markCompleted(plan.id);
            }
          }

          await this.deps.positionRepo.upsert({
            tradingInstanceId: this.tradingInstanceId,
            venueAccountId: this.deps.venueAccountId,
            venue: this.deps.venue,
            symbol: this.deps.symbol,
            side: this.position.side,
            size: this.position.size.toString(),
            entryPrice: this.position.entryPrice.toString(),
            realizedPnl: this.position.realizedPnl.toString(),
          });
          this.logger.info({ count: resolvedFills.length }, 'Resolved pending shadow limit fills');
        }
      }

      let snapshot = await this.deps.fetchPrice();
      // Swap venues have no orderbook ticker — derive snapshot from market data feed
      if (!snapshot && this.marketDataFeed) {
        const ticker = this.marketDataFeed.getTicker(this.deps.symbol);
        if (ticker) {
          snapshot = { symbol: this.deps.symbol, price: ticker.last, timestamp: ticker.timestamp };
        }
      }
      if (!snapshot) return;

      if (this.deps.recordMarketSnapshot) {
        try {
          await this.deps.recordMarketSnapshot(snapshot);
        } catch (err) {
          this.logger.warn({ err }, 'Failed to record live market snapshot');
        }
      }

      // Delegate the core decision/plan/risk/execute path to the reusable trading cycle
      // Live mode guard: skip tick if there are unresolved live plans to prevent overlapping real orders
      if (this.deps.executionMode === 'live') {
        const incompletePlans = await this.deps.planRepo.getIncomplete(this.tradingInstanceId);
        if (incompletePlans.length > 0) {
          // Attempt to resolve plans whose orders are all terminal (fallback for stream-before-persist race)
          let resolved = 0;
          for (const plan of incompletePlans) {
            if (plan.status !== 'executing') continue;
            const planOrders = await this.deps.orderRepo.getByExecutionPlanId(plan.id);
            if (planOrders.length > 0 && planOrders.every((o) => ['filled', 'cancelled', 'rejected'].includes(o.status))) {
              const anyFilled = planOrders.some((o) => o.status === 'filled');
              if (anyFilled) {
                await this.deps.planRepo.markCompleted(plan.id);
                this.logger.info({ planId: plan.id }, 'Completed live plan — all orders terminal');
              } else {
                await this.deps.planRepo.markFailed(plan.id);
                this.logger.info({ planId: plan.id }, 'Failed live plan — all orders cancelled/rejected, no fills');
              }
              resolved++;
            }
          }
          if (resolved < incompletePlans.length) {
            this.logger.debug({ count: incompletePlans.length - resolved }, 'Skipping tick — unresolved live plans');
            return;
          }
        }
      }

      const cycleResult = await runTradingCycle(snapshot, this.position, {
        tradingInstanceId: this.tradingInstanceId,
        venue: this.deps.venue,
        symbol: this.deps.symbol,
        venueAccountId: this.deps.venueAccountId,
        venueType: this.deps.venueType,
        swapAssets: this.deps.swapAssets,
        strategy: this.deps.strategy,
        strategyConfig: this.strategyConfig,
        executor: this.executor,
        journal: this.deps.journal,
        riskLimits: this.deps.riskLimits,
        markSource: this.deps.markSource,
        persistence: this.buildCyclePersistence(),
        idGen: this.deps.idGen,
        clock: realClock,
      });

      this.position = cycleResult.position;

      // Emit credential.used audit event for live order submissions
      if (cycleResult.decided && cycleResult.executionResult && this.deps.executionMode === 'live' && this.deps.credentialId) {
        // Only count orders that were actually submitted to the venue (market type).
        // Limit/swap orders are rejected locally by LiveExecutor without calling submitOrder.
        const submittedCount = cycleResult.executionResult.orders.filter((o) => o.type === 'market').length;
        if (submittedCount > 0) {
          this.deps.journal.append(credentialUsedEvent(this.tradingInstanceId, {
            credentialId: this.deps.credentialId,
            venue: this.deps.venue,
            venueAccountId: this.deps.venueAccountId,
            action: 'live_order_submit',
            ordersSubmitted: submittedCount,
          })).catch((err) => {
            this.logger.error({ err, credentialId: this.deps.credentialId, eventType: 'credential.used' }, 'Failed to persist credential audit event');
          });
        }
      }

      if (cycleResult.decided && cycleResult.executionResult) {
        this.logger.info(
          { intent: cycleResult.decision?.intent, fills: cycleResult.executionResult.fills.length, position: this.position.side },
          'Tick completed',
        );
      } else if (cycleResult.riskRejected) {
        this.logger.warn({ decision: cycleResult.decision?.intent }, 'Risk gate rejected');
      } else if (cycleResult.executionFailed) {
        this.logger.error({ decision: cycleResult.decision?.intent }, 'Execution failed');
        void this.deps.journal.append({
          tradingInstanceId: this.tradingInstanceId,
          type: 'execution.failure',
          payload: { intent: cycleResult.decision?.intent, planId: cycleResult.plan?.id },
        }).catch((e: unknown) => this.logger.warn({ err: e }, 'Failed to append execution.failure journal event'));
      }
    } catch (err) {
      this.logger.error({ err }, 'Tick error');
      void this.deps.journal.append({
        tradingInstanceId: this.tradingInstanceId,
        type: 'instance.tick_error',
        payload: { error: err instanceof Error ? err.message : String(err) },
      }).catch((e: unknown) => this.logger.warn({ err: e }, 'Failed to append instance.tick_error journal event'));
    }
  }

  /** Build persistence hooks that delegate to real DB repositories */
  private buildCyclePersistence(): TradingCyclePersistence {
    return {
      persistDecision: async (decision) => {
        await this.deps.decisionRepo.insertDecision({
          id: decision.id,
          tradingInstanceId: decision.tradingInstanceId,
          instrumentId: decision.instrumentId,
          intent: decision.intent,
          targetSize: decision.targetSize.toString(),
          limitPrice: decision.limitPrice?.toString(),
          contextHash: decision.contextHash,
          metadata: decision.metadata,
        });
      },
      persistDecisionContext: async (context) => {
        const latestBalanceSnapshot = await this.deps.balanceSnapshotRepo.getLatestByVenueAccount(
          this.deps.venueAccountId,
          this.deps.venue,
        );

        await this.deps.backtestingRepo.insertDecisionContext({
          decisionId: context.decisionId,
          tradingInstanceId: context.tradingInstanceId,
          contextHash: context.contextHash,
          context: {
            snapshot: context.snapshot,
            position: context.position,
            referenceMark: context.referenceMark,
            balanceSnapshot: latestBalanceSnapshot
              ? { balances: latestBalanceSnapshot.balances }
              : null,
            strategyParams: context.strategyParams,
          },
        });

        if (this.deps.recordReferenceMark) {
          try {
            await this.deps.recordReferenceMark({
              symbol: context.snapshot.symbol,
              price: context.referenceMark.price,
              source: context.referenceMark.source,
              timestamp: context.snapshot.timestamp,
            });
          } catch (err) {
            this.logger.warn({ err }, 'Failed to record reference mark');
          }
        }
      },
      persistPlan: async (plan) => {
        await this.deps.planRepo.insertPlan(plan);
      },
      markPlanExecuting: async (planId) => {
        await this.deps.planRepo.markExecuting(planId);
      },
      markPlanCompleted: async (planId) => {
        await this.deps.planRepo.markCompleted(planId);
      },
      markPlanFailed: async (planId) => {
        await this.deps.planRepo.markFailed(planId);
      },
      persistFill: async (fill) => {
        await this.deps.fillRepo.insertFill(fill);
      },
      persistPosition: async (pos) => {
        await this.deps.positionRepo.upsert(pos);
      },
      persistOrder: async (order) => {
        if (order.venueRefId) {
          await this.deps.orderRepo.upsertByVenueRefId({ ...order, venueRefId: order.venueRefId });
        }
      },
    };
  }

  /** Expose current position for read queries */
  get currentPosition(): PositionState {
    return this.position;
  }

  /**
   * Persist a fill received from the private stream.
   * Updates fill repo, position state, and journals the event.
   */
  private async persistPrivateStreamFill(fill: PrivateStreamFill): Promise<void> {
    // Only process fills for this actor's symbol — the private stream is account-scoped
    if (fill.symbol !== this.deps.symbol) {
      this.logger.debug({ fillSymbol: fill.symbol, actorSymbol: this.deps.symbol }, 'Ignoring fill for different symbol');
      return;
    }

    // Serialize position mutations to prevent stale-read overwrites from concurrent fills
    this.positionMutex = this.positionMutex.then(() => this.applyPrivateStreamFill(fill)).catch((err) => {
      this.logger.error({ err, venueRefId: fill.venueRefId }, 'Failed to persist private stream fill — crashing actor');
      void this.crash();
    });
    await this.positionMutex;
  }

  private async applyPrivateStreamFill(fill: PrivateStreamFill): Promise<void> {
    await this.deps.fillRepo.insertFill({
      orderId: fill.orderId,
      tradingInstanceId: this.tradingInstanceId,
      venueRefId: fill.venueRefId,
      venue: this.deps.venue,
      symbol: fill.symbol,
      side: fill.side,
      quantity: fill.quantity,
      price: fill.price,
      fee: fill.fee,
      feeCurrency: fill.feeCurrency,
      filledAt: new Date(fill.filledAt),
    });

    // Update in-memory position
    this.position = applyFill(this.position, {
      id: this.deps.idGen.fillId(),
      orderId: fill.orderId as unknown as import('@herobids/domain').OrderId,
      tradingInstanceId: this.tradingInstanceId as TradingInstanceId,
      venueRefId: fill.venueRefId,
      venue: this.deps.venue,
      symbol: fill.symbol,
      side: fill.side,
      quantity: quantity(fill.quantity),
      price: price(fill.price),
      fee: quantity(fill.fee || '0'),
      feeCurrency: fill.feeCurrency,
      filledAt: fill.filledAt,
    });

    // Persist updated position
    const markResult = await this.fetchCachedMark();
    await this.deps.positionRepo.upsert({
      tradingInstanceId: this.tradingInstanceId,
      venueAccountId: this.deps.venueAccountId,
      venue: this.deps.venue,
      symbol: this.deps.symbol,
      side: this.position.side,
      size: this.position.size.toString(),
      entryPrice: this.position.entryPrice.toString(),
      realizedPnl: this.position.realizedPnl.toString(),
      markSource: markResult?.ok ? markResult.data.source : undefined,
    });

    await this.deps.journal.append({
      tradingInstanceId: this.tradingInstanceId,
      type: 'fill.private_stream',
      payload: fill as unknown as Record<string, unknown>,
    });

    // After position is updated, check if the owning plan can be completed.
    // This is the safe trigger point for 'filled' orders — position already reflects the fill.
    if (this.deps.executionMode === 'live') {
      await this.tryCompleteLivePlan(fill.venueRefId ?? fill.orderId);
    }
  }

  /**
   * Persist an order update received from the private stream.
   * Updates order status in DB and journals the event.
   */
  private async persistPrivateStreamOrder(order: PrivateStreamOrder): Promise<void> {
    // Only process orders for this actor's symbol — the private stream is account-scoped
    if (order.symbol !== this.deps.symbol) {
      this.logger.debug({ orderSymbol: order.symbol, actorSymbol: this.deps.symbol }, 'Ignoring order update for different symbol');
      return;
    }

    try {
      await this.deps.orderRepo.upsertByVenueRefId({
        tradingInstanceId: this.tradingInstanceId,
        venueRefId: order.venueRefId,
        clientOrderId: order.clientOrderId,
        venue: this.deps.venue,
        symbol: order.symbol,
        side: order.side,
        type: order.type,
        quantity: order.quantity,
        price: order.price,
        status: order.status,
        filledQuantity: order.filledQuantity,
        avgFillPrice: order.avgFillPrice,
      });

      await this.deps.journal.append({
        tradingInstanceId: this.tradingInstanceId,
        type: 'order.private_stream',
        payload: order as unknown as Record<string, unknown>,
      });

      // In live mode, when an order is cancelled/rejected (no fill expected), check if the
      // owning plan's orders are all terminal. Do NOT trigger on 'filled' here — that path
      // is handled after the fill event updates the position, preventing the next tick from
      // trading against stale exposure.
      if (this.deps.executionMode === 'live' && ['cancelled', 'rejected'].includes(order.status)) {
        await this.tryCompleteLivePlan(order.venueRefId);
      }
    } catch (err) {
      this.logger.error({ err, venueRefId: order.venueRefId }, 'Failed to persist private stream order');
    }
  }

  /**
   * Attempt to mark the owning execution plan as completed/failed when all its orders are terminal.
   * Completed = at least one order filled. Failed = all cancelled/rejected (no fills).
   * Looks up the order's executionPlanId (may be null during stream-before-persist race;
   * in that case, the overlap guard's fallback handles completion on the next tick).
   */
  private async tryCompleteLivePlan(venueRefId: string): Promise<void> {
    try {
      const incompletePlans = await this.deps.planRepo.getIncomplete(this.tradingInstanceId);
      for (const plan of incompletePlans) {
        if (plan.status !== 'executing') continue;
        const orders = await this.deps.orderRepo.getByExecutionPlanId(plan.id);
        if (orders.length > 0 && orders.every((o) => ['filled', 'cancelled', 'rejected'].includes(o.status))) {
          const anyFilled = orders.some((o) => o.status === 'filled');
          if (anyFilled) {
            await this.deps.planRepo.markCompleted(plan.id);
            this.logger.info({ planId: plan.id }, 'Completed live plan via private stream — all orders terminal');
          } else {
            await this.deps.planRepo.markFailed(plan.id);
            this.logger.info({ planId: plan.id }, 'Failed live plan via private stream — all orders cancelled/rejected');
          }
        }
      }
    } catch (err) {
      this.logger.warn({ err, venueRefId }, 'Failed to check live plan completion after stream order update');
    }
  }

  /**
   * Update in-memory position from a private stream position update.
   * Also persists to DB for crash recovery.
   */
  private async persistPrivateStreamPosition(pos: PrivateStreamPosition): Promise<void> {
    // Only process positions for this actor's symbol
    if (pos.symbol !== this.deps.symbol) return;

    // Route through mutex to prevent races with concurrent fill application
    this.positionMutex = this.positionMutex.then(() => this.applyPrivateStreamPosition(pos)).catch((err) => {
      this.logger.error({ err, symbol: pos.symbol }, 'Failed to persist private stream position');
    });
    await this.positionMutex;
  }

  private async applyPrivateStreamPosition(pos: PrivateStreamPosition): Promise<void> {
    if (pos.side === 'flat') {
      this.position = flatPosition(this.deps.venue, this.deps.symbol);
    } else {
      this.position = {
        venue: this.deps.venue,
        symbol: pos.symbol,
        side: pos.side,
        size: new Decimal(pos.size),
        entryPrice: new Decimal(pos.entryPrice),
        realizedPnl: this.position.realizedPnl, // Preserve — stream doesn't always provide this
      };
    }

    const markResult = await this.fetchCachedMark();
    await this.deps.positionRepo.upsert({
      tradingInstanceId: this.tradingInstanceId,
      venueAccountId: this.deps.venueAccountId,
      venue: this.deps.venue,
      symbol: this.deps.symbol,
      side: this.position.side,
      size: this.position.size.toString(),
      entryPrice: this.position.entryPrice.toString(),
      realizedPnl: this.position.realizedPnl.toString(),
      markSource: markResult?.ok ? markResult.data.source : undefined,
    });
  }
}
