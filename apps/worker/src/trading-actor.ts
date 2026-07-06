import pino from 'pino';
import type { Strategy, MarketSnapshot, OrderbookVenuePort, Subscription, SubscriptionState, PrivateStreamFill, PrivateStreamOrder, PrivateStreamPosition, SwapVenuePort, MarkSource, SwapTokenSafetyPort, CandleFetcher } from '@herobids/domain';
import type { InstanceActor } from './runtime.js';
import type { ExecutionActor, IntakeResult } from './execution-actor.js';
import type { SwapConfirmationPoller } from '@herobids/venues';
import {
  PaperExecutor,
  ShadowExecutor,
  LiveExecutor,
  SwapLiveExecutor,
  SwapPositionTracker,
  PollingMarketDataFeed,
  StreamMarketDataFeed,
  flatPosition,
  unrealizedPnl,
  applyFillAccounting,
  fillEvent,
  Reconciler,
  createOrderbookVenueStateLoader,
  createSwapVenueStateLoader,
  realClock,
  credentialUsedEvent,
  EquityTracker,
  DailyLossTracker,
  VenueCircuitBreaker,
  checkStopLoss,
  rehydrateDailyLoss,
  computeSlippageBps,
  computeLiveTimeoutActions,
  evaluateOrderbookRecovery,
  executeDecision,
} from '@herobids/engine';
import type {
  Executor,
  Journal,
  JournalEventType,
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
  DecisionContext,
  LiveTimeoutPolicy,
  InstrumentExecutorDeps,
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
import type { DecisionId, InstrumentId, BotId, OrderId, VenueAccountId } from '@herobids/domain';

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
  /** Execution mode: paper, shadow, live */
  executionMode: 'paper' | 'shadow' | 'live';
  /** Private stream config (reconnection parameters) */
  streamConfig?: StreamConfig;
  /** Polling interval for shadow market data feed (ms). Defaults to 2000. */
  shadowPollIntervalMs?: number;
  /** Slippage used for shadow swap price quotes (bps). Defaults to 50. */
  shadowQuoteSlippageBps?: number;
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
  onCrashed?: (botId: string) => Promise<void>;
  /** Credential ID used by this actor (for audit trail). Set when credentials resolved from DB. */
  credentialId?: string;
  /** Swap token safety port for pre-execution guardrails */
  swapTokenSafety?: SwapTokenSafetyPort;
  /** Swap network identifier (e.g. 'solana', 'base') for token safety lookups */
  swapNetwork?: string;
  /** Base token address for swap token safety checks */
  swapBaseTokenAddress?: string;
  /** Instance-level swap-token thresholds that tighten operator defaults */
  swapTokenSafetyThresholds?: {
    minLiquidityUsd?: number;
    minVolume24hUsd?: number;
    minAgeHours?: number;
    allowOverrides?: boolean;
  };
  /** USD allocation cap — used as equity for %-based risk checks and risk tracking */
  capital?: string;
  /** Simulated fee configuration for paper/shadow fills */
  feeConfig?: { takerFeePct: number; makerFeePct: number; paperSlippageBps?: number };
  /** Max consecutive venue errors before circuit breaker trips */
  maxConsecutiveVenueErrors?: number;
  /** Live fill slippage alert threshold in bps */
  slippageAlertBps?: number;
  /** Fatal live crash policy */
  crashPolicy?: 'auto_go_flat' | 'alert_manual_intervention';
  /** Timeout policy for stale live order handling */
  liveOrderTimeoutPolicy?: LiveTimeoutPolicy;
  /** Venue-specific swap confirmation poller for authoritative on-chain tx status checks */
  swapConfirmationPoller?: SwapConfirmationPoller;
  /** Candle fetcher for OHLCV data (optional — used by mechanical/hybrid strategy phases) */
  candleFetcher?: CandleFetcher;
  /** Risk-config values forwarded to strategy via snapshot.data (mechanical/hybrid playbook guards) */
  riskPlaybook?: { maxNewPositionsPerDay?: number; avoidParabolicMovePct?: number };
  /** Consecutive strategy.config_invalid errors before auto-stop (from operator config) */
  botConfigInvalidHaltThreshold?: number;
  /** Consecutive strategy.execution_error errors before auto-stop (from operator config) */
  botExecutionErrorHaltThreshold?: number;
  /** Callback invoked when bot is halted due to exceeding strategy error thresholds */
  onHalted?: (botId: string) => Promise<void>;
}

interface StartupPendingLiveOrderSnapshot {
  orderId: string;
  status: string;
  submissionState?: string | null;
  venueRefId?: string | null;
  clientOrderId?: string | null;
  symbol?: string;
}

interface StartupPendingLivePlanSnapshot {
  planId: string;
  planStatus: string;
  orderCount: number;
  nonTerminalOrders: StartupPendingLiveOrderSnapshot[];
}

interface StartupPendingLiveSnapshot {
  capturedAt: string;
  plans: StartupPendingLivePlanSnapshot[];
}

/**
 * TradingActor — one per running trading instance.
 * Owns the scan loop timer, position state, and selects executor based on config.
 *
 * Lifecycle: start → rehydrate → venue-state reconciliation → open private stream → begin scan loop
 */
export class TradingActor implements InstanceActor, ExecutionActor {
  readonly botId: string;
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
  /** Most recent market snapshot — used to provide context to agent decision handler */
  private lastSnapshot: MarketSnapshot | null = null;
  /** Serializes async position mutations to prevent stale-read overwrites from concurrent fills */
  private positionMutex: Promise<void> = Promise.resolve();
  /** Cached mark result to avoid redundant oracle calls during fill bursts */
  private cachedMark: { result: Awaited<ReturnType<MarkSource['fetchMark']>>; fetchedAt: number } | undefined;
  /** Equity tracker (drawdown + dynamic equity) */
  private equityTracker?: EquityTracker;
  /** Rolling 24h loss tracker */
  private dailyLossTracker?: DailyLossTracker;
  /** Stop-loss exit timestamp for cooldown enforcement */
  private lastStopLossExitMs?: number;
  /** Venue error circuit breaker */
  private circuitBreaker?: VenueCircuitBreaker;
  /** Swap fill projection tracker for actor-local swap accounting (swap venues only) */
  private swapPositionTracker?: SwapPositionTracker;
  /** Deduplicates recovery-required timeout alerts per open order */
  private readonly timeoutRecoveryAlertedOrderIds = new Set<string>();
  /** Startup-only in-memory snapshot of pending live work before recovery decisions run */
  private startupPendingLiveSnapshot?: StartupPendingLiveSnapshot;
  /** True when swap live recovery entered an ambiguous state and requires manual intervention */
  private swapRecoveryHalted = false;
  private readonly swapRecoveryAlertedPlanIds = new Set<string>();
  /** In-memory counter of new positions opened today (resets on date change) */
  private newPositionsToday = 0;
  private newPositionsDate = '';
  /** Consecutive strategy error counter — reset on successful tick */
  private consecutiveStrategyErrors = 0;
  private lastStrategyErrorCode: string | null = null;

