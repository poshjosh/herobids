import pino from 'pino';
import type { ContextSnapshotPayload, OrderbookVenuePort, SwapVenuePort, MarkSource, LiveRolloutConfig, Subscription, SubscriptionState, SwapTokenSafetyPort } from '@herobids/domain';
import { quantity, price, Decimal } from '@herobids/domain';
import type { ExecutionActor } from './execution-actor.js';
import type { VenueAdapterFactory } from './venue-adapter-factory.js';
import { assertLiveReadiness } from './live-gate.js';
import type { StreamConfig } from './trading-actor.js';
import {
  PaperExecutor,
  ShadowExecutor,
  LiveExecutor,
  PollingMarketDataFeed,
  StreamMarketDataFeed,
  applyFill,
  flatPosition,
  Reconciler,
  createOrderbookVenueStateLoader,
  createSwapVenueStateLoader,
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
  TradeHandler,
  StreamPoolHandle,
  TradingCyclePersistence,
  DecisionIntakeDeps,
  DecisionContext,
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

export interface AgentTradingActorDeps {
  agentId: string;
  executionMode: 'paper' | 'shadow' | 'live';
  venueAccountId: string;
  venue: string;
  venueType: 'orderbook' | 'swap';
  swapAssets?: { baseAsset: string; quoteAsset: string; baseDecimals: number; quoteDecimals: number };
  riskLimits: RiskLimits;
  venueAdapterFactory: VenueAdapterFactory;
  streamPool?: StreamPoolHandle;
  createStreamPoolHandle?: (testnet: boolean) => StreamPoolHandle | undefined;
  markSource: MarkSource;
  journal: Journal;
  idGen: IdGenerator & { planId(): string };
  positionRepo: PositionRepository;
  fillRepo: FillRepository;
  planRepo: ExecutionPlanRepository;
  orderRepo: OrderRepository;
  decisionRepo: DecisionRepository;
  balanceSnapshotRepo: BalanceSnapshotRepository;
  backtestingRepo: BacktestingRepository;
  reconciliationRepo: ReconciliationEventRepository;
  reconciliationConfig?: ReconcilerConfig;
  streamConfig?: StreamConfig;
  shadowPollIntervalMs?: number;
  shadowQuoteSlippageBps?: number;
  /** Operator live-rollout config for startup gate enforcement */
  liveRollout?: LiveRolloutConfig;
  /** Operator reconciliation.driftAlertOnly setting for live gate */
  driftAlertOnly?: boolean;
  /** Swap network identifier (e.g. 'solana', 'base') for token safety lookups */
  swapNetwork?: string;
  /** Base token address for swap token safety checks */
  swapBaseTokenAddress?: string;
  /** Swap token safety port for pre-execution guardrails */
  swapTokenSafety?: SwapTokenSafetyPort;
  /** Instance-level swap-token safety thresholds */
  swapTokenSafetyThresholds?: {
    minLiquidityUsd?: number;
    minVolume24hUsd?: number;
    minAgeHours?: number;
    allowOverrides?: boolean;
  };
  /** Callback invoked when the actor crashes after startup and can no longer trade safely. */
  onCrashed?: (err: Error) => Promise<void>;
  /** USD allocation cap — used as equity for %-based risk checks (maxPositionSizePct). */
  capital?: string;
}

/**
 * AgentTradingActor — long-lived, multi-instrument execution context for agent-direct trading.
 *
 * Implements ExecutionActor so it can be registered in the actorRegistry alongside bot TradingActors.
 * The intakeResolver automatically routes agent decisions here when it finds the actor in the registry.
 *
 * Lifecycle: start → resolve venue adapter → rehydrate positions → begin reconciler → ready
 * Stops: tear down venue infra, clear positions, deregister from registry.
 */
export class AgentTradingActor implements ExecutionActor {
  readonly agentId: string;
  private running = false;
  private paused = false;
  private readonly logger;
  private executor?: Executor;
  private venuePort?: OrderbookVenuePort;
  private swapVenue?: SwapVenuePort;
  private reconciler?: Reconciler;
  private credentialId?: string;
  private credentialsPresent = false;
  private privateStream?: Subscription;
  private streamPool?: StreamPoolHandle;
  private streamMutationQueue = Promise.resolve();

  /** Per-instrument market data feeds (created lazily on first trade) */
  private readonly instrumentFeeds = new Map<string, MarketDataFeed>();

  /** Per-instrument position tracking */
  private readonly positions = new Map<string, PositionState>();

  constructor(private readonly deps: AgentTradingActorDeps) {
    this.agentId = deps.agentId;
    this.logger = pino({ name: `agent-actor-${deps.agentId.slice(0, 8)}` });
    this.streamPool = deps.streamPool;
  }

  get isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;

    const { deps } = this;
    this.running = true;

    try {
      // Paper mode requires no venue adapter or credentials
      if (deps.executionMode === 'paper') {
        this.executor = new PaperExecutor(deps.idGen);
        await this.reconcileIncompletePlans();
        await this.rehydratePositions();
        this.logger.info({ mode: 'paper', venue: deps.venue, venueType: deps.venueType }, 'Agent trading actor started');
        return;
      }

      // Resolve venue adapter for shadow/live
      if (deps.venueType === 'orderbook') {
        const result = await deps.venueAdapterFactory.buildOrderbookAdapter({
          venueAccountId: deps.venueAccountId,
          venue: deps.venue,
          actorType: 'agent',
          actorId: deps.agentId,
          executionMode: deps.executionMode,
        });
        this.venuePort = result.venuePort;
        this.credentialId = result.credentialId;
        this.credentialsPresent = !!(result.credentials.apiKey.trim() && result.credentials.secret.trim());
        this.streamPool = deps.createStreamPoolHandle?.(result.credentials.testnet) ?? deps.streamPool;
      } else if (deps.venueType === 'swap') {
        if (!deps.swapAssets) {
          throw new Error(`Swap venue ${deps.venue} requires explicit swapAssets metadata for agent ${deps.agentId}`);
        }
        const result = await deps.venueAdapterFactory.buildSwapAdapter({
          venueAccountId: deps.venueAccountId,
          venue: deps.venue,
          swapAssets: deps.swapAssets,
          actorType: 'agent',
          actorId: deps.agentId,
        });
        this.swapVenue = result.swapVenue;
      }

      // Live-mode startup gate (fail-closed) — same check bots go through
      if (deps.liveRollout) {
        const liveGateResult = assertLiveReadiness(deps.liveRollout, {
          executionMode: deps.executionMode,
          venue: deps.venue,
          venueType: deps.venueType,
          venueAccountId: deps.venueAccountId,
          credentialsFromDb: !!this.credentialId,
          credentialsPresent: this.credentialsPresent,
          driftAlertOnly: deps.driftAlertOnly ?? false,
          instanceMaxOrderNotional: deps.riskLimits.maxOrderNotional?.toString(),
        });
        if (liveGateResult.effectiveMaxOrderNotional) {
          deps.riskLimits = { ...deps.riskLimits, maxOrderNotional: liveGateResult.effectiveMaxOrderNotional };
        }
      }

      if (deps.executionMode === 'live') {
        if (!this.venuePort) {
          throw new Error('Live execution mode requires a venue port (OrderbookVenuePort).');
        }
        this.executor = new LiveExecutor({
          venuePort: this.venuePort,
          idGen: deps.idGen,
          clientOrderId: (planId, idx) => `agent:${deps.agentId.slice(0, 8)}:${planId}:${idx}`,
        });
      } else if (this.venuePort || this.swapVenue) {
        this.executor = new ShadowExecutor(deps.idGen, this.createLazyShadowFeed(), this.swapVenue);
      } else {
        this.executor = new PaperExecutor(deps.idGen);
      }

      await this.reconcileIncompletePlans();
      await this.rehydratePositions();

      if (deps.reconciliationConfig) {
        await this.startReconciler();
      }

      await this.openPrivateStream();

      if (this.credentialId) {
        deps.journal.append(credentialUsedEvent(deps.agentId, {
          credentialId: this.credentialId,
          venue: deps.venue,
          venueAccountId: deps.venueAccountId,
          action: 'agent_trading_actor_start',
          ordersSubmitted: 0,
        })).catch((err) => this.logger.error({ err }, 'Failed to append credential-used audit event'));
      }

      this.logger.info({ mode: deps.executionMode, venue: deps.venue, venueType: deps.venueType }, 'Agent trading actor started');
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.reconciler) {
      this.reconciler.stop();
      this.reconciler = undefined;
    }

    if (this.privateStream) {
      await this.privateStream.unsubscribe();
      this.privateStream = undefined;
    }

    for (const feed of this.instrumentFeeds.values()) {
      feed.stop();
    }
    this.instrumentFeeds.clear();

    if (this.executor instanceof ShadowExecutor) {
      this.executor.dispose();
    }

    this.logger.info('Agent trading actor stopped');
  }

  private async crash(reason: Error): Promise<void> {
    if (!this.running) return;

    this.logger.error({ err: reason }, 'Agent trading actor crashing');
    await this.stop();

    if (this.deps.onCrashed) {
      await this.deps.onCrashed(reason);
    }
  }

  // --- ExecutionActor interface ---

  getIntakeDeps(instrumentId?: string): DecisionIntakeDeps | undefined {
    if (!this.running || this.paused || !this.executor || !instrumentId) return undefined;

    const swapDecisionMetadata = this.buildSwapDecisionMetadata(instrumentId);

    return {
      actorType: 'agent',
      actorId: this.agentId,
      venue: this.deps.venue,
      symbol: instrumentId,
      venueAccountId: this.deps.venueAccountId,
      venueType: this.deps.venueType,
      swapAssets: swapDecisionMetadata?.swapAssets,
      swapNetwork: this.deps.swapNetwork,
      swapBaseTokenAddress: swapDecisionMetadata?.swapBaseTokenAddress,
      executor: this.executor,
      journal: this.deps.journal,
      riskLimits: this.deps.riskLimits,
      markSource: this.deps.markSource,
      persistence: this.buildPersistence(instrumentId),
      idGen: { planId: () => this.deps.idGen.planId() },
      clock: realClock,
      swapTokenSafety: this.deps.swapTokenSafety,
      swapTokenSafetyThresholds: this.deps.swapTokenSafetyThresholds,
      openPositionCount: this.getOpenPositionCount(),
      equity: this.deps.capital ? price(this.deps.capital) : undefined,
    };
  }

  async getDecisionContext(instrumentId?: string): Promise<DecisionContext | undefined> {
    if (!instrumentId) return undefined;

    const markResult = await this.deps.markSource.fetchMark(instrumentId);
    if (!markResult.ok) {
      this.logger.warn({ instrumentId, error: markResult.error }, 'Failed to fetch mark for decision context');
      return undefined;
    }

    const position = this.getPosition(instrumentId);

    return {
      snapshot: {
        symbol: instrumentId,
        price: markResult.data.price.toString(),
        timestamp: markResult.data.timestamp,
      },
      position: position && position.side !== 'flat' ? {
        side: position.side,
        size: position.size.toString(),
        entryPrice: position.entryPrice.toString(),
        realizedPnl: position.realizedPnl.toString(),
      } : null,
      referenceMark: {
        price: markResult.data.price.toString(),
        source: markResult.data.source,
      },
      strategyParams: {},
    };
  }

  getPosition(instrumentId?: string): PositionState | undefined {
    if (!instrumentId) return undefined;
    return this.positions.get(instrumentId) ?? flatPosition(this.deps.venue, instrumentId);
  }

  /** Count of non-flat positions across all instruments */
  private getOpenPositionCount(): number {
    return this.positions.size;
  }

  get executionMode(): 'paper' | 'shadow' | 'live' {
    return this.deps.executionMode;
  }

  async buildReconnectSnapshot(): Promise<ContextSnapshotPayload | undefined> {
    const snapshots = await this.buildReconnectSnapshots();
    return snapshots[0];
  }

  /** Build reconnect snapshots for ALL tracked instruments (positions + feeds). */
  async buildReconnectSnapshots(): Promise<ContextSnapshotPayload[]> {
    const instrumentIds = this.getReconnectInstrumentIds();
    if (instrumentIds.length === 0) return [];

    const snapshots: ContextSnapshotPayload[] = [];
    for (const instrumentId of instrumentIds) {
      const position = this.getPosition(instrumentId);
      const markResult = await this.deps.markSource.fetchMark(instrumentId);

      // Even if mark fetch fails, emit a snapshot with position state so that
      // reconnect recovery does not silently drop an open instrument.
      const priceStr = markResult.ok ? markResult.data.price.toString() : '0';
      const timestamp = markResult.ok ? markResult.data.timestamp : new Date().toISOString();
      const referenceMark = markResult.ok
        ? { price: markResult.data.price.toString(), source: markResult.data.source }
        : { price: '0', source: 'unavailable' };

      // Compute per-instrument unrealized PnL when mark is available and position is open
      let pnl: string | undefined;
      if (markResult.ok && position && position.side !== 'flat') {
        const markPrice = parseFloat(markResult.data.price.toString());
        const entryPrice = parseFloat(position.entryPrice.toString());
        const size = parseFloat(position.size.toString());
        const direction = position.side === 'long' ? 1 : -1;
        const unrealizedPnl = (markPrice - entryPrice) * size * direction;
        if (Number.isFinite(unrealizedPnl)) {
          pnl = unrealizedPnl.toFixed(2);
        }
      }

      snapshots.push({
        snapshotId: crypto.randomUUID(),
        symbol: instrumentId,
        price: priceStr,
        timestamp,
        position: position && position.side !== 'flat' ? {
          side: position.side,
          size: position.size.toString(),
          entryPrice: position.entryPrice.toString(),
          realizedPnl: position.realizedPnl.toString(),
        } : null,
        pnl,
        referenceMark,
        strategyParams: {},
        executionMode: this.executionMode,
        guardrails: {},
      });
    }
    return snapshots;
  }

  // --- Private ---

  /** Collect all unique instrument IDs from open positions and active feeds. */
  private getReconnectInstrumentIds(): string[] {
    const ids = new Set<string>();
    for (const key of this.positions.keys()) ids.add(key);
    for (const key of this.instrumentFeeds.keys()) ids.add(key);
    return [...ids];
  }

  private buildSwapDecisionMetadata(instrumentId: string): {
    swapAssets?: { baseAsset: string; quoteAsset: string; baseDecimals?: number; quoteDecimals?: number };
    swapBaseTokenAddress?: string;
  } | undefined {
    if (this.deps.venueType !== 'swap') return undefined;

    if (this.deps.swapAssets) {
      return {
        swapAssets: this.deps.swapAssets,
        swapBaseTokenAddress: this.deps.swapBaseTokenAddress ?? this.deps.swapAssets.baseAsset,
      };
    }

    const [rawBaseAsset, rawQuoteAsset] = instrumentId.split('/');
    if (!rawBaseAsset || !rawQuoteAsset) {
      return {
        swapBaseTokenAddress: this.deps.swapBaseTokenAddress,
      };
    }

    const baseAsset = rawBaseAsset.split(':').at(-1) ?? rawBaseAsset;
    const quoteAsset = rawQuoteAsset.split(':')[0] ?? rawQuoteAsset;
    return {
      swapAssets: { baseAsset, quoteAsset },
      // Direct-agent swap decisions are instrument-scoped, so derive the base token
      // from the requested symbol when startup had no single canonical instrument.
      swapBaseTokenAddress: this.deps.swapBaseTokenAddress ?? baseAsset,
    };
  }

  /**
   * Open a private WebSocket stream for real-time fill/order/position updates.
   * Only opens for shadow/live mode when a venue port with subscribePrivate is available.
   * Throws on connection failure to block startup (consistent with bot actor pattern).
   */
  private async openPrivateStream(): Promise<void> {
    if (!this.venuePort) return;

    const result = await this.venuePort.subscribePrivate({
      onFill: (fill) => {
        this.logger.info({ venueRefId: fill.venueRefId, symbol: fill.symbol, side: fill.side }, 'Private stream fill received');
        this.enqueueStreamMutation(() => this.persistPrivateStreamFill(fill), fill.venueRefId ?? fill.orderId);
      },
      onOrderUpdate: (order) => {
        this.logger.info({ venueRefId: order.venueRefId, status: order.status }, 'Private stream order update');
        this.enqueueStreamMutation(() => this.persistPrivateStreamOrder(order), order.venueRefId ?? order.symbol);
      },
      onPositionUpdate: (pos) => {
        this.logger.info({ symbol: pos.symbol, side: pos.side, size: pos.size }, 'Private stream position update');
        this.enqueueStreamMutation(() => this.persistPrivateStreamPosition(pos), pos.symbol);
      },
      onError: (error) => {
        this.logger.error({ err: error.message }, 'Private stream error');
      },
    });

    if (!result.ok) {
      throw new Error(`Private stream connection failed: ${result.error.message}. Trading blocked (${this.deps.executionMode} mode).`);
    }

    this.privateStream = result.data;

    this.privateStream.onStateChange((state: SubscriptionState) => {
      if (state === 'disconnected' || state === 'reconnecting') {
        if (!this.paused) {
          this.paused = true;
          this.logger.warn('Private stream disconnected — pausing decision intake');
        }
      } else if (state === 'connected') {
        if (this.paused) {
          this.paused = false;
          this.logger.info('Private stream reconnected — resuming decision intake');
        }
      } else if (state === 'closed') {
        void this.crash(new Error('Private stream closed permanently'));
      }
    });
  }

  private enqueueStreamMutation(mutation: () => Promise<void>, context: string): void {
    this.streamMutationQueue = this.streamMutationQueue
      .then(async () => {
        if (!this.running) return;
        await mutation();
      })
      .catch(async (err) => {
        this.logger.error({ err, context }, 'Failed to apply private stream mutation — stopping actor');
        if (this.running) {
          const crashReason = err instanceof Error ? err : new Error(String(err));
          await this.crash(crashReason);
        }
      });
  }

  private async persistPrivateStreamFill(fill: {
    orderId: string;
    venueRefId?: string;
    symbol: string;
    side: 'buy' | 'sell';
    quantity: string;
    price: string;
    fee?: string;
    feeCurrency?: string;
    filledAt: string;
  }): Promise<void> {
    await this.deps.fillRepo.insertFill({
      orderId: fill.orderId,
      venueAccountId: this.deps.venueAccountId,
      actorType: 'agent',
      actorId: this.agentId,
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

    const currentPosition = this.positions.get(fill.symbol) ?? flatPosition(this.deps.venue, fill.symbol);
    const nextPosition = applyFill(currentPosition, {
      id: this.deps.idGen.fillId(),
      orderId: fill.orderId as unknown as import('@herobids/domain').OrderId,
      venueAccountId: this.deps.venueAccountId,
      actorType: 'agent',
      actorId: this.agentId,
      venueRefId: fill.venueRefId,
      venue: this.deps.venue,
      symbol: fill.symbol,
      side: fill.side,
      quantity: quantity(fill.quantity),
      price: price(fill.price),
      fee: fill.fee ? quantity(fill.fee) : undefined,
      feeCurrency: fill.feeCurrency,
      filledAt: fill.filledAt,
    });

    await this.persistPrivateStreamPositionState(nextPosition);

    // After position is updated, check if the owning plan can be completed.
    if (this.deps.executionMode === 'live') {
      await this.tryCompletePlans();
    }
  }

  private async persistPrivateStreamPosition(pos: {
    symbol: string;
    side: 'long' | 'short' | 'flat';
    size: string;
    entryPrice: string;
  }): Promise<void> {
    const existing = this.positions.get(pos.symbol);
    const nextPosition = pos.side === 'flat'
      ? flatPosition(this.deps.venue, pos.symbol)
      : {
          venue: this.deps.venue,
          symbol: pos.symbol,
          side: pos.side,
          size: new Decimal(pos.size),
          entryPrice: new Decimal(pos.entryPrice),
          realizedPnl: existing?.realizedPnl ?? new Decimal(0),
        };

    await this.persistPrivateStreamPositionState(nextPosition);
  }

  private async persistPrivateStreamOrder(order: {
    venueRefId?: string;
    symbol: string;
    side: 'buy' | 'sell';
    type: string;
    quantity: string;
    price?: string;
    status: string;
    filledQuantity: string;
    avgFillPrice?: string;
  }): Promise<void> {
    if (!order.venueRefId) return;

    await this.deps.orderRepo.upsertByVenueRefId({
      venueAccountId: this.deps.venueAccountId,
      actorType: 'agent',
      actorId: this.agentId,
      venueRefId: order.venueRefId,
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

    // In live mode, when an order is cancelled/rejected (no fill expected), check if the
    // owning plan's orders are all terminal so the plan can be marked complete/failed.
    if (this.deps.executionMode === 'live' && ['cancelled', 'rejected'].includes(order.status)) {
      await this.tryCompletePlans();
    }
  }

  private async persistPrivateStreamPositionState(position: PositionState): Promise<void> {
    if (position.side === 'flat') {
      this.positions.delete(position.symbol);
    } else {
      this.positions.set(position.symbol, position);
    }

    await this.deps.positionRepo.upsert({
      venueAccountId: this.deps.venueAccountId,
      actorType: 'agent',
      actorId: this.agentId,
      venue: position.venue,
      symbol: position.symbol,
      side: position.side,
      size: position.size.toString(),
      entryPrice: position.entryPrice.toString(),
      realizedPnl: position.realizedPnl.toString(),
    });
  }

  /**
   * Check all incomplete plans for this agent and mark them completed/failed
   * when all orders in the plan have reached terminal states.
   */
  private async tryCompletePlans(): Promise<void> {
    try {
      const incompletePlans = await this.deps.planRepo.getIncomplete('agent', this.agentId);
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
      this.logger.warn({ err }, 'Failed to check live plan completion after stream update');
    }
  }

  /**
   * Creates a lazy-delegating MarketDataFeed that creates real per-instrument feeds on demand.
   * The ShadowExecutor calls feed.getTicker(symbol) and feed.onTrade(symbol, handler);
   * this proxy ensures the underlying feed is subscribed to that symbol before forwarding.
   */
  private createLazyShadowFeed(): MarketDataFeed {
    return {
      getTicker: (symbol: string) => {
        const feed = this.ensureMarketDataFeed(symbol);
        return feed.getTicker(symbol);
      },
      onTrade: (symbol: string, handler: TradeHandler) => {
        const feed = this.ensureMarketDataFeed(symbol);
        return feed.onTrade(symbol, handler);
      },
      start: () => { /* no-op: per-instrument feeds auto-start */ },
      stop: () => {
        for (const feed of this.instrumentFeeds.values()) {
          feed.stop();
        }
      },
    };
  }

  /** Creates and starts a real market data feed for the given instrument if not already active */
  private ensureMarketDataFeed(symbol: string): MarketDataFeed {
    const existing = this.instrumentFeeds.get(symbol);
    if (existing) return existing;

    const { deps } = this;
    let feed: MarketDataFeed;

    if (this.streamPool && deps.venueType !== 'swap') {
      feed = new StreamMarketDataFeed([symbol], deps.venue, this.streamPool, {
        fallbackIntervalMs: deps.shadowPollIntervalMs ?? 2000,
      });
    } else {
      feed = new PollingMarketDataFeed(
        [symbol],
        async (s: string): Promise<TickerSnapshot | null> => {
          if (this.venuePort) {
            const result = await this.venuePort.fetchTicker(s);
            if (!result.ok) return null;
            return {
              symbol: s,
              last: result.data.last,
              bid: result.data.bid,
              ask: result.data.ask,
              timestamp: result.data.timestamp,
            };
          }
          if (this.swapVenue && deps.swapAssets) {
            const { baseAsset, quoteAsset } = deps.swapAssets;
            const quoteResult = await this.swapVenue.quote({
              inputAsset: quoteAsset,
              outputAsset: baseAsset,
              amount: quantity('1'),
              slippageBps: deps.shadowQuoteSlippageBps ?? 50,
            });
            if (quoteResult.ok) {
              const inAmt = new Decimal(quoteResult.data.inputAmount.toString());
              const outAmt = new Decimal(quoteResult.data.expectedOutputAmount.toString());
              const effectivePrice = inAmt.div(outAmt);
              return { symbol: s, last: effectivePrice, timestamp: new Date().toISOString() };
            }
          }
          return null;
        },
        deps.shadowPollIntervalMs ?? 2000,
      );
    }

    feed.start();
    this.instrumentFeeds.set(symbol, feed);
    this.logger.debug({ symbol }, 'Started market data feed for instrument');
    return feed;
  }

  /**
   * Detect execution plans that were in-flight when the previous worker died.
   * Paper mode: mark as failed (no venue to reconcile against).
   * Shadow/live with orderbook venue: query venue for order/fill status and reconcile.
   * Shadow/live without orderbook venue (swap): mark as failed with warning.
   */
  private async reconcileIncompletePlans(): Promise<void> {
    const incomplete = await this.deps.planRepo.getIncomplete('agent', this.agentId);
    if (incomplete.length === 0) return;

    this.logger.warn(
      { count: incomplete.length, planIds: incomplete.map((p) => p.id) },
      'Found incomplete execution plans from previous run — reconciling',
    );

    const mode = this.deps.executionMode;
    const venuePort = this.venuePort;

    if (mode === 'paper' || !venuePort) {
      // Paper mode or swap venues without order-query capability: mark all as failed
      for (const plan of incomplete) {
        await this.deps.planRepo.markFailed(plan.id);
      }
      if (mode !== 'paper') {
        this.logger.warn('No orderbook venue port for plan reconciliation — marked all incomplete plans failed');
      }
      return;
    }

    // Shadow/live with orderbook venue: fetch venue state once
    const [oor, rfr] = await Promise.all([
      venuePort.fetchOpenOrders(),
      venuePort.fetchRecentFills(),
    ]);

    if (!oor.ok || !rfr.ok) {
      this.logger.warn('Could not fetch venue state for plan reconciliation — marking all incomplete plans failed');
      for (const plan of incomplete) {
        await this.deps.planRepo.markFailed(plan.id);
      }
      return;
    }

    const openVenueOrderIds = new Set(oor.data.map((o) => o.venueRefId));

    for (const plan of incomplete) {
      try {
        const planOrders = await this.deps.orderRepo.getByExecutionPlanId(plan.id);

        if (planOrders.length === 0) {
          await this.deps.planRepo.markFailed(plan.id);
          this.logger.info({ planId: plan.id }, 'No orders were submitted for incomplete plan — marked failed');
          continue;
        }

        const hasOpenOrders = planOrders.some((o) => o.venueRefId && openVenueOrderIds.has(o.venueRefId));

        if (hasOpenOrders) {
          this.logger.info({ planId: plan.id }, 'Plan has orders still open on venue — will be resolved by reconciliation');
        } else {
          const matchedFills = rfr.data.filter((f) =>
            planOrders.some((o) => o.venueRefId && (f.orderId === o.venueRefId || f.venueRefId === o.venueRefId)),
          );

          if (matchedFills.length > 0) {
            await this.deps.planRepo.markCompleted(plan.id);
            this.logger.info({ planId: plan.id, fillCount: matchedFills.length }, 'Incomplete plan had fills on venue — marked completed');
          } else {
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

  private async rehydratePositions(): Promise<void> {
    try {
      const openPositions = await this.deps.positionRepo.getOpenByActorAndVenueAccount('agent', this.agentId, this.deps.venueAccountId);
      for (const pos of openPositions) {
        if (pos.side !== 'flat') {
          this.positions.set(pos.symbol, {
            venue: pos.venue,
            symbol: pos.symbol,
            side: pos.side as 'long' | 'short',
            size: new Decimal(pos.size ?? '0'),
            entryPrice: new Decimal(pos.entryPrice ?? '0'),
            realizedPnl: new Decimal(pos.realizedPnl ?? '0'),
          });
        }
      }
      if (this.positions.size > 0) {
        this.logger.info({ count: this.positions.size }, 'Rehydrated agent positions from DB');
      }
    } catch (err) {
      this.logger.error({ err }, 'Failed to rehydrate agent positions — starting flat');
    }
  }

  private async startReconciler(): Promise<void> {
    const { venuePort, reconciliationConfig } = { venuePort: this.venuePort, reconciliationConfig: this.deps.reconciliationConfig };
    if ((!venuePort && !this.swapVenue) || !reconciliationConfig) return;

    const fetchVenueState = venuePort
      ? createOrderbookVenueStateLoader(venuePort, this.logger)
      : createSwapVenueStateLoader(this.swapVenue!, this.logger);

    this.reconciler = new Reconciler(reconciliationConfig, {
      fetchVenueState,
      loadLocalState: async (): Promise<LocalState> => {
        const lastReconciledAt = await this.deps.reconciliationRepo.getLastReconciledAtForInstance(this.deps.venueAccountId);
        const [positions, recentFills, openOrders, balanceSnapshot] = await Promise.all([
          this.deps.positionRepo.getOpenByActorAndVenueAccount('agent', this.agentId, this.deps.venueAccountId),
          this.deps.fillRepo.getRecentByVenueAccount(this.deps.venueAccountId, lastReconciledAt ?? undefined),
          this.deps.orderRepo.getOpenByActorAndVenueAccount('agent', this.agentId, this.deps.venueAccountId),
          this.deps.balanceSnapshotRepo.getLatestByVenueAccount(this.deps.venueAccountId, this.deps.venue),
        ]);
        return {
          // Swap venues don't have directional positions on-venue. Including local
          // strategy positions would cause permanent false drift because the swap
          // venue loader always returns an empty position set.
          positions: this.deps.venueType === 'swap' ? [] : positions
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
            quantity: new Decimal(f.quantity),
            price: new Decimal(f.price),
            filledAt: f.filledAt instanceof Date ? f.filledAt.toISOString() : String(f.filledAt),
          })),
          openOrders: openOrders.map((o) => ({
            venueRefId: o.venueRefId ?? undefined,
            symbol: o.symbol,
            side: o.side as 'buy' | 'sell',
            type: o.type,
            status: o.status,
            quantity: new Decimal(o.quantity),
            price: o.price ? new Decimal(o.price) : undefined,
          })),
        };
      },
      persistResult: async (result, localState, venueState) => {
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
          venueAccountId: this.deps.venueAccountId,
          result: result.status,
          localState: serializedLocal,
          venueState: serializedVenue,
          diff: result.diffs as unknown as Array<Record<string, unknown>>,
        });

        // Promote venue balances to local baseline on successful reconciliation
        if (result.status === 'match' || (result.status === 'drift_within_threshold' && reconciliationConfig.autoCorrect)) {
          await this.deps.balanceSnapshotRepo.insertSnapshot({
            venueAccountId: this.deps.venueAccountId,
            venue: this.deps.venue,
            balances: serializedVenue.balances,
            snapshotAt: new Date(venueState.balances.timestamp),
          });
        }
      },
      journal: this.deps.journal,
      actorType: 'agent',
      actorId: this.agentId,
      venueAccountId: this.deps.venueAccountId,
      logger: this.logger,
      getLastReconciledAt: () => this.deps.reconciliationRepo.getLastReconciledAtForInstance(this.deps.venueAccountId),
    });

    // Seed initial balance snapshot on first boot to prevent false drift from empty local state
    const existingSnapshot = await this.deps.balanceSnapshotRepo.getLatestByVenueAccount(this.deps.venueAccountId, this.deps.venue);
    if (!existingSnapshot) {
      const initialVenueState = await fetchVenueState(null);
      if (initialVenueState) {
        await this.deps.balanceSnapshotRepo.insertSnapshot({
          venueAccountId: this.deps.venueAccountId,
          venue: this.deps.venue,
          balances: initialVenueState.balances.balances.map((b) => ({
            asset: b.asset,
            free: b.free.toString(),
            locked: b.locked.toString(),
            total: b.total.toString(),
          })),
          snapshotAt: new Date(initialVenueState.balances.timestamp),
        });
      }
    }

    this.reconciler.start();

    // Await the first pass explicitly to block startup
    const firstResult = await this.reconciler.runPass();

    // If the first pass returned null, venue state could not be confirmed — block trading
    if (firstResult === null) {
      this.reconciler.stop();
      this.logger.error('Reconciliation first pass inconclusive (venue fetch failed) — blocking trading');
      throw new Error('Reconciliation first pass failed: venue state could not be confirmed. Trading blocked.');
    }

    // If drift is within acceptable threshold, proceed (no auto-correction for multi-instrument agents)
    if (firstResult.status === 'drift_within_threshold') {
      this.logger.info(
        { diffCount: firstResult.diffs.length },
        'Drift within threshold — proceeding without correction',
      );
      return;
    }

    // If drift is detected (exceeds threshold) and we are NOT in alert-only mode, block trading
    if (firstResult.status === 'drift_detected' && !reconciliationConfig.driftAlertOnly) {
      this.reconciler.stop();
      this.logger.error(
        { diffCount: firstResult.diffs.length, diffs: firstResult.diffs },
        'Reconciliation drift detected on startup — blocking trading',
      );
      throw new Error(`Reconciliation drift detected: ${firstResult.diffs.length} diff(s). Trading blocked.`);
    }
  }

  private buildPersistence(_instrumentId: string): TradingCyclePersistence {
    return {
      persistDecision: async (decision) => {
        await this.deps.decisionRepo.insertDecision({
          id: decision.id,
          venueAccountId: decision.venueAccountId,
          instrumentId: decision.instrumentId,
          intent: decision.intent,
          targetSize: decision.targetSize.toString(),
          limitPrice: decision.limitPrice?.toString(),
          contextHash: decision.contextHash,
          actorType: decision.actorType,
          actorId: decision.actorId,
          metadata: decision.metadata,
        });
      },
      persistDecisionContext: async (context) => {
        await this.deps.backtestingRepo.insertDecisionContext({
          decisionId: context.decisionId,
          venueAccountId: this.deps.venueAccountId,
          contextHash: context.contextHash,
          context: {
            snapshot: context.snapshot,
            position: context.position,
            referenceMark: context.referenceMark,
            balanceSnapshot: null,
            strategyParams: context.strategyParams,
          },
        });
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
        await this.deps.fillRepo.insertFill({ ...fill, venueAccountId: fill.venueAccountId ?? this.deps.venueAccountId });
      },
      persistPosition: async (pos) => {
        await this.deps.positionRepo.upsert({
          ...pos,
          actorType: pos.actorType ?? 'agent',
          actorId: pos.actorId ?? this.agentId,
        });
        // Keep in-memory positions map in sync
        if (pos.side === 'flat') {
          this.positions.delete(pos.symbol);
        } else {
          this.positions.set(pos.symbol, {
            venue: pos.venue,
            symbol: pos.symbol,
            side: pos.side as 'long' | 'short',
            size: new Decimal(pos.size),
            entryPrice: new Decimal(pos.entryPrice),
            realizedPnl: new Decimal(pos.realizedPnl),
          });
        }
      },
      persistOrder: async (order) => {
        if (order.venueRefId) {
          await this.deps.orderRepo.upsertByVenueRefId({ ...order, venueRefId: order.venueRefId });
        }
      },
    };
  }
}
