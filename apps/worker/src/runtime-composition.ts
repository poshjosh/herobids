import type { CapabilityReadiness, RuntimeDescriptor, RuntimeDescriptorUpdatePayload } from '@herobids/domain';
import type { RegimeResult } from '@herobids/market-data';

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

export interface RuntimeVenueSignal {
  kind: 'perps' | 'dex';
  instrument: string;
  venue: string;
  fields: Array<{ label: string; value: string }>;
  freshness: RuntimeFreshness;
}

export interface RuntimeMarketSnapshot {
  symbol: string | null;
  price: number | null;
  freshness: RuntimeFreshness;
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

export interface RuntimeSessionMetrics {
  decisionsSubmitted: number;
  decisionsAccepted: number;
  decisionsRejected: number;
  lastPnlSummary: string | null;
  lastPositionSide: string | null;
  degradedCapabilities: Array<{ dependency: string; summary: string; guidance: string }>;
  managedBots: Array<{ id: string; status: string; strategyPreset?: string; symbol?: string }> | null;
  market: RuntimeMarketSnapshot;
  portfolio: RuntimePortfolioSummary;
  openPositions: RuntimePositionSnapshot[];
  recentEvents: RuntimeEventSummary[];
  venueSignals: RuntimeVenueSignal[];
  regime: {
    result: RegimeResult | null;
    freshness: RuntimeFreshness;
  };
  sessionCosts: RuntimeSessionCosts;
  performance: RuntimePerformanceInputs;
}

export interface RuntimeCompositionState {
  runtimeDescriptor: RuntimeDescriptor;
  sessionStartMs: number;
  tickCount: number;
  metrics: RuntimeSessionMetrics;
}

export interface RuntimeContextBlock {
  id: string;
  title: string;
  content: string;
  provider: string;
}

export interface RuntimeContextProvider {
  id: string;
  costTier: 'free' | 'cheap' | 'expensive';
  section: 'static' | 'dynamic';
  requiredFamilies: string[];
  trimOrder: number;
  preserveWhenTrimmed?: boolean;
  build: (state: RuntimeCompositionState) => RuntimeContextBlock | null;
}

const DEFAULT_SERVER_COST_PER_HOUR_USD = 0.02;
const MAX_RECENT_EVENTS = 6;

function unavailableFreshness(note: string): RuntimeFreshness {
  return { state: 'unavailable', note };
}

function freshFreshness(provider?: string): RuntimeFreshness {
  return { state: 'fresh', provider };
}

function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 'unavailable';
  }
  return `$${value.toFixed(2)}`;
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 'unavailable';
  }
  return `${value.toFixed(2)}%`;
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
  const tradingBindings = state.runtimeDescriptor.grantedBindingsByFamily['trading'] ?? [];
  const providers = new Set(tradingBindings.map((binding) => binding.provider.toLowerCase()));
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

function renderReadinessLine(family: string, readiness: CapabilityReadiness): string {
  const bindingSuffix = readiness.bindingId ? ` binding=${readiness.bindingId}` : '';
  const reasonSuffix = readiness.reasons.length > 0 ? ` reasons=${readiness.reasons.join('; ')}` : '';
  return `${family}: ${readiness.state} (${readiness.agentEligibility}${bindingSuffix}${reasonSuffix})`;
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
        `Goal: ${state.runtimeDescriptor.goal}`,
        `Execution mode: ${state.runtimeDescriptor.executionMode}`,
        `Tools visible: ${formatVisibleTools(state.runtimeDescriptor)}`,
        `Budgets: history=${state.runtimeDescriptor.budgets.maxHistoryMessages}, toolResults=${state.runtimeDescriptor.budgets.maxToolResultChars}, toolSchemas=${state.runtimeDescriptor.budgets.maxVisibleToolSchemas}`,
      ].join('\n'),
    }),
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
    id: 'degraded-capabilities',
    costTier: 'free',
    section: 'dynamic',
    requiredFamilies: [],
    trimOrder: 1,
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
    id: 'venue-intelligence',
    costTier: 'cheap',
    section: 'dynamic',
    requiredFamilies: ['trading'],
    trimOrder: 4,
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