  constructor(
    botId: string,
    private readonly strategyConfig: Record<string, unknown>,
    private readonly deps: TradingActorDeps,
    private readonly scanIntervalMs: number = 5000,
  ) {
    this.botId = botId;
    this.logger = pino({ name: `actor-${botId}` });
    this.position = flatPosition(deps.venue, deps.symbol);

    // Executor selection based on execution mode
    const mode = deps.executionMode;
    if (mode === 'live') {
      if (deps.venueType === 'swap' && deps.swapVenue) {
        this.executor = new SwapLiveExecutor({
          swapVenue: deps.swapVenue,
          idGen: deps.idGen,
          clientOrderId: (planId, idx) => `${botId}:swap:${planId}:${idx}`,
          onOrderStateChange: async (order) => {
            const payload = {
              id: order.id as unknown as string,
              venueAccountId: order.venueAccountId,
              actorType: order.actorType,
              actorId: order.actorId,
              executionPlanId: order.executionPlanId,
              venueRefId: order.venueRefId,
              clientOrderId: order.clientOrderId,
              venue: order.venue,
              symbol: order.symbol,
              side: order.side,
              type: order.type,
              quantity: order.quantity.toString(),
              price: order.price?.toString(),
              referencePrice: order.referencePrice?.toString(),
              status: order.status,
              submissionState: order.submissionState,
              submitAttemptedAt: order.submitAttemptedAt,
              acknowledgedAt: order.acknowledgedAt,
              filledQuantity: order.filledQuantity.toString(),
              avgFillPrice: order.avgFillPrice?.toString(),
            };
            if (payload.venueRefId) {
              await this.deps.orderRepo.upsertByVenueRefId(payload);
            } else if (payload.clientOrderId) {
              await (this.deps.orderRepo as { upsertByClientOrderId?: (order: typeof payload) => Promise<void> })
                .upsertByClientOrderId?.(payload);
            }
          },
        });
      } else if (deps.venuePort) {
        this.executor = new LiveExecutor({
          venuePort: deps.venuePort,
          idGen: deps.idGen,
          clientOrderId: (planId, idx) => `${botId}:${planId}:${idx}`,
          onOrderStateChange: async (order) => {
            const payload = {
              id: order.id as unknown as string,
              venueAccountId: order.venueAccountId,
              actorType: order.actorType,
              actorId: order.actorId,
              executionPlanId: order.executionPlanId,
              venueRefId: order.venueRefId,
              clientOrderId: order.clientOrderId,
              venue: order.venue,
              symbol: order.symbol,
              side: order.side,
              type: order.type,
              quantity: order.quantity.toString(),
              price: order.price?.toString(),
              referencePrice: order.referencePrice?.toString(),
              status: order.status,
              submissionState: order.submissionState,
              submitAttemptedAt: order.submitAttemptedAt,
              acknowledgedAt: order.acknowledgedAt,
              filledQuantity: order.filledQuantity.toString(),
              avgFillPrice: order.avgFillPrice?.toString(),
            };
            if (payload.venueRefId) {
              await this.deps.orderRepo.upsertByVenueRefId(payload);
            } else if (payload.clientOrderId) {
              await (this.deps.orderRepo as { upsertByClientOrderId?: (order: typeof payload) => Promise<void> })
                .upsertByClientOrderId?.(payload);
            }
          },
        });
      } else {
        throw new Error('Live execution mode requires a venue port (OrderbookVenuePort) or swap venue.');
      }
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
      this.executor = new ShadowExecutor(deps.idGen, feed, deps.swapVenue, deps.feeConfig);
    } else {
      this.executor = new PaperExecutor(deps.idGen, undefined, deps.feeConfig);
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
            slippageBps: this.deps.shadowQuoteSlippageBps ?? 50,
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
    await this.initializeRiskTrackers();

    // Initialize the actor-local swap fill projection tracker (swap venues only)
    if (this.deps.venueType === 'swap') {
      this.swapPositionTracker = new SwapPositionTracker();
      await this.rehydrateSwapPositionTracker();
    }

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

    this.logger.info({ position: this.position.side, mode: this.deps.executionMode }, 'Actor started');
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

    const crashPolicy = this.deps.crashPolicy ?? 'alert_manual_intervention';
    let attemptedEmergencyGoFlat = false;
    let emergencyGoFlatSucceeded = false;
    let cancelledOpenOrders = 0;
    let crashRecoveryAmbiguous = false;
    let openSwapOrders = 0;
    let unresolvedSwapOrders = 0;

    if (this.deps.executionMode === 'live' && this.deps.venueType !== 'swap') {
      const crashOrderResult = await this.cancelOpenOrderbookOrdersOnCrash();
      cancelledOpenOrders = crashOrderResult.cancelledCount;
      crashRecoveryAmbiguous = crashOrderResult.ambiguous;
    } else if (this.deps.executionMode === 'live' && this.deps.venueType === 'swap') {
      const crashOrderResult = await this.assessSwapCrashAmbiguity();
      crashRecoveryAmbiguous = crashOrderResult.ambiguous;
      openSwapOrders = crashOrderResult.openSwapOrders;
      unresolvedSwapOrders = crashOrderResult.unresolvedSwapOrders;
    }

    if (this.deps.executionMode === 'live' && crashPolicy === 'auto_go_flat' && !crashRecoveryAmbiguous) {
      attemptedEmergencyGoFlat = true;
      emergencyGoFlatSucceeded = await this.tryEmergencyGoFlat();
    }

    await this.deps.journal.append({
      actorType: 'bot',
      actorId: this.botId,
      type: 'instance.crashed',
      payload: {
        reason: 'actor_crash',
        crashPolicy,
        attemptedEmergencyGoFlat,
        emergencyGoFlatSucceeded,
        cancelledOpenOrders,
        crashRecoveryAmbiguous,
        openSwapOrders,
        unresolvedSwapOrders,
        positionSide: this.position.side,
        symbol: this.deps.symbol,
      },
    }).catch((err: unknown) => {
      this.logger.warn({ err }, 'Failed to append instance.crashed journal event');
    });

    await this.stop();
    if (this.deps.onCrashed) {
      await this.deps.onCrashed(this.botId);
    }
  }

  private async cancelOpenOrderbookOrdersOnCrash(): Promise<{ cancelledCount: number; ambiguous: boolean }> {
    if (!this.deps.venuePort) {
      return { cancelledCount: 0, ambiguous: true };
    }

    const openOrders = await this.deps.orderRepo.getOpenByInstance(this.botId);
    if (openOrders.length === 0) {
      return { cancelledCount: 0, ambiguous: false };
    }

    let cancelledCount = 0;
    let ambiguous = false;
    for (const order of openOrders) {
      if (!order.venueRefId) {
        ambiguous = true;
        continue;
      }

      const cancelResult = await this.deps.venuePort.cancelOrder({
        orderId: order.venueRefId as unknown as OrderId,
        symbol: order.symbol,
      });
      if (!cancelResult.ok) {
        ambiguous = true;
        continue;
      }

      await this.deps.orderRepo.upsertByVenueRefId({
        id: order.id,
        venueAccountId: order.venueAccountId,
        actorType: order.actorType,
        actorId: order.actorId ?? undefined,
        executionPlanId: order.executionPlanId ?? undefined,
        venueRefId: order.venueRefId,
        clientOrderId: order.clientOrderId ?? undefined,
        venue: order.venue,
        symbol: order.symbol,
        side: order.side,
        type: order.type,
        quantity: order.quantity,
        price: order.price ?? undefined,
        referencePrice: order.referencePrice ?? undefined,
        status: 'cancelled',
        submissionState: 'terminal',
        submitAttemptedAt: order.submitAttemptedAt?.toISOString(),
        acknowledgedAt: order.acknowledgedAt?.toISOString(),
        filledQuantity: order.filledQuantity,
        avgFillPrice: order.avgFillPrice ?? undefined,
      });
      cancelledCount++;
    }

    return { cancelledCount, ambiguous };
  }

  private async assessSwapCrashAmbiguity(): Promise<{ ambiguous: boolean; openSwapOrders: number; unresolvedSwapOrders: number }> {
    const openOrders = await this.deps.orderRepo.getOpenByInstance(this.botId);
    if (openOrders.length === 0) {
      return { ambiguous: false, openSwapOrders: 0, unresolvedSwapOrders: 0 };
    }

    if (!this.deps.swapVenue) {
      return { ambiguous: true, openSwapOrders: openOrders.length, unresolvedSwapOrders: openOrders.length };
    }

    const txResult = await this.deps.swapVenue.fetchRecentTransactions();
    if (!txResult.ok) {
      await this.deps.journal.append({
        actorType: 'bot',
        actorId: this.botId,
        type: 'execution.failure',
        payload: {
          reason: 'live_swap_crash_recovery_ambiguous',
          code: txResult.error.code,
          message: txResult.error.message,
          openSwapOrders: openOrders.length,
        },
      });
      return { ambiguous: true, openSwapOrders: openOrders.length, unresolvedSwapOrders: openOrders.length };
    }

    const knownTxRefs = new Set(txResult.data.map((tx) => tx.executionRef));
    const unresolvedSwapOrders = openOrders.filter((order) => !order.venueRefId || !knownTxRefs.has(order.venueRefId)).length;
    if (unresolvedSwapOrders > 0) {
      await this.deps.journal.append({
        actorType: 'bot',
        actorId: this.botId,
        type: 'execution.failure',
        payload: {
          reason: 'live_swap_crash_recovery_ambiguous',
          openSwapOrders: openOrders.length,
          unresolvedSwapOrders,
        },
      });
    }

    return {
      ambiguous: unresolvedSwapOrders > 0,
      openSwapOrders: openOrders.length,
      unresolvedSwapOrders,
    };
  }

  private async tryEmergencyGoFlat(): Promise<boolean> {
    if (this.position.side === 'flat') return true;

    let context = this.getDecisionContext();
    if (!context) {
      const snapshot = await this.deps.fetchPrice();
      if (snapshot) {
        this.lastSnapshot = snapshot;
        context = this.getDecisionContext();
      }
    }
    if (!context) {
      this.logger.error('Crash policy auto_go_flat could not build decision context');
      return false;
    }

    const decisionId = this.deps.idGen.decisionId() as DecisionId;
    const decision = {
      id: decisionId,
      venueAccountId: this.deps.venueAccountId as unknown as VenueAccountId,
      instrumentId: this.deps.symbol as InstrumentId,
      intent: 'go_flat' as const,
      targetSize: quantity('0'),
      timestamp: new Date().toISOString(),
      actorType: 'bot' as const,
      actorId: this.botId,
      botId: this.botId as BotId,
      metadata: { trigger: 'crash_policy_auto_go_flat' },
    };

    try {
      const execResult = await executeDecision(decision, this.position, {
        ...this.buildInstrumentExecutorDeps(context.snapshot.price),
        executor: this.executor,
        persistence: this.buildCyclePersistence(),
        markSource: this.deps.markSource,
        swapAssets: this.deps.swapAssets,
        swapNetwork: this.deps.swapNetwork,
        swapBaseTokenAddress: this.deps.swapBaseTokenAddress,
        swapTokenSafety: this.deps.swapTokenSafety,
        swapTokenSafetyThresholds: this.deps.swapTokenSafetyThresholds,
        swapPositionTracker: this.swapPositionTracker,
        lastStopLossExitMs: this.lastStopLossExitMs,
      });
      this.position = execResult.newPosition;
      return !execResult.error && execResult.newPosition.side === 'flat';
    } catch (err) {
      this.logger.error({ err }, 'Crash policy auto_go_flat failed');
      return false;
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
      // 1. Capture startup pending live work in memory (no recovery mutation)
      await this.captureStartupPendingLiveSnapshot();

      // 2. Reconcile incomplete execution plans (write-ahead recovery)
      await this.reconcileIncompletePlans();

      // 3. Rebuild position state from DB
      const openPositions = await this.deps.positionRepo.getOpenByInstance(this.botId);
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

  private async captureStartupPendingLiveSnapshot(): Promise<void> {
    const mode = this.deps.executionMode;
    if (mode !== 'live') {
      this.startupPendingLiveSnapshot = undefined;
      return;
    }

    const incompletePlans = await this.deps.planRepo.getIncomplete('bot', this.botId);
    const plans: StartupPendingLivePlanSnapshot[] = [];

    for (const plan of incompletePlans) {
      const orders = await this.deps.orderRepo.getByExecutionPlanId(plan.id);
      const nonTerminalOrders = orders
        .filter((order) => !['filled', 'cancelled', 'rejected'].includes(order.status))
        .map((order) => ({
          orderId: order.id,
          status: order.status,
          submissionState: order.submissionState,
          venueRefId: order.venueRefId ?? null,
          clientOrderId: order.clientOrderId ?? null,
          symbol: order.symbol,
        }));

      plans.push({
        planId: plan.id,
        planStatus: plan.status,
        orderCount: orders.length,
        nonTerminalOrders,
      });
    }

    this.startupPendingLiveSnapshot = {
      capturedAt: new Date().toISOString(),
      plans,
    };

    const nonTerminalOrderCount = this.startupPendingLiveSnapshot.plans
      .reduce((sum, plan) => sum + plan.nonTerminalOrders.length, 0);
    this.logger.info({
      planCount: plans.length,
      nonTerminalOrderCount,
    }, 'Captured startup pending live snapshot before recovery reconciliation');
  }

  /** Replay historical fills into the swap tracker to rebuild fill projections on restart. */
  private async rehydrateSwapPositionTracker(): Promise<void> {
    if (!this.swapPositionTracker || !this.deps.swapAssets) return;
    try {
      const fills = await this.deps.fillRepo.getRecentByActorAndVenueAccount(
        'bot',
        this.botId,
        this.deps.venueAccountId,
      );
      const sorted = [...fills].sort((a, b) =>
        new Date(a.filledAt).getTime() - new Date(b.filledAt).getTime(),
      );
      for (const fill of sorted) {
        const isBuy = fill.side === 'buy';
        const fillQty = quantity(fill.quantity ?? '0');
        const fillPrice = price(fill.price ?? '0');
        this.swapPositionTracker.recordSwapFill({
          inputAsset: isBuy ? this.deps.swapAssets.quoteAsset : this.deps.swapAssets.baseAsset,
          inputAmount: isBuy ? fillPrice.mul(fillQty) : fillQty,
          outputAsset: isBuy ? this.deps.swapAssets.baseAsset : this.deps.swapAssets.quoteAsset,
          outputAmount: isBuy ? fillQty : fillPrice.mul(fillQty),
          timestamp: new Date(fill.filledAt).getTime(),
        });
      }
      if (sorted.length > 0) {
        this.logger.info({ fillCount: sorted.length }, 'Rehydrated swap fill projection tracker from historical fills');
      }
    } catch (err) {
      this.logger.warn({ err }, 'Failed to rehydrate swap position tracker — starting with empty holdings');
    }
  }

  private async initializeRiskTrackers(): Promise<void> {
    const capital = this.deps.capital ? price(this.deps.capital) : price('0');
    this.dailyLossTracker = new DailyLossTracker();
    if (this.deps.maxConsecutiveVenueErrors) {
      this.circuitBreaker = new VenueCircuitBreaker(this.deps.maxConsecutiveVenueErrors);
    }

    // Rehydrate fee-adjusted realized P&L from fills for equity tracker
    let economicRealizedPnl = price('0');
    try {
      const total = await this.deps.fillRepo.sumRealizedPnlDelta('bot', this.botId);
      economicRealizedPnl = price(total);
    } catch (err) {
      this.logger.warn({ err }, 'Failed to rehydrate economic realized P&L — falling back to position.realizedPnl');
      economicRealizedPnl = this.position.realizedPnl;
    }
    this.equityTracker = new EquityTracker(capital, economicRealizedPnl);

    // Rehydrate rolling 24h losses from persisted fills
    try {
      const since = new Date(Date.now() - 86_400_000);
      const fills = await this.deps.fillRepo.getRecentByInstance(this.botId, since);
      if (fills.length > 0) {
        // Replay oldest-first
        const sorted = [...fills].sort((a, b) => a.filledAt.getTime() - b.filledAt.getTime());
        rehydrateDailyLoss(sorted, this.dailyLossTracker);
      }
    } catch (err) {
      this.logger.warn({ err }, 'Failed to rehydrate daily loss tracker — starting fresh');
    }
  }

  /** Force a go_flat decision via the decision intake pipeline when stop-loss triggers */
  private async executeStopLoss(_snapshot: MarketSnapshot): Promise<void> {
    const decisionId = this.deps.idGen.decisionId() as DecisionId;
    const decision = {
      id: decisionId,
      venueAccountId: this.deps.venueAccountId as unknown as VenueAccountId,
      instrumentId: this.deps.symbol as InstrumentId,
      intent: 'go_flat' as const,
      targetSize: quantity('0'),
      timestamp: new Date().toISOString(),
      actorType: 'bot' as const,
      actorId: this.botId,
      botId: this.botId as BotId,
      metadata: { trigger: 'stop_loss' },
    };
    const context = this.getDecisionContext();
    if (!context) return;

    try {
      const execResult = await executeDecision(decision, this.position, {
        ...this.buildInstrumentExecutorDeps(context.snapshot.price),
        executor: this.executor,
        persistence: this.buildCyclePersistence(),
        markSource: this.deps.markSource,
        swapAssets: this.deps.swapAssets,
        swapNetwork: this.deps.swapNetwork,
        swapBaseTokenAddress: this.deps.swapBaseTokenAddress,
        swapTokenSafety: this.deps.swapTokenSafety,
        swapTokenSafetyThresholds: this.deps.swapTokenSafetyThresholds,
        swapPositionTracker: this.swapPositionTracker,
        lastStopLossExitMs: this.lastStopLossExitMs,
      });
      this.position = execResult.newPosition;

      if (!execResult.error && execResult.newPosition.side === 'flat') {
        this.lastStopLossExitMs = Date.now();
        void this.deps.journal.append({
          actorType: 'bot',
          actorId: this.botId,
          type: 'stop_loss.exit' as JournalEventType,
          payload: { instrument: this.deps.symbol, timestamp: this.lastStopLossExitMs },
        }).catch((e: unknown) => this.logger.warn({ err: e }, 'Failed to append stop_loss.exit journal event'));
      }
    } catch (err) {
      this.logger.error({ err }, 'Failed to execute stop-loss go_flat');
    }
  }

  /**
   * Detect execution plans that were in-flight when the previous worker died.
   * In paper mode: mark them as failed (paper fills are ephemeral — no venue to reconcile against).
   * In shadow/live mode: query venue for actual order/fill status and reconcile.
   */
  private async reconcileIncompletePlans(): Promise<void> {
    const incomplete = await this.deps.planRepo.getIncomplete('bot', this.botId);
    if (incomplete.length === 0) return;

    this.logger.warn(
      { count: incomplete.length, planIds: incomplete.map((p) => p.id) },
      'Found incomplete execution plans from previous run — reconciling',
    );

    const mode = this.deps.executionMode;
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
      if (mode === 'paper') {
        // Paper mode: no venue state to check — mark as failed
        await this.deps.planRepo.markFailed(plan.id);
        this.logger.info({ planId: plan.id, status: plan.status }, 'Marked incomplete plan as failed (paper mode)');
      } else if (!venuePort && this.deps.swapVenue) {
        // Swap venue: check on-chain transactions using confirmation poller (primary) or fetchRecentTransactions (fallback)
        try {
          const planOrders = await this.deps.orderRepo.getByExecutionPlanId(plan.id);
          const txResult = await this.deps.swapVenue.fetchRecentTransactions();

          if (planOrders.length === 0) {
            // No order rows persisted — crash may have occurred after on-chain confirmation
            // but before persistOrder. Check recent transactions for a match.
            if (txResult.ok) {
              const matchedTx = this.matchPlanToRecentSwapTransactions(plan, txResult.data);
              if (matchedTx) {
                await this.deps.planRepo.markCompleted(plan.id);
                this.logger.error(
                  { planId: plan.id, executionRef: matchedTx.executionRef },
                  'RECOVERY: Swap plan has no persisted orders but matching on-chain transaction found — ' +
                  'marked completed to prevent double-execution. Order/fill/position state is incomplete and needs manual reconciliation.',
                );
              } else {
                await this.haltSwapRecovery(plan.id, {
                  reason: 'live_swap_recovery_ambiguous',
                  detail: 'no_persisted_orders_and_no_matching_transaction',
                });
              }
            } else if (!this.deps.swapConfirmationPoller) {
              await this.haltSwapRecovery(plan.id, {
                reason: 'live_swap_recovery_ambiguous',
                detail: 'transaction_lookup_failed',
                code: txResult.error.code,
                message: txResult.error.message,
              });
            } else {
              // No tx list but no orders to check via poller either
              await this.haltSwapRecovery(plan.id, {
                reason: 'live_swap_recovery_ambiguous',
                detail: 'no_persisted_orders_and_transaction_lookup_failed',
              });
            }
            continue;
          }

          // Primary: use confirmation poller for orders with a venueRefId (authoritative)
          let confirmedViaPoller = false;
          let failedViaPoller = false;
          if (this.deps.swapConfirmationPoller) {
            for (const order of planOrders) {
              if (!order.venueRefId) continue;
              const confirmResult = await this.deps.swapConfirmationPoller.checkConfirmation(order.venueRefId);
              if (confirmResult.ok && confirmResult.data.confirmed) {
                confirmedViaPoller = true;
                break;
              }
              if (confirmResult.ok && confirmResult.data.failed) {
                failedViaPoller = true;
                break;
              }
            }
          }

          if (failedViaPoller) {
            for (const order of planOrders) {
              if (order.status !== 'filled' && order.status !== 'cancelled' && order.status !== 'rejected') {
                await this.deps.orderRepo.updateStatus(order.id, 'rejected');
              }
            }
            await this.deps.planRepo.markFailed(plan.id);
            this.logger.info({ planId: plan.id }, 'Swap tx reverted on-chain — plan marked failed');
            continue;
          }

          // Supplementary: check fetchRecentTransactions evidence
          const confirmedViaTxList = !confirmedViaPoller && txResult.ok
            && planOrders.some((o) => o.venueRefId && new Set(txResult.data.map((tx) => tx.executionRef)).has(o.venueRefId!));

          if (confirmedViaPoller || confirmedViaTxList) {
            await this.deps.planRepo.markCompleted(plan.id);
            this.logger.info({ planId: plan.id, source: confirmedViaPoller ? 'confirmation_poller' : 'recent_transactions' },
              'Incomplete swap plan confirmed on-chain — marked completed');
          } else {
            await this.haltSwapRecovery(plan.id, {
              reason: 'live_swap_recovery_ambiguous',
              detail: 'order_not_confirmed_on_chain',
            });
          }
        } catch (err) {
          await this.haltSwapRecovery(plan.id, {
            reason: 'live_swap_recovery_ambiguous',
            detail: 'recovery_exception',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else if (!venuePort) {
        // No venue port and no swap venue — mark as failed
        await this.deps.planRepo.markFailed(plan.id);
        this.logger.info({ planId: plan.id, status: plan.status }, 'Marked incomplete plan as failed (no venue port)');
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

            let lookupMatchedOrders: Array<{ venueRefId: string; status: string }> = [];
            let lookupAmbiguous = false;
            if (matchedFills.length === 0) {
              const lookupResult = await this.lookupPlanOrderbookRecoveryEvidence(venuePort, planOrders);
              lookupMatchedOrders = lookupResult.matchedOrders;
              lookupAmbiguous = lookupResult.ambiguous;
            }

            // noOrdersPlanned is always false here — plans with zero orders
            // are caught by the planOrders.length === 0 guard above.
            const noOrdersPlanned = !Array.isArray(plan.plannedOrders) || plan.plannedOrders.length === 0;
            const decision = evaluateOrderbookRecovery({
              orders: planOrders,
              hasOpenOrders,
              matchedFillCount: matchedFills.length,
              matchedOrdersFromLookup: lookupMatchedOrders,
              lookupAmbiguous,
              noOrdersPlanned,
            });

            await this.deps.journal.append({
              actorType: 'bot',
              actorId: this.botId,
              type: 'order.recovery_evaluated',
              payload: {
                planId: plan.id,
                decision: decision.kind,
                reason: decision.reason,
                orderCount: planOrders.length,
                matchedFillCount: matchedFills.length,
                lookupMatchedOrderCount: lookupMatchedOrders.length,
              },
            });

            if (decision.kind === 'mark_completed') {
              await this.deps.planRepo.markCompleted(plan.id);
              this.logger.info({ planId: plan.id, reason: decision.reason }, 'Recovered incomplete live plan as completed');
              continue;
            }

            if (decision.kind === 'mark_failed') {
              await this.deps.planRepo.markFailed(plan.id);
              this.logger.info({ planId: plan.id, reason: decision.reason }, 'Recovered incomplete live plan as failed');
              continue;
            }

            if (decision.kind === 'halt_ambiguous') {
              await this.deps.journal.append({
                actorType: 'bot',
                actorId: this.botId,
                type: 'execution.failure',
                payload: {
                  reason: 'live_recovery_ambiguous',
                  planId: plan.id,
                  recoveryReason: decision.reason,
                },
              });
              this.logger.warn({ planId: plan.id, reason: decision.reason }, 'Incomplete plan recovery is ambiguous — leaving executing for manual intervention');
              continue;
            }

            this.logger.info({ planId: plan.id, reason: decision.reason }, 'Incomplete plan remains executing pending venue resolution');
          }
        } catch (err) {
          await this.deps.planRepo.markFailed(plan.id);
          this.logger.error({ err, planId: plan.id }, 'Error reconciling incomplete plan against venue');
        }
      }
    }
  }

  private async lookupPlanOrderbookRecoveryEvidence(
    venuePort: OrderbookVenuePort,
    planOrders: Array<{ venueRefId?: string | null; clientOrderId?: string | null; symbol?: string | null }>,
  ): Promise<{ matchedOrders: Array<{ venueRefId: string; status: string }>; ambiguous: boolean }> {
    const matchedOrders: Array<{ venueRefId: string; status: string }> = [];
    const seenVenueRefs = new Set<string>();
    let ambiguous = false;

    const addMatchedOrder = (order: { venueRefId: string; status: string }) => {
      if (!order.venueRefId || seenVenueRefs.has(order.venueRefId)) return;
      seenVenueRefs.add(order.venueRefId);
      matchedOrders.push(order);
    };

    if (venuePort.fetchOrderByVenueRefId) {
      for (const order of planOrders) {
        if (!order.venueRefId) continue;
        const result = await venuePort.fetchOrderByVenueRefId(order.venueRefId, order.symbol ?? undefined);
        if (!result.ok) {
          ambiguous = true;
          this.logger.warn({
            venueRefId: order.venueRefId,
            code: result.error.code,
            message: result.error.message,
          }, 'Direct venueRefId lookup failed during recovery evidence gathering');
          continue;
        }
        if (result.data) {
          addMatchedOrder({ venueRefId: result.data.venueRefId, status: result.data.status });
        }
      }
    }

    if (venuePort.fetchOrderByClientOrderId) {
      for (const order of planOrders) {
        if (!order.clientOrderId) continue;
        const result = await venuePort.fetchOrderByClientOrderId(order.clientOrderId, order.symbol ?? undefined);
        if (!result.ok) {
          ambiguous = true;
          this.logger.warn({
            clientOrderId: order.clientOrderId,
            code: result.error.code,
            message: result.error.message,
          }, 'Direct clientOrderId lookup failed during recovery evidence gathering');
          continue;
        }
        if (result.data) {
          addMatchedOrder({ venueRefId: result.data.venueRefId, status: result.data.status });
        }
      }
    }

    return { matchedOrders, ambiguous };
  }

  /**
   * Match a plan (with no persisted orders) to a recent on-chain transaction
   * by comparing the plan's stored swap params against transaction input/output assets.
   */
  private matchPlanToRecentSwapTransactions(
    plan: { id: string; plannedOrders: unknown; createdAt: Date },
    recentTxs: Array<{ executionRef: string; inputAsset: string; outputAsset: string; timestamp: string }>,
  ): { executionRef: string } | undefined {
    const plannedOrders = plan.plannedOrders as Array<{ swapParams?: { inputAsset: string; outputAsset: string } }> | undefined;
    if (!plannedOrders || plannedOrders.length === 0) return undefined;

    const planCreatedAt = plan.createdAt.getTime();
    const windowMs = 5 * 60 * 1000;

    for (const planned of plannedOrders) {
      if (!planned.swapParams) continue;
      const { inputAsset, outputAsset } = planned.swapParams;

      for (const tx of recentTxs) {
        const txTime = new Date(tx.timestamp).getTime();
        if (txTime < planCreatedAt || txTime > planCreatedAt + windowMs) continue;
        if (tx.inputAsset === inputAsset && tx.outputAsset === outputAsset) {
          return { executionRef: tx.executionRef };
        }
      }
    }
    return undefined;
  }

  private async haltSwapRecovery(planId: string, details: Record<string, unknown>): Promise<void> {
    this.swapRecoveryHalted = true;
    if (this.swapRecoveryAlertedPlanIds.has(planId)) return;
    this.swapRecoveryAlertedPlanIds.add(planId);

    await this.deps.journal.append({
      actorType: 'bot',
      actorId: this.botId,
      type: 'execution.failure',
      payload: {
        planId,
        ...details,
      },
    });
    this.logger.error({ planId, ...details }, 'Swap recovery ambiguity detected — halting bot for manual intervention');
  }

  /**
   * Start the periodic reconciler if a venue port is provided.
   * Awaits the first reconciliation pass to ensure no trading occurs
   * until local == venue state is confirmed (or drift is within threshold).
   * Throws if drift is detected and driftAlertOnly is false.
   */
  private async startReconciler(): Promise<void> {
    if (!this.running) return;

    // Shadow/paper mode — positions are synthetic and never sent to the venue.
    // There is nothing to reconcile against real venue state. Skipping avoids
    // 4,600+ false-positive reconciliation.drift_detected events per session.
    if (this.deps.executionMode === 'shadow' || this.deps.executionMode === 'paper') return;

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
          botId: this.botId,
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
      actorType: 'bot',
      actorId: this.botId,
      venueAccountId: this.deps.venueAccountId,
      balanceDiffMode: this.deps.venueType === 'swap' ? 'observational' : 'authoritative',
      logger: this.logger,
      getLastReconciledAt: () => this.deps.reconciliationRepo.getLastReconciledAtForInstance(this.deps.venueAccountId),
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

    if (result.status === 'observed_variance') {
      this.logger.info(
        { diffCount: result.diffs.length, diffs: result.diffs },
        'Observed shared-wallet balance variance on startup — proceeding',
      );
      return;
    }

    // If drift is detected (exceeds threshold) and we are NOT in alert-only mode, block trading.
    // Shadow/paper modes return early above (no venue state to reconcile against).
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
    const mode = this.deps.executionMode;
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
            actorType: 'bot',
            actorId: this.botId,
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
            actorType: 'bot',
            actorId: this.botId,
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
    const lastReconciledAt = await this.deps.reconciliationRepo.getLastReconciledAtForInstance(this.deps.venueAccountId);

    const [openPositions, recentFills, openOrders, balanceSnapshot] = await Promise.all([
      this.deps.positionRepo.getOpenByInstance(this.botId),
      // Fetch fills across ALL instances sharing this venue account so that venue fills
      // from sibling/predecessor instances are matched and not flagged as unknown_fill drift.
      this.deps.fillRepo.getRecentByVenueAccount(this.deps.venueAccountId, lastReconciledAt ?? undefined),
      this.deps.orderRepo.getOpenByInstance(this.botId),
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
          actorType: 'bot',
          actorId: this.botId,
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
          actorType: 'bot',
          actorId: this.botId,
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
    if (this.swapRecoveryHalted) return;
    try {
      // Resolve any pending shadow limit orders that were triggered by trade stream
      if (this.executor instanceof ShadowExecutor) {
        const resolvedFills = this.executor.resolvePendingLimits();
        for (const fill of resolvedFills) {
          const { position: nextPos, realizedPnlDelta } = applyFillAccounting(this.position, fill, {
            equityTracker: this.equityTracker,
            dailyLossTracker: this.dailyLossTracker,
          });
          this.position = nextPos;
          await this.deps.journal.append(fillEvent(fill));
          await this.deps.fillRepo.insertFill({
            venueAccountId: this.deps.venueAccountId,
            orderId: fill.orderId,
            botId: this.botId,
            actorType: 'bot',
            actorId: this.botId,
            venue: this.deps.venue,
            symbol: this.deps.symbol,
            side: fill.side,
            quantity: fill.quantity.toString(),
            price: fill.price.toString(),
            fee: fill.fee?.toString(),
            feeCurrency: fill.feeCurrency,
            realizedPnlDelta: realizedPnlDelta.toString(),
            filledAt: new Date(fill.filledAt),
          });
        }
        if (resolvedFills.length > 0) {
          // Mark the corresponding orders as filled and plans as completed
          for (const fill of resolvedFills) {
            await this.deps.orderRepo.upsertByVenueRefId({
              venueAccountId: this.deps.venueAccountId,
              id: fill.orderId as unknown as string,
              actorType: 'bot',
              actorId: this.botId,
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
          const executingPlans = await this.deps.planRepo.getIncomplete('bot', this.botId);
          for (const plan of executingPlans) {
            if (plan.status !== 'executing') continue;
            const planOrders = await this.deps.orderRepo.getByExecutionPlanId(plan.id);
            const allFilled = planOrders.length > 0 && planOrders.every((o) => o.status === 'filled');
            if (allFilled) {
              await this.deps.planRepo.markCompleted(plan.id);
            }
          }

          await this.deps.positionRepo.upsert({
            actorType: 'bot',
            actorId: this.botId,
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

      this.lastSnapshot = snapshot;

      if (this.deps.recordMarketSnapshot) {
        try {
          await this.deps.recordMarketSnapshot(snapshot);
        } catch (err) {
          this.logger.warn({ err }, 'Failed to record live market snapshot');
        }
      }

      // Circuit breaker check — skip execution if tripped
      if (this.circuitBreaker?.isOpen) {
        this.logger.warn({ errorCount: this.circuitBreaker.errorCount }, 'Circuit breaker open — skipping tick');
        return;
      }

      // Stop-loss check — force exit if position breaches threshold
      if (this.position.side !== 'flat' && this.equityTracker && this.deps.riskLimits.stopLossMaxUnrealizedLossPct != null && this.deps.riskLimits.stopLossMaxUnrealizedLossPct > 0) {
        const markPrice = price(snapshot.price.toString());
        const equity = this.equityTracker.currentEquity(unrealizedPnl(this.position, markPrice));
        const slResult = checkStopLoss(
          { maxUnrealizedLossPct: this.deps.riskLimits.stopLossMaxUnrealizedLossPct },
          [{ instrument: this.deps.symbol, position: this.position, markPrice, equity }],
        );
        if (slResult.triggered) {
          this.logger.warn({ instrument: slResult.instrument, loss: slResult.unrealizedLoss?.toString(), threshold: slResult.threshold?.toString() }, 'Stop-loss triggered — forcing go_flat');
          await this.executeStopLoss(snapshot);
          return;
        }
      }

      // Delegate the core decision/plan/risk/execute path to the reusable trading cycle
      // Live mode guard: skip tick if there are unresolved live plans to prevent overlapping real orders
      if (this.deps.executionMode === 'live') {
        await this.enforceLiveOrderTimeouts();

        const incompletePlans = await this.deps.planRepo.getIncomplete('bot', this.botId);
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

      // Enrich snapshot with position state and risk playbook values for strategy consumption
      const today = snapshot.timestamp.slice(0, 10);
      if (today !== this.newPositionsDate) {
        this.newPositionsToday = 0;
        this.newPositionsDate = today;
      }

      // Compute account equity for percent_equity position sizing
      const equityValue = this.equityTracker
        ? this.equityTracker.currentEquity(unrealizedPnl(this.position, price(snapshot.price.toString())))
        : undefined;

      snapshot = {
        ...snapshot,
        playbook: {
          maxNewPositionsPerDay: this.deps.riskPlaybook?.maxNewPositionsPerDay,
          avoidParabolicMovePct: this.deps.riskPlaybook?.avoidParabolicMovePct,
        },
        data: {
          ...snapshot.data,
          openPositionSize: this.position.size.toString(),
          hasOpenPosition: this.position.side !== 'flat',
          newPositionsToday: this.newPositionsToday,
          accountEquity: equityValue !== undefined ? equityValue.toNumber() : undefined,
        },
      };

      const previousSide = this.position.side;

      // Evaluate strategy to produce a decision
      const evalResult = await this.deps.strategy.evaluate(snapshot, this.strategyConfig);
      if (!evalResult.ok) {
        const errorCode = evalResult.error.code;

        // Circuit breaker: track consecutive errors by error code
        if (this.lastStrategyErrorCode === errorCode) {
          this.consecutiveStrategyErrors++;
        } else {
          this.consecutiveStrategyErrors = 1;
          this.lastStrategyErrorCode = errorCode;
        }

        // Determine the halt threshold for this error code
        const threshold = errorCode === 'strategy.config_invalid'
          ? (this.deps.botConfigInvalidHaltThreshold ?? 1)
          : errorCode === 'strategy.execution_error'
            ? (this.deps.botExecutionErrorHaltThreshold ?? 5)
            : undefined;

        if (threshold !== undefined && this.consecutiveStrategyErrors >= threshold) {
          // Halt: emit strategy.fatal, stop the bot, and notify via callback
          void this.deps.journal.append({
            actorType: 'bot',
            actorId: this.botId,
            type: 'strategy.fatal',
            payload: {
              code: errorCode,
              message: evalResult.error.message,
              consecutiveErrors: this.consecutiveStrategyErrors,
              threshold,
            },
          }).catch((e: unknown) => this.logger.warn({ err: e }, 'Failed to append strategy.fatal journal event'));

          this.logger.error(
            { errorCode, consecutiveErrors: this.consecutiveStrategyErrors, threshold },
            'Strategy fatal error — halting bot',
          );

          await this.stop();
          if (this.deps.onHalted) {
            await this.deps.onHalted(this.botId);
          }
          return;
        }

        // Below threshold — emit warning and continue
        void this.deps.journal.append({
          actorType: 'bot',
          actorId: this.botId,
          type: 'strategy.error' as JournalEventType,
          payload: { code: errorCode, message: evalResult.error.message },
        }).catch((e: unknown) => this.logger.warn({ err: e }, 'Failed to append strategy.error journal event'));
        return;
      }

      // Successful evaluation — reset error counter
      this.consecutiveStrategyErrors = 0;
      this.lastStrategyErrorCode = null;

      const strategyDecision = evalResult.data;
      if (!strategyDecision) return; // hold — strategy chose not to act

      // Stamp actor context on the decision — preserve strategy's actorType/actorId when set
      const tickDecision = {
        ...strategyDecision,
        venueAccountId: this.deps.venueAccountId as unknown as typeof strategyDecision.venueAccountId,
        actorType: (strategyDecision.actorType ?? 'bot') as typeof strategyDecision.actorType,
        actorId: strategyDecision.actorId || this.botId,
        botId: (this.botId as BotId) ?? strategyDecision.botId,
      };

      // Delegate execution to executeDecision with full tick deps (pre-built executor +
      // full persistence + oracle mark + swap safety + cooldown enforcement)
      const execResult = await executeDecision(tickDecision, this.position, {
        ...this.buildInstrumentExecutorDeps(snapshot.price.toString()),
        executor: this.executor,
        persistence: this.buildCyclePersistence(),
        markSource: this.deps.markSource,
        swapAssets: this.deps.swapAssets,
        swapNetwork: this.deps.swapNetwork,
        swapBaseTokenAddress: this.deps.swapBaseTokenAddress,
        swapTokenSafety: this.deps.swapTokenSafety,
        swapTokenSafetyThresholds: this.deps.swapTokenSafetyThresholds,
        swapPositionTracker: this.swapPositionTracker,
        lastStopLossExitMs: this.lastStopLossExitMs,
        strategyParams: this.strategyConfig,
        snapshotTimestamp: snapshot.timestamp,
      });

      this.position = execResult.newPosition;

      // Track new position entries for daily counter
      if (previousSide === 'flat' && this.position.side !== 'flat') {
        this.newPositionsToday++;
      }

      // Circuit breaker tracking
      if (this.circuitBreaker) {
        if (execResult.error) {
          const tripped = this.circuitBreaker.recordError();
          if (tripped) {
            this.logger.error({ errorCount: this.circuitBreaker.errorCount }, 'Circuit breaker tripped — halting execution');
            void this.deps.journal.append({
              actorType: 'bot',
              actorId: this.botId,
              type: 'circuit_breaker.tripped' as JournalEventType,
              payload: { consecutiveErrors: this.circuitBreaker.errorCount },
            }).catch((e: unknown) => this.logger.warn({ err: e }, 'Failed to append circuit_breaker.tripped journal event'));
          }
        } else if (execResult.executed) {
          this.circuitBreaker.recordSuccess();
        }
      }

      // Emit credential.used audit event for live order submissions
      if (execResult.executed && this.deps.executionMode === 'live' && this.deps.credentialId) {
        const submittedCount = (execResult.orders ?? []).filter(
          (o) => (o.type === 'market' || o.type === 'limit') && o.status !== 'rejected',
        ).length;
        if (submittedCount > 0) {
          this.deps.journal.append(credentialUsedEvent(this.botId, {
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

      if (execResult.executed) {
        this.logger.info(
          { intent: tickDecision.intent, fills: execResult.fills.length, position: this.position.side },
          'Tick completed',
        );
      } else if (execResult.preExecutionRejection) {
        this.logger.warn(
          { decision: tickDecision.intent, code: execResult.preExecutionRejection.code, scope: execResult.preExecutionRejection.scope },
          'Pre-execution guardrail rejected',
        );
        void this.deps.journal.append({
          actorType: 'bot',
          actorId: this.botId,
          type: 'guardrail.rejected',
          payload: {
            planId: execResult.planId,
            scope: execResult.preExecutionRejection.scope,
            code: execResult.preExecutionRejection.code,
            message: execResult.preExecutionRejection.message,
            retryable: execResult.preExecutionRejection.retryable,
            intent: tickDecision.intent,
          },
        }).catch((e: unknown) => this.logger.warn({ err: e }, 'Failed to append guardrail.rejected journal event'));
      } else if (execResult.riskRejected) {
        this.logger.warn({ decision: tickDecision.intent }, 'Risk gate rejected');
      } else if (execResult.error) {
        this.logger.error({ decision: tickDecision.intent }, 'Execution failed');
        void this.deps.journal.append({
          actorType: 'bot',
          actorId: this.botId,
          type: 'execution.failure',
          payload: { intent: tickDecision.intent },
        }).catch((e: unknown) => this.logger.warn({ err: e }, 'Failed to append execution.failure journal event'));
      }
    } catch (err) {
      this.logger.error({ err }, 'Tick error');
      void this.deps.journal.append({
        actorType: 'bot',
        actorId: this.botId,
        type: 'instance.tick_error',
        payload: { error: err instanceof Error ? err.message : String(err) },
      }).catch((e: unknown) => this.logger.warn({ err: e }, 'Failed to append instance.tick_error journal event'));
    }
  }

  private async enforceLiveOrderTimeouts(): Promise<void> {
    if (this.deps.executionMode !== 'live' || !this.deps.liveOrderTimeoutPolicy) {
      return;
    }

    if (this.deps.venueType === 'swap') {
      await this.enforceLiveSwapConfirmationRecovery();
      return;
    }

    if (!this.deps.venuePort) {
      return;
    }

    const openOrders = await this.deps.orderRepo.getOpenByInstance(this.botId);
    if (openOrders.length === 0) {
      this.timeoutRecoveryAlertedOrderIds.clear();
      return;
    }

    const openOrderIds = new Set(openOrders.map((o) => o.id));
    for (const orderId of this.timeoutRecoveryAlertedOrderIds) {
      if (!openOrderIds.has(orderId)) {
        this.timeoutRecoveryAlertedOrderIds.delete(orderId);
      }
    }

    const actions = computeLiveTimeoutActions(openOrders, this.deps.liveOrderTimeoutPolicy);
    if (actions.length === 0) return;

    for (const action of actions) {
      const order = openOrders.find((candidate) => candidate.id === action.orderId);
      if (!order) continue;

      if (action.kind === 'cancel_limit') {
        const cancelResult = await this.deps.venuePort.cancelOrder({
          orderId: action.venueRefId as unknown as OrderId,
          symbol: action.symbol,
        });

        if (!cancelResult.ok) {
          await this.deps.journal.append({
            actorType: 'bot',
            actorId: this.botId,
            type: 'execution.failure',
            payload: {
              code: cancelResult.error.code,
              message: cancelResult.error.message,
              reason: 'live_limit_timeout_cancel_failed',
              orderId: action.orderId,
              venueRefId: action.venueRefId,
            },
          });
          continue;
        }

        await this.deps.orderRepo.upsertByVenueRefId({
          id: order.id,
          venueAccountId: order.venueAccountId,
          actorType: order.actorType,
          actorId: order.actorId ?? undefined,
          executionPlanId: order.executionPlanId ?? undefined,
          venueRefId: action.venueRefId,
          clientOrderId: order.clientOrderId ?? undefined,
          venue: order.venue,
          symbol: order.symbol,
          side: order.side,
          type: order.type,
          quantity: order.quantity,
          price: order.price ?? undefined,
          referencePrice: order.referencePrice ?? undefined,
          status: 'cancelled',
          submissionState: 'terminal',
          submitAttemptedAt: order.submitAttemptedAt?.toISOString(),
          acknowledgedAt: order.acknowledgedAt?.toISOString(),
          filledQuantity: order.filledQuantity,
          avgFillPrice: order.avgFillPrice ?? undefined,
        });

        await this.deps.journal.append({
          actorType: 'bot',
          actorId: this.botId,
          type: 'order.cancelled',
          payload: {
            orderId: action.orderId,
            venueRefId: action.venueRefId,
            reason: 'live_limit_timeout',
            ageMs: action.ageMs,
            symbol: action.symbol,
          },
        });
        continue;
      }

      if (this.timeoutRecoveryAlertedOrderIds.has(action.orderId)) {
        continue;
      }
      this.timeoutRecoveryAlertedOrderIds.add(action.orderId);

      await this.deps.journal.append({
        actorType: 'bot',
        actorId: this.botId,
        type: 'execution.failure',
        payload: {
          reason: 'live_order_timeout_recovery_required',
          orderId: action.orderId,
          venueRefId: action.venueRefId,
          symbol: action.symbol,
          ageMs: action.ageMs,
          timeoutType: action.reason,
        },
      });
    }
  }

  private async enforceLiveSwapConfirmationRecovery(): Promise<void> {
    if (!this.deps.swapVenue || !this.deps.liveOrderTimeoutPolicy) {
      return;
    }
    const swapVenue = this.deps.swapVenue;

    const openOrders = await this.deps.orderRepo.getOpenByInstance(this.botId);
    if (openOrders.length === 0) {
      this.timeoutRecoveryAlertedOrderIds.clear();
      return;
    }

    // Use the confirmation poller as the primary authoritative check for orders with a venueRefId.
    // Fall back to fetchRecentTransactions when the poller is unavailable or temporarily errors.
    let knownTxRefs: Set<string> | undefined;
    let txLookupAttempted = false;
    let txLookupError: { code: string; message: string } | undefined;
    const loadKnownTxRefs = async (): Promise<Set<string> | undefined> => {
      if (txLookupAttempted) {
        return knownTxRefs;
      }
      txLookupAttempted = true;
      const txResult = await swapVenue.fetchRecentTransactions();
      if (!txResult.ok) {
        txLookupError = { code: txResult.error.code, message: txResult.error.message };
        return undefined;
      }
      knownTxRefs = new Set(txResult.data.map((tx) => tx.executionRef));
      return knownTxRefs;
    };
    if (!this.deps.swapConfirmationPoller) {
      const resolvedKnownTxRefs = await loadKnownTxRefs();
      if (!resolvedKnownTxRefs && txLookupError) {
        await this.deps.journal.append({
          actorType: 'bot',
          actorId: this.botId,
          type: 'execution.failure',
          payload: {
            reason: 'live_swap_confirmation_check_failed',
            code: txLookupError.code,
            message: txLookupError.message,
            openSwapOrderCount: openOrders.length,
          },
        });
        return;
      }
    }

    const timeoutMs = this.deps.liveOrderTimeoutPolicy.marketOrderTimeoutMs;

    for (const order of openOrders) {
      // Primary path: use confirmation poller for orders with a venueRefId (tx hash)
      if (order.venueRefId && this.deps.swapConfirmationPoller) {
        const confirmResult = await this.deps.swapConfirmationPoller.checkConfirmation(order.venueRefId);
        if (confirmResult.ok && confirmResult.data.confirmed) {
          await this.finalizeConfirmedSwapOrder(order, confirmResult.data.timestamp);
          continue;
        }
        if (confirmResult.ok && confirmResult.data.failed) {
          // Definitively reverted on-chain — mark as rejected
          await this.finalizeFailedSwapOrder(order);
          continue;
        }
        if (!confirmResult.ok) {
          this.logger.warn({
            venueRefId: order.venueRefId,
            code: confirmResult.error.code,
          }, 'Confirmation poller error during runtime recovery — falling through to timeout check');
          const fallbackTxRefs = await loadKnownTxRefs();
          if (order.venueRefId && fallbackTxRefs?.has(order.venueRefId)) {
            await this.finalizeConfirmedSwapOrder(order);
            continue;
          }
        }
      } else if (order.venueRefId && knownTxRefs?.has(order.venueRefId)) {
        // Fallback: fetchRecentTransactions evidence (when poller is unavailable)
        await this.finalizeConfirmedSwapOrder(order);
        continue;
      }

      const orderStartMs = order.submitAttemptedAt?.getTime() ?? order.createdAt.getTime();
      const ageMs = Date.now() - orderStartMs;
      if (ageMs < timeoutMs) {
        continue;
      }

      const alertKey = order.executionPlanId ?? order.id;
      if (this.timeoutRecoveryAlertedOrderIds.has(alertKey)) {
        continue;
      }
      this.timeoutRecoveryAlertedOrderIds.add(alertKey);

      await this.haltSwapRecovery(alertKey, {
        reason: 'live_swap_confirmation_timeout_recovery_required',
        orderId: order.id,
        executionPlanId: order.executionPlanId,
        venueRefId: order.venueRefId,
        symbol: order.symbol,
        ageMs,
      });
    }
  }

  /**
   * Finalize a confirmed swap order: mark as filled, persist fill + position, trigger plan completion + quality alerting.
   */
  private async finalizeConfirmedSwapOrder(
    order: { id: string; venueAccountId: string; actorType: string; actorId?: string | null; executionPlanId?: string | null; venueRefId?: string | null; clientOrderId?: string | null; venue: string; symbol: string; side: string; type: string; quantity: string; price?: string | null; referencePrice?: string | null; status: string; submitAttemptedAt?: Date | null; acknowledgedAt?: Date | null; filledQuantity: string; avgFillPrice?: string | null },
    confirmedAt?: string,
  ): Promise<void> {
    const resolvedFillPrice = order.avgFillPrice ?? order.price ?? order.referencePrice;
    const resolvedFilledQuantity = order.filledQuantity && order.filledQuantity !== '0'
      ? order.filledQuantity
      : order.quantity;
    // Prefer persisted order timestamps (closer to actual execution) over the
    // synthetic poll-time timestamp the poller returns at recovery time.
    const recoveredFillTimestamp = order.acknowledgedAt?.toISOString()
      ?? order.submitAttemptedAt?.toISOString()
      ?? confirmedAt
      ?? new Date().toISOString();

    await this.deps.orderRepo.upsertByVenueRefId({
      id: order.id,
      venueAccountId: order.venueAccountId,
      actorType: order.actorType,
      actorId: order.actorId ?? undefined,
      executionPlanId: order.executionPlanId ?? undefined,
      venueRefId: order.venueRefId!,
      clientOrderId: order.clientOrderId ?? undefined,
      venue: order.venue,
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      quantity: order.quantity,
      price: order.price ?? undefined,
      referencePrice: order.referencePrice ?? undefined,
      status: 'filled',
      submissionState: 'terminal',
      submitAttemptedAt: order.submitAttemptedAt?.toISOString(),
      acknowledgedAt: order.acknowledgedAt?.toISOString(),
      filledQuantity: resolvedFilledQuantity,
      avgFillPrice: resolvedFillPrice ?? undefined,
    });

    // Persist fill and update position state for risk enforcement
    if (resolvedFillPrice) {
      const side = order.side as 'buy' | 'sell';
      const fillEvt = {
        id: this.deps.idGen.fillId(),
        orderId: order.id as unknown as import('@herobids/domain').OrderId,
        venueAccountId: this.deps.venueAccountId,
        actorType: 'bot' as const,
        actorId: this.botId,
        venueRefId: order.venueRefId ?? undefined,
        venue: this.deps.venue,
        symbol: order.symbol,
        side,
        quantity: quantity(resolvedFilledQuantity),
        price: price(resolvedFillPrice),
        fee: quantity('0'),
        feeCurrency: undefined,
        filledAt: recoveredFillTimestamp,
      };

      const { position: nextPos, realizedPnlDelta } = applyFillAccounting(this.position, fillEvt, {
        equityTracker: this.equityTracker,
        dailyLossTracker: this.dailyLossTracker,
      });
      this.position = nextPos;

      if (this.swapPositionTracker && this.deps.swapAssets) {
        const isBuy = side === 'buy';
        const fillQty = quantity(resolvedFilledQuantity);
        const fillPrice = price(resolvedFillPrice);
        this.swapPositionTracker.recordSwapFill({
          inputAsset: isBuy ? this.deps.swapAssets.quoteAsset : this.deps.swapAssets.baseAsset,
          inputAmount: isBuy ? fillPrice.mul(fillQty) : fillQty,
          outputAsset: isBuy ? this.deps.swapAssets.baseAsset : this.deps.swapAssets.quoteAsset,
          outputAmount: isBuy ? fillQty : fillPrice.mul(fillQty),
          timestamp: new Date(recoveredFillTimestamp).getTime(),
        });
      }

      await this.deps.fillRepo.insertFill({
        venueAccountId: this.deps.venueAccountId,
        orderId: order.id,
        botId: this.botId,
        actorType: 'bot',
        actorId: this.botId,
        venueRefId: order.venueRefId ?? undefined,
        venue: this.deps.venue,
        symbol: order.symbol,
        side: order.side,
        quantity: resolvedFilledQuantity,
        price: resolvedFillPrice,
        fee: undefined,
        feeCurrency: undefined,
        realizedPnlDelta: realizedPnlDelta.toString(),
        filledAt: new Date(recoveredFillTimestamp),
      });

      const markResult = await this.fetchCachedMark();
      await this.deps.positionRepo.upsert({
        actorType: 'bot',
        actorId: this.botId,
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

    // Emit execution-quality alert from confirmed recovery
    if (resolvedFillPrice && order.side) {
      await this.maybeEmitLiveSwapExecutionQualityAlert({
        venueRefId: order.venueRefId ?? undefined,
        symbol: order.symbol,
        side: order.side,
        price: resolvedFillPrice,
      });
    }

    if (order.executionPlanId) {
      await this.tryCompleteLivePlan(order.venueRefId!);
    }
  }

  /**
   * Finalize a definitively failed/reverted swap order: mark as rejected and fail the plan.
   */
  private async finalizeFailedSwapOrder(
    order: { id: string; executionPlanId?: string | null; venueRefId?: string | null; symbol: string },
  ): Promise<void> {
    await this.deps.orderRepo.updateStatus(order.id, 'rejected');
    this.logger.info({ orderId: order.id, venueRefId: order.venueRefId, symbol: order.symbol },
      'Swap tx reverted on-chain — order marked rejected');

    if (order.executionPlanId) {
      await this.deps.planRepo.markFailed(order.executionPlanId);
    }
  }

  /** Build persistence hooks that delegate to real DB repositories */
  private buildCyclePersistence(): TradingCyclePersistence {
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
        const latestBalanceSnapshot = await this.deps.balanceSnapshotRepo.getLatestByVenueAccount(
          this.deps.venueAccountId,
          this.deps.venue,
        );

        await this.deps.backtestingRepo.insertDecisionContext({
          decisionId: context.decisionId,
          venueAccountId: this.deps.venueAccountId,
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
        await this.deps.fillRepo.insertFill({ ...fill, venueAccountId: fill.venueAccountId ?? this.deps.venueAccountId });
        await this.maybeEmitLiveSwapExecutionQualityAlert({
          venueRefId: fill.venueRefId,
          symbol: fill.symbol,
          side: fill.side,
          price: fill.price,
        });
      },
      persistPosition: async (pos) => {
        await this.deps.positionRepo.upsert({
          ...pos,
          actorType: pos.actorType ?? 'bot',
          actorId: pos.actorId ?? this.botId,
        });
      },
      persistOrder: async (order) => {
        const payload = {
          ...order,
          actorType: order.actorType ?? 'bot',
          actorId: order.actorId ?? this.botId,
        };
        if (payload.venueRefId) {
          await this.deps.orderRepo.upsertByVenueRefId(payload);
        } else if (payload.clientOrderId) {
          await (this.deps.orderRepo as { upsertByClientOrderId?: (order: typeof payload) => Promise<void> })
            .upsertByClientOrderId?.(payload);
        }
      },
    };
  }

  private async maybeEmitLiveSwapExecutionQualityAlert(fill: {
    venueRefId?: string;
    symbol: string;
    side: string;
    price: string;
  }): Promise<void> {
    if (this.deps.executionMode !== 'live' || this.deps.venueType !== 'swap') return;
    const thresholdBps = this.deps.slippageAlertBps;
    if (thresholdBps == null || !fill.venueRefId) return;

    const order = await this.deps.orderRepo.getByVenueRefId(fill.venueRefId);
    if (!order?.referencePrice) return;
    if (fill.side !== 'buy' && fill.side !== 'sell') return;

    const slippageBps = computeSlippageBps(order.referencePrice, fill.price, fill.side);
    if (slippageBps <= thresholdBps) return;

    await this.deps.journal.append({
      actorType: 'bot',
      actorId: this.botId,
      type: 'live.slippage_alert',
      payload: {
        orderId: order.id,
        venue: this.deps.venue,
        symbol: fill.symbol,
        side: fill.side,
        referencePrice: order.referencePrice,
        avgFillPrice: fill.price,
        slippageBps,
        thresholdBps,
        executionType: 'swap',
      },
    });
  }

  /** Expose current position for read queries */
  get currentPosition(): PositionState {
    return this.position;
  }

  /** Whether the actor is actively running */
  get isRunning(): boolean {
    return this.running;
  }

  /** Execution mode for this actor */
  get executionMode(): 'paper' | 'shadow' | 'live' {
    return this.deps.executionMode;
  }

  /** Most recent market snapshot (null if no tick has completed yet) */
  getLastSnapshot(): MarketSnapshot | null {
    return this.lastSnapshot;
  }

  /** Most recent cached mark result — exposes the same value used by the trading cycle so agent
   * decision contexts share the oracle mark rather than falling back to raw snapshot price. */
  getLastMarkResult() {
    return this.cachedMark?.result;
  }

  /** Build decision intake deps for the agent decision handler */
  getIntakeDeps(): IntakeResult {
    if (this.swapRecoveryHalted) {
      return {
        rejected: true,
        code: 'swap_recovery_ambiguous',
        message: 'Swap recovery is in ambiguous state — manual intervention required before new executions',
        retryable: false,
      };
    }
    if (this.circuitBreaker?.isOpen) {
      return {
        rejected: true,
        code: 'circuit_breaker_open',
        message: 'Circuit breaker is open — execution halted after consecutive venue errors',
        retryable: false,
      };
    }
    return {
      actorType: 'bot',
      actorId: this.botId,
      venue: this.deps.venue,
      symbol: this.deps.symbol,
      venueAccountId: this.deps.venueAccountId,
      venueType: this.deps.venueType,
      swapAssets: this.deps.swapAssets,
      swapNetwork: this.deps.swapNetwork,
      swapBaseTokenAddress: this.deps.swapBaseTokenAddress,
      executor: this.executor,
      journal: this.deps.journal,
      riskLimits: this.deps.riskLimits,
      markSource: this.deps.markSource,
      persistence: this.buildCyclePersistence(),
      idGen: this.deps.idGen,
      clock: realClock,
      swapTokenSafety: this.deps.swapTokenSafety,
      swapTokenSafetyThresholds: this.deps.swapTokenSafetyThresholds,
      equityTracker: this.equityTracker,
      dailyLossTracker: this.dailyLossTracker,
      openPositions: this.position.side !== 'flat' ? [this.position] : [],
      lastStopLossExitMs: this.lastStopLossExitMs,
      swapPositionTracker: this.swapPositionTracker,
    };
  }

  private buildInstrumentExecutorDeps(snapshotPrice: string): InstrumentExecutorDeps {
    return {
      venue: this.deps.venue,
      symbol: this.deps.symbol,
      venueAccountId: this.deps.venueAccountId,
      executionMode: this.deps.executionMode,
      venueType: this.deps.venueType ?? 'orderbook',
      venuePort: this.deps.venuePort,
      swapVenue: this.deps.swapVenue,
      riskLimits: this.deps.riskLimits,
      idGen: this.deps.idGen,
      fillRepo: this.deps.fillRepo,
      orderRepo: this.deps.orderRepo,
      positionRepo: this.deps.positionRepo,
      journal: this.deps.journal,
      snapshotPrice,
      equityTracker: this.equityTracker,
      dailyLossTracker: this.dailyLossTracker,
      openPositionCount: this.position.side !== 'flat' ? 1 : 0,
    };
  }

  getDecisionContext(): DecisionContext | undefined {
    const snapshot = this.lastSnapshot;
    if (!snapshot) return undefined;
    const pos = this.position;
    const lastMark = this.cachedMark?.result;
    const referenceMark = (lastMark?.ok && !lastMark.data.stale)
      ? { price: lastMark.data.price.toString(), source: lastMark.data.source }
      : { price: snapshot.price.toString(), source: 'snapshot' };
    return {
      snapshot: { symbol: snapshot.symbol, price: snapshot.price.toString(), timestamp: snapshot.timestamp },
      position: pos.side === 'flat' ? null : {
        side: pos.side,
        size: pos.size.toString(),
        entryPrice: pos.entryPrice.toString(),
        realizedPnl: pos.realizedPnl.toString(),
      },
      referenceMark,
      strategyParams: {},
    };
  }

  getPosition(): PositionState {
    return this.position;
  }

  recordExecutionOutcome(success: boolean): void {
    if (!this.circuitBreaker) return;
    if (success) {
      this.circuitBreaker.recordSuccess();
    } else {
      const tripped = this.circuitBreaker.recordError();
      if (tripped) {
        this.logger.error({ errorCount: this.circuitBreaker.errorCount }, 'Circuit breaker tripped via external outcome — halting execution');
      }
    }
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
    // Build a FillEvent for the accounting helper
    const fillEvent = {
      id: this.deps.idGen.fillId(),
      orderId: fill.orderId as unknown as import('@herobids/domain').OrderId,
      venueAccountId: this.deps.venueAccountId,
      actorType: 'bot' as const,
      actorId: this.botId,
      venueRefId: fill.venueRefId,
      venue: this.deps.venue,
      symbol: fill.symbol,
      side: fill.side,
      quantity: quantity(fill.quantity),
      price: price(fill.price),
      fee: quantity(fill.fee || '0'),
      feeCurrency: fill.feeCurrency,
      filledAt: fill.filledAt,
    };

    const { position: nextPos, realizedPnlDelta } = applyFillAccounting(this.position, fillEvent, {
      equityTracker: this.equityTracker,
      dailyLossTracker: this.dailyLossTracker,
    });
    this.position = nextPos;

    // Record to swap position tracker (balance-delta model)
    if (this.swapPositionTracker && this.deps.swapAssets) {
      const isBuy = fill.side === 'buy';
      const fillQty = quantity(fill.quantity);
      const fillPrice = price(fill.price);
      this.swapPositionTracker.recordSwapFill({
        inputAsset: isBuy ? this.deps.swapAssets.quoteAsset : this.deps.swapAssets.baseAsset,
        inputAmount: isBuy ? fillPrice.mul(fillQty) : fillQty,
        outputAsset: isBuy ? this.deps.swapAssets.baseAsset : this.deps.swapAssets.quoteAsset,
        outputAmount: isBuy ? fillQty : fillPrice.mul(fillQty),
        timestamp: new Date(fill.filledAt).getTime(),
      });
    }

    await this.deps.fillRepo.insertFill({
      venueAccountId: this.deps.venueAccountId,
      orderId: fill.orderId,
      botId: this.botId,
      actorType: 'bot',
      actorId: this.botId,
      venueRefId: fill.venueRefId,
      venue: this.deps.venue,
      symbol: fill.symbol,
      side: fill.side,
      quantity: fill.quantity,
      price: fill.price,
      fee: fill.fee,
      feeCurrency: fill.feeCurrency,
      realizedPnlDelta: realizedPnlDelta.toString(),
      filledAt: new Date(fill.filledAt),
    });

    // Persist updated position
    const markResult = await this.fetchCachedMark();
    await this.deps.positionRepo.upsert({
      actorType: 'bot',
      actorId: this.botId,
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
      actorType: 'bot',
      actorId: this.botId,
      type: 'fill.private_stream' as JournalEventType,
      payload: fill as unknown as Record<string, unknown>,
    });

    await this.maybeEmitLiveSlippageAlert(fill);

    // After position is updated, check if the owning plan can be completed.
    // This is the safe trigger point for 'filled' orders — position already reflects the fill.
    if (this.deps.executionMode === 'live') {
      await this.tryCompleteLivePlan(fill.venueRefId ?? fill.orderId);
    }
  }

  private async maybeEmitLiveSlippageAlert(fill: PrivateStreamFill): Promise<void> {
    if (this.deps.executionMode !== 'live') return;
    const thresholdBps = this.deps.slippageAlertBps;
    if (thresholdBps == null) return;

    const order = await this.deps.orderRepo.getByVenueRefId(fill.orderId)
      ?? (fill.venueRefId ? await this.deps.orderRepo.getByVenueRefId(fill.venueRefId) : null);
    const referencePrice = order?.referencePrice;
    if (!referencePrice) return;

    const slippageBps = computeSlippageBps(referencePrice, fill.price, fill.side);
    if (slippageBps <= thresholdBps) return;

    await this.deps.journal.append({
      actorType: 'bot',
      actorId: this.botId,
      type: 'live.slippage_alert',
      payload: {
        orderId: order.id,
        venue: this.deps.venue,
        symbol: fill.symbol,
        side: fill.side,
        referencePrice,
        avgFillPrice: fill.price,
        slippageBps,
        thresholdBps,
      },
    });
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
        venueAccountId: this.deps.venueAccountId,
        actorType: 'bot',
        actorId: this.botId,
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
        actorType: 'bot',
        actorId: this.botId,
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
      const incompletePlans = await this.deps.planRepo.getIncomplete('bot', this.botId);
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
      actorType: 'bot',
      actorId: this.botId,
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
