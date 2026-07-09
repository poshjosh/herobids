import type { CapabilityReadiness, RuntimeDescriptor, RuntimeDescriptorUpdatePayload, ReminderWakeContext, WatchThresholdWakeContext, DiscoveryDeltaWakeContext, RegimeChangeWakeContext, ScannerWakeContext, MarketDiscoveryDetectedPayload, MarketRegimeChangedPayload, EconomicEvent } from '@herobids/domain';
import { formatAgentGoalLiteralBlock, AgentWakePayloadSchema, INSTANCE_MESSAGE_TYPES } from '@herobids/domain';
import crypto from 'node:crypto';
import type { RegimeResult } from '@herobids/market-data';
import type { ScoredSignal } from '@herobids/strategy';
import type { PromptTimingContext } from './prompt-timing-context.js';
import { formatPromptTimingContextLines } from './prompt-timing-context.js';
import type { PositionIndicatorUpdate } from './technical-phase.js';
import type { WatchInstrumentIdentity, WatchPurpose, WatchCoverageLink } from './watch-types.js';
import type { CoverageEvaluationResult } from './position-coverage.js';
import { fmtUsd } from './fmt.js';

type FreshnessState = 'fresh' | 'stale' | 'unavailable';

export interface RuntimeFreshness {
  state: FreshnessState;
  ageMs?: number;
  provider?: string;
  note?: string;
}

export interface RuntimePortfolioSummary {
  exposureUsd: number | null;
  realizedPnlUsd: number | null;
  unrealizedPnlUsd: number | null;
  drawdownPct: number | null;
  availableCapitalUsd: number | null;
  netDelta: number | null;
  freshness: RuntimeFreshness;
}

export interface RuntimePositionSnapshot {
  instrumentId: string;
  side: string;
  size: string;
  entryPrice: string | null;
  unrealizedPnlUsd: number | null;
  openedAt: string | null;
  holdDurationMinutes: number | null;
  venueType: 'perps' | 'dex' | 'unknown';
  freshness: RuntimeFreshness;
}

export interface RuntimeEventSummary {
  type: string;
  summary: string;
  createdAt: string;
}

export interface RuntimeReminderContext {
  wakeId: string;
  reminderId: string | null;
  message: string;
  requestedAt: string | null;
  scheduledBy: 'scout' | 'judge';
}

export interface RuntimeMarketWakeContext {
  wakeId: string;
  source: 'watch_threshold' | 'discovery_delta' | 'regime_change' | 'scanner';
  reason: string;
  requestedAt: string | null;
  context: WatchThresholdWakeContext | DiscoveryDeltaWakeContext | RegimeChangeWakeContext | ScannerWakeContext;
}

export interface RuntimeVenueSignal {
  kind: 'perps' | 'dex';
  instrument: string;
  venue: string;
  fields: Array<{ label: string; value: string }>;
  freshness: RuntimeFreshness;
}

export interface RuntimeActiveWatch {
  watchId: string;
  symbol: string;
  chain: string;
  address?: string;
  resolvedSymbol?: string;
  resolvedChain?: string;
  resolvedAddress?: string;
  condition: 'above' | 'below';
  thresholdPrice: number;
  note?: string;
  lastConditionMet: boolean | null;
  lastCheckedAt?: string;
  /** Semantic purpose — tells the runtime what this watch is for. */
  purpose?: WatchPurpose;
  /** Schema version discriminator from the canonical WatchEntry. */
  schemaVersion?: number;
  /** Links this watch to a specific actor, position, or intent group. */
  coverage?: WatchCoverageLink;
  /** Canonical venue + instrument identity resolved from the trading system's instrument repository. */
  instrument?: WatchInstrumentIdentity;
}

export interface RuntimeActiveWatchSummary {
  totalCount: number;
  uniqueCount: number;
  lines: string[];
  overflowCount: number;
}

export interface RuntimeMarketSnapshot {
  symbol: string | null;
  price: number | null;
  freshness: RuntimeFreshness;
}

export interface TechnicalScanState {
  timestamp: string;
  scanIntervalMs: number;
  regimeResult: RegimeResult | null;
  signals: ScoredSignal[];
  positionIndicators: PositionIndicatorUpdate[];
  summary: { scanned: number; rejected: number; passed: number };
}

export interface RuntimeSessionCosts {
  llmTokensUsed: number;
  hiddenReasoningTokensUsed: number;
  llmCostUsd: number;
  estimatedServerCostUsdPerHour: number;
}

export interface RuntimePerformanceInputs {
  startingCapitalUsd: number | null;
  winRate: number | null;
  riskAdjustedReturn: number | null;
  drawdownPct: number | null;
  netPnlUsd: number | null;
  peakEquityUsd: number | null;
}

export interface RuntimeQueuedWakeSignal {
  source: string;
  reason: string;
  receivedAt: number;
}

/** Pending market-monitor context-only events (no agent.wake). Accumulated between ticks. */
export interface PendingMarketEvent {
  eventId: string;
  type: 'market.discovery.detected' | 'market.regime.changed';
  receivedAt: number;
  payload: MarketDiscoveryDetectedPayload | MarketRegimeChangedPayload;
}

export type ActivityTimelineEvent =
  | { kind: 'USER'; text: string; timestamp: number }
  | { kind: 'MEMORY'; key: string; value: string; timestamp: number }
  | { kind: 'DECISION'; text: string; timestamp: number };

export interface RuntimeSessionMetrics {
  decisionsSubmitted: number;
  decisionsAccepted: number;
  decisionsRejected: number;
  lastPnlSummary: string | null;
  lastPositionSide: string | null;
  currentReminder: RuntimeReminderContext | null;
  currentMarketWake: RuntimeMarketWakeContext | null;
  degradedCapabilities: Array<{ dependency: string; summary: string; guidance: string }>;
  managedBots: Array<{ id: string; status: string; strategyPreset?: string; symbol?: string }> | null;
  market: RuntimeMarketSnapshot;
  portfolio: RuntimePortfolioSummary;
  openPositions: RuntimePositionSnapshot[];
  activeWatches: RuntimeActiveWatch[];
  activeWatchSummary: RuntimeActiveWatchSummary | null;
  recentEvents: RuntimeEventSummary[];
  venueSignals: RuntimeVenueSignal[];
  regime: {
    result: RegimeResult | null;
    freshness: RuntimeFreshness;
  };
  sessionCosts: RuntimeSessionCosts;
  performance: RuntimePerformanceInputs;
  lastTechnicalScan?: TechnicalScanState;
  /** Agent memory snapshot loaded at tick start. Null until first load. */
  agentMemory: Record<string, { value: unknown; updatedAt?: string }> | null;
  /** Queued wake signals received between ticks. Drained at tick start. */
  queuedWakeSignals: RuntimeQueuedWakeSignal[];
  /** Chronological activity timeline interleaving user messages, memory writes, and decisions. */
  activityTimeline: ActivityTimelineEvent[];
  /** Position coverage evaluation from structured watch metadata (purpose, instrument, coverage links). */
  positionCoverage: CoverageEvaluationResult | null;
  /** Pending market-monitor context-only events (no agent.wake). Accumulated between ticks. */
  pendingMarketContext: PendingMarketEvent[];
  /** Upcoming economic events for context injection. Null when calendar is disabled or unavailable. */
  macroEvents: EconomicEvent[] | null;
}

export interface RuntimeCompositionState {
  runtimeDescriptor: RuntimeDescriptor;
  sessionStartMs: number;
  tickCount: number;
  context: RuntimeCompositionContext;
  metrics: RuntimeSessionMetrics;
}

export interface RuntimeCompositionContext {
  workspaceRoot: string | null;
}

export interface RuntimeContextBlock {
  id: string;
  title: string;
  content: string;
  provider: string;
}

export interface PromptEnrichmentPolicy {
  memory: { enabled: boolean; maxInlineKeys: number };
  judgeHistory: { hybridMaxResponses: number; tickMaxDisplayed: number };
  configReference: { enabled: boolean };
  queuedSignals: { enabled: boolean; max: number };
  wakeEmphasis: { enabled: boolean };
  activityTimeline: { enabled: boolean; maxEvents: number };
}

export interface RuntimeContextProvider {
  id: string;
  costTier: 'free' | 'cheap' | 'expensive';
  section: 'static' | 'dynamic';
  requiredFamilies: string[];
  trimOrder: number;
  preserveWhenTrimmed?: boolean;
  build: (state: RuntimeCompositionState, policy?: PromptEnrichmentPolicy) => RuntimeContextBlock | null;
}

const DEFAULT_SERVER_COST_PER_HOUR_USD = 0.02;
const MAX_RECENT_EVENTS = 6;
const MAX_ACTIVE_WATCHES_IN_CONTEXT = 10;
const MAX_ACTIVE_WATCH_NOTE_CHARS = 40;
const DEFAULT_MAX_SIGNALS_IN_CONTEXT = 10;

export function buildTechnicalContextBlock(
  scan: TechnicalScanState,
  config?: { maxSignalsInContext?: number },
): string | null {
  const ageMs = Date.now() - Date.parse(scan.timestamp);
  if (ageMs > 2 * scan.scanIntervalMs) {
    return null;
  }

  const maxSignals = config?.maxSignalsInContext ?? DEFAULT_MAX_SIGNALS_IN_CONTEXT;
  const topSignals = scan.signals.slice(0, maxSignals);

  if (topSignals.length === 0 && scan.regimeResult === null && scan.positionIndicators.length === 0) {
    return null;
  }

  const lines: string[] = [];
  lines.push('## Technical Scan Results');

  const regimePart = scan.regimeResult !== null
    ? `Regime: ${scan.regimeResult.pass ? 'PASS' : 'BLOCK'} (ADX ${scan.regimeResult.details.adxValue.toFixed(0)}, ${scan.regimeResult.details.emaAlignment} alignment)`
    : 'Regime: not evaluated';
  lines.push(`Last scan: ${scan.timestamp} | ${regimePart}`);

  if (topSignals.length > 0) {
    lines.push('');
    lines.push('### Top Signals (ranked by confidence)');
    lines.push('| Symbol | Confidence | RSI | MACD | Volume | CHOCH | Reasons |');
    lines.push('|--------|-----------|-----|------|--------|-------|---------|');
    for (const signal of topSignals) {
      const rsiStr = signal.indicators.rsi !== undefined ? String(signal.indicators.rsi.toFixed(0)) : '—';
      const macdStr = signal.indicators.macdHistogram === undefined
        ? '—'
        : signal.indicators.macdHistogram > 0
          ? '+bullish crossover'
          : signal.indicators.macdHistogram < 0
            ? '—bearish'
            : '—';
      const volStr = signal.indicators.volumeRatio !== undefined
        ? `${signal.indicators.volumeRatio.toFixed(1)}x`
        : '—';
      const chochStr = signal.indicators.choch ? signal.indicators.choch : '—';
      const reasons = signal.reasons.join(', ');
      lines.push(`| ${signal.symbol} | ${signal.confidence.toFixed(2)} | ${rsiStr} | ${macdStr} | ${volStr} | ${chochStr} | ${reasons} |`);
    }
  }

  const { scanned, rejected, passed } = scan.summary;
  lines.push('');
  lines.push(`### Rejected\n${scanned} instruments scanned, ${rejected} rejected (${passed} passed filters)`);

  if (scan.positionIndicators.length > 0) {
    const openIndicators = scan.positionIndicators.filter((p) => p.side === 'long');
    if (openIndicators.length > 0) {
      lines.push('');
      lines.push('### Open Positions (indicator update)');
      lines.push('| Symbol | Side | Entry | RSI | Signal |');
      lines.push('|--------|------|-------|-----|--------|');
      for (const ind of openIndicators) {
        const entryStr = ind.entryPrice !== undefined ? `$${ind.entryPrice.toFixed(4)}` : '—';
        const rsiStr = ind.rsi !== undefined ? String(ind.rsi.toFixed(0)) : '—';
        const noteStr = ind.signalNote ?? '—';
        lines.push(`| ${ind.symbol} | ${ind.side} | ${entryStr} | ${rsiStr} | ${noteStr} |`);
      }
    }
  }

  return lines.join('\n');
}

function unavailableFreshness(note: string): RuntimeFreshness {
  return { state: 'unavailable', note };
}

function freshFreshness(provider?: string): RuntimeFreshness {
  return { state: 'fresh', provider };
}

function watchPriority(watch: RuntimeActiveWatch): number {
  if (watch.lastConditionMet === true) {
    return 0;
  }
  if (watch.lastConditionMet === null) {
    return 1;
  }
  return 2;
}

function compareWatchEntries(left: RuntimeActiveWatch, right: RuntimeActiveWatch): number {
  return watchPriority(left) - watchPriority(right)
    || left.chain.localeCompare(right.chain)
    || left.symbol.localeCompare(right.symbol)
    || left.condition.localeCompare(right.condition)
    || left.thresholdPrice - right.thresholdPrice;
}

function watchSummaryKey(watch: RuntimeActiveWatch): string {
  return JSON.stringify([
    watch.chain,
    watch.symbol,
    watch.condition,
    watch.thresholdPrice,
  ]);
}

function mergeWatchEntry(existing: { watch: RuntimeActiveWatch; count: number }, incoming: RuntimeActiveWatch): void {
  existing.count += 1;

  const existingPriority = watchPriority(existing.watch);
  const incomingPriority = watchPriority(incoming);

  if (incomingPriority < existingPriority) {
    existing.watch = {
      ...incoming,
      note: incoming.note ?? existing.watch.note,
      lastCheckedAt: incoming.lastCheckedAt ?? existing.watch.lastCheckedAt,
    };
    return;
  }

  if (!existing.watch.note && incoming.note) {
    existing.watch = {
      ...existing.watch,
      note: incoming.note,
    };
  }

  if (!existing.watch.lastCheckedAt && incoming.lastCheckedAt) {
    existing.watch = {
      ...existing.watch,
      lastCheckedAt: incoming.lastCheckedAt,
    };
  }
}

function formatWatchNote(note: string | undefined): string {
  if (!note) {
    return '';
  }

  const compactNote = note.replace(/\s+/g, ' ').trim();
  if (compactNote.length <= MAX_ACTIVE_WATCH_NOTE_CHARS) {
    return compactNote;
  }

  return `${compactNote.slice(0, MAX_ACTIVE_WATCH_NOTE_CHARS - 1)}…`;
}

function formatWatchStatus(lastConditionMet: boolean | null): string {
  if (lastConditionMet === true) {
    return 'met';
  }
  if (lastConditionMet === false) {
    return 'not_met';
  }
  return 'unknown';
}

export function summarizeActiveWatches(watches: RuntimeActiveWatch[]): RuntimeActiveWatchSummary {
  const grouped = new Map<string, { watch: RuntimeActiveWatch; count: number }>();

  for (const watch of watches) {
    const key = watchSummaryKey(watch);
    const existing = grouped.get(key);
    if (existing) {
      mergeWatchEntry(existing, watch);
      continue;
    }
    grouped.set(key, { watch, count: 1 });
  }

  const orderedGroups = [...grouped.values()].sort((left, right) => compareWatchEntries(left.watch, right.watch));
  const visibleGroups = orderedGroups.slice(0, MAX_ACTIVE_WATCHES_IN_CONTEXT);
  const overflowCount = Math.max(0, orderedGroups.length - visibleGroups.length);

  return {
    totalCount: watches.length,
    uniqueCount: grouped.size,
    overflowCount,
    lines: visibleGroups.map(({ watch, count }) => {
      const status = formatWatchStatus(watch.lastConditionMet);
      const countSuffix = count > 1 ? ` x${count}` : '';
      const noteSuffix = formatWatchNote(watch.note);
      const noteSegment = noteSuffix ? ` — ${noteSuffix}` : '';
      const purposePrefix = watch.purpose?.trim() ? `[${watch.purpose}] ` : '';
      return `${purposePrefix}${watch.symbol} (${watch.chain}) ${watch.condition} $${watch.thresholdPrice} status=${status}${countSuffix}${noteSegment}`;
    }),
  };
}

function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 'unavailable';
  }
  // Use compact format for values >= 10,000 to save tokens
  if (Math.abs(value) >= 10_000) return fmtUsd(value);
  return `$${value.toFixed(2)}`;
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 'unavailable';
  }
  return `${value.toFixed(2)}%`;
}

function formatUsdAmount(raw: string | null | undefined): string {
  if (!raw) return '$0.00';
  const n = Number(raw);
  if (!Number.isFinite(n)) return `$${raw}`;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatFreshness(freshness: RuntimeFreshness): string {
  if (freshness.state === 'unavailable') {
    return freshness.note ? `unavailable (${freshness.note})` : 'unavailable';
  }

  if (freshness.state === 'stale') {
    const ageLabel = freshness.ageMs !== undefined
      ? `stale ${Math.max(1, Math.round(freshness.ageMs / 60_000))}m`
      : 'stale';
    return freshness.note ? `${ageLabel} (${freshness.note})` : ageLabel;
  }

  return freshness.provider ? `fresh via ${freshness.provider}` : 'fresh';
}

function trimText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function pushRecentEvent(state: RuntimeCompositionState, type: string, summary: string): void {
  state.metrics.recentEvents.push({
    type,
    summary,
    createdAt: new Date().toISOString(),
  });
  while (state.metrics.recentEvents.length > MAX_RECENT_EVENTS) {
    state.metrics.recentEvents.shift();
  }
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const match = value.match(/-?\d+(?:\.\d+)?/);
    if (match) {
      const parsed = Number(match[0]);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
  return null;
}

function normalizeWinRatePercent(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }

  if (value >= 0 && value <= 1) {
    return value * 100;
  }

  return value;
}

function refreshDerivedPerformanceInputs(state: RuntimeCompositionState): void {
  const netPnlUsd = (state.metrics.portfolio.realizedPnlUsd ?? 0) + (state.metrics.portfolio.unrealizedPnlUsd ?? 0);
  state.metrics.performance.netPnlUsd = netPnlUsd;

  const currentEquityUsd = (state.metrics.portfolio.availableCapitalUsd ?? 0) + (state.metrics.portfolio.exposureUsd ?? 0);
  if (state.metrics.performance.startingCapitalUsd === null && currentEquityUsd > 0) {
    state.metrics.performance.startingCapitalUsd = Math.max(currentEquityUsd - netPnlUsd, 0.01);
  }

  const startingCapitalUsd = state.metrics.performance.startingCapitalUsd;
  const elapsedHours = Math.max((Date.now() - state.sessionStartMs) / 3_600_000, 1 / 60);
  if (currentEquityUsd > 0) {
    state.metrics.performance.peakEquityUsd = Math.max(state.metrics.performance.peakEquityUsd ?? currentEquityUsd, currentEquityUsd);
    if (state.metrics.performance.peakEquityUsd > 0) {
      state.metrics.performance.drawdownPct = ((currentEquityUsd - state.metrics.performance.peakEquityUsd) / state.metrics.performance.peakEquityUsd) * 100;
    }
  }
  if (startingCapitalUsd !== null && startingCapitalUsd > 0) {
    const pnlReturnPct = (netPnlUsd / startingCapitalUsd) * 100;
    state.metrics.performance.riskAdjustedReturn = pnlReturnPct / Math.sqrt(elapsedHours);
  }
}

function inferVenueType(state: RuntimeCompositionState, instrumentId: string): RuntimePositionSnapshot['venueType'] {
  const tradingConnections = state.runtimeDescriptor.grantedConnectionsByFamily['trading'] ?? [];
  const providers = new Set(tradingConnections.map((connection) => connection.provider.toLowerCase()));
  const hasPerpsBindings = providers.has('hyperliquid') || providers.has('bybit');
  const hasDexBindings = providers.has('jupiter') || providers.has('1inch');

  if (hasDexBindings && !hasPerpsBindings) {
    return 'dex';
  }

  if (hasPerpsBindings && !hasDexBindings) {
    return 'perps';
  }

  if (/[/:]/.test(instrumentId)) {
    return 'dex';
  }

  if (/perp/i.test(instrumentId)) {
    return 'perps';
  }

  return 'unknown';
}

function formatVisibleTools(runtimeDescriptor: RuntimeDescriptor): string {
  const tools = new Set<string>();
  for (const skill of runtimeDescriptor.resolvedSkills) {
    for (const tool of skill.requiredTools) {
      tools.add(tool);
      if (tools.size >= runtimeDescriptor.budgets.maxVisibleToolSchemas) {
        break;
      }
    }
    if (tools.size >= runtimeDescriptor.budgets.maxVisibleToolSchemas) {
      break;
    }
  }
  return [...tools].join(', ') || 'none';
}

function hasTradingCapability(runtimeDescriptor: RuntimeDescriptor): boolean {
  if ((runtimeDescriptor.grantedConnectionsByFamily['trading']?.length ?? 0) > 0) {
    return true;
  }

  if (runtimeDescriptor.readinessByFamily['trading']) {
    return true;
  }

  return runtimeDescriptor.resolvedSkills.some((skill) => skill.capabilityFamilies.includes('trading'));
}

const WORKSPACE_CONTEXT_TOOL_NAMES = new Set([
  'execute_code',
  'read_file',
  'list_files',
  'write_file',
  'delete_file',
]);

function hasVisibleWorkspacePathTooling(state: RuntimeCompositionState): boolean {
  return getVisibleToolNames(state).some((tool) => WORKSPACE_CONTEXT_TOOL_NAMES.has(tool));
}

function renderReadinessLine(family: string, readiness: CapabilityReadiness): string {
  const connectionSuffix = readiness.connectionId ? ` connection=${readiness.connectionId}` : '';
  const reasonSuffix = readiness.reasons.length > 0 ? ` reasons=${readiness.reasons.join('; ')}` : '';
  return `${family}: ${readiness.state} (${readiness.agentEligibility}${connectionSuffix}${reasonSuffix})`;
}

const PROVIDER_VENUE_DETAILS: Record<string, { type: string; tradeInstrumentHint: string }> = {
  hyperliquid: {
    type: 'perpetuals',
    tradeInstrumentHint: 'trade instruments use base tickers (e.g. "BTC", "SOL")',
  },
  bybit: {
    type: 'perpetuals',
    tradeInstrumentHint: 'trade instruments use base tickers (e.g. "BTC", "ETH")',
  },
  jupiter: {
    type: 'swap / DEX',
    tradeInstrumentHint: 'trade instruments use pair symbols (e.g. "SOL/USDC", "ETH/USDC")',
  },
  '1inch': {
    type: 'swap / DEX',
    tradeInstrumentHint: 'trade instruments use pair symbols (e.g. "ETH/USDC", "WBTC/USDC")',
  },
};

function formatTradingVenueLine(provider: string): string {
  const details = PROVIDER_VENUE_DETAILS[provider.toLowerCase()];
  if (!details) {
    return `- ${provider} (unknown)`;
  }
  return `- ${provider} (${details.type}) — ${details.tradeInstrumentHint}`;
}

function getEffectiveTradingConnections(state: RuntimeCompositionState): typeof state.runtimeDescriptor.grantedConnectionsByFamily[string] {
  const connections = state.runtimeDescriptor.grantedConnectionsByFamily['trading'] ?? [];
  const executableConnections = connections.filter((connection) => connection.readiness.effectiveReady);
  if (executableConnections.length <= 1) return executableConnections;

  const defaultConnectionId = state.runtimeDescriptor.defaultConnectionByFamily['trading'];
  if (defaultConnectionId) {
    const defaultConnection = executableConnections.find((connection) => connection.connectionId === defaultConnectionId);
    if (defaultConnection) return [defaultConnection];
  }

  const defaultConnection = executableConnections.find((connection) => connection.isDefault);
  if (defaultConnection) return [defaultConnection];

  // No explicit default metadata — surface all executable connections rather than guessing.
  return executableConnections;
}

function computePerformanceSummary(state: RuntimeCompositionState): string {
  const elapsedHours = Math.max(0, (Date.now() - state.sessionStartMs) / 3_600_000);
  const llmCost = state.metrics.sessionCosts.llmCostUsd;
  const serverCost = elapsedHours * state.metrics.sessionCosts.estimatedServerCostUsdPerHour;
  const netPnlUsd = state.metrics.performance.netPnlUsd
    ?? ((state.metrics.portfolio.realizedPnlUsd ?? 0) + (state.metrics.portfolio.unrealizedPnlUsd ?? 0));
  const netAfterCosts = netPnlUsd - llmCost - serverCost;
  const winRate = state.metrics.performance.winRate;
  const startingCapital = state.metrics.performance.startingCapitalUsd;
  const pnlReturnPct = startingCapital && startingCapital > 0 ? (netPnlUsd / startingCapital) * 100 : null;
  const riskAdjustedReturn = state.metrics.performance.riskAdjustedReturn
    ?? (pnlReturnPct !== null && elapsedHours > 0 ? pnlReturnPct / Math.sqrt(elapsedHours) : null);
  const drawdownPct = state.metrics.performance.drawdownPct ?? state.metrics.portfolio.drawdownPct;

  const pnlScore = pnlReturnPct === null ? 0.5 : Math.max(0, Math.min(1, (pnlReturnPct + 5) / 10));
  const winRateScore = winRate === null ? 0.5 : Math.max(0, Math.min(1, winRate / 100));
  const riskAdjustedScore = riskAdjustedReturn === null ? 0.5 : Math.max(0, Math.min(1, (riskAdjustedReturn + 1) / 3));
  const drawdownScore = drawdownPct === null ? 0.5 : Math.max(0, Math.min(1, 1 - Math.abs(drawdownPct) / 10));
  const weightedScore = (pnlScore * 0.4) + (winRateScore * 0.2) + (riskAdjustedScore * 0.2) + (drawdownScore * 0.2);
  const performanceScore = Math.max(1, Math.min(10, Math.round(weightedScore * 10)));
  const durationMinutes = Math.round((Date.now() - state.sessionStartMs) / 60_000);
  const durationLabel = durationMinutes >= 60
    ? `${Math.floor(durationMinutes / 60)}h ${durationMinutes % 60}m`
    : `${durationMinutes}m`;

  return [
    '## Performance Summary',
    `Net P&L (after estimated costs): ${formatCurrency(netAfterCosts)}`,
    `LLM cost this session: ${formatCurrency(llmCost)}`,
    `Estimated server cost: ${formatCurrency(serverCost)}`,
    `Win rate: ${winRate === null ? 'unavailable' : `${winRate.toFixed(0)}%`}`,
    `Session duration: ${durationLabel}`,
    `Performance score: ${performanceScore}/10`,
  ].join('\n');
}

/**
 * Produces a stable digest from pending market context events.
 * Only hashes type + eventId pairs for stability — NOT timestamps.
 * Returns "__none__" when the buffer is empty.
 */
export function computeMarketEventDigest(events: PendingMarketEvent[]): string {
  if (events.length === 0) return '__none__';
  const normalized = events.map(e => ({ type: e.type, eventId: e.eventId }));
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export const RUNTIME_CONTEXT_PROVIDERS: RuntimeContextProvider[] = [
  {
    id: 'core-platform',
    costTier: 'free',
    section: 'static',
    requiredFamilies: [],
    trimOrder: 0,
    preserveWhenTrimmed: true,
    build: (state) => ({
      id: 'corePlatformContext',
      title: 'Core Platform',
      provider: 'core-platform',
      content: [
        `Agent ID: ${state.runtimeDescriptor.agentId}`,
        ...(hasTradingCapability(state.runtimeDescriptor)
          ? [`Execution mode: ${state.runtimeDescriptor.executionMode}`]
          : []),
        ...(state.context.workspaceRoot && hasVisibleWorkspacePathTooling(state)
          ? [
              `Workspace root: ${state.context.workspaceRoot}`,
              'Use paths relative to workspace root, such as log.txt or folder/output.txt.',
            ]
          : []),
      ].join('\n'),
    }),
  },
  {
    id: 'trading-venue',
    costTier: 'free',
    section: 'static',
    requiredFamilies: ['trading'],
    trimOrder: 0,
    preserveWhenTrimmed: true,
    build: (state) => {
      const connections = getEffectiveTradingConnections(state);
      if (connections.length === 0) return null;

      const lines = connections.map((c) => formatTradingVenueLine(c.provider));

      return {
        id: 'tradingVenue',
        title: 'Trading Venue',
        provider: 'trading-venue',
        content: lines.join('\n'),
      };
    },
  },
  {
    id: 'agent-memory',
    costTier: 'cheap',
    section: 'static',
    requiredFamilies: [],
    trimOrder: 1,
    preserveWhenTrimmed: true,
    build: (state, policy) => {
      if (!policy?.memory.enabled) return null;
      const mem = state.metrics.agentMemory;
      if (!mem || Object.keys(mem).length === 0) return null;

      const entries = Object.entries(mem);
      // Sort by updatedAt desc (most recent first), unset/parseable go last
      entries.sort(([, a], [, b]) => {
        const aTs = a.updatedAt ? Date.parse(a.updatedAt) : 0;
        const bTs = b.updatedAt ? Date.parse(b.updatedAt) : 0;
        if (Number.isFinite(aTs) && Number.isFinite(bTs)) return bTs - aTs;
        if (Number.isFinite(aTs)) return -1;
        if (Number.isFinite(bTs)) return 1;
        return 0;
      });

      const maxInline = policy.memory.maxInlineKeys;
      const inline = entries.slice(0, maxInline);
      const overflow = entries.slice(maxInline);

      const lines = inline.map(([key, entry]) => {
        const ts = entry.updatedAt ? ` (${new Date(entry.updatedAt).toISOString().substring(0, 19)})` : '';
        const val = typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value);
        return `**${key}**${ts}: ${val}`;
      });

      if (overflow.length > 0) {
        const overflowKeys = overflow.map(([k]) => k).join(', ');
        lines.push(`Older keys: ${overflowKeys} (+${overflow.length} more — use list_memory_keys tool)`);
      }

      return {
        id: 'agentMemory',
        title: 'Agent Memory',
        provider: 'agent-memory',
        content: lines.join('\n'),
      };
    },
  },
  {
    id: 'trading-config-reference',
    costTier: 'cheap',
    section: 'static',
    requiredFamilies: ['trading'],
    trimOrder: 99,
    preserveWhenTrimmed: false,
    build: (state, policy) => {
      if (!policy?.configReference.enabled) return null;

      const desc = state.runtimeDescriptor;
      const lines: string[] = [];
      if (desc.guardrails.dailyLossLimit) lines.push(`Daily loss limit (rolling 24h realized loss): ${formatUsdAmount(desc.guardrails.dailyLossLimit)} — when reached, new positions are blocked until losses roll out of the 24h window, but go_flat and decrease remain available to manage existing positions`);
      if (desc.guardrails.maxDrawdownPct != null) lines.push(`Max drawdown: ${desc.guardrails.maxDrawdownPct}% of peak equity`);
      if (desc.guardrails.maxBots != null) lines.push(`Max concurrent bots: ${desc.guardrails.maxBots}`);
      if (desc.guardrails.maxOpenPositions != null) lines.push(`Max open positions: ${desc.guardrails.maxOpenPositions}`);
      if (desc.guardrails.maxPositionSizePct != null) lines.push(`Max position size: ${desc.guardrails.maxPositionSizePct}%`);
      if (desc.guardrails.capital) lines.push(`Capital: ${formatUsdAmount(desc.guardrails.capital)}`);
      lines.push('Per-trade stop-loss and take-profit should be set via submit_decision. An operator backstop applies if levels are missing.');

      return {
        id: 'tradingGuardrails',
        title: 'Trading Guardrails',
        provider: 'trading-config-reference',
        content: lines.join('\n'),
      };
    },
  },
  {
    id: 'readiness-summary',
    costTier: 'free',
    section: 'dynamic',
    requiredFamilies: [],
    trimOrder: 0,
    preserveWhenTrimmed: true,
    build: (state) => {
      const readinessLines = Object.entries(state.runtimeDescriptor.readinessByFamily);
      return {
        id: 'readinessSummary',
        title: 'Capability Readiness',
        provider: 'readiness-summary',
        content: readinessLines.length === 0
          ? 'No capability families are configured yet.'
          : readinessLines.map(([family, readiness]) => renderReadinessLine(family, readiness)).join('\n'),
      };
    },
  },
  {
    id: 'reminder-context',
    costTier: 'free',
    section: 'dynamic',
    requiredFamilies: [],
    trimOrder: 1,
    preserveWhenTrimmed: true,
    build: (state) => {
      const reminder = state.metrics.currentReminder;
      if (!reminder) {
        return null;
      }

      return {
        id: 'reminderContext',
        title: 'A reminder you set for yourself is now due',
        provider: 'reminder-context',
        content: [
          `Message: ${reminder.message}`,
          `Requested at: ${reminder.requestedAt ?? 'unavailable'}`,
          `Reminder ID: ${reminder.reminderId ?? 'unavailable'}`,
          `Wake ID: ${reminder.wakeId}`,
        ].join('\n'),
      };
    },
  },
  {
    id: 'queued-signals',
    costTier: 'free',
    section: 'dynamic',
    requiredFamilies: [],
    trimOrder: 1,
    preserveWhenTrimmed: true,
    build: (state, policy) => {
      if (!policy?.queuedSignals.enabled) return null;
      const signals = state.metrics.queuedWakeSignals;
      if (signals.length === 0) return null;

      const now = Date.now();
      const lines = signals.map((s) => {
        const ageSec = Math.round((now - s.receivedAt) / 1000);
        const ageLabel = ageSec < 60 ? `${ageSec}s ago` : `${Math.round(ageSec / 60)}m ago`;
        return `${s.source}: ${s.reason} (${ageLabel})`;
      });

      return {
        id: 'queuedSignals',
        title: 'Queued Wake Signals',
        provider: 'queued-signals',
        content: lines.join('\n'),
      };
    },
  },
  {
    id: 'activity-timeline',
    costTier: 'cheap',
    section: 'dynamic',
    requiredFamilies: [],
    trimOrder: 2,
    preserveWhenTrimmed: false,
    build: (state, policy) => {
      if (!policy?.activityTimeline.enabled) return null;
      const events = state.metrics.activityTimeline;
      if (!events || events.length === 0) return null;

      const lines = events.map((e) => {
        const ts = new Date(e.timestamp).toISOString().substring(11, 16); // HH:MM
        if (e.kind === 'USER') return `${ts} [USER] ${e.text}`;
        if (e.kind === 'MEMORY') return `${ts} [MEMORY] ${e.key}: ${e.value}`;
        /* DECISION */ return `${ts} [DECISION] ${e.text}`;
      });

      return {
        id: 'activityTimeline',
        title: 'Activity Timeline',
        provider: 'activity-timeline',
        content: lines.join('\n'),
      };
    },
  },
  {
    id: 'watch-trigger-context',
    costTier: 'free',
    section: 'dynamic',
    requiredFamilies: [],
    trimOrder: 1,
    preserveWhenTrimmed: true,
    build: (state, policy) => {
      const wake = state.metrics.currentMarketWake;
      if (!wake || wake.source !== 'watch_threshold') {
        return null;
      }
      const ctx = wake.context as WatchThresholdWakeContext;
      const emphasis = policy?.wakeEmphasis.enabled ? '\n→ Prioritize evaluating and acting on this signal.' : '';
      return {
        id: 'watchTriggerContext',
        title: 'Watch Trigger Context',
        provider: 'watch-trigger-context',
        content: [
          `Summary: ${wake.reason}`,
          `Watch ID: ${ctx.watchId}`,
          `Symbol: ${ctx.symbol} (${ctx.chain})`,
          `Condition: ${ctx.condition} ${ctx.thresholdPrice}`,
          `Current price: ${ctx.currentPrice}`,
          `Stale: ${String(ctx.stale)}`,
          `Triggered at: ${ctx.triggeredAt}`,
        ].join('\n') + emphasis,
      };
    },
  },
  {
    id: 'discovery-trigger-context',
    costTier: 'free',
    section: 'dynamic',
    requiredFamilies: [],
    trimOrder: 1,
    preserveWhenTrimmed: true,
    build: (state, policy) => {
      const wake = state.metrics.currentMarketWake;
      if (!wake || wake.source !== 'discovery_delta') {
        return null;
      }
      const ctx = wake.context as DiscoveryDeltaWakeContext;
      const rank = ctx.rank !== undefined ? String(ctx.rank) : 'unavailable';
      const liquidity = fmtUsd(ctx.liquidityUsd);
      const volume = fmtUsd(ctx.volume24hUsd);
      const emphasis = policy?.wakeEmphasis.enabled ? '\n→ Prioritize evaluating and acting on this signal.' : '';
      return {
        id: 'discoveryTriggerContext',
        title: 'Discovery Trigger Context',
        provider: 'discovery-trigger-context',
        content: [
          `Summary: ${wake.reason}`,
          `Symbol: ${ctx.symbol} (${ctx.network})`,
          `Reason: ${ctx.reason}`,
          `Rank: ${rank}`,
          `Liquidity: ${liquidity}`,
          `Volume 24h: ${volume}`,
          `Detected at: ${ctx.detectedAt}`,
        ].join('\n') + emphasis,
      };
    },
  },
  {
    id: 'regime-change-context',
    costTier: 'free',
    section: 'dynamic',
    requiredFamilies: [],
    trimOrder: 1,
    preserveWhenTrimmed: true,
    build: (state, policy) => {
      const wake = state.metrics.currentMarketWake;
      if (!wake || wake.source !== 'regime_change') {
        return null;
      }
      const ctx = wake.context as RegimeChangeWakeContext;
      const emphasis = policy?.wakeEmphasis.enabled ? '\n→ Prioritize evaluating and acting on this signal.' : '';
      return {
        id: 'regimeChangeContext',
        title: 'Regime Change Context',
        provider: 'regime-change-context',
        content: [
          `Summary: ${wake.reason}`,
          `Benchmark: ${ctx.benchmarkSymbol}`,
          `Previous state: ${ctx.previousState}`,
          `Current state: ${ctx.currentState}`,
          `Changed at: ${ctx.changedAt}`,
        ].join('\n') + emphasis,
      };
    },
  },
  {
    id: 'pending-market-context',
    costTier: 'free',
    section: 'dynamic',
    requiredFamilies: [],
    trimOrder: 80,
    preserveWhenTrimmed: true,
    build: (state) => {
      const events = state.metrics.pendingMarketContext;
      if (events.length === 0) return null;

      const lines = events.map(e => {
        if (e.type === 'market.discovery.detected') {
          const p = e.payload as MarketDiscoveryDetectedPayload;
          return `• [Discovery] ${p.symbol} (${p.network}) — ${p.reason}`;
        } else {
          const p = e.payload as MarketRegimeChangedPayload;
          return `• [Regime] ${p.benchmarkSymbol}: ${p.previousState} → ${p.currentState}`;
        }
      });

      return {
        id: 'pendingMarketContext',
        title: '📊 Market Context',
        provider: 'pending-market-context',
        content: lines.join('\n'),
      };
    },
  },
  {
    id: 'degraded-capabilities',
    costTier: 'free',
    section: 'dynamic',
    requiredFamilies: [],
    trimOrder: 2,
    preserveWhenTrimmed: true,
    build: (state) => {
      if (state.metrics.degradedCapabilities.length === 0) {
        return null;
      }

      return {
        id: 'degradedCapabilities',
        title: 'Degraded Capabilities',
        provider: 'degraded-capabilities',
        content: state.metrics.degradedCapabilities
          .map((entry) => `${entry.summary}\nGuidance: ${entry.guidance}`)
          .join('\n'),
      };
    },
  },
  {
    id: 'portfolio-summary',
    costTier: 'cheap',
    section: 'dynamic',
    requiredFamilies: ['trading'],
    trimOrder: 1,
    preserveWhenTrimmed: true,
    build: (state) => ({
      id: 'portfolioSummary',
      title: 'Portfolio Summary',
      provider: 'portfolio-summary',
      content: [
        `Exposure: ${formatCurrency(state.metrics.portfolio.exposureUsd)}`,
        `Realized P&L: ${formatCurrency(state.metrics.portfolio.realizedPnlUsd)}`,
        `Unrealized P&L: ${formatCurrency(state.metrics.portfolio.unrealizedPnlUsd)}`,
        `Drawdown: ${formatPercent(state.metrics.portfolio.drawdownPct)}`,
        `Available capital: ${formatCurrency(state.metrics.portfolio.availableCapitalUsd)}`,
        `Net delta: ${state.metrics.portfolio.netDelta === null ? 'unavailable' : state.metrics.portfolio.netDelta.toFixed(2)}`,
        `Freshness: ${formatFreshness(state.metrics.portfolio.freshness)}`,
      ].join('\n'),
    }),
  },
  {
    id: 'open-positions',
    costTier: 'cheap',
    section: 'dynamic',
    requiredFamilies: ['trading'],
    trimOrder: 2,
    preserveWhenTrimmed: true,
    build: (state) => ({
      id: 'openPositions',
      title: 'Open Positions',
      provider: 'open-positions',
      content: state.metrics.openPositions.length === 0
        ? 'No open positions.'
        : state.metrics.openPositions.map((position) => [
            `${position.instrumentId}: ${position.side} size=${position.size}`,
            `entry=${position.entryPrice ?? 'unavailable'} unrealized=${formatCurrency(position.unrealizedPnlUsd)} hold=${position.holdDurationMinutes === null ? 'unavailable' : `${position.holdDurationMinutes}m`}`,
            `freshness=${formatFreshness(position.freshness)}`,
          ].join(' | ')).join('\n'),
    }),
  },
  {
    id: 'position-coverage',
    costTier: 'free',
    section: 'dynamic',
    requiredFamilies: ['trading'],
    trimOrder: 2,
    preserveWhenTrimmed: true,
    build: (state) => {
      const coverage = state.metrics.positionCoverage;
      if (!coverage || coverage.totalOpenPositions === 0) {
        return null;
      }

      const lines: string[] = [];

      // Triggered protective watches — most actionable, show first
      const triggered = coverage.positions.filter((p) => p.triggeredProtectiveWatch);
      if (triggered.length > 0) {
        for (const p of triggered) {
          const staleFlag = p.staleProtectiveWatch ? ' [STALE]' : '';
          lines.push(`[TRIGGERED]${staleFlag} ${p.positionKey} — protective watch triggered`);
        }
      }

      // Uncovered positions
      const uncovered = coverage.positions.filter((p) => !p.hasProtectiveCoverage);
      if (uncovered.length > 0) {
        for (const p of uncovered) {
          lines.push(`[UNCOVERED] ${p.positionKey} — no protective watch`);
        }
      }

      // All-covered summary when neither triggered nor uncovered
      if (lines.length === 0) {
        const staleFlag = coverage.hasStaleProtectiveWatch ? ' (some stale)' : '';
        lines.push(`All positions covered${staleFlag} (no protective watches triggered)`);
      }

      return {
        id: 'positionCoverage',
        title: 'Position Coverage',
        provider: 'position-coverage',
        content: lines.join('\n'),
      };
    },
  },
  {
    id: 'active-watches',
    costTier: 'free',
    section: 'dynamic',
    requiredFamilies: ['trading'],
    trimOrder: 3,
    preserveWhenTrimmed: true,
    build: (state) => {
      const summary = state.metrics.activeWatchSummary ?? summarizeActiveWatches(state.metrics.activeWatches);
      if (summary.totalCount === 0) {
        return null;
      }
      return {
        id: 'activeWatches',
        title: `Active Watches (${summary.totalCount} total, ${summary.uniqueCount} unique)`,
        provider: 'active-watches',
        content: [
          ...summary.lines,
          ...(summary.overflowCount > 0 ? [`+ ${summary.overflowCount} more unique watches not shown`] : []),
        ].join('\n'),
      };
    },
  },
  {
    id: 'regime-summary',
    costTier: 'cheap',
    section: 'dynamic',
    requiredFamilies: ['trading'],
    trimOrder: 3,
    preserveWhenTrimmed: true,
    build: (state) => {
      const regime = state.metrics.regime.result;
      if (!regime) {
        return {
          id: 'regimeSummary',
          title: 'Market Regime',
          provider: 'regime-summary',
          content: `Regime: unavailable (${formatFreshness(state.metrics.regime.freshness)})`,
        };
      }

      return {
        id: 'regimeSummary',
        title: 'Market Regime',
        provider: 'regime-summary',
        content: [
          `Pass: ${regime.pass ? 'yes' : 'no'}`,
          `Benchmark: ${regime.details.benchmarkSymbol} @ ${regime.details.currentPrice.toFixed(2)}`,
          `ADX: ${regime.details.adxValue.toFixed(1)} | EMA alignment: ${regime.details.emaAlignment} | Structure: ${regime.details.marketStructure}`,
          `VWAP: ${regime.details.priceAboveVwap ? 'above' : 'below'} | Choppy: ${regime.details.choppy ? 'yes' : 'no'}`,
          `Reasons: ${regime.reasons.join('; ')}`,
          `Freshness: ${formatFreshness(state.metrics.regime.freshness)}`,
        ].join('\n'),
      };
    },
  },
  {
    id: 'technical-scan',
    costTier: 'cheap',
    section: 'dynamic',
    requiredFamilies: ['trading'],
    trimOrder: 4,
    preserveWhenTrimmed: true,
    build: (state) => {
      const scan = state.metrics.lastTechnicalScan;
      if (!scan) return null;
      const content = buildTechnicalContextBlock(scan);
      if (!content) return null;
      return {
        id: 'technicalScan',
        title: 'Technical Scan Results',
        provider: 'technical-scan',
        content,
      };
    },
  },
  {
    id: 'venue-intelligence',
    costTier: 'cheap',
    section: 'dynamic',
    requiredFamilies: ['trading'],
    trimOrder: 5,
    build: (state) => {
      if (state.metrics.venueSignals.length === 0) {
        return null;
      }

      return {
        id: 'venueIntelligence',
        title: 'Venue Intelligence',
        provider: 'venue-intelligence',
        content: state.metrics.venueSignals.map((signal) => [
          `${signal.instrument} (${signal.venue}, ${signal.kind})`,
          ...signal.fields.map((field) => `  - ${field.label}: ${field.value}`),
          `  - Freshness: ${formatFreshness(signal.freshness)}`,
        ].join('\n')).join('\n'),
      };
    },
  },
  {
    id: 'recent-events',
    costTier: 'cheap',
    section: 'dynamic',
    requiredFamilies: [],
    trimOrder: 5,
    build: (state) => ({
      id: 'recentEvents',
      title: 'Recent Events',
      provider: 'recent-events',
      content: state.metrics.recentEvents.length === 0
        ? 'No recent platform events.'
        : state.metrics.recentEvents.map((event) => `${event.createdAt}: ${event.summary}`).join('\n'),
    }),
  },
  {
    id: 'managed-bots',
    costTier: 'cheap',
    section: 'dynamic',
    requiredFamilies: ['trading'],
    trimOrder: 6,
    build: (state) => ({
      id: 'managedBots',
      title: 'Managed Bots',
      provider: 'managed-bots',
      content: !state.metrics.managedBots || state.metrics.managedBots.length === 0
        ? 'No managed bots.'
        : state.metrics.managedBots.map((bot) => `${bot.id} [${bot.status}]${bot.strategyPreset ? ` strategy=${bot.strategyPreset}` : ''}${bot.symbol ? ` symbol=${bot.symbol}` : ''}`).join('\n'),
    }),
  },
];

function buildBlockList(state: RuntimeCompositionState, section: 'static' | 'dynamic', policy?: PromptEnrichmentPolicy): Array<{ provider: RuntimeContextProvider; block: RuntimeContextBlock }> {
  return RUNTIME_CONTEXT_PROVIDERS
    .filter((provider) => provider.section === section)
    .filter((provider) => provider.requiredFamilies.every((family) => Boolean(state.runtimeDescriptor.readinessByFamily[family] || state.runtimeDescriptor.grantedConnectionsByFamily[family])))
    .map((provider) => ({ provider, block: provider.build(state, policy) }))
    .filter((entry): entry is { provider: RuntimeContextProvider; block: RuntimeContextBlock } => entry.block !== null);
}

function trimDynamicBlocks(
  state: RuntimeCompositionState,
  blocks: Array<{ provider: RuntimeContextProvider; block: RuntimeContextBlock }>,
): RuntimeContextBlock[] {
  const limit = state.runtimeDescriptor.budgets.maxContextBlockChars * 2;
  const renderedLength = (entries: RuntimeContextBlock[]): number => entries.reduce((total, block) => total + block.title.length + block.content.length + 8, 0);

  let current = blocks.map(({ block }) => ({ ...block, content: trimText(block.content, state.runtimeDescriptor.budgets.maxContextBlockChars) }));
  if (renderedLength(current) <= limit) {
    return current;
  }

  for (const block of current) {
    if (block.id === 'managedBots') {
      block.content = trimText(block.content.split('\n').slice(0, 2).join('\n'), 250);
    }
    if (block.id === 'recentEvents') {
      block.content = trimText(block.content.split('\n').slice(-3).join('\n'), 350);
    }
    if (block.id === 'venueIntelligence') {
      block.content = trimText(block.content.split('\n').slice(0, 5).join('\n'), 400);
    }

    if (renderedLength(current) <= limit) {
      return current;
    }
  }

  return current.filter((block) => block.id !== 'venueIntelligence');
}

function buildContextSection(state: RuntimeCompositionState, section: 'static' | 'dynamic', policy?: PromptEnrichmentPolicy): string {
  const blocks = section === 'static'
    ? buildBlockList(state, 'static', policy).map(({ block }) => ({ ...block, content: trimText(block.content, state.runtimeDescriptor.budgets.maxContextBlockChars) }))
    : trimDynamicBlocks(state, buildBlockList(state, 'dynamic', policy));
  return blocks.map((block) => `## ${block.title}\n${block.content}`).join('\n\n');
}

export function createRuntimeCompositionState(
  runtimeDescriptor: RuntimeDescriptor,
  context: Partial<RuntimeCompositionContext> = {},
): RuntimeCompositionState {
  return {
    runtimeDescriptor,
    sessionStartMs: Date.now(),
    tickCount: 0,
    context: {
      workspaceRoot: context.workspaceRoot ?? null,
    },
    metrics: {
      decisionsSubmitted: 0,
      decisionsAccepted: 0,
      decisionsRejected: 0,
      lastPnlSummary: null,
      lastPositionSide: null,
      currentReminder: null,
      currentMarketWake: null,
      degradedCapabilities: [],
      managedBots: null,
      market: {
        symbol: null,
        price: null,
        freshness: unavailableFreshness('market snapshot pending'),
      },
      portfolio: {
        exposureUsd: null,
        realizedPnlUsd: null,
        unrealizedPnlUsd: null,
        drawdownPct: null,
        availableCapitalUsd: null,
        netDelta: null,
        freshness: unavailableFreshness('portfolio summary pending'),
      },
      openPositions: [],
      activeWatches: [],
      activeWatchSummary: null,
      recentEvents: [],
      venueSignals: [],
      regime: {
        result: null,
        freshness: unavailableFreshness('regime not evaluated yet'),
      },
      sessionCosts: {
        llmTokensUsed: 0,
        hiddenReasoningTokensUsed: 0,
        llmCostUsd: 0,
        estimatedServerCostUsdPerHour: DEFAULT_SERVER_COST_PER_HOUR_USD,
      },
      performance: {
        startingCapitalUsd: null,
        winRate: null,
        riskAdjustedReturn: null,
        drawdownPct: null,
        netPnlUsd: null,
        peakEquityUsd: null,
      },
      agentMemory: null,
      queuedWakeSignals: [],
      activityTimeline: [],
      positionCoverage: null,
      pendingMarketContext: [],
      macroEvents: null,
    },
  };
}

export function updateRuntimeDescriptor(
  state: RuntimeCompositionState,
  runtimeDescriptor: RuntimeDescriptor,
): void {
  state.runtimeDescriptor = {
    ...runtimeDescriptor,
    name: runtimeDescriptor.name ?? state.runtimeDescriptor.name ?? runtimeDescriptor.agentId,
  };
}

export function recordAgentMemory(
  state: RuntimeCompositionState,
  raw: Record<string, string>,
): void {
  const mem: Record<string, { value: unknown; updatedAt?: string }> = {};
  for (const [key, rawVal] of Object.entries(raw)) {
    try {
      const parsed = JSON.parse(rawVal) as unknown;
      // The stored value is always a plain JSON value (string, number, object, array).
      // Wrap it so renderers always have entry.value.
      mem[key] = { value: parsed };
    } catch {
      // Raw value is not valid JSON — store as-is.
      mem[key] = { value: rawVal };
    }
  }
  state.metrics.agentMemory = mem;
}

export function recordRuntimeEvent(state: RuntimeCompositionState, type: string, summary: string): void {
  pushRecentEvent(state, type, summary);
}

export function setCapabilityDegradation(
  state: RuntimeCompositionState,
  dependency: 'database' | 'market-data',
  degraded: boolean,
): void {
  const summary = dependency === 'database'
    ? 'Database-backed tools are temporarily unavailable.'
    : 'Market-data tools are temporarily unavailable.';
  const guidance = dependency === 'database'
    ? 'Skip DB-backed tools for now and retry after the next healthy heartbeat.'
    : 'Skip market-data lookups for now or retry next tick after recovery.';

  state.metrics.degradedCapabilities = state.metrics.degradedCapabilities.filter((entry) => entry.dependency !== dependency);
  if (degraded) {
    state.metrics.degradedCapabilities.push({ dependency, summary, guidance });
  }
}

export function setToolCapabilityDegradation(
  state: RuntimeCompositionState,
  tool: 'execute_code',
  degraded: boolean,
): void {
  const summary = 'Code-execution tools are temporarily unavailable.';
  const guidance = 'Do not retry execute_code this session. Continue without code execution or use other available tools.';

  state.metrics.degradedCapabilities = state.metrics.degradedCapabilities.filter((entry) => entry.dependency !== tool);
  if (degraded) {
    state.metrics.degradedCapabilities.push({ dependency: tool, summary, guidance });
  }
}

export function updatePortfolioSummary(
  state: RuntimeCompositionState,
  update: Partial<Omit<RuntimePortfolioSummary, 'freshness'>> & { freshness?: RuntimeFreshness },
): void {
  state.metrics.portfolio = {
    ...state.metrics.portfolio,
    ...update,
    freshness: update.freshness ?? state.metrics.portfolio.freshness,
  };
  refreshDerivedPerformanceInputs(state);
  state.metrics.lastPnlSummary = formatCurrency(state.metrics.performance.netPnlUsd);
}

export function setOpenPositions(state: RuntimeCompositionState, positions: RuntimePositionSnapshot[]): void {
  state.metrics.openPositions = orderReplacementPositions(state.metrics.openPositions, positions);
  state.metrics.lastPositionSide = state.metrics.openPositions[0]?.side ?? 'flat';
  recalculatePortfolioFromPositions(state);
}

function orderReplacementPositions(
  current: RuntimePositionSnapshot[],
  replacement: RuntimePositionSnapshot[],
): RuntimePositionSnapshot[] {
  const currentIndex = new Map(current.map((position, index) => [position.instrumentId, index]));

  return replacement
    .map((position, originalIndex) => ({ position, originalIndex }))
    .sort((left, right) => {
      const leftCurrentIndex = currentIndex.get(left.position.instrumentId);
      const rightCurrentIndex = currentIndex.get(right.position.instrumentId);
      if (leftCurrentIndex !== undefined && rightCurrentIndex !== undefined) {
        return leftCurrentIndex - rightCurrentIndex;
      }
      if (leftCurrentIndex !== undefined) return -1;
      if (rightCurrentIndex !== undefined) return 1;

      const leftOpenedAt = left.position.openedAt ? Date.parse(left.position.openedAt) : Number.NaN;
      const rightOpenedAt = right.position.openedAt ? Date.parse(right.position.openedAt) : Number.NaN;
      const leftHasOpenedAt = Number.isFinite(leftOpenedAt);
      const rightHasOpenedAt = Number.isFinite(rightOpenedAt);
      if (leftHasOpenedAt && rightHasOpenedAt && leftOpenedAt !== rightOpenedAt) {
        return rightOpenedAt - leftOpenedAt;
      }
      if (leftHasOpenedAt) return -1;
      if (rightHasOpenedAt) return 1;

      return left.originalIndex - right.originalIndex;
    })
    .map(({ position }) => position);
}

/**
 * Upsert a single position by instrumentId. If the position is flat/null, remove it.
 * Used by context-snapshot processing to merge multi-instrument state without
 * overwriting siblings. The list is kept newest-first so cached position-side
 * fallbacks follow the most recently updated non-flat instrument.
 */
export function upsertOpenPosition(state: RuntimeCompositionState, position: RuntimePositionSnapshot): void {
  const idx = state.metrics.openPositions.findIndex((p) => p.instrumentId === position.instrumentId);
  if (idx >= 0) {
    state.metrics.openPositions.splice(idx, 1);
    state.metrics.openPositions.unshift(position);
  } else {
    state.metrics.openPositions.unshift(position);
  }
  state.metrics.lastPositionSide = state.metrics.openPositions[0]?.side ?? 'flat';
  recalculatePortfolioFromPositions(state);
}

/** Remove a position by instrumentId (instrument went flat). */
export function removeOpenPosition(state: RuntimeCompositionState, instrumentId: string): void {
  state.metrics.openPositions = state.metrics.openPositions.filter((p) => p.instrumentId !== instrumentId);
  state.metrics.lastPositionSide = state.metrics.openPositions[0]?.side ?? 'flat';
  recalculatePortfolioFromPositions(state);
}

function recalculatePortfolioFromPositions(state: RuntimeCompositionState): void {
  const positions = state.metrics.openPositions;
  const exposureUsd = positions.reduce((total, position) => {
    const size = parseNumber(position.size);
    const entryPrice = parseNumber(position.entryPrice);
    if (size === null || entryPrice === null) {
      return total;
    }
    return total + Math.abs(size * entryPrice);
  }, 0);
  const anyPositionHasUnrealizedPnl = positions.some((position) => position.unrealizedPnlUsd !== null);
  const unrealizedPnlUsd = anyPositionHasUnrealizedPnl
    ? positions.reduce((total, position) => total + (position.unrealizedPnlUsd ?? 0), 0)
    : null;
  state.metrics.portfolio.exposureUsd = positions.length === 0 ? 0 : exposureUsd;
  state.metrics.portfolio.unrealizedPnlUsd = positions.length === 0 ? 0 : unrealizedPnlUsd;
  refreshDerivedPerformanceInputs(state);
}

export function recordVenueSignals(state: RuntimeCompositionState, signals: RuntimeVenueSignal[]): void {
  state.metrics.venueSignals = signals;
}

export function recordActiveWatches(
  state: RuntimeCompositionState,
  watches: RuntimeSessionMetrics['activeWatches'],
): void {
  state.metrics.activeWatches = watches;
  state.metrics.activeWatchSummary = null;
}

export function recordActiveWatchSummary(
  state: RuntimeCompositionState,
  summary: RuntimeActiveWatchSummary | null,
): void {
  state.metrics.activeWatchSummary = summary;
}

export function recordPositionCoverage(
  state: RuntimeCompositionState,
  coverage: CoverageEvaluationResult | null,
): void {
  state.metrics.positionCoverage = coverage;
}

export function recordRegimeEvaluation(
  state: RuntimeCompositionState,
  result: RegimeResult | null,
  freshness: RuntimeFreshness,
): void {
  state.metrics.regime = { result, freshness };
}

export function recordTechnicalScan(
  state: RuntimeCompositionState,
  scan: TechnicalScanState,
): void {
  state.metrics.lastTechnicalScan = scan;
}

export function recordSessionCost(
  state: RuntimeCompositionState,
  usage: { tokensUsed?: number | null; thinkingTokens?: number | null; costUsd?: number | null },
): void {
  state.metrics.sessionCosts.llmTokensUsed += usage.tokensUsed ?? 0;
  state.metrics.sessionCosts.hiddenReasoningTokensUsed += usage.thinkingTokens ?? 0;
  state.metrics.sessionCosts.llmCostUsd += usage.costUsd ?? 0;
}

export function recordPerformanceInputs(
  state: RuntimeCompositionState,
  update: Partial<RuntimePerformanceInputs>,
): void {
  state.metrics.performance = {
    ...state.metrics.performance,
    ...update,
    ...(update.winRate !== undefined ? { winRate: normalizeWinRatePercent(update.winRate) } : {}),
  };
  refreshDerivedPerformanceInputs(state);
}

export {
  recordPerformanceInputs as updatePerformanceInputs,
  recordRegimeEvaluation as setRegimeResult,
  recordSessionCost as recordLlmUsage,
  recordVenueSignals as setVenueSignals,
};

export function applyRuntimeMessage(
  state: RuntimeCompositionState,
  message: Record<string, unknown>,
): string {
  const type = typeof message['type'] === 'string' ? message['type'] : 'unknown';
  const payload = (message['payload'] as Record<string, unknown> | undefined) ?? {};

  if (type === 'agent.runtime.config_update') {
    const update = payload['runtimeDescriptor'] as RuntimeDescriptorUpdatePayload['runtimeDescriptor'] | undefined;
    if (update) {
      updateRuntimeDescriptor(state, update);
      const summary = `Runtime config updated: ${payload['reason'] ?? 'update'}`;
      pushRecentEvent(state, type, summary);
      return summary;
    }
    const summary = 'Runtime config update received';
    pushRecentEvent(state, type, summary);
    return summary;
  }

  if (type === 'instance.context.snapshot') {
    const position = payload['position'] as Record<string, unknown> | undefined | null;
    const unrealizedPnl = parseNumber(payload['pnl']);
    if (unrealizedPnl !== null) {
      updatePortfolioSummary(state, {
        unrealizedPnlUsd: unrealizedPnl,
        freshness: freshFreshness('runtime-snapshot'),
      });
    }
    const instrumentId = String(payload['symbol'] ?? 'unknown');
    if (position?.['side']) {
      upsertOpenPosition(state, {
        instrumentId,
        side: String(position['side']),
        size: String(position['size'] ?? 'unknown'),
        entryPrice: position['entryPrice'] ? String(position['entryPrice']) : null,
        unrealizedPnlUsd: unrealizedPnl,
        openedAt: null,
        holdDurationMinutes: null,
        venueType: inferVenueType(state, instrumentId),
        freshness: freshFreshness('runtime-snapshot'),
      });
    } else if (position === null) {
      // null position means this instrument went flat — remove only this instrument
      removeOpenPosition(state, instrumentId);
    }
    const symbol = payload['symbol'];
    const price = parseNumber(payload['price']);
    state.metrics.market = {
      symbol: typeof symbol === 'string' ? symbol : state.metrics.market.symbol,
      price: price ?? state.metrics.market.price,
      freshness: freshFreshness('runtime-snapshot'),
    };
    const summary = `Market: ${payload['symbol'] ?? 'unknown'} @ ${payload['price'] ?? 'unknown'}`;
    pushRecentEvent(state, type, summary);
    return summary;
  }

  if (type === 'instance.decision.accepted') {
    state.metrics.decisionsAccepted++;
    const summary = `Decision accepted: ${payload['decisionId'] ?? 'unknown'}`;
    pushRecentEvent(state, type, summary);
    return summary;
  }

  if (type === 'instance.decision.rejected') {
    state.metrics.decisionsRejected++;
    const summary = `Decision rejected: ${payload['message'] ?? 'unknown'}`;
    pushRecentEvent(state, type, summary);
    return summary;
  }

  if (type === 'instance.execution.result') {
    const summary = 'Execution result received';
    pushRecentEvent(state, type, summary);
    return summary;
  }

  if (type === 'instance.status') {
    const bots = payload['managedBots'] as RuntimeCompositionState['metrics']['managedBots'];
    if (bots) {
      state.metrics.managedBots = bots;
    }
    const summary = `Platform status: ${payload['reason'] ?? payload['status'] ?? 'updated'}`;
    pushRecentEvent(state, type, summary);
    return summary;
  }

  if (type === 'agent.wake') {
    const parsed = AgentWakePayloadSchema.safeParse(payload);
    if (!parsed.success) {
      // Backward compatibility: older wake envelopes may omit typed context.
      // Preserve actionable reason text when source/reason are present.
      const source = payload['source'];
      const reason = payload['reason'];
      if (
        (source === 'watch_threshold' || source === 'discovery_delta' || source === 'regime_change' || source === 'scanner')
        && typeof reason === 'string'
        && reason.trim().length > 0
      ) {
        state.metrics.currentReminder = null;
        state.metrics.currentMarketWake = null;
        const summary = reason.trim();
        pushRecentEvent(state, type, summary);
        return summary;
      }

      // Unrecognised or malformed wake — drop silently rather than rendering garbage.
      return '';
    }
    const wake = parsed.data;
    const { wakeId, reason, requestedAt } = wake;

    if (wake.source === 'reminder') {
      const ctx = wake.context as ReminderWakeContext;
      state.metrics.currentReminder = { wakeId, reminderId: ctx.reminderId, message: ctx.message, requestedAt, scheduledBy: ctx.scheduledBy };
      state.metrics.currentMarketWake = null;
      const summary = `Reminder: ${ctx.message}`;
      pushRecentEvent(state, type, summary);
      return summary;
    }

    state.metrics.currentReminder = null;

    if (wake.source === 'watch_threshold' || wake.source === 'discovery_delta' || wake.source === 'regime_change' || wake.source === 'scanner') {
      state.metrics.currentMarketWake = { wakeId, source: wake.source, reason, requestedAt, context: wake.context as WatchThresholdWakeContext | DiscoveryDeltaWakeContext | RegimeChangeWakeContext };

      // Remove pending context-only market events that this wake will render.
      // Prevents duplicate rendering when context-only events arrive before agent.wake.
      if (wake.source === 'discovery_delta') {
        state.metrics.pendingMarketContext = state.metrics.pendingMarketContext.filter(
          e => e.type !== 'market.discovery.detected'
        );
      } else if (wake.source === 'regime_change') {
        state.metrics.pendingMarketContext = state.metrics.pendingMarketContext.filter(
          e => e.type !== 'market.regime.changed'
        );
      }

      const summary = reason || `Wake: ${wake.source}`;
      pushRecentEvent(state, type, summary);
      return summary;
    }

    state.metrics.currentMarketWake = null;
    return '';
  }

  if (type === 'instance.tool.result') {
    const tool = typeof payload['tool'] === 'string' ? payload['tool'] : 'tool';
    const data = payload['data'] as Record<string, unknown> | Array<Record<string, unknown>> | undefined;

    if (tool === 'list_bots' && data && !Array.isArray(data) && Array.isArray(data['bots'])) {
      const bots = data['bots'] as Array<Record<string, unknown>>;
      state.metrics.managedBots = bots.map((bot) => ({
        id: String(bot['id'] ?? 'unknown'),
        status: String(bot['status'] ?? 'unknown'),
        strategyPreset: typeof bot['strategyPreset'] === 'string' ? bot['strategyPreset'] : undefined,
        symbol: typeof bot['symbol'] === 'string' ? bot['symbol'] : undefined,
      }));
      const summary = `Bot list updated: ${bots.length} bot(s)`;
      pushRecentEvent(state, type, summary);
      return summary;
    }

    if (tool === 'get_bot_status' && data && !Array.isArray(data)) {
      const status = typeof data['status'] === 'string' ? data['status'] : 'unknown';
      const botId = typeof data['id'] === 'string' ? data['id'] : 'unknown';
      const summary = `Bot status: ${botId} [${status}]`;
      pushRecentEvent(state, type, summary);
      return summary;
    }

    if (tool === 'get_analytics' && data && !Array.isArray(data)) {
      updatePortfolioSummary(state, {
        realizedPnlUsd: parseNumber(data['realizedPnlUsd']),
        freshness: freshFreshness('analytics-tool'),
      });
      recordPerformanceInputs(state, {
        winRate: parseNumber(data['winRate']),
      });
      const summary = `Portfolio analytics: P&L ${state.metrics.lastPnlSummary ?? 'unavailable'}, open positions ${parseNumber(data['openPositions']) ?? 0}`;
      pushRecentEvent(state, type, summary);
      return summary;
    }

    if (tool === 'get_account_summary' && data && !Array.isArray(data)) {
      const capitalUsd = parseNumber(data['capital']);
      if (capitalUsd !== null) {
        updatePortfolioSummary(state, {
          availableCapitalUsd: capitalUsd,
          freshness: freshFreshness('account-summary-tool'),
        });
      }
      const summary = capitalUsd !== null
        ? `Account summary: available capital ${formatCurrency(capitalUsd)}`
        : 'Account summary: capital unavailable';
      pushRecentEvent(state, type, summary);
      return summary;
    }

    const positionRows = tool === 'list_positions'
      ? (Array.isArray(data)
        ? data
        : (data && !Array.isArray(data) && Array.isArray(data['positions']) ? data['positions'] : null))
      : null;

    if (positionRows) {
      setOpenPositions(state, positionRows.map((position) => ({
        instrumentId: String(position['instrumentId'] ?? position['symbol'] ?? 'unknown'),
        side: String(position['side'] ?? 'unknown'),
        size: String(position['size'] ?? 'unknown'),
        entryPrice: position['entryPrice'] ? String(position['entryPrice']) : null,
        unrealizedPnlUsd: parseNumber(position['unrealizedPnlUsd']),
        openedAt: typeof position['openedAt'] === 'string' ? position['openedAt'] : null,
        holdDurationMinutes: null,
        venueType: inferVenueType(state, String(position['instrumentId'] ?? position['symbol'] ?? 'unknown')),
        freshness: freshFreshness('positions-tool'),
      })));
      const summary = `Open positions: ${positionRows.length}`;
      pushRecentEvent(state, type, summary);
      return summary;
    }

    const summary = typeof payload['message'] === 'string' ? String(payload['message']) : 'Tool result received';
    pushRecentEvent(state, type, summary);
    return summary;
  }

  if (type === 'instance.guardrail.triggered') {
    const code = typeof payload['code'] === 'string' ? payload['code'] : 'unknown';
    const message = typeof payload['message'] === 'string' ? payload['message'] : 'Guardrail triggered';
    const summary = `Guardrail: ${code} — ${message}`;
    pushRecentEvent(state, type, summary);
    return summary;
  }

  if (type === 'agent.technical.scan_completed') {
    const scan = payload as unknown as TechnicalScanState;
    if (
      scan &&
      typeof scan.timestamp === 'string' &&
      Array.isArray(scan.signals) &&
      typeof scan.summary === 'object' &&
      scan.summary !== null
    ) {
      recordTechnicalScan(state, scan);
      const summary = `Technical scan: ${scan.summary.passed}/${scan.summary.scanned} passed, regime=${scan.regimeResult?.pass ? 'pass' : scan.regimeResult ? 'blocked' : 'n/a'}`;
      pushRecentEvent(state, type, summary);
      return summary;
    }
    const summary = 'Technical scan completed';
    pushRecentEvent(state, type, summary);
    return summary;
  }

  if (type === INSTANCE_MESSAGE_TYPES.BOT_CONFIG_CHANGED) {
    const botId = typeof payload['botId'] === 'string' ? payload['botId'] : 'unknown';
    const changedBy = typeof payload['changedBy'] === 'string' ? payload['changedBy'] : 'system';
    const prevMode = typeof payload['previousExecutionMode'] === 'string' ? payload['previousExecutionMode'] : 'unknown';
    const newMode = typeof payload['newExecutionMode'] === 'string' ? payload['newExecutionMode'] : 'unknown';
    const summary = `Bot ${botId} config changed by ${changedBy}: execution mode ${prevMode} → ${newMode}`;
    pushRecentEvent(state, type, summary);
    return summary;
  }

  // Market monitor context-only events (no agent.wake).
  // Stored as pending context for the next tick digest and prompt rendering.
  // If a preceding agent.wake already set currentMarketWake for the same event
  // source, skip the push to avoid duplicate rendering in the same tick.
  if (type === 'market.discovery.detected') {
    if (state.metrics.currentMarketWake?.source === 'discovery_delta') {
      return ''; // Already rendered via discovery-trigger-context provider
    }
    const parsed = payload as unknown as MarketDiscoveryDetectedPayload;
    if (parsed.eventId && parsed.symbol && parsed.network) {
      // Deduplicate by eventId — same event may arrive via wake + batched modes
      if (state.metrics.pendingMarketContext.some(e => e.eventId === parsed.eventId)) {
        return '';
      }
      // Cap at 50 events to prevent unbounded memory growth
      if (state.metrics.pendingMarketContext.length >= 50) {
        console.warn('pendingMarketContext exceeded 50-event cap — oldest events dropped');
        state.metrics.pendingMarketContext.shift();
      }
      state.metrics.pendingMarketContext.push({
        eventId: parsed.eventId,
        type: 'market.discovery.detected',
        receivedAt: Date.now(),
        payload: parsed,
      });
      const summary = `Market discovery: ${parsed.symbol} (${parsed.network}) — ${parsed.reason}`;
      pushRecentEvent(state, type, summary);
      return summary;
    }
    return '';
  }

  if (type === 'market.regime.changed') {
    if (state.metrics.currentMarketWake?.source === 'regime_change') {
      return ''; // Already rendered via regime-change-context provider
    }
    const parsed = payload as unknown as MarketRegimeChangedPayload;
    if (parsed.eventId && parsed.benchmarkSymbol) {
      // Deduplicate by eventId
      if (state.metrics.pendingMarketContext.some(e => e.eventId === parsed.eventId)) {
        return '';
      }
      // Cap at 50 events
      if (state.metrics.pendingMarketContext.length >= 50) {
        console.warn('pendingMarketContext exceeded 50-event cap — oldest events dropped');
        state.metrics.pendingMarketContext.shift();
      }
      state.metrics.pendingMarketContext.push({
        eventId: parsed.eventId,
        type: 'market.regime.changed',
        receivedAt: Date.now(),
        payload: parsed,
      });
      const summary = `Regime change: ${parsed.benchmarkSymbol} ${parsed.previousState} → ${parsed.currentState}`;
      pushRecentEvent(state, type, summary);
      return summary;
    }
    return '';
  }

  const summary = `Platform message: ${type}`;
  pushRecentEvent(state, type, summary);
  return summary;
}

export function buildSystemPrompt(state: RuntimeCompositionState, timing: PromptTimingContext, _toolGuidanceByName?: Record<string, string>, policy?: PromptEnrichmentPolicy): string {
  const skillInstructions = state.runtimeDescriptor.resolvedSkills.map((skill) => `## Skill: ${skill.name}\n\n${skill.instructions}`).join('\n\n');
  const allowedTools = formatVisibleTools(state.runtimeDescriptor);
  const staticContext = buildContextSection(state, 'static', policy);
  const tokenBudget = state.runtimeDescriptor.guardrails.dailyTokenBudget;
  const guardRailLines: string[] = [];
  if (tokenBudget && tokenBudget !== 'unlimited tokens') {
    guardRailLines.push(`- Daily token budget: ${tokenBudget}`);
  }

  const toolsBlock = `You can call the following tools: ${allowedTools}.`;

  return [
    `You are an autonomous agent named "${state.runtimeDescriptor.name ?? state.runtimeDescriptor.agentId}". Use the available tools to accomplish your goal.`,
    skillInstructions,
    '## Your Goal',
    formatAgentGoalLiteralBlock(state.runtimeDescriptor.goal),
    '## Operating Context',
    ...formatPromptTimingContextLines(timing),
    '## Available Tools',
    toolsBlock,
    ...(guardRailLines.length > 0 ? ['## Guardrails', ...guardRailLines] : []),
    staticContext ? `## Runtime Context\n\n${staticContext}` : '',
    '## Instructions',
    'Take the next concrete step toward your goal.',
    'If nothing further can be done this tick, do not call any tool, rather respond with a short status update.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function buildTickUserContext(state: RuntimeCompositionState, incomingMessages: Array<Record<string, unknown>>, policy?: PromptEnrichmentPolicy): string {
  for (const message of incomingMessages) {
    applyRuntimeMessage(state, message);
  }

  const dynamicContext = buildContextSection(state, 'dynamic', policy);
  const progressSummary = computePerformanceSummary(state);
  const output = [dynamicContext, progressSummary].filter(Boolean).join('\n\n');

  // Reminder context and market wake context should only influence the tick immediately triggered by them.
  state.metrics.currentReminder = null;
  state.metrics.currentMarketWake = null;
  state.metrics.pendingMarketContext = [];

  return output;
}

export function buildVenueLines(state: RuntimeCompositionState): string[] {
  const connections = getEffectiveTradingConnections(state);
  if (connections.length === 0) return [];
  return connections.map((c) => formatTradingVenueLine(c.provider));
}

export function getVisibleToolNames(state: RuntimeCompositionState): string[] {
  const tools = new Set<string>();
  for (const skill of state.runtimeDescriptor.resolvedSkills) {
    for (const tool of skill.requiredTools) {
      tools.add(tool);
      if (tools.size >= state.runtimeDescriptor.budgets.maxVisibleToolSchemas) {
        return [...tools];
      }
    }
  }
  return [...tools];
}