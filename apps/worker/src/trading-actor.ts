import pino from 'pino';
import type { Strategy, MarketSnapshot, OrderbookVenuePort } from '@herobids/domain';
import type { TradingInstanceId } from '@herobids/domain';
import type { InstanceActor } from './runtime.js';
import {
  planDecision,
  PaperExecutor,
  flatPosition,
  applyFill,
  checkRisk,
  decisionEvent,
  planEvent,
  orderEvent,
  fillEvent,
  riskEvent,
  Reconciler,
} from '@herobids/engine';
import type {
  Journal,
  PositionState,
  RiskLimits,
  IdGenerator,
  PlannerDeps,
  ReconcilerConfig,
  LocalState,
} from '@herobids/engine';
import type {
  FillRepository,
  PositionRepository,
  ExecutionPlanRepository,
  OrderRepository,
  BalanceSnapshotRepository,
  ReconciliationEventRepository,
} from '@herobids/db';
import { price, Decimal } from '@herobids/domain';

export interface TradingActorDeps {
  strategy: Strategy;
  journal: Journal;
  fillRepo: FillRepository;
  positionRepo: PositionRepository;
  planRepo: ExecutionPlanRepository;
  orderRepo: OrderRepository;
  balanceSnapshotRepo: BalanceSnapshotRepository;
  reconciliationRepo: ReconciliationEventRepository;
  riskLimits: RiskLimits;
  idGen: IdGenerator & { planId(): string; decisionId(): string };
  /** Function to get current market price for the instrument */
  fetchPrice: () => Promise<MarketSnapshot | null>;
  /** Venue port for reconciliation (fetching venue state) */
  venuePort?: OrderbookVenuePort;
  /** Reconciliation config */
  reconciliationConfig?: ReconcilerConfig;
  venue: string;
  symbol: string;
  venueAccountId: string;
}

/**
 * TradingActor — one per running trading instance.
 * Owns the scan loop timer, position state, and executes in paper mode.
 */
export class TradingActor implements InstanceActor {
  readonly tradingInstanceId: string;
  private readonly logger;
  private timer?: ReturnType<typeof setInterval>;
  private position: PositionState;
  private readonly executor: PaperExecutor;
  private reconciler?: Reconciler;
  private running = false;

