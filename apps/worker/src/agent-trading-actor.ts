import { createLogger } from './logger.js';
import type { CandleFetchBreaker } from './candle-fetch-breaker.js';
import type { RetryOptions } from './candle-fetch-retry.js';
import type { ContextSnapshotPayload, OrderbookVenuePort, SwapVenuePort, MarkSource, LiveRolloutConfig, Subscription, SubscriptionState, SwapTokenSafetyPort, Price, Decision, DecisionId, VenueAccountId, InstrumentId, TechnicalConfig, RiskConfig, AgentWakePayload } from '@herobids/domain';
import type { OrderId } from '@herobids/domain';
import { quantity, price, Decimal, ok, err, type Result } from '@herobids/domain';
import type { ExecutionActor, IntakeResult } from './execution-actor.js';
import type { VenueInstrumentCache } from './venue-instrument-cache.js';
import type { VenueAdapterFactory } from './venue-adapter-factory.js';
import { parseSwapInstrumentId } from './swap-instrument-id.js';
import { validateTradeInstrument } from './validate-trade-instrument.js';
import { assertLiveReadiness } from './live-gate.js';
import type { StreamConfig } from './trading-actor.js';
import type { SwapConfirmationPoller } from '@herobids/venues';
import type { PriceCandle, RegimeParams } from '@herobids/market-data';
import { evaluateRegime } from '@herobids/market-data';
import { runTechnicalPhase } from './technical-phase.js';
import type { DiscoveredInstrument, FilterConfig } from './technical-phase.js';
import type { ScannerCandleTarget } from '@herobids/strategy';
import { completeTechnicalScan, computeSignalFingerprint, deriveVenueFamily, deriveStyleTier } from './complete-technical-scan.js';
import type { PersistableScanCandidate, ScanMetricInput } from './complete-technical-scan.js';
import type { TechnicalScanState } from './runtime-composition.js';
import { cleanupOrphanedPositions } from './reconciliation-orphaned-cleanup.js';
import { scannerSignalFingerprintKey } from './redis-keys.js';
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
  Reconciler,
  createOrderbookVenueStateLoader,
  createSwapVenueStateLoader,
  realClock,
  credentialUsedEvent,
  EquityTracker,
  DailyLossTracker,
  VenueCircuitBreaker,
  checkStopLoss,
  checkPerTradeLevels,
  submitDecisionForExecution,
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
  FeeSimulatorConfig,
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
  LiveTimeoutPolicy,
  InstrumentExecutorDeps,
  PerTradeLevelCheck,
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

// ── Concurrency gate ─────────────────────────────────────────────────────────
// Per-worker in-memory counter guarding max concurrent technical scans across
// all agents. The cap is set once from operator config (marketData.binance.scanner.maxConcurrentScans)
// and checked before each scan. A Redis-backed cross-worker semaphore is the
// long-term plan but deferred to follow-on.
let activeConcurrentScans = 0;
let globalMaxConcurrentScans = 0;

/** Minimal Redis store interface for scanner signal dedup. */
export interface SignalFingerprintStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: string[]): Promise<unknown>;
}

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
  idGen: IdGenerator & { planId(): string; decisionId(): string };
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
  /** Simulated fee configuration for paper/shadow fills */
  feeConfig?: FeeSimulatorConfig;
  /** Max consecutive venue errors before circuit breaker trips */
  maxConsecutiveVenueErrors?: number;
  /** Live fill slippage alert threshold in bps */
  slippageAlertBps?: number;
  /** Fatal live crash policy */
  crashPolicy?: 'auto_go_flat' | 'alert_manual_intervention';
  /** Timeout policy for stale live order handling */
  liveOrderTimeoutPolicy?: LiveTimeoutPolicy & { checkIntervalMs?: number };
  /** Venue-specific swap confirmation poller for authoritative on-chain tx status checks */
  swapConfirmationPoller?: SwapConfirmationPoller;
  /** Technical phase config — when present, a scan loop runs on `config.scanIntervalMs` */
  technicalConfig?: TechnicalConfig;
  /** Per-instance risk config used by the technical phase (maxOpenPositions, maxPositionSize) */
  technicalRiskConfig?: RiskConfig;
  /** Discover candidate instruments for the technical scan (injected for testability) */
  discoverCandidates?: (filters: FilterConfig) => Promise<DiscoveredInstrument[]>;
  /** Fetch OHLCV candles for the technical scan (injected for testability) */
  fetchCandles?: (target: ScannerCandleTarget, interval: string, limit: number) => Promise<PriceCandle[]>;
  /** Callback invoked after each technical scan completes — used to forward results to the agent container */
  onTechnicalScanComplete?: (agentId: string, scan: TechnicalScanState) => void | Promise<void>;
  /** Emit an agent wake signal (e.g. scanner results) to trigger an early LLM tick */
  emitAgentWake?: (agentId: string, payload: AgentWakePayload) => Promise<void>;
  /** Whether the agent is in hybrid mode (capabilityMode === 'hybrid').
   *  004: Derived from UnifiedAgentConfig. */
  isHybridMode?: boolean;
  /** In-memory venue instrument cache for symbol validation at decision intake */
  instrumentCache?: VenueInstrumentCache;
  /** 1inch operator-level config for network resolution in instrument validation */
  oneInchConfig?: { tokenSafetyNetwork?: string; chainId?: number };
  /** Binding-level profile for network resolution (carries chainId / network overrides) */
  bindingProfile?: Record<string, unknown> | null;
  /** Canonical token definitions for quote address validation on swap venues */
  canonicalTokens?: Record<string, Record<string, { address: string; name: string; aliases: string[] }>>;
  /** Interval in ms for the per-trade stop-loss / take-profit monitor loop (operator config) */
  perTradeLevelMonitorIntervalMs?: number;
  /** Callback invoked alongside journal.append for events the agent's circuit breaker should track.
   *  Caller (worker index.ts) wires this to publish to the agent's outbound stream. */
  onJournalEvent?: (event: { type: string; payload?: Record<string, unknown> }) => void;
  /** Operator-level max concurrent technical scans across all agents (per-worker in-memory gate). */
  maxConcurrentScans?: number;
  /** Redis store for scanner signal fingerprint read/write (fail-open when absent). */
  signalFingerprintStore?: SignalFingerprintStore;
  /** Operator config for scanner signal deduplication (fail-open when absent or disabled). */
  scannerSignalDedup?: {
    enabled: boolean;
    topN: number;
    confidenceBucketSize: number;
    ttlSeconds: number;
  };
  /** Persist scanner candidate observations for the deterministic review pre-check.
   *  Best-effort — failures must not crash the scan. */
  onPersistScanCandidates?: (candidates: PersistableScanCandidate[]) => Promise<void>;
  /** Persist a per-scan metrics row for scanner health and signal observability.
   *  Best-effort — failures must not crash the scan. */
  onPersistScanMetrics?: (metrics: ScanMetricInput) => Promise<void>;
  /** In-cycle retry config for transient candle fetch failures. Fail-open when absent. */
  candleFetchRetry?: RetryOptions;
  /** Cross-scan circuit breaker for symbols that fail every retry. Fail-open when absent. */
  candleFetchBreaker?: CandleFetchBreaker;
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
  private signerPresent = false;
  private privateStream?: Subscription;
  private liveOrderTimeoutTimer?: ReturnType<typeof setInterval>;
  private streamPool?: StreamPoolHandle;
  private streamMutationQueue = Promise.resolve();
  private liveOrderTimeoutScanRunning = false;
  private readonly timeoutRecoveryAlertedOrderIds = new Set<string>();

  /** Per-instrument market data feeds (created lazily on first trade) */
  private readonly instrumentFeeds = new Map<string, MarketDataFeed>();

  /** Per-instrument position tracking */
  private readonly positions = new Map<string, PositionState>();

  /** Per-instrument stop-loss exit timestamps (cooldown enforcement) */
  private readonly stopLossExits = new Map<string, number>();

  /** Per-instrument per-trade exit levels (stopLoss / takeProfit). Keyed by instrument identifier. */
  private readonly exitLevels = new Map<string, { stopLoss?: Price; takeProfit?: Price }>();

  /** Periodic timer that checks all per-trade stop-loss / take-profit levels */
  private perTradeLevelInterval?: ReturnType<typeof setInterval>;

  /** Instruments currently undergoing a stop-loss/take-profit exit (prevents double execution) */
  private readonly exitingInstruments = new Set<string>();

  /** Equity tracker (drawdown + dynamic equity) */
  private equityTracker?: EquityTracker;

  /** Rolling 24h loss tracker */
  private dailyLossTracker?: DailyLossTracker;

  /** Venue error circuit breaker */
  private circuitBreaker?: VenueCircuitBreaker;

  /** Swap fill projection tracker for actor-local swap accounting (swap venues only) */
  private swapPositionTracker?: SwapPositionTracker;
  /** Venue-specific confirmation poller for authoritative on-chain tx status checks */
  private swapConfirmationPoller?: SwapConfirmationPoller;
  /** Startup-only in-memory snapshot of pending live work before recovery decisions run */
  private startupPendingLiveSnapshot?: StartupPendingLiveSnapshot;
  /** True when swap live recovery enters an ambiguous state and intake must halt */
  private swapRecoveryHalted = false;
  private readonly swapRecoveryAlertedPlanIds = new Set<string>();
  /** Scan timer for the technical phase (runs when config.technicalConfig is present) */
  private technicalScanTimer?: ReturnType<typeof setInterval>;
  /** Latest technical scan results — forwarded to agent container for LLM context enrichment */
  private lastTechnicalScan?: TechnicalScanState;
  /** Phase 2: single-flight guard — prevents overlapping scans for the same actor. */
  private scanInProgress = false;
  /** Last reconciliation status for drift-only reconnect suppression. */
  private lastReconciliationStatus?: string;
  /** Whether the last reconciliation detected position changes (as opposed to balance-only drift). */
  private lastReconciliationHadPositionChange?: boolean;

  constructor(private readonly deps: AgentTradingActorDeps) {
    this.agentId = deps.agentId;
    this.logger = createLogger(`agent-actor-${deps.agentId.slice(0, 8)}`);
    this.streamPool = deps.streamPool;
    // Seed the global concurrency limit from operator config (first actor to start wins).
    if (deps.maxConcurrentScans !== undefined && globalMaxConcurrentScans === 0) {
      globalMaxConcurrentScans = deps.maxConcurrentScans;
    }
  }

  /**
   * Returns true when the last reconciliation detected drift but no position
   * changes. In this state, context snapshots carry no actionable difference
   * for the agent and would only trigger spurious LLM ticks through the
   * context-hash gate.
   */
  private isDriftOnlyReconnect(): boolean {
    return this.lastReconciliationStatus === 'drift_detected'
      && this.lastReconciliationHadPositionChange === false;
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
        this.executor = new PaperExecutor(deps.idGen, undefined, deps.feeConfig);
        await this.captureStartupPendingLiveSnapshot();
        await this.reconcileIncompletePlans();
        await this.rehydratePositions();
        await this.initializeRiskTrackers();
        this.startPerTradeLevelMonitor();
        // Ensure market data feeds are running for rehydrated open positions
        // so that per-trade level checks fire correctly on restart.
        for (const [symbol, pos] of this.positions) {
          // Defensive: rehydratePositions() only inserts non-flat positions,
          // but guard is retained for clarity.
          if (pos.side !== 'flat') {
            this.ensureMarketDataFeed(symbol);
          }
        }
        this.logger.info({ mode: 'paper', venue: deps.venue, venueType: deps.venueType }, 'Agent trading actor started');
        this.startTechnicalScanLoop();
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
        // Agents can start without pre-configured swapAssets — they decide
        // tokens dynamically via submit_decision. Decimals are resolved on-demand
        // at decision time by the swap adapter (fetches from on-chain / token
        // registry when a token is first encountered). Bots must have swapAssets
        // at creation (validated by BotConfigSchema).
        const result = await deps.venueAdapterFactory.buildSwapAdapter({
          venueAccountId: deps.venueAccountId,
          venue: deps.venue,
          swapAssets: deps.swapAssets,
          actorType: 'agent',
          actorId: deps.agentId,
        });
        this.swapVenue = result.swapVenue;
        this.signerPresent = result.signerPresent;
        this.swapConfirmationPoller = result.confirmationPoller ?? deps.swapConfirmationPoller;
        if (!deps.swapAssets) {
          this.logger.info({ venue: deps.venue, agentId: deps.agentId },
            'Agent started without pre-configured swapAssets — token pairs will be resolved from instrument at decision time');
        }
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
          signerPresent: this.signerPresent,
          driftAlertOnly: deps.driftAlertOnly ?? false,
          instanceMaxOrderNotional: deps.riskLimits.maxOrderNotional?.toString(),
        });
        if (liveGateResult.effectiveMaxOrderNotional) {
          deps.riskLimits = { ...deps.riskLimits, maxOrderNotional: liveGateResult.effectiveMaxOrderNotional };
        }
      }

      if (deps.executionMode === 'live') {
        if (deps.venueType === 'swap' && this.swapVenue) {
          this.executor = new SwapLiveExecutor({
            swapVenue: this.swapVenue,
            idGen: deps.idGen,
            clientOrderId: (planId, idx) => `agent:${deps.agentId.slice(0, 8)}:swap:${planId}:${idx}`,
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
        } else if (this.venuePort) {
          this.executor = new LiveExecutor({
            venuePort: this.venuePort,
            idGen: deps.idGen,
            clientOrderId: (planId, idx) => `agent:${deps.agentId.slice(0, 8)}:${planId}:${idx}`,
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
      } else if (this.venuePort || this.swapVenue) {
        this.executor = new ShadowExecutor(deps.idGen, this.createLazyShadowFeed(), this.swapVenue, deps.feeConfig);
      } else {
        this.executor = new PaperExecutor(deps.idGen, undefined, deps.feeConfig);
      }

      await this.captureStartupPendingLiveSnapshot();
      await this.reconcileIncompletePlans();
      await this.rehydratePositions();
      await this.initializeRiskTrackers();
      this.startPerTradeLevelMonitor();

      // Ensure market data feeds are running for all open positions so that
      // computeUnrealizedPnl and stop-loss checks work in live mode (not just shadow).
      for (const [symbol, pos] of this.positions) {
        // Defensive: rehydratePositions() only inserts non-flat positions,
        // but guard is retained for clarity.
        if (pos.side !== 'flat') {
          this.ensureMarketDataFeed(symbol);
        }
      }

      // Initialize the actor-local swap fill projection tracker (swap venues only)
      if (deps.venueType === 'swap') {
        this.swapPositionTracker = new SwapPositionTracker();
        await this.rehydrateSwapPositionTracker();
      }

      if (deps.reconciliationConfig) {
        await this.startReconciler();
      }

      await this.openPrivateStream();

      this.startLiveOrderTimeoutLoop();

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
      this.startTechnicalScanLoop();
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  private async captureStartupPendingLiveSnapshot(): Promise<void> {
    if (this.deps.executionMode !== 'live') {
      this.startupPendingLiveSnapshot = undefined;
      return;
    }

    const incompletePlans = await this.deps.planRepo.getIncomplete('agent', this.agentId);
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

  async stop(): Promise<void> {
    if (!this.running) return;

    if (this.reconciler) {
      this.reconciler.stop();
      this.reconciler = undefined;
    }

    if (this.privateStream) {
      await this.privateStream.unsubscribe();
      this.privateStream = undefined;
    }

    if (this.liveOrderTimeoutTimer) {
      clearInterval(this.liveOrderTimeoutTimer);
      this.liveOrderTimeoutTimer = undefined;
    }

    if (this.technicalScanTimer) {
      clearInterval(this.technicalScanTimer);
      this.technicalScanTimer = undefined;
    }

    if (this.perTradeLevelInterval) {
      clearInterval(this.perTradeLevelInterval);
      this.perTradeLevelInterval = undefined;
    }

    for (const feed of this.instrumentFeeds.values()) {
      feed.stop();
    }
    this.instrumentFeeds.clear();

    if (this.executor instanceof ShadowExecutor) {
      this.executor.dispose();
    }

    this.running = false;
    this.logger.info('Agent trading actor stopped');
  }

  private async crash(reason: Error): Promise<void> {
    if (!this.running) return;

    this.logger.error({ err: reason }, 'Agent trading actor crashing');

    const crashPolicy = this.deps.crashPolicy ?? 'alert_manual_intervention';
    let attemptedEmergencyGoFlat = 0;
    let emergencyGoFlatSucceeded = 0;
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
      const flattenResult = await this.tryEmergencyGoFlatAcrossPositions();
      attemptedEmergencyGoFlat = flattenResult.attempted;
      emergencyGoFlatSucceeded = flattenResult.succeeded;
    }

    await this.deps.journal.append({
      actorType: 'agent',
      actorId: this.agentId,
      type: 'instance.crashed',
      payload: {
        reason: reason.message,
        crashPolicy,
        attemptedEmergencyGoFlat,
        emergencyGoFlatSucceeded,
        cancelledOpenOrders,
        crashRecoveryAmbiguous,
        openSwapOrders,
        unresolvedSwapOrders,
        openPositionCount: [...this.positions.values()].filter((p) => p.side !== 'flat').length,
      },
    }).catch((err: unknown) => {
      this.logger.warn({ err }, 'Failed to append instance.crashed journal event');
    });

    await this.stop();

    if (this.deps.onCrashed) {
      await this.deps.onCrashed(reason);
    }
  }

  private async cancelOpenOrderbookOrdersOnCrash(): Promise<{ cancelledCount: number; ambiguous: boolean }> {
    if (!this.venuePort) {
      return { cancelledCount: 0, ambiguous: true };
    }

    const openOrders = await this.deps.orderRepo.getOpenByActorAndVenueAccount(
      'agent',
      this.agentId,
      this.deps.venueAccountId,
    );
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

      const cancelResult = await this.venuePort.cancelOrder({
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
    const openOrders = await this.deps.orderRepo.getOpenByActorAndVenueAccount(
      'agent',
      this.agentId,
      this.deps.venueAccountId,
    );
    if (openOrders.length === 0) {
      return { ambiguous: false, openSwapOrders: 0, unresolvedSwapOrders: 0 };
    }

    if (!this.swapVenue) {
      return { ambiguous: true, openSwapOrders: openOrders.length, unresolvedSwapOrders: openOrders.length };
    }

    const txResult = await this.swapVenue.fetchRecentTransactions();
    if (!txResult.ok) {
      await this.deps.journal.append({
        actorType: 'agent',
        actorId: this.agentId,
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
        actorType: 'agent',
        actorId: this.agentId,
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

  private async tryEmergencyGoFlatAcrossPositions(): Promise<{ attempted: number; succeeded: number }> {
    let attempted = 0;
    let succeeded = 0;

    for (const [instrumentId, position] of this.positions) {
      if (position.side === 'flat') continue;
      attempted++;

      const context = await this.getDecisionContext(instrumentId);
      if (!context) {
        this.logger.error({ instrumentId }, 'Crash policy auto_go_flat could not build decision context');
        continue;
      }

      const deps = this.buildIntakeDepsForStopLoss(instrumentId);
      if (!deps) continue;

      const decision: Decision = {
        id: this.deps.idGen.decisionId() as DecisionId,
        venueAccountId: this.deps.venueAccountId as VenueAccountId,
        instrumentId: instrumentId as InstrumentId,
        intent: 'go_flat',
        targetSize: quantity('0'),
        timestamp: new Date().toISOString(),
        actorType: 'agent',
        actorId: this.agentId,
        metadata: { trigger: 'crash_policy_auto_go_flat' },
      };

      try {
        const result = await submitDecisionForExecution(decision, context, position, deps);
        if (!result.executionFailed && result.position.side === 'flat') {
          this.positions.delete(instrumentId);
          this.exitLevels.delete(instrumentId);
          succeeded++;
        } else {
          this.positions.set(instrumentId, result.position);
        }
      } catch (err) {
        this.logger.error({ err, instrumentId }, 'Crash policy auto_go_flat failed for instrument');
      }
    }

    return { attempted, succeeded };
  }

  // --- ExecutionActor interface ---

  getIntakeDeps(instrumentId?: string): IntakeResult {
    if (!this.running || this.paused || !this.executor || !instrumentId) return undefined;
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

    // Stop-loss enforcement: check the requested instrument before accepting a new decision
    if (this.isStopLossTriggered(instrumentId)) {
      return {
        rejected: true,
        code: 'stop_loss_active',
        message: `Stop-loss cooldown active for ${instrumentId} — re-entry blocked`,
        retryable: false,
      };
    }

    const swapDecisionMetadata = this.buildSwapDecisionMetadata(instrumentId);

    // Require BASE/QUOTE instrument format for swap venues when no pre-configured
    // swapAssets exist. Agents must specify the pair explicitly so the system
    // never guesses which token is the quote side of a trade.
    if (this.deps.venueType === 'swap' && !this.deps.swapAssets && !swapDecisionMetadata?.swapAssets) {
      return {
        rejected: true,
        code: 'swap.instrument_format',
        message: `Swap venue requires instrument in BASE/QUOTE format (e.g. 'WETH/USDC' for 1inch on Base, 'SOL/USDC' for Jupiter on Solana). Got: '${instrumentId}'`,
        retryable: true,
      };
    }

    // Venue-specific instrument validation — replaces the generic hasSymbol() check
    // with rules that understand orderbook vs. swap venue semantics.
    if (this.deps.instrumentCache?.isReady()) {
      const validation = validateTradeInstrument(
        this.deps.venue,
        instrumentId,
        this.deps.instrumentCache,
        {
          oneInchConfig: this.deps.oneInchConfig,
          canonicalTokens: this.deps.canonicalTokens,
          bindingProfile: this.deps.bindingProfile,
        },
      );
      if (!validation.valid) {
        return {
          rejected: true,
          code: 'instrument_unknown',
          message: validation.reason ?? `'${instrumentId}' is not a recognized instrument on ${this.deps.venue}`,
          retryable: false,
        };
      }
    }

    // Compute per-instrument unrealized P&L; when unavailable (missing marks),
    // omit openPositions too to prevent single-mark cross-instrument mispricing.
    const precomputedPnl = this.computeUnrealizedPnl();
    const hasAccuratePnl = precomputedPnl !== undefined;

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
      equityTracker: this.equityTracker,
      dailyLossTracker: this.dailyLossTracker,
      openPositions: hasAccuratePnl ? [...this.positions.values()] : undefined,
      lastStopLossExitMs: this.stopLossExits.get(instrumentId),
      precomputedUnrealizedPnl: precomputedPnl,
      swapPositionTracker: this.swapPositionTracker,
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

  getPosition(instrumentId: string): PositionState;
  getPosition(instrumentId?: string): PositionState | undefined;
  getPosition(instrumentId?: string): PositionState | undefined {
    if (!instrumentId) return undefined;
    return this.positions.get(instrumentId) ?? flatPosition(this.deps.venue, instrumentId);
  }

  recordExecutionOutcome(success: boolean): void {
    if (!this.circuitBreaker) return;
    if (success) {
      this.circuitBreaker.recordSuccess();
    } else {
      const tripped = this.circuitBreaker.recordError();
      if (tripped) {
        this.logger.error({ errorCount: this.circuitBreaker.errorCount }, 'Circuit breaker tripped — halting execution');
        void this.deps.journal.append({
          actorType: 'agent',
          actorId: this.agentId,
          type: 'circuit_breaker.tripped' as JournalEventType,
          payload: { consecutiveErrors: this.circuitBreaker.errorCount },
        }).catch((e: unknown) => this.logger.warn({ err: e }, 'Failed to append circuit_breaker.tripped journal event'));
      }
    }
  }

  /** Record a stop-loss exit for cooldown enforcement */
  recordStopLossExit(instrumentId: string): void {
    this.stopLossExits.set(instrumentId, Date.now());
    void this.deps.journal.append({
      actorType: 'agent',
      actorId: this.agentId,
      type: 'stop_loss.exit' as JournalEventType,
      payload: { instrument: instrumentId, timestamp: Date.now() },
    }).catch((e: unknown) => this.logger.warn({ err: e }, 'Failed to append stop_loss.exit journal event'));
  }

  /** Hot-swap risk limits so runtime overrides take effect without restart. */
  updateRiskLimits(limits: RiskLimits): void {
    this.deps.riskLimits = limits;
  }

  /** Check if stop-loss threshold is breached for the given instrument. If triggered, fires async go_flat. */
  private isStopLossTriggered(instrumentId: string): boolean {
    const pct = this.deps.riskLimits.stopLossMaxUnrealizedLossPct;
    if (!this.equityTracker && this.exitLevels.size === 0) return false;
    if (!this.equityTracker && !this.exitLevels.has(instrumentId)) return false;

    const position = this.positions.get(instrumentId);
    if (!position || position.side === 'flat') return false;

    const feed = this.instrumentFeeds.get(instrumentId);
    const ticker = feed?.getTicker(instrumentId);
    if (!ticker) return false; // Cannot check without mark

    // Portfolio-level stop-loss check
    if (pct && pct > 0 && this.equityTracker) {
      const totalUnrealized = this.computeUnrealizedPnl();
      if (totalUnrealized !== undefined) {
        const equity = this.equityTracker.currentEquity(totalUnrealized);
        const slResult = checkStopLoss(
          { maxUnrealizedLossPct: pct },
          [{ instrument: instrumentId, position, markPrice: ticker.last, equity }],
        );

        if (slResult.triggered) {
          this.logger.warn(
            { instrument: slResult.instrument, loss: slResult.unrealizedLoss?.toString(), threshold: slResult.threshold?.toString() },
            'Agent stop-loss triggered — forcing go_flat',
          );
          void this.executeAgentStopLoss(instrumentId);
          return true;
        }
      }
    }

    // Per-trade stop-loss / take-profit check
    const exitLevels = this.exitLevels.get(instrumentId);
    if (exitLevels && (exitLevels.stopLoss || exitLevels.takeProfit)) {
      const check: PerTradeLevelCheck = {
        instrument: instrumentId,
        side: position.side as 'long' | 'short',
        markPrice: ticker.last,
        stopLoss: exitLevels.stopLoss,
        takeProfit: exitLevels.takeProfit,
      };
      const ptResult = checkPerTradeLevels([check]);
      if (ptResult.triggered && ptResult.reason) {
        const tag = ptResult.reason === 'stop_loss' ? 'per_trade_stop_loss' : 'per_trade_take_profit';
        this.logger.warn(
          { instrument: instrumentId, reason: ptResult.reason, markPrice: ptResult.markPrice?.toString(), level: ptResult.level?.toString() },
          `Per-trade ${ptResult.reason} triggered — forcing go_flat`,
        );
        // Prevent double execution: if the periodic monitor is already exiting, skip
        if (this.exitingInstruments.has(instrumentId)) return true;
        this.exitingInstruments.add(instrumentId);

        void this.deps.journal.append({
          actorType: 'agent',
          actorId: this.agentId,
          type: `${tag}.triggered`,
          payload: {
            instrument: instrumentId,
            markPrice: ptResult.markPrice?.toString(),
            level: ptResult.level?.toString(),
            timestamp: Date.now(),
          },
        }).catch((e: unknown) => this.logger.warn({ err: e }, `Failed to append ${tag}.triggered journal event`));
        void this.executeAgentStopLoss(instrumentId, {
          trigger: tag,
          instrument: instrumentId,
          markPrice: ptResult.markPrice?.toString(),
          level: ptResult.level?.toString(),
        }).finally(() => {
          this.exitingInstruments.delete(instrumentId);
        });
        return true;
      }
    }

    return false;
  }

  /** Execute a stop-loss go_flat decision for the agent */
  private async executeAgentStopLoss(instrumentId: string, metadataOverrides?: Record<string, unknown>): Promise<void> {
    if (!this.executor) return;
    const context = await this.getDecisionContext(instrumentId);
    if (!context) return;
    const position = this.getPosition(instrumentId);
    if (!position || position.side === 'flat') return;
    const deps = this.buildIntakeDepsForStopLoss(instrumentId);
    if (!deps) return;

    const decision: Decision = {
      id: this.deps.idGen.decisionId() as DecisionId,
      venueAccountId: this.deps.venueAccountId as VenueAccountId,
      instrumentId: instrumentId as InstrumentId,
      intent: 'go_flat',
      targetSize: quantity('0'),
      timestamp: new Date().toISOString(),
      actorType: 'agent',
      actorId: this.agentId,
      metadata: { trigger: 'stop_loss', ...metadataOverrides },
    };
    try {
      const result = await submitDecisionForExecution(decision, context, position, deps);
      if (!result.executionFailed && result.position.side === 'flat') {
        this.positions.delete(instrumentId);
        this.exitLevels.delete(instrumentId);
        this.recordStopLossExit(instrumentId);
      } else {
        this.positions.set(instrumentId, result.position);
      }
    } catch (err) {
      this.logger.error({ err, instrumentId }, 'Failed to execute agent stop-loss');
    }
  }

  /** Start a periodic timer that checks all per-trade stop-loss / take-profit levels. */
  private startPerTradeLevelMonitor(): void {
    if (this.perTradeLevelInterval) return; // already running
    const intervalMs = this.deps.perTradeLevelMonitorIntervalMs ?? 5_000;
    this.perTradeLevelInterval = setInterval(() => this.checkAllPerTradeLevels(), intervalMs);
  }

  /** Check all open positions with stored per-trade exit levels and execute stop-loss/TP if triggered. */
  private checkAllPerTradeLevels(): void {
    if (!this.running) return;
    if (this.exitLevels.size === 0) return;

    const checks: PerTradeLevelCheck[] = [];

    for (const [instrumentId, levels] of this.exitLevels) {
      if (!levels.stopLoss && !levels.takeProfit) continue;

      const position = this.positions.get(instrumentId);
      if (!position || position.side === 'flat') continue;

      const feed = this.instrumentFeeds.get(instrumentId);
      const ticker = feed?.getTicker(instrumentId);
      if (!ticker) continue;

      checks.push({
        instrument: instrumentId,
        side: position.side as 'long' | 'short',
        markPrice: ticker.last,
        stopLoss: levels.stopLoss,
        takeProfit: levels.takeProfit,
      });
    }

    if (checks.length === 0) return;

    const result = checkPerTradeLevels(checks);
    if (!result.triggered || !result.instrument || !result.reason) return;

    const tag = result.reason === 'stop_loss' ? 'per_trade_stop_loss' : 'per_trade_take_profit';

    this.logger.warn(
      { instrument: result.instrument, reason: result.reason, markPrice: result.markPrice?.toString(), level: result.level?.toString() },
      `Per-trade ${result.reason} triggered (periodic monitor) — forcing go_flat`,
    );

    // Prevent double execution: if the intake path is already exiting, skip
    if (this.exitingInstruments.has(result.instrument)) return;
    this.exitingInstruments.add(result.instrument);

    // Journal the trigger event
    void this.deps.journal.append({
      actorType: 'agent',
      actorId: this.agentId,
      type: `${tag}.triggered`,
      payload: {
        instrument: result.instrument,
        markPrice: result.markPrice?.toString(),
        level: result.level?.toString(),
        timestamp: Date.now(),
      },
    }).catch((e: unknown) => this.logger.warn({ err: e }, `Failed to append ${tag}.triggered journal event`));

    void this.executeAgentStopLoss(result.instrument, {
      trigger: tag,
      instrument: result.instrument,
      markPrice: result.markPrice?.toString(),
      level: result.level?.toString(),
    }).finally(() => {
      this.exitingInstruments.delete(result.instrument!);
    });
  }

  /** Build intake deps specifically for stop-loss execution (bypasses stop-loss check) */
  private buildIntakeDeps(instrumentId: string): DecisionIntakeDeps | undefined {
    if (!this.executor) return undefined;
    const swapDecisionMetadata = this.buildSwapDecisionMetadata(instrumentId);
    const precomputedPnl = this.computeUnrealizedPnl();
    const hasAccuratePnl = precomputedPnl !== undefined;

    return {
      actorType: 'agent',
      actorId: this.agentId,
      venue: this.deps.venue,
      symbol: instrumentId,
      instrumentId,
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
      equityTracker: this.equityTracker,
      dailyLossTracker: this.dailyLossTracker,
      openPositions: hasAccuratePnl ? [...this.positions.values()] : undefined,
      lastStopLossExitMs: this.stopLossExits.get(instrumentId),
      precomputedUnrealizedPnl: precomputedPnl,
      swapPositionTracker: this.swapPositionTracker,
    };
  }

  private buildIntakeDepsForStopLoss(instrumentId: string): DecisionIntakeDeps | undefined {
    return this.buildIntakeDeps(instrumentId);
  }

  private buildInstrumentExecutorDeps(instrumentId: string, snapshotPrice: string): InstrumentExecutorDeps | undefined {
    if (!this.executor) return undefined;
    return {
      venue: this.deps.venue,
      symbol: instrumentId,
      venueAccountId: this.deps.venueAccountId,
      executionMode: this.deps.executionMode,
      venueType: this.deps.venueType,
      venuePort: this.venuePort,
      swapVenue: this.swapVenue,
      riskLimits: this.deps.riskLimits,
      idGen: this.deps.idGen,
      fillRepo: this.deps.fillRepo,
      orderRepo: this.deps.orderRepo,
      positionRepo: this.deps.positionRepo,
      journal: this.deps.journal,
      snapshotPrice,
      equityTracker: this.equityTracker,
      dailyLossTracker: this.dailyLossTracker,
      openPositionCount: this.getOpenPositionCount(),
    };
  }

  /** Count of non-flat positions across all instruments */
  private getOpenPositionCount(): number {
    let count = 0;
    for (const pos of this.positions.values()) {
      if (pos.side !== 'flat') count++;
    }
    return count;
  }

  /** Compute total unrealized P&L using per-instrument mark prices from cached feeds */
  private computeUnrealizedPnl(): Price | undefined {
    if (this.positions.size === 0) return price('0');
    let total = price('0');
    for (const [instrumentId, pos] of this.positions) {
      if (pos.side === 'flat') continue;
      const feed = this.instrumentFeeds.get(instrumentId);
      const ticker = feed?.getTicker(instrumentId);
      if (!ticker) return undefined; // Cannot compute without mark — let fallback handle it
      total = total.plus(unrealizedPnl(pos, ticker.last));
    }
    return total;
  }

  get executionMode(): 'paper' | 'shadow' | 'live' {
    return this.deps.executionMode;
  }

  /** Returns the current technical config, or undefined if none is set. */
  getTechnicalConfig(): TechnicalConfig | undefined {
    return this.deps.technicalConfig;
  }

  getLastTechnicalScan(): TechnicalScanState | undefined {
    return this.lastTechnicalScan;
  }

  /**
   * Apply a pending config update (called by the worker after agent.config.update message).
   * - Updates technical scan loop if technical config changed.
   * - Execution mode changes are noted but require a restart to take full effect.
   *
   * @returns ok(undefined) when the config was applied, or err when the actor
   *          is not running and cannot accept the update.
   */
  applyPendingConfigUpdate(
    newConfig: { technical?: TechnicalConfig | null; execution?: { mode?: string } } | null,
  ): Result<void> {
    if (!this.running) {
      return err({ code: 'actor.not_running', message: 'Actor is not running' });
    }

    const newTechnical = newConfig?.technical ?? undefined;
    const currentTechnical = this.deps.technicalConfig;

    const technicalChanged = JSON.stringify(newTechnical) !== JSON.stringify(currentTechnical);
    if (technicalChanged) {
      // Clear existing scan loop
      if (this.technicalScanTimer) {
        clearInterval(this.technicalScanTimer);
        this.technicalScanTimer = undefined;
      }
      this.lastTechnicalScan = undefined;

      // Update deps and restart loop if new technical config is present
      this.deps.technicalConfig = newTechnical;
      if (this.deps.technicalConfig) {
        this.startTechnicalScanLoop();
      } else {
        this.logger.info('Technical scan loop stopped (technical config removed)');
      }
    }

    return ok(undefined);
  }

  async buildReconnectSnapshot(): Promise<ContextSnapshotPayload | undefined> {
    const snapshots = await this.buildReconnectSnapshots();
    return snapshots[0];
  }

  /** Build reconnect snapshots for ALL tracked instruments (positions + feeds). */
  async buildReconnectSnapshots(): Promise<ContextSnapshotPayload[]> {
    // Drift-only reconnect: suppress context snapshots to prevent spurious LLM ticks.
    // When the reconciler detects drift but positions haven't changed, a new snapshot
    // would only differ in fields the agent cannot meaningfully act on.
    if (this.isDriftOnlyReconnect()) {
      this.logger.debug('Drift-only reconnect detected — suppressing context snapshots');
      return [];
    }

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

    // Capture decimals before the early return so they survive TypeScript narrowing.
    const configuredDecimals = this.deps.swapAssets
      ? { baseDecimals: this.deps.swapAssets.baseDecimals, quoteDecimals: this.deps.swapAssets.quoteDecimals }
      : undefined;

    if (this.deps.swapAssets) {
      return {
        swapAssets: this.deps.swapAssets,
        swapBaseTokenAddress: this.deps.swapBaseTokenAddress ?? this.deps.swapAssets.baseAsset,
      };
    }

    // Parse instrument ID to extract addresses with correct semantics.
    // This preserves BOTH base and quote addresses — the old ad-hoc split
    // dropped the quote address (bug: rawQuoteAsset.split(':')[0] discarded QUOTE_ID).
    let parsed;
    try {
      parsed = parseSwapInstrumentId(instrumentId);
    } catch {
      // Malformed instrument ID — when only a base token is given (e.g. "ETH"
      // without "/USDC"), treat it as the swap base token address so token
      // safety always runs.
      return {
        swapBaseTokenAddress: this.deps.swapBaseTokenAddress ?? instrumentId,
      };
    }

    // Always populate both addresses when available so the pipeline can use
    // exact on-chain identities for swap execution.
    const swapAssets: { baseAsset: string; quoteAsset: string; baseDecimals?: number; quoteDecimals?: number } = {
      baseAsset: parsed.baseAddress ?? parsed.baseSymbol,
      quoteAsset: parsed.quoteAddress ?? parsed.quoteSymbol,
      ...configuredDecimals,
    };

    return {
      swapAssets,
      swapBaseTokenAddress: this.deps.swapBaseTokenAddress ?? swapAssets.baseAsset,
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
        // Shadow/paper modes use simulated fills — no real venue confirmations arrive
        // via the private stream, so disconnecting it shouldn't block decision intake.
        // The reconciler catches drift on its own schedule.
        if (!this.paused && this.deps.executionMode !== 'shadow' && this.deps.executionMode !== 'paper') {
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

  private startTechnicalScanLoop(): void {
    const { technicalConfig, discoverCandidates, fetchCandles } = this.deps;
    if (!technicalConfig || !discoverCandidates || !fetchCandles) {
      if (technicalConfig) {
        this.logger.warn(
          'Technical scan loop not started: discoverCandidates or fetchCandles not provided despite technical config being set',
        );
      }
      return;
    }

    const intervalMs = technicalConfig.scanIntervalMs;
    this.technicalScanTimer = setInterval(() => {
      void this.runTechnicalScan();
    }, intervalMs);
    this.technicalScanTimer.unref?.();
    this.logger.info({ intervalMs }, 'Technical scan loop started');
  }

  private async runTechnicalScan(): Promise<void> {
    const { technicalConfig, discoverCandidates, fetchCandles, agentId, venueAccountId } = this.deps;
    if (!technicalConfig || !discoverCandidates || !fetchCandles) return;
    if (!this.running) return;

    // Phase 2: global concurrency gate — skip if the per-worker active scan
    // count has reached the operator-configured maxConcurrentScans ceiling.
    if (globalMaxConcurrentScans > 0 && activeConcurrentScans >= globalMaxConcurrentScans) {
      this.logger.info(
        { activeConcurrentScans, max: globalMaxConcurrentScans },
        'Technical scan skipped — worker concurrency limit reached (capacity_unavailable)',
      );
      const capacityScan: TechnicalScanState = {
        timestamp: new Date().toISOString(),
        scanIntervalMs: technicalConfig.scanIntervalMs,
        regimeResult: null,
        signals: [],
        positionIndicators: [],
        summary: { scanned: 0, rejected: 0, passed: 0 },
        symbolOutcomes: [],
        discovered: 0,
        symbolsSelected: 0,
        eligible: 0,
        fetched: 0,
        unsupported: 0,
        fetchFailures: 0,
        signalsGenerated: 0,
        overlapSkipped: true,
        scannerHealth: { status: 'overlap_skipped', reason: 'Scan skipped — worker concurrency limit reached (capacity_unavailable)' },
      };
      this.lastTechnicalScan = capacityScan;
      if (this.deps.onTechnicalScanComplete) {
        await Promise.resolve(this.deps.onTechnicalScanComplete(agentId, capacityScan)).catch(() => {});
      }
      if (this.deps.onPersistScanMetrics) {
        try {
          const styleTier = deriveStyleTier(technicalConfig);
          await this.deps.onPersistScanMetrics({
            agentId,
            presetKey: (technicalConfig as Record<string, unknown>)['preset'] as string ?? 'unknown',
            presetBehaviorVersion: `ts-${styleTier}-v1`,
            venueFamily: deriveVenueFamily(technicalConfig),
            styleTier,
            scanScope: { discovered: 0, symbolsSelected: 0, eligible: 0, fetched: 0, scored: 0, signals: 0 },
            scannedAt: new Date().toISOString(),
            candidatesDiscovered: 0,
            candidatesScored: 0,
            signalsGenerated: 0,
            scanHealth: 'overlap_skipped',
            topConfidence: null,
            regimeBucket: 'unavailable',
          });
        } catch (_) { /* best-effort */ }
      }
      return;
    }

    // Phase 2: single-flight guard — skip if a scan is already in progress.
    if (this.scanInProgress) {
      this.logger.info('Technical scan skipped — previous scan still in progress (overlap_skipped)');
      // Emit an overlap-skipped scan state so operators can distinguish scheduler
      // outcomes from healthy no-signal scans.
      const overlapScan: TechnicalScanState = {
        timestamp: new Date().toISOString(),
        scanIntervalMs: technicalConfig.scanIntervalMs,
        regimeResult: null,
        signals: [],
        positionIndicators: [],
        summary: { scanned: 0, rejected: 0, passed: 0 },
        symbolOutcomes: [],
        discovered: 0,
        symbolsSelected: 0,
        eligible: 0,
        fetched: 0,
        unsupported: 0,
        fetchFailures: 0,
        signalsGenerated: 0,
        overlapSkipped: true,
        scannerHealth: { status: 'overlap_skipped', reason: 'Scan skipped — previous scan still in progress' },
      };
      this.lastTechnicalScan = overlapScan;
      if (this.deps.onTechnicalScanComplete) {
        await Promise.resolve(this.deps.onTechnicalScanComplete(agentId, overlapScan)).catch(() => {});
      }
      if (this.deps.onPersistScanMetrics) {
        try {
          const styleTier = deriveStyleTier(technicalConfig);
          await this.deps.onPersistScanMetrics({
            agentId,
            presetKey: (technicalConfig as Record<string, unknown>)['preset'] as string ?? 'unknown',
            presetBehaviorVersion: `ts-${styleTier}-v1`,
            venueFamily: deriveVenueFamily(technicalConfig),
            styleTier,
            scanScope: { discovered: 0, symbolsSelected: 0, eligible: 0, fetched: 0, scored: 0, signals: 0 },
            scannedAt: new Date().toISOString(),
            candidatesDiscovered: 0,
            candidatesScored: 0,
            signalsGenerated: 0,
            scanHealth: 'overlap_skipped',
            topConfidence: null,
            regimeBucket: 'unavailable',
          });
        } catch (_) { /* best-effort */ }
      }
      return;
    }

    this.scanInProgress = true;
    activeConcurrentScans++;
    try {
      const phaseResult = await runTechnicalPhase({
        config: technicalConfig,
        riskConfig: { ...(this.deps.technicalRiskConfig ?? {}), maxOpenPositions: this.deps.riskLimits.maxOpenPositions },
        agentId,
        venueAccountId,
        advisoryMode: !!this.deps.isHybridMode,
        discoverCandidates,
        fetchCandles,
        evaluateRegime: (params) => {
          const candleFetcher = (symbol: string) =>
            fetchCandles({ venueType: 'orderbook', providerSymbol: symbol }, technicalConfig.candles.interval, Math.max(200, technicalConfig.candles.limit));
          return evaluateRegime(params as RegimeParams, candleFetcher);
        },
        submitDecision: (decision) => this.executeTechnicalDecision(decision),
        getOpenPositions: () => [...this.positions.values()],
        generateDecisionId: () => this.deps.idGen.decisionId(),
        logger: this.logger,
        candleFetchRetry: this.deps.candleFetchRetry,
        candleFetchBreaker: this.deps.candleFetchBreaker,
        currentScanEpoch: Math.floor(Date.now() / technicalConfig.scanIntervalMs),
      });

      // ── Scanner signal dedup: suppress wake when fingerprint hasn't changed ──
      let wakeEmitter = this.deps.emitAgentWake;

      if (this.deps.scannerSignalDedup?.enabled && wakeEmitter) {
        const exitAdvisorySymbols = phaseResult.positionIndicators
          .filter((ind) => ind.exitAdvisory === true)
          .map((ind) => ind.symbol);

        const fingerprint = computeSignalFingerprint(
          phaseResult.signals,
          exitAdvisorySymbols,
          phaseResult.regimeResult?.pass ?? null,
          this.deps.scannerSignalDedup.topN,
          this.deps.scannerSignalDedup.confidenceBucketSize,
        );

        try {
          const key = scannerSignalFingerprintKey(agentId);
          const previous = await this.deps.signalFingerprintStore?.get(key);

          if (previous === fingerprint) {
            this.logger.debug({ agentId, fingerprint }, 'Scanner signals unchanged — suppressing wake');
            wakeEmitter = undefined;
          } else {
            await this.deps.signalFingerprintStore?.set(
              key,
              fingerprint,
              'EX',
              String(this.deps.scannerSignalDedup.ttlSeconds),
            );
          }
        } catch (err) {
          this.logger.warn({ err, agentId }, 'Scanner signal dedup failed — proceeding with wake');
        }
      }

      const scan = await completeTechnicalScan({
        phaseResult,
        technicalConfig,
        agentId,
        isHybridMode: !!this.deps.isHybridMode,
        onTechnicalScanComplete: this.deps.onTechnicalScanComplete,
        emitAgentWake: wakeEmitter,
        onJournalEvent: this.deps.onJournalEvent,
        onPersistScanCandidates: this.deps.onPersistScanCandidates
          ? async (candidates) => {
              try {
                await this.deps.onPersistScanCandidates!(candidates);
              } catch (err) {
                this.logger.warn({ err, count: candidates.length }, 'Failed to persist scan candidates — non-fatal');
              }
            }
          : undefined,
        onPersistScanMetrics: this.deps.onPersistScanMetrics
          ? async (metrics) => {
              try {
                await this.deps.onPersistScanMetrics!(metrics);
              } catch (err) {
                this.logger.warn({ err, agentId }, 'Failed to persist scan metrics — non-fatal');
              }
            }
          : undefined,
      });
      this.lastTechnicalScan = scan;
    } catch (err) {
      this.logger.error({ err }, 'Technical scan loop error — will retry on next tick');
    } finally {
      activeConcurrentScans = Math.max(0, activeConcurrentScans - 1);
      this.scanInProgress = false;
    }
  }

  private async executeTechnicalDecision(decision: Decision): Promise<void> {
    if (!this.executor || !this.running) return;

    const instrumentId = decision.instrumentId as unknown as string;
    const context = await this.getDecisionContext(instrumentId);
    if (!context) {
      this.logger.warn({ instrumentId }, 'Technical phase: could not build decision context — skipping');
      return;
    }

    const currentPosition = this.getPosition(instrumentId) ?? flatPosition(this.deps.venue, instrumentId);
    const executorDeps = this.buildInstrumentExecutorDeps(instrumentId, context.snapshot.price);
    if (!executorDeps) return;

    const result = await executeDecision(decision, currentPosition, {
      ...executorDeps,
      persistence: this.buildPersistence(instrumentId),
    });

    if (!result.error) {
      if (result.newPosition.side === 'flat') {
        this.positions.delete(instrumentId);
        this.exitLevels.delete(instrumentId);
      } else {
        this.positions.set(instrumentId, result.newPosition);
      }
    }
  }

  private startLiveOrderTimeoutLoop(): void {
    if (this.deps.executionMode !== 'live' || !this.deps.liveOrderTimeoutPolicy) {
      return;
    }

    const supportsTimeoutLoop =
      (this.deps.venueType === 'orderbook' && !!this.venuePort)
      || (this.deps.venueType === 'swap' && !!this.swapVenue);
    if (!supportsTimeoutLoop) {
      return;
    }

    const intervalMs = this.deps.liveOrderTimeoutPolicy.checkIntervalMs ?? 10_000;
    this.liveOrderTimeoutTimer = setInterval(() => {
      void this.enforceLiveOrderTimeouts();
    }, intervalMs);
    this.liveOrderTimeoutTimer.unref?.();
  }

  private async enforceLiveOrderTimeouts(): Promise<void> {
    if (this.liveOrderTimeoutScanRunning) return;
    if (!this.running || this.deps.executionMode !== 'live' || !this.deps.liveOrderTimeoutPolicy) return;

    this.liveOrderTimeoutScanRunning = true;
    try {
      if (this.deps.venueType === 'swap') {
        await this.enforceLiveSwapConfirmationRecovery();
        return;
      }

      if (!this.venuePort) return;

      const openOrders = await this.deps.orderRepo.getOpenByActorAndVenueAccount('agent', this.agentId, this.deps.venueAccountId);
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
          const cancelResult = await this.venuePort.cancelOrder({
            orderId: action.venueRefId as unknown as OrderId,
            symbol: action.symbol,
          });

          if (!cancelResult.ok) {
            await this.deps.journal.append({
              actorType: 'agent',
              actorId: this.agentId,
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
            actorType: 'agent',
            actorId: this.agentId,
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
          actorType: 'agent',
          actorId: this.agentId,
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
    } finally {
      this.liveOrderTimeoutScanRunning = false;
    }
  }

  private async enforceLiveSwapConfirmationRecovery(): Promise<void> {
    if (!this.swapVenue || !this.deps.liveOrderTimeoutPolicy) return;
    const swapVenue = this.swapVenue;

    const openOrders = await this.deps.orderRepo.getOpenByActorAndVenueAccount('agent', this.agentId, this.deps.venueAccountId);
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
    if (!this.swapConfirmationPoller) {
      const resolvedKnownTxRefs = await loadKnownTxRefs();
      if (!resolvedKnownTxRefs && txLookupError) {
        await this.deps.journal.append({
          actorType: 'agent',
          actorId: this.agentId,
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
      if (order.venueRefId && this.swapConfirmationPoller) {
        const confirmResult = await this.swapConfirmationPoller.checkConfirmation(order.venueRefId);
        if (confirmResult.ok && confirmResult.data.confirmed) {
          await this.finalizeConfirmedSwapOrder(order, confirmResult.data.actualOutputAmount?.toString(), confirmResult.data.timestamp);
          continue;
        }
        if (confirmResult.ok && confirmResult.data.failed) {
          // Definitively reverted on-chain — mark as rejected, no ambiguity
          await this.finalizeFailedSwapOrder(order);
          continue;
        }
        // If poller returns not confirmed (still pending) or errors, fall through to timeout check
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
      if (ageMs < timeoutMs) continue;

      const alertKey = order.executionPlanId ?? order.id;
      if (this.timeoutRecoveryAlertedOrderIds.has(alertKey)) continue;
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
    actualOutputAmount?: string,
    confirmedAt?: string,
  ): Promise<void> {
    const resolvedFillPrice = actualOutputAmount
      ? this.computeRecoveredFillPrice(order, actualOutputAmount)
      : (order.avgFillPrice ?? order.price ?? order.referencePrice);
    // For buy swaps, filledQuantity is the output asset received (base), not the planned quantity.
    // For sell swaps, filledQuantity is the input asset sold (base) = order.quantity.
    const resolvedFilledQuantity = order.filledQuantity && order.filledQuantity !== '0'
      ? order.filledQuantity
      : (actualOutputAmount && order.side === 'buy')
        ? actualOutputAmount
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
      const currentPosition = this.positions.get(order.symbol) ?? flatPosition(this.deps.venue, order.symbol);
      const fillEvt = {
        id: this.deps.idGen.fillId(),
        orderId: order.id as unknown as import('@herobids/domain').OrderId,
        venueAccountId: this.deps.venueAccountId,
        actorType: 'agent' as const,
        actorId: this.agentId,
        venueRefId: order.venueRefId ?? undefined,
        venue: this.deps.venue,
        symbol: order.symbol,
        side,
        quantity: quantity(resolvedFilledQuantity),
        price: price(resolvedFillPrice),
        fee: undefined,
        feeCurrency: undefined,
        filledAt: recoveredFillTimestamp,
      };

      const { position: nextPosition, realizedPnlDelta } = applyFillAccounting(currentPosition, fillEvt, {
        equityTracker: this.equityTracker,
        dailyLossTracker: this.dailyLossTracker,
      });

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
        orderId: order.id,
        venueAccountId: this.deps.venueAccountId,
        actorType: 'agent',
        actorId: this.agentId,
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

      await this.persistPrivateStreamPositionState(nextPosition);
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

    await this.tryCompletePlans();
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

  /**
   * Compute an effective fill price from the actual output amount returned by the confirmation poller.
   * Uses the same logic as SwapLiveExecutor: inputAmount / outputAmount.
   */
  private computeRecoveredFillPrice(
    order: { side: string; quantity: string; price?: string | null; referencePrice?: string | null },
    actualOutputAmount: string,
  ): string | undefined {
    try {
      const output = new Decimal(actualOutputAmount);
      if (output.isZero()) return order.price ?? order.referencePrice ?? undefined;
      // For buy: fill price = inputAmount / outputAmount (cost per unit received)
      // For sell: fill price = outputAmount / inputAmount (proceeds per unit sold)
      // We use referencePrice * quantity as estimated input when actual input is unavailable
      const qty = new Decimal(order.quantity);
      if (qty.isZero()) return undefined;
      if (order.side === 'buy') {
        // output = base received, input was quote spent ≈ referencePrice * outputAmount at quote time
        // best we can do: recompute from the reference price context
        return output.isZero() ? undefined : order.referencePrice ?? order.price ?? undefined;
      }
      // sell: output is quote received, input was base sold
      return output.div(qty).toString();
    } catch {
      return order.price ?? order.referencePrice ?? undefined;
    }
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
    const currentPosition = this.positions.get(fill.symbol) ?? flatPosition(this.deps.venue, fill.symbol);
    const fillEvt = {
      id: this.deps.idGen.fillId(),
      orderId: fill.orderId as unknown as import('@herobids/domain').OrderId,
      venueAccountId: this.deps.venueAccountId,
      actorType: 'agent' as const,
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
    };

    const { position: nextPosition, realizedPnlDelta } = applyFillAccounting(currentPosition, fillEvt, {
      equityTracker: this.equityTracker,
      dailyLossTracker: this.dailyLossTracker,
    });

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
      realizedPnlDelta: realizedPnlDelta.toString(),
      filledAt: new Date(fill.filledAt),
    });

    await this.persistPrivateStreamPositionState(nextPosition);

    await this.maybeEmitLiveSlippageAlert(fill);

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
      ? flatPosition(this.deps.venue, pos.symbol, existing?.instrumentId)
      : {
          venue: this.deps.venue,
          symbol: pos.symbol,
          side: pos.side,
          size: new Decimal(pos.size),
          entryPrice: new Decimal(pos.entryPrice),
          realizedPnl: existing?.realizedPnl ?? new Decimal(0),
          instrumentId: existing?.instrumentId,
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
      this.exitLevels.delete(position.symbol);
    } else {
      this.positions.set(position.symbol, position);
      // Ensure a market data feed is running for this instrument (needed for
      // unrealized P&L and stop-loss checks in live mode).
      this.ensureMarketDataFeed(position.symbol);
    }

    await this.deps.positionRepo.upsert({
      venueAccountId: this.deps.venueAccountId,
      actorType: 'agent',
      actorId: this.agentId,
      venue: position.venue,
      symbol: position.symbol,
      instrumentId: position.instrumentId ?? undefined,
      side: position.side,
      size: position.size.toString(),
      entryPrice: position.entryPrice.toString(),
      realizedPnl: position.realizedPnl.toString(),
    });
  }

  private async maybeEmitLiveSlippageAlert(fill: {
    orderId: string;
    venueRefId?: string;
    symbol: string;
    side: 'buy' | 'sell';
    price: string;
  }): Promise<void> {
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
      actorType: 'agent',
      actorId: this.agentId,
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

    if (!this.venuePort && !this.swapVenue) {
      this.logger.warn(
        { symbol },
        'ensureMarketDataFeed: no venue connection available — feed will not receive live prices (paper mode)',
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

    if (mode === 'paper') {
      // Paper mode: no venue to reconcile against — mark all as failed
      for (const plan of incomplete) {
        await this.deps.planRepo.markFailed(plan.id);
      }
      return;
    }

    // Live/shadow swap venues: check on-chain transactions for confirmation
    if (!venuePort && this.swapVenue) {
      await this.reconcileIncompleteSwapPlans(incomplete);
      return;
    }

    if (!venuePort) {
      // No venue port and no swap venue — cannot reconcile
      for (const plan of incomplete) {
        await this.deps.planRepo.markFailed(plan.id);
      }
      this.logger.warn('No venue port for plan reconciliation — marked all incomplete plans failed');
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
            actorType: 'agent',
            actorId: this.agentId,
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
              actorType: 'agent',
              actorId: this.agentId,
              type: 'execution.failure',
              payload: {
                reason: 'live_recovery_ambiguous',
                planId: plan.id,
                recoveryReason: decision.reason,
              },
            });
            this.logger.warn({ planId: plan.id, reason: decision.reason }, 'Incomplete plan recovery is ambiguous — leaving plan executing for manual intervention');
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
   * Recover incomplete swap plans by checking on-chain transaction status.
   *
   * Uses the confirmation poller (authoritative) as the primary check for orders
   * with a venueRefId (tx hash). Falls back to fetchRecentTransactions as supplementary
   * evidence when the poller is unavailable.
   */
  private async reconcileIncompleteSwapPlans(incomplete: Array<{ id: string; status: string; plannedOrders: unknown; createdAt: Date }>): Promise<void> {
    // Build supplementary evidence from fetchRecentTransactions (used when poller unavailable
    // or for plans with no persisted orders)
    const txResult = await this.swapVenue!.fetchRecentTransactions();
    const knownTxRefs = new Set<string>();
    let txLookupFailed = false;
    if (txResult.ok) {
      for (const tx of txResult.data) {
        knownTxRefs.add(tx.executionRef);
      }
    } else {
      txLookupFailed = true;
      this.logger.warn('Could not fetch recent swap transactions for crash recovery');
      if (!this.swapConfirmationPoller) {
        // No poller and no tx list — cannot determine swap state
        for (const plan of incomplete) {
          if (this.deps.executionMode === 'live') {
            await this.haltSwapRecovery(plan.id, {
              reason: 'live_swap_recovery_ambiguous',
              detail: 'transaction_lookup_failed',
              code: txResult.error.code,
              message: txResult.error.message,
            });
          } else {
            await this.deps.planRepo.markFailed(plan.id);
          }
        }
        return;
      }
    }

    for (const plan of incomplete) {
      try {
        const planOrders = await this.deps.orderRepo.getByExecutionPlanId(plan.id);

        if (planOrders.length === 0) {
          // No order rows persisted — crash may have occurred after on-chain confirmation
          // but before persistOrder. Check if any recent transaction matches the plan's
          // expected swap params to avoid marking a completed swap as failed.
          if (!txLookupFailed) {
            const matchedTx = this.matchPlanToRecentTransactions(plan, txResult.ok ? txResult.data : []);
            if (matchedTx) {
              await this.deps.planRepo.markCompleted(plan.id);
              this.logger.error(
                { planId: plan.id, executionRef: matchedTx.executionRef },
                'RECOVERY: Swap plan has no persisted orders but matching on-chain transaction found — ' +
                'marked completed to prevent double-execution. Order/fill/position state is incomplete and needs manual reconciliation.',
              );
              continue;
            }
          }
          if (this.deps.executionMode === 'live') {
            await this.haltSwapRecovery(plan.id, {
              reason: 'live_swap_recovery_ambiguous',
              detail: 'no_persisted_orders_and_no_matching_transaction',
            });
          } else {
            await this.deps.planRepo.markFailed(plan.id);
            this.logger.info({ planId: plan.id }, 'No orders were submitted for incomplete swap plan — marked failed');
          }
          continue;
        }

        // Primary: use confirmation poller for orders with a venueRefId (authoritative)
        let confirmedViaPoller = false;
        let failedViaPoller = false;
        if (this.swapConfirmationPoller) {
          for (const order of planOrders) {
            if (!order.venueRefId) continue;
            const confirmResult = await this.swapConfirmationPoller.checkConfirmation(order.venueRefId);
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
          // Transaction definitively reverted — mark plan as failed (no ambiguity)
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
        const confirmedViaTxList = !confirmedViaPoller && !txLookupFailed
          && planOrders.some((o) => o.venueRefId && knownTxRefs.has(o.venueRefId));

        if (confirmedViaPoller || confirmedViaTxList) {
          await this.deps.planRepo.markCompleted(plan.id);
          this.logger.info({ planId: plan.id, source: confirmedViaPoller ? 'confirmation_poller' : 'recent_transactions' },
            'Incomplete swap plan confirmed on-chain — marked completed');
        } else {
          if (this.deps.executionMode === 'live') {
            await this.haltSwapRecovery(plan.id, {
              reason: 'live_swap_recovery_ambiguous',
              detail: 'order_not_confirmed_on_chain',
            });
          } else {
            await this.deps.planRepo.markFailed(plan.id);
            this.logger.info({ planId: plan.id }, 'Incomplete swap plan not found on-chain — marked failed');
          }
        }
      } catch (err) {
        if (this.deps.executionMode === 'live') {
          await this.haltSwapRecovery(plan.id, {
            reason: 'live_swap_recovery_ambiguous',
            detail: 'recovery_exception',
            error: err instanceof Error ? err.message : String(err),
          });
        } else {
          await this.deps.planRepo.markFailed(plan.id);
          this.logger.error({ err, planId: plan.id }, 'Error reconciling incomplete swap plan');
        }
      }
    }
  }

  private async haltSwapRecovery(planId: string, details: Record<string, unknown>): Promise<void> {
    this.swapRecoveryHalted = true;
    if (this.swapRecoveryAlertedPlanIds.has(planId)) return;
    this.swapRecoveryAlertedPlanIds.add(planId);

    await this.deps.journal.append({
      actorType: 'agent',
      actorId: this.agentId,
      type: 'execution.failure',
      payload: {
        planId,
        ...details,
      },
    });
    this.logger.error({ planId, ...details }, 'Swap recovery ambiguity detected — halting agent intake for manual intervention');
  }

  /**
   * Attempt to match a plan (with no persisted orders) to a recent on-chain transaction
   * by comparing the plan's swap params against transaction input/output assets.
   * This covers the crash window: after chain confirmation but before order persistence.
   */
  private matchPlanToRecentTransactions(
    plan: { id: string; plannedOrders: unknown; createdAt: Date },
    recentTxs: Array<{ executionRef: string; inputAsset: string; outputAsset: string; timestamp: string }>,
  ): { executionRef: string } | undefined {
    const plannedOrders = plan.plannedOrders as Array<{ swapParams?: { inputAsset: string; outputAsset: string } }> | undefined;
    if (!plannedOrders || plannedOrders.length === 0) return undefined;

    const planCreatedAt = plan.createdAt.getTime();
    // Only consider transactions within a reasonable window after plan creation (5 minutes)
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
            instrumentId: pos.instrumentId ?? undefined,
          });
          // Read exit levels directly from the position row (persisted at fill time).
          if (pos.stopLoss || pos.takeProfit) {
            this.exitLevels.set(pos.symbol, {
              stopLoss: pos.stopLoss ? new Decimal(pos.stopLoss) : undefined,
              takeProfit: pos.takeProfit ? new Decimal(pos.takeProfit) : undefined,
            });
          }
        }
      }
      if (this.positions.size > 0) {
        this.logger.info({ count: this.positions.size }, 'Rehydrated agent positions from DB');
      }
      if (this.exitLevels.size > 0) {
        this.logger.info({ count: this.exitLevels.size }, 'Rehydrated per-trade exit levels from positions');
      }
    } catch (err) {
      this.logger.error({ err }, 'Failed to rehydrate agent positions — starting flat');
    }
  }

  /** Replay historical fills into the swap position tracker to rebuild expected holdings on restart. */
  private async rehydrateSwapPositionTracker(): Promise<void> {
    if (!this.swapPositionTracker || !this.deps.swapAssets) return;
    try {
      const fills = await this.deps.fillRepo.getRecentByActorAndVenueAccount(
        'agent',
        this.agentId,
        this.deps.venueAccountId,
      );
      // Sort oldest-first for correct accumulation
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

    // Rehydrate fee-adjusted realized P&L from fills for equity tracker (venue-account-scoped)
    let economicRealizedPnl = price('0');
    try {
      const total = await this.deps.fillRepo.sumRealizedPnlDeltaByVenueAccount('agent', this.agentId, this.deps.venueAccountId);
      economicRealizedPnl = price(total);
    } catch (err) {
      this.logger.warn({ err }, 'Failed to rehydrate economic realized P&L — falling back to position sum');
      economicRealizedPnl = [...this.positions.values()].reduce(
        (sum, p) => sum.plus(p.realizedPnl),
        price('0'),
      );
    }
    this.equityTracker = new EquityTracker(capital, economicRealizedPnl);

    // Rehydrate rolling 24h losses from persisted fills (venue-account-scoped)
    try {
      const since = new Date(Date.now() - 86_400_000);
      const fills = await this.deps.fillRepo.getRecentByActorAndVenueAccount('agent', this.agentId, this.deps.venueAccountId, since);
      if (fills.length > 0) {
        const sorted = [...fills].sort((a, b) => a.filledAt.getTime() - b.filledAt.getTime());
        rehydrateDailyLoss(sorted, this.dailyLossTracker);
      }
    } catch (err) {
      this.logger.warn({ err }, 'Failed to rehydrate daily loss tracker — starting fresh');
    }
  }

  private async startReconciler(): Promise<void> {
    const { venuePort, reconciliationConfig } = { venuePort: this.venuePort, reconciliationConfig: this.deps.reconciliationConfig };
    if (!venuePort && !this.swapVenue) return;

    const fetchVenueState = venuePort
      ? createOrderbookVenueStateLoader(venuePort, this.logger)
      : createSwapVenueStateLoader(this.swapVenue!, this.logger);

    // Seed initial balance snapshot on first boot to prevent false drift from empty local state.
    // Runs in all execution modes (including shadow/paper) so the balance tracker has a baseline.
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

    // Shadow/paper mode — positions are synthetic and never sent to the venue.
    // There is nothing to reconcile against real venue state. Skipping avoids
    // false-positive reconciliation.drift_detected events every pass.
    // (Matches the same guard in bot TradingActor.startReconciler.)
    if (this.deps.executionMode === 'shadow' || this.deps.executionMode === 'paper') return;

    if (!reconciliationConfig) return;

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
        // Track actual reconciliation outcome for isDriftOnlyReconnect().
        this.lastReconciliationStatus = result.status;
        this.lastReconciliationHadPositionChange = result.diffs?.some(
          (d: { type?: string }) => d.type === 'position_mismatch',
        ) ?? false;

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
      // Wrap journal to feed the agent's session circuit breaker via onJournalEvent.
      // Reconciliation events (drift, match) are emitted by the engine Reconciler
      // and need to be forwarded to the agent's outbound stream for breaker tracking.
      journal: this.deps.onJournalEvent
        ? {
            append: async (entry) => {
              await this.deps.journal.append(entry);
              // Forward reconciliation event types to the breaker callback.
              if (typeof entry.type === 'string' && entry.type.startsWith('reconciliation.')) {
                this.deps.onJournalEvent?.({ type: entry.type, payload: entry.payload as Record<string, unknown> });
              }
            },
            appendBatch: async (entries) => {
              await this.deps.journal.appendBatch(entries);
              for (const entry of entries) {
                if (typeof entry.type === 'string' && entry.type.startsWith('reconciliation.')) {
                  this.deps.onJournalEvent?.({ type: entry.type, payload: entry.payload as Record<string, unknown> });
                }
              }
            },
          }
        : this.deps.journal,
      actorType: 'agent',
      actorId: this.agentId,
      venueAccountId: this.deps.venueAccountId,
      balanceDiffMode: this.deps.venueType === 'swap' ? 'observational' : 'authoritative',
      logger: this.logger,
      isShadowOrPaper: false,
      getLastReconciledAt: () => this.deps.reconciliationRepo.getLastReconciledAtForInstance(this.deps.venueAccountId),
    });

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

    if (firstResult.status === 'observed_variance') {
      this.logger.info(
        { diffCount: firstResult.diffs.length, diffs: firstResult.diffs },
        'Observed shared-wallet balance variance on startup — proceeding',
      );
      return;
    }

    // If drift is detected (exceeds threshold) and we are NOT in alert-only mode, block trading.
    // Exception: shadow/paper mode — orphaned local positions (venue has no matching position)
    // are auto-closed because no real trades happen on the venue. Only balance mismatches
    // and venue-only positions (someone else trading on the shared account) remain actionable.
    if (firstResult.status === 'drift_detected' && !reconciliationConfig.driftAlertOnly) {
      const isShadowOrPaper = false;

      if (isShadowOrPaper) {
        // Delegate orphaned-position auto-close to the shared cleanup helper.
        // Returns any remaining non-orphaned diffs that still need action.
        const otherDiffs = await cleanupOrphanedPositions(firstResult.diffs, {
          positionRepo: this.deps.positionRepo,
          venueAccountId: this.deps.venueAccountId,
          actorType: 'agent',
          actorId: this.agentId,
          venue: this.deps.venue,
          logger: this.logger,
        });

        // If there are still other actionable diffs, block trading
        if (otherDiffs.length > 0) {
          this.reconciler.stop();
          this.logger.error(
            { diffCount: otherDiffs.length, diffs: otherDiffs },
            'Reconciliation drift detected on startup (non-orphaned diffs) — blocking trading',
          );
          throw new Error(`Reconciliation drift detected: ${otherDiffs.length} non-orphaned diff(s). Trading blocked.`);
        }

        // All diffs were orphaned positions — cleanup helper already logged, proceed
        return;
      }

      // Live mode or unhandled mode — block trading
      this.reconciler.stop();
      this.logger.error(
        { diffCount: firstResult.diffs.length, diffs: firstResult.diffs },
        'Reconciliation drift detected on startup — blocking trading',
      );
      throw new Error(`Reconciliation drift detected: ${firstResult.diffs.length} diff(s). Trading blocked.`);
    }
  }

  private buildPersistence(_instrumentId: string): TradingCyclePersistence {
    // Stash per-trade exit levels from persistDecision so persistPosition can
    // upsert into the exitLevels map once the final position is known.
    let pendingExitLevels: { stopLoss?: Price; takeProfit?: Price } | null = null;

    return {
      persistDecision: async (decision) => {
        if (decision.stopLoss || decision.takeProfit) {
          pendingExitLevels = {
            stopLoss: decision.stopLoss,
            takeProfit: decision.takeProfit,
          };
        }
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
          stopLoss: decision.stopLoss?.toString(),
          takeProfit: decision.takeProfit?.toString(),
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
        await this.maybeEmitLiveSwapExecutionQualityAlert({
          venueRefId: fill.venueRefId,
          symbol: fill.symbol,
          side: fill.side,
          price: fill.price,
        });
      },
      persistPosition: async (pos) => {
        // Preserve the existing instrumentId from the in-memory position if the engine
        // didn't carry one (e.g. decision-based fills where the engine is symbol-only).
        const existingInstrumentId = pos.instrumentId ?? this.positions.get(pos.symbol)?.instrumentId;
        await this.deps.positionRepo.upsert({
          ...pos,
          actorType: pos.actorType ?? 'agent',
          actorId: pos.actorId ?? this.agentId,
          instrumentId: existingInstrumentId ?? undefined,
          ...(pendingExitLevels != null ? {
            ...(pendingExitLevels.stopLoss !== undefined ? { stopLoss: pendingExitLevels.stopLoss.toString() } : {}),
            ...(pendingExitLevels.takeProfit !== undefined ? { takeProfit: pendingExitLevels.takeProfit.toString() } : {}),
          } : {}),
        });
        // Keep in-memory positions map in sync
        if (pos.side === 'flat') {
          this.positions.delete(pos.symbol);
          this.exitLevels.delete(pos.symbol);
          pendingExitLevels = null;
        } else {
          this.positions.set(pos.symbol, {
            venue: pos.venue,
            symbol: pos.symbol,
            side: pos.side as 'long' | 'short',
            size: new Decimal(pos.size),
            entryPrice: new Decimal(pos.entryPrice),
            realizedPnl: new Decimal(pos.realizedPnl),
            instrumentId: existingInstrumentId ?? undefined,
          });
          // Upsert per-trade exit levels from the accepted decision (if any).
          // When a new decision with levels comes in for an already-open position,
          // this UPDATEs the entry (the agent can tighten or widen stops).
          if (pendingExitLevels) {
            this.exitLevels.set(pos.symbol, pendingExitLevels);
            pendingExitLevels = null;
          }
          // Ensure a market data feed is running for unrealized P&L and stop-loss checks
          this.ensureMarketDataFeed(pos.symbol);
        }
      },
      persistOrder: async (order) => {
        const payload = {
          ...order,
          actorType: order.actorType ?? 'agent',
          actorId: order.actorId ?? this.agentId,
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
      actorType: 'agent',
      actorId: this.agentId,
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
}
