export { canTransition, isTerminal } from './order-state.js';
export type { ManagedOrder, FillEvent, OrderTransition, LiveSubmissionState } from './order-state.js';

export { OrderManager } from './order-manager.js';
export type { OrderManagerDeps, OrderManagerError, CreateOrderParams, AcknowledgeParams, ApplyFillParams } from './order-manager.js';

export { decideOrderUpdateAction } from './order-update-decision.js';
export type { OrderUpdateRequest, OrderUpdateAction } from './order-update-decision.js';

export { planDecision } from './planner.js';
export type { ExecutionPlan, PlanAction, PlannedOrder, PlannerDeps } from './planner.js';

export type { Executor, ExecutionResult, EngineError } from './executor.js';

export { PaperExecutor } from './paper-executor.js';
export type { IdGenerator } from './paper-executor.js';

export { ShadowExecutor } from './shadow-executor.js';

export { LiveExecutor } from './live-executor.js';
export type { LiveExecutorDeps } from './live-executor.js';

export { computeLiveTimeoutActions } from './live-timeout-manager.js';
export type { LiveTimeoutPolicy, LiveTimeoutOrder, LiveTimeoutAction } from './live-timeout-manager.js';

export { evaluateOrderbookRecovery } from './live-recovery.js';
export type { LiveRecoveryOrder, LiveRecoveryMatchedOrder, EvaluateOrderbookRecoveryInput, LiveRecoveryDecision, LiveRecoveryReason } from './live-recovery.js';

export { SwapLiveExecutor } from './swap-live-executor.js';
export type { SwapLiveExecutorDeps } from './swap-live-executor.js';

export { SwapPositionTracker } from './swap-position-tracker.js';
export type { SwapAssetProjection, SwapFill, SwapBalanceVariance } from './swap-position-tracker.js';

export { PollingMarketDataFeed } from './market-data-feed.js';
export type { MarketDataFeed, TickerSnapshot, TradeEvent, TradeHandler } from './market-data-feed.js';

export { StreamMarketDataFeed } from './stream-market-data-feed.js';
export type { StreamPoolHandle, TickerFetcher } from './stream-market-data-feed.js';

export { LastFillMarkSource, MarkSelector, createFillFirstMarkSource } from './mark-source.js';
export type { FillLookup, FillRecord, MarkSelectorConfig } from './mark-source.js';

export { flatPosition, applyFill, unrealizedPnl, totalUnrealizedPnl } from './position-tracker.js';
export type { PositionState } from './position-tracker.js';

export { applyFillAccounting } from './fill-accounting.js';
export type { FillAccountingResult } from './fill-accounting.js';

export { EquityTracker } from './equity-tracker.js';
export { DailyLossTracker } from './daily-loss-tracker.js';
export { rehydrateDailyLoss } from './rehydrate-daily-loss.js';
export type { StoredFill } from './rehydrate-daily-loss.js';
export { checkStopLoss, checkPerTradeLevels } from './stop-loss-monitor.js';
export type { StopLossConfig, StopLossCheck, StopLossResult, PerTradeLevelCheck, PerTradeLevelResult } from './stop-loss-monitor.js';
export { validatePerTradeLevels } from './per-trade-level-validator.js';
export type { LevelValidationInput, LevelValidationError } from './per-trade-level-validator.js';
export { VenueCircuitBreaker } from './circuit-breaker.js';
export { simulateFee, applyPaperSlippage } from './fee-simulator.js';
export type { FeeSimulatorConfig } from './fee-simulator.js';

export { checkRisk } from './risk-gate.js';
export type { RiskError, RiskLimits, RiskSnapshot, RiskCheckResult } from './risk-gate.js';

export { decisionEvent, planEvent, orderEvent, fillEvent, riskEvent, liveBlockedEvent, liveArmedEvent, orderSubmittedToVenueEvent, orderAcknowledgedEvent, fillConfirmedFromStreamEvent, completionRecoveredEvent, slippageAlertEvent, computeSlippageBps, credentialCreatedEvent, credentialRotatedEvent, credentialDeletedEvent, credentialDecryptedEvent, credentialUsedEvent } from './journal.js';
export type { Journal, JournalEntry, JournalEventType, LiveBlockedPayload, LiveArmedPayload, OrderSubmittedToVenuePayload, OrderAcknowledgedPayload, FillConfirmedFromStreamPayload, CompletionRecoveredPayload, SlippageAlertPayload, CredentialCreatedPayload, CredentialRotatedPayload, CredentialDeletedPayload, CredentialDecryptedPayload, CredentialUsedPayload } from './journal.js';

export { InMemoryJournal } from './journal-memory.js';

export { runTradingCycle, realClock } from './trading-cycle.js';
export type {
  Clock,
  TradingCycleDeps,
  TradingCyclePersistence,
  TradingCycleResult,
  InsertPlanParams,
  PersistFillParams,
  PersistPositionParams,
  PersistOrderParams,
} from './trading-cycle.js';

export { computeDecisionContextHash, DecisionContextHashMismatchError, DECISION_CONTEXT_HASH_MISMATCH_CODE } from './decision-context-hash.js';

export { submitDecisionForExecution } from './decision-intake.js';
export type { DecisionIntakeDeps, DecisionIntakeResult, DecisionContext, PreExecutionRejection } from './decision-intake.js';

export { executeDecision } from './instrument-executor.js';
export type { InstrumentExecutorDeps, InstrumentExecutionResult } from './instrument-executor.js';

export { reconcile, reconcileWithThresholds, Reconciler, createOrderbookVenueStateLoader, createSwapVenueStateLoader } from './reconciliation/index.js';
export type {
  LocalState,
  VenueState,
  LocalPosition,
  LocalBalance,
  LocalFill,
  LocalOrder,
  ReconciliationResult,
  ReconciliationStatus,
  Diff,
  DiffType,
  DiffSeverity,
  DriftCategory,
  DriftThresholds,
  ReconcilerConfig,
  ReconcilerDeps,
  ReconcilerHealth,
  VenueStateLoader,
} from './reconciliation/index.js';