function buildBlockList(state: RuntimeCompositionState, section: 'static' | 'dynamic'): Array<{ provider: RuntimeContextProvider; block: RuntimeContextBlock }> {
  return RUNTIME_CONTEXT_PROVIDERS
    .filter((provider) => provider.section === section)
    .filter((provider) => provider.requiredFamilies.every((family) => Boolean(state.runtimeDescriptor.readinessByFamily[family] || state.runtimeDescriptor.grantedBindingsByFamily[family])))
    .map((provider) => ({ provider, block: provider.build(state) }))
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

function buildContextSection(state: RuntimeCompositionState, section: 'static' | 'dynamic'): string {
  const blocks = section === 'static'
    ? buildBlockList(state, 'static').map(({ block }) => ({ ...block, content: trimText(block.content, state.runtimeDescriptor.budgets.maxContextBlockChars) }))
    : trimDynamicBlocks(state, buildBlockList(state, 'dynamic'));
  return blocks.map((block) => `## ${block.title}\n${block.content}`).join('\n\n');
}

export function createRuntimeCompositionState(runtimeDescriptor: RuntimeDescriptor): RuntimeCompositionState {
  return {
    runtimeDescriptor,
    sessionStartMs: Date.now(),
    tickCount: 0,
    metrics: {
      decisionsSubmitted: 0,
      decisionsAccepted: 0,
      decisionsRejected: 0,
      lastPnlSummary: null,
      lastPositionSide: null,
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
    },
  };
}

export function updateRuntimeDescriptor(
  state: RuntimeCompositionState,
  runtimeDescriptor: RuntimeDescriptor,
): void {
  state.runtimeDescriptor = runtimeDescriptor;
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
  state.metrics.openPositions = positions;
  state.metrics.lastPositionSide = positions[0]?.side ?? 'flat';
  const exposureUsd = positions.reduce((total, position) => {
    const size = parseNumber(position.size);
    const entryPrice = parseNumber(position.entryPrice);
    if (size === null || entryPrice === null) {
      return total;
    }
    return total + Math.abs(size * entryPrice);
  }, 0);
  const unrealizedPnlUsd = positions.reduce((total, position) => total + (position.unrealizedPnlUsd ?? 0), 0);
  state.metrics.portfolio.exposureUsd = positions.length === 0 ? 0 : exposureUsd;
  state.metrics.portfolio.unrealizedPnlUsd = positions.length === 0
    ? 0
    : positions.some((position) => position.unrealizedPnlUsd !== null)
      ? unrealizedPnlUsd
      : 0;
  refreshDerivedPerformanceInputs(state);
}

export function recordVenueSignals(state: RuntimeCompositionState, signals: RuntimeVenueSignal[]): void {
  state.metrics.venueSignals = signals;
}

export function recordRegimeEvaluation(
  state: RuntimeCompositionState,
  result: RegimeResult | null,
  freshness: RuntimeFreshness,
): void {
  state.metrics.regime = { result, freshness };
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
    const pnl = parseNumber(payload['pnl']) ?? parseNumber(position?.['realizedPnl']);
    if (pnl !== null) {
      updatePortfolioSummary(state, {
        unrealizedPnlUsd: pnl,
        freshness: freshFreshness('runtime-snapshot'),
      });
    }
    if (position?.['side']) {
      const instrumentId = String(payload['symbol'] ?? 'unknown');
      setOpenPositions(state, [{
        instrumentId,
        side: String(position['side']),
        size: String(position['size'] ?? 'unknown'),
        entryPrice: position['entryPrice'] ? String(position['entryPrice']) : null,
        unrealizedPnlUsd: pnl,
        openedAt: null,
        holdDurationMinutes: null,
        venueType: inferVenueType(state, instrumentId),
        freshness: freshFreshness('runtime-snapshot'),
      }]);
    } else if (position === null) {
      setOpenPositions(state, []);
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

  if (type === 'instance.tool.result') {
    const tool = typeof payload['tool'] === 'string' ? payload['tool'] : 'tool';
    const data = payload['data'] as Record<string, unknown> | Array<Record<string, unknown>> | undefined;

    if (tool === 'list_bots' && Array.isArray(data)) {
      state.metrics.managedBots = data.map((bot) => ({
        id: String(bot['id'] ?? 'unknown'),
        status: String(bot['status'] ?? 'unknown'),
        strategyPreset: typeof bot['strategyPreset'] === 'string' ? bot['strategyPreset'] : undefined,
        symbol: typeof bot['symbol'] === 'string' ? bot['symbol'] : undefined,
      }));
      const summary = `Bot list updated: ${data.length} bot(s)`;
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
      const summary = `Bot analytics: P&L ${state.metrics.lastPnlSummary ?? 'unavailable'}, open positions ${parseNumber(data['openPositions']) ?? 0}`;
      pushRecentEvent(state, type, summary);
      return summary;
    }

    if (tool === 'list_positions' && Array.isArray(data)) {
      setOpenPositions(state, data.map((position) => ({
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
      const summary = `Open positions: ${data.length}`;
      pushRecentEvent(state, type, summary);
      return summary;
    }

    const summary = typeof payload['message'] === 'string' ? String(payload['message']) : 'Tool result received';
    pushRecentEvent(state, type, summary);
    return summary;
  }

  const summary = `Platform message: ${type}`;
  pushRecentEvent(state, type, summary);
  return summary;
}

export function buildContextBlocks(state: RuntimeCompositionState): RuntimeContextBlock[] {
  const staticBlocks = buildBlockList(state, 'static').map(({ block }) => ({
    ...block,
    content: trimText(block.content, state.runtimeDescriptor.budgets.maxContextBlockChars),
  }));
  const dynamicBlocks = trimDynamicBlocks(state, buildBlockList(state, 'dynamic'));
  return [...staticBlocks, ...dynamicBlocks];
}

export function buildSystemPrompt(state: RuntimeCompositionState): string {
  const skillInstructions = state.runtimeDescriptor.resolvedSkills.map((skill) => skill.instructions).join('\n\n');
  const allowedTools = formatVisibleTools(state.runtimeDescriptor);
  const staticContext = buildContextSection(state, 'static');

  return [
    skillInstructions,
    '## Your Goal',
    state.runtimeDescriptor.goal,
    '## Available Tools',
    `You can call the following tools: ${allowedTools}.`,
    '## Agent Identity',
    `Agent ID: ${state.runtimeDescriptor.agentId}`,
    `Execution mode: ${state.runtimeDescriptor.executionMode}`,
    '## Guard Rails',
    `- Daily token budget: ${state.runtimeDescriptor.guardrails.dailyTokenBudget ?? 'unlimited'} tokens`,
    `- Daily loss limit: ${state.runtimeDescriptor.guardrails.dailyLossLimit ?? 'none'}`,
    `- Max concurrent bots: ${state.runtimeDescriptor.guardrails.maxBots ?? 'unlimited'}`,
    staticContext ? `## Runtime Context\n${staticContext}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function buildTickUserContext(state: RuntimeCompositionState, incomingMessages: Array<Record<string, unknown>>): string {
  for (const message of incomingMessages) {
    applyRuntimeMessage(state, message);
  }

  const dynamicContext = buildContextSection(state, 'dynamic');
  const progressSummary = computePerformanceSummary(state);
  return [dynamicContext, progressSummary].filter(Boolean).join('\n\n');
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