export { canTransition, isTerminal } from './order-state.js';
export type { ManagedOrder, FillEvent } from './order-state.js';

export { OrderManager } from './order-manager.js';
export type { OrderManagerError, CreateOrderParams, AcknowledgeParams, ApplyFillParams } from './order-manager.js';

export { planDecision } from './planner.js';
export type { ExecutionPlan, PlanAction, PlannedOrder, PlannerDeps } from './planner.js';

export type { Executor, ExecutionResult, EngineError } from './executor.js';

export { PaperExecutor } from './paper-executor.js';
export type { IdGenerator } from './paper-executor.js';

export { ShadowExecutor } from './shadow-executor.js';

export { PollingMarketDataFeed } from './market-data-feed.js';
export type { MarketDataFeed, TickerSnapshot, TradeEvent, TradeHandler } from './market-data-feed.js';

export { StreamMarketDataFeed } from './stream-market-data-feed.js';
export type { StreamPoolHandle, TickerFetcher } from './stream-market-data-feed.js';

export { LastFillMarkSource, MarkSelector } from './mark-source.js';
export type { FillLookup, FillRecord, MarkSelectorConfig } from './mark-source.js';

export { flatPosition, applyFill } from './position-tracker.js';
export type { PositionState } from './position-tracker.js';

export { checkRisk } from './risk-gate.js';
export type { RiskError, RiskLimits, RiskSnapshot, RiskCheckResult } from './risk-gate.js';

export { decisionEvent, planEvent, orderEvent, fillEvent, riskEvent } from './journal.js';
export type { Journal, JournalEntry, JournalEventType } from './journal.js';

export { InMemoryJournal } from './journal-memory.js';

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
  DriftThresholds,
  ReconcilerConfig,
  ReconcilerDeps,
  VenueStateLoader,
} from './reconciliation/index.js';