  constructor(
    tradingInstanceId: string,
    private readonly config: Record<string, unknown>,
    private readonly deps: TradingActorDeps,
    private readonly scanIntervalMs: number = 5000,
  ) {
    this.tradingInstanceId = tradingInstanceId;
    this.logger = pino({ name: `actor-${tradingInstanceId}` });
    this.position = flatPosition(deps.venue, deps.symbol);
    this.executor = new PaperExecutor(deps.idGen);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Rehydrate position from DB before scanning
    await this.rehydratePosition();

    // Run initial reconciliation pass and start periodic loop (awaits first pass)
    await this.startReconciler();

    this.logger.info({ position: this.position.side }, 'Actor started');
    // First tick immediately, then on interval
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.scanIntervalMs);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.reconciler) {
      this.reconciler.stop();
      this.reconciler = undefined;
    }
    this.logger.info('Actor stopped');
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
   * In live mode (future): would query venue for actual order/fill status and reconcile.
   */
  private async reconcileIncompletePlans(): Promise<void> {
    const incomplete = await this.deps.planRepo.getIncomplete(this.tradingInstanceId);
    if (incomplete.length === 0) return;

    this.logger.warn(
      { count: incomplete.length, planIds: incomplete.map((p) => p.id) },
      'Found incomplete execution plans from previous run — reconciling',
    );

    for (const plan of incomplete) {
      // Paper mode: no venue state to check — mark as failed (unresolvable without real venue)
      // In live mode, this would query the venue for order status and replay fills
      await this.deps.planRepo.markFailed(plan.id);
      this.logger.info({ planId: plan.id, status: plan.status }, 'Marked incomplete plan as failed');
    }
  }

  /**
   * Start the periodic reconciler if a venue port is provided.
   * Awaits the first reconciliation pass to ensure no trading occurs
   * until local == venue state is confirmed (or drift is logged).
   */
  private async startReconciler(): Promise<void> {
    const { venuePort, reconciliationConfig } = this.deps;
    if (!venuePort || !reconciliationConfig) return;

    this.reconciler = new Reconciler(reconciliationConfig, {
      venue: venuePort,
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
      },
      journal: this.deps.journal,
      tradingInstanceId: this.tradingInstanceId,
      venueAccountId: this.deps.venueAccountId,
      logger: this.logger,
    });

    // Run the first pass synchronously before starting ticks — no trading until reconciled
    this.reconciler.start();
    // Await the first pass explicitly to block startup
    await this.reconciler.runPass();
  }

  /**
   * Load local state from DB for reconciliation comparison.
   * Reads positions, balances, recent fills, and open orders.
   */
  private async loadLocalState(): Promise<LocalState> {
    // Read cursor for "since" filter on fills
    const lastReconciledAt = await this.deps.reconciliationRepo.getLastReconciledAt(this.deps.venueAccountId);

    const [openPositions, recentFills, openOrders, balanceSnapshot] = await Promise.all([
      this.deps.positionRepo.getOpenByInstance(this.tradingInstanceId),
      this.deps.fillRepo.getRecentByInstance(this.tradingInstanceId, lastReconciledAt ?? undefined),
      this.deps.orderRepo.getOpenByInstance(this.tradingInstanceId),
      this.deps.balanceSnapshotRepo.getLatestByVenueAccount(this.deps.venueAccountId),
    ]);

    return {
      positions: openPositions
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

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      const snapshot = await this.deps.fetchPrice();
      if (!snapshot) return;

      // 1. Evaluate strategy
      const evalResult = await this.deps.strategy.evaluate(snapshot, this.config);
      if (!evalResult.ok) {
        this.logger.warn({ err: evalResult.error }, 'Strategy evaluation failed');
        return;
      }

      const decision = evalResult.data;
      if (!decision) return; // Strategy has no opinion (hold)

      // Stamp the trading instance ID
      const stampedDecision = {
        ...decision,
        tradingInstanceId: this.tradingInstanceId as TradingInstanceId,
      };

      // 2. Journal the decision
      await this.deps.journal.append(decisionEvent(stampedDecision));

      // 3. Plan the execution
      const plannerDeps: PlannerDeps = {
        venue: this.deps.venue,
        symbol: this.deps.symbol,
        currentPosition: this.position.side === 'flat' ? null : {
          symbol: this.position.symbol,
          side: this.position.side,
          size: this.position.size,
          entryPrice: this.position.entryPrice,
        },
      };
      const plan = {
        ...planDecision(stampedDecision, plannerDeps),
        id: this.deps.idGen.planId(),
      };

      if (plan.orders.length === 0) return; // Nothing to do

      // Write-ahead: persist execution plan to DB BEFORE execution
      await this.deps.planRepo.insertPlan({
        id: plan.id,
        decisionId: stampedDecision.id ?? plan.decisionId,
        tradingInstanceId: this.tradingInstanceId,
        venue: this.deps.venue,
        symbol: this.deps.symbol,
        action: plan.action,
        plannedOrders: plan.orders.map((o) => ({
          side: o.side,
          type: o.type,
          quantity: o.quantity.toString(),
          price: o.price?.toString(),
        })),
      });

      await this.deps.journal.append(planEvent(plan, 'plan.created'));

      // 4. Risk check
      const riskResult = checkRisk(plan, this.deps.riskLimits, {
        currentPosition: this.position.side === 'flat' ? null : this.position,
        openPositionCount: this.position.side === 'flat' ? 0 : 1,
        currentDrawdown: price('0'), // TODO: compute from equity curve
      });

      if (!riskResult.ok) {
        await this.deps.journal.append(riskEvent(this.tradingInstanceId, riskResult.error));
        this.logger.warn({ code: riskResult.error.code }, 'Risk gate rejected');
        return;
      }

      // 5. Execute (paper mode)
      await this.deps.planRepo.markExecuting(plan.id);
      const execResult = await this.executor.execute(plan, snapshot.price);
      if (!execResult.ok) {
        await this.deps.planRepo.markFailed(plan.id);
        await this.deps.journal.append(planEvent(plan, 'plan.failed'));
        this.logger.error({ err: execResult.error }, 'Execution failed');
        return;
      }

      // 6. Record fills + update position
      for (const fill of execResult.data.fills) {
        this.position = applyFill(this.position, fill);
        await this.deps.journal.append(fillEvent(fill));

        // Persist fill to DB
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

      // Persist position state to DB
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

      // Mark plan completed in DB
      await this.deps.planRepo.markCompleted(plan.id);

      for (const order of execResult.data.orders) {
        await this.deps.journal.append(orderEvent(order));
      }
      await this.deps.journal.append(planEvent(execResult.data.plan, 'plan.completed'));

      this.logger.info(
        { intent: stampedDecision.intent, fills: execResult.data.fills.length, position: this.position.side },
        'Tick completed',
      );
    } catch (err) {
      this.logger.error({ err }, 'Tick error');
    }
  }

  /** Expose current position for read queries */
  get currentPosition(): PositionState {
    return this.position;
  }
}
