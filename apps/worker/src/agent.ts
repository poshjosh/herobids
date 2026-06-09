/**
 * Agent container entry point.
 *
 * This module runs inside the per-agent Docker container.
 * It reads config from environment variables, connects to Redis Streams,
 * and runs the agent reasoning loop.
 *
 * Does NOT import trading-actor, BullMQ worker, or bot execution code.
 */

import Redis from 'ioredis';
import crypto from 'node:crypto';
import { writeFile, mkdir, rm, access } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import pino from 'pino';
import { AGENT_MESSAGE_TYPES, BASE_SKILL, BOT_MANAGEMENT_SKILL, RISK_MONITORING_SKILL, TRADING_SKILL } from '@herobids/domain';
import { createDatabase, BotRepository } from '@herobids/db';
import type { RuntimeDescriptor, SkillDefinition } from '@herobids/domain';
import { stripReasoningContent } from '@herobids/llm';
import {
  type BybitCrowdingSignal,
  createProviderRegistry,
  type HyperliquidAssetContext,
  type MarketDataConfig,
  type ProviderRegistry,
  type TokenInfo,
  evaluateRegime,
  type RegimeParams,
} from '@herobids/market-data';
import { buildCapabilityGrants, buildCapabilityPolicyEngine } from './agents/capability-policy.js';
import { SandboxEnforcer } from './agents/sandbox-enforcer.js';
import { OUTBOUND_READ_BLOCK_MS, OUTBOUND_READ_TIMEOUT_MS, readOutboundMessages as readAgentOutboundMessages } from './agents/outbound-message-reader.js';
import { buildIncrementalContext } from './context-diff.js';
import { resolveAgentCostProfile, type CostPreset } from './cost-profile.js';
import {
  applyRuntimeMessage,
  buildSystemPrompt as composeSystemPrompt,
  buildTickUserContext,
  createRuntimeCompositionState,
  getVisibleToolNames,
  recordPerformanceInputs,
  recordRegimeEvaluation,
  recordSessionCost,
  setCapabilityDegradation,
  recordVenueSignals,
  type RuntimeCompositionState,
} from './runtime-composition.js';
import { executeDiscoverTokensTool, executeFundingRatesTool, executeMarketOverviewTool } from './intelligence-tools.js';
import { shouldSkipTick, type TradingHoursConfig } from './tick-gates.js';
import { buildScoutSystemPrompt, parseScoutDecision, resolveDefaultScoutModel } from './scout-dispatch.js';
import { callLlmWithRetry, classifyRuntimeError } from './runtime-errors.js';
import { applyToolExclusions, FailureBackoffController, ToolCircuitBreaker } from './runtime-resilience.js';
import { processRuntimeFailure } from './runtime-degradation.js';
import { createRuntimeToolVisibilityController, DATABASE_DEPENDENT_TOOLS, MARKET_DATA_TOOLS } from './runtime-tool-visibility.js';
import { classifyTickThinking, extractDrawdownPct } from './tick-thinking.js';
import { buildDiscoveryNetworkMap, collectDexTrackedTargets, collectPerpsTrackedSymbols, findDexPositionForTarget, normalizeTrackedSymbol } from './venue-intelligence.js';

const execFileAsync = promisify(execFileCb);

const logger = pino({ name: 'agent-runtime', level: process.env['LOG_LEVEL'] ?? 'info' });

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------

const AGENT_ID = process.env['AGENT_ID'];
const SESSION_ID = process.env['SESSION_ID'];
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const AGENT_CONFIG_RAW = process.env['AGENT_CONFIG'] ?? '{}';
// TOOL_POLICY is forwarded into the container and enforced here for direct-tier tools.
// Brokered tools are also enforced by the broker, but the container adds a second gate.
const TOOL_POLICY_RAW = process.env['TOOL_POLICY'] ?? '{}';
const MARKET_DATA_CONFIG_RAW = process.env['MARKET_DATA_CONFIG_JSON'];
const LLM_MODEL = process.env['LLM_MODEL'] ?? 'claude-sonnet-4-5';
const LLM_PROVIDER = process.env['LLM_PROVIDER'];
const LLM_BASE_URL = process.env['LLM_BASE_URL'];
const LLM_MAX_TOKENS = parseInt(process.env['LLM_MAX_TOKENS'] ?? '4096', 10);
const LLM_TIMEOUT_MS = parseInt(process.env['LLM_TIMEOUT_MS'] ?? '60000', 10);
const TICK_INTERVAL_MS = parseInt(process.env['TICK_INTERVAL_MS'] ?? '900000', 10);
const HEARTBEAT_INTERVAL_MS = parseInt(process.env['HEARTBEAT_INTERVAL_MS'] ?? '5000', 10);
const SERVER_COST_USD_PER_HOUR = Number(process.env['LLM_SERVER_COST_USD_PER_HOUR'] ?? '0.02');
const TRADING_HOURS_RAW = process.env['TRADING_HOURS_JSON'];
// 0 = unlimited (the default). Set to a positive number of milliseconds to impose
// a hard wall-clock cap on any single agent session.
const SANDBOX_MAX_WALL_CLOCK_MS = parseInt(process.env['SANDBOX_MAX_WALL_CLOCK_MS'] ?? '0', 10);

if (!AGENT_ID || !SESSION_ID) {
  logger.fatal({ AGENT_ID, SESSION_ID }, 'AGENT_ID and SESSION_ID env vars are required');
  process.exit(1);
}

if (!LLM_PROVIDER) {
  logger.fatal('LLM_PROVIDER env var is required');
  process.exit(1);
}

const LLM_API_KEY_RESOLVED =
  process.env[`LLM_API_KEY_${LLM_PROVIDER.toUpperCase()}`] ||
  process.env['LLM_API_KEY'];
// Local providers (e.g. Ollama) don't need an API key when LLM_BASE_URL is set.
if (!LLM_API_KEY_RESOLVED && !LLM_BASE_URL) {
  logger.fatal({ provider: LLM_PROVIDER }, 'No API key found for LLM provider — set LLM_API_KEY or LLM_API_KEY_<PROVIDER>');
  process.exit(1);
}

interface AgentConfig {
  prompt?: string;
  goal?: string;
  skillIds?: string[];
  executionMode?: string;
  scoutModel?: string;
  costPreset?: CostPreset;
  dailySpendBudgetUsd?: number;
  dexWatchlistSymbols?: string[];
  dailyTokenBudget?: number;
  dailyLossLimit?: string;
  maxBots?: number;
  maxSlippageBps?: number;
  telegramChatId?: string;
  runtimeDescriptor?: RuntimeDescriptor;
}

let agentConfig: AgentConfig;

function parseTradingHours(rawTradingHours: string | undefined): TradingHoursConfig | undefined {
  if (!rawTradingHours) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(rawTradingHours) as TradingHoursConfig;
    return parsed;
  } catch {
    logger.warn({ rawTradingHours }, 'Failed to parse TRADING_HOURS_JSON — session gate disabled');
    return undefined;
  }
}

function parseToolPolicy(rawPolicy: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawPolicy) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    logger.warn('Failed to parse TOOL_POLICY — using defaults');
  }
  return {};
}

// SandboxEnforcer enforces the session wall-clock limit in-process. All other
// sandbox limits (network, download) require hooking the network layer inside
// the container process and are enforced by the container runtime (cgroups/ulimits).
const sandboxEnforcer = new SandboxEnforcer({ maxWallClockMs: SANDBOX_MAX_WALL_CLOCK_MS });

try {
  agentConfig = JSON.parse(AGENT_CONFIG_RAW) as AgentConfig;
} catch {
  logger.fatal({ AGENT_CONFIG_RAW }, 'Failed to parse AGENT_CONFIG');
  process.exit(1);
}

const agentGoal = agentConfig.prompt ?? agentConfig.goal ?? 'No goal provided';
const skillIds = agentConfig.skillIds ?? [];
const initialToolPolicy = agentConfig.runtimeDescriptor?.toolPolicy ?? parseToolPolicy(TOOL_POLICY_RAW);
const tradingHours = parseTradingHours(TRADING_HOURS_RAW);
const costProfile = resolveAgentCostProfile({
  provider: LLM_PROVIDER!,
  judgeModel: LLM_MODEL,
  scoutModel: agentConfig.scoutModel,
  costPreset: agentConfig.costPreset,
  dailyBudgetUsd: agentConfig.dailySpendBudgetUsd,
  baseTickIntervalMs: TICK_INTERVAL_MS,
});

// ---------------------------------------------------------------------------
// Skill resolution
// ---------------------------------------------------------------------------

const ALL_SKILLS_BY_ID: Record<string, SkillDefinition> = {
  base: BASE_SKILL,
  'bot-management': BOT_MANAGEMENT_SKILL,
  trading: TRADING_SKILL,
  'risk-monitoring': RISK_MONITORING_SKILL,
};

function resolveSkills(ids: string[]): SkillDefinition[] {
  return ids
    .map((id) => ALL_SKILLS_BY_ID[id])
    .filter((s): s is SkillDefinition => s !== undefined);
}

const activeSkills = resolveSkills(skillIds);
// Base skill is always injected at runtime
const allActiveSkills = [BASE_SKILL, ...activeSkills];

function buildFallbackRuntimeDescriptor(): RuntimeDescriptor {
  const isTradingSkill = (skillId: string) => skillId === 'bot-management' || skillId === 'risk-monitoring' || skillId === 'trading';
  const resolvedSkills = allActiveSkills.map((skill) => ({
    ...skill,
    capabilityFamilies: isTradingSkill(skill.id) ? ['trading'] : [],
    bindingRequirements: (isTradingSkill(skill.id)
      ? { trading: { minBindings: 1, requireReady: true } }
      : {}) as Record<string, { minBindings: number; requireReady: boolean }>,
    requiredContextBlocks: isTradingSkill(skill.id)
      ? ['corePlatformContext', 'tradingContext']
      : ['corePlatformContext'],
    promptRendererHints: isTradingSkill(skill.id)
      ? ['readiness-summary', 'trading']
      : ['core-system'],
  })) as SkillDefinition[];

  return {
    schemaVersion: 'v1',
    agentId: AGENT_ID!,
    goal: agentGoal,
    executionMode: agentConfig.executionMode ?? 'paper',
    resolvedSkills,
    grantedBindingsByFamily: {},
    defaultBindingByFamily: {},
    readinessByFamily: {},
    toolPolicy: initialToolPolicy,
    guardrails: {
      dailyTokenBudget: agentConfig.dailyTokenBudget ?? null,
      dailyLossLimit: agentConfig.dailyLossLimit ?? null,
      maxBots: agentConfig.maxBots ?? null,
      maxSlippageBps: agentConfig.maxSlippageBps ?? null,
    },
    budgets: {
      maxHistoryMessages: 20,
      maxRecentToolMessages: 6,
      maxToolResultChars: 4_000,
      maxVisibleToolSchemas: 16,
      maxContextBlockChars: 4_000,
    },
  };
}

const runtimeDescriptor = agentConfig.runtimeDescriptor ?? buildFallbackRuntimeDescriptor();
const runtimeState: RuntimeCompositionState = createRuntimeCompositionState(runtimeDescriptor);
runtimeState.metrics.sessionCosts.estimatedServerCostUsdPerHour = Number.isFinite(SERVER_COST_USD_PER_HOUR)
  ? SERVER_COST_USD_PER_HOUR
  : runtimeState.metrics.sessionCosts.estimatedServerCostUsdPerHour;
const sessionMetrics = runtimeState.metrics;
let capabilityEngine = buildCapabilityPolicyEngine(runtimeState.runtimeDescriptor.toolPolicy);
const permanentlyExcludedTools = new Set<string>();
const toolCircuitBreaker = new ToolCircuitBreaker();
const failureBackoff = new FailureBackoffController({ baseIntervalMs: costProfile.tickIntervalMs });
const toolVisibility = createRuntimeToolVisibilityController(() => runtimeState.runtimeDescriptor, permanentlyExcludedTools);
const marketDataRuntimeTelemetry = {
  providerAttempts: new Map<string, number>(),
  providerRejections: new Map<string, number>(),
  fallbackActivations: 0,
  executionPriorityStarvationEvents: 0,
  maxPriceStalenessMs: 0,
  maxDiscoveryStalenessMs: 0,
  recoveryTimeMs: new Map<string, number>(),
  failureStartedAtMs: new Map<string, number>(),
};

function recordMarketDataAttempt(provider: string): void {
  marketDataRuntimeTelemetry.providerAttempts.set(provider, (marketDataRuntimeTelemetry.providerAttempts.get(provider) ?? 0) + 1);
}

function recordMarketDataRejection(provider: string, options?: { priority?: 'execution' | 'discovery' }): void {
  marketDataRuntimeTelemetry.providerRejections.set(provider, (marketDataRuntimeTelemetry.providerRejections.get(provider) ?? 0) + 1);
  if (!marketDataRuntimeTelemetry.failureStartedAtMs.has(provider)) {
    marketDataRuntimeTelemetry.failureStartedAtMs.set(provider, Date.now());
  }
  if (options?.priority === 'execution') {
    marketDataRuntimeTelemetry.executionPriorityStarvationEvents += 1;
  }
}

function recordMarketDataRecovery(provider: string): void {
  const failureStartedAtMs = marketDataRuntimeTelemetry.failureStartedAtMs.get(provider);
  if (failureStartedAtMs !== undefined) {
    marketDataRuntimeTelemetry.recoveryTimeMs.set(provider, Date.now() - failureStartedAtMs);
    marketDataRuntimeTelemetry.failureStartedAtMs.delete(provider);
  }
}

function recordMarketDataFallback(): void {
  marketDataRuntimeTelemetry.fallbackActivations += 1;
}

function recordSignalStaleness(kind: 'price' | 'discovery', ageMs: number): void {
  if (kind === 'price') {
    marketDataRuntimeTelemetry.maxPriceStalenessMs = Math.max(marketDataRuntimeTelemetry.maxPriceStalenessMs, ageMs);
  } else {
    marketDataRuntimeTelemetry.maxDiscoveryStalenessMs = Math.max(marketDataRuntimeTelemetry.maxDiscoveryStalenessMs, ageMs);
  }
}

function logMarketDataTelemetry(): void {
  const rejectionRatePctByProvider = Object.fromEntries(
    [...marketDataRuntimeTelemetry.providerAttempts.entries()].map(([provider, attempts]) => {
      const rejections = marketDataRuntimeTelemetry.providerRejections.get(provider) ?? 0;
      const rejectionRatePct = attempts > 0 ? (rejections / attempts) * 100 : 0;
      return [provider, rejectionRatePct];
    }),
  );
  const maxProviderRejectionRatePct = Math.max(0, ...Object.values(rejectionRatePctByProvider));

  logger.info({
    metric: 'agent.market_data.telemetry',
    providerAttemptCount: Object.fromEntries(marketDataRuntimeTelemetry.providerAttempts),
    rejectionCountByProvider: Object.fromEntries(marketDataRuntimeTelemetry.providerRejections),
    rejectionRatePctByProvider,
    fallbackActivationCount: marketDataRuntimeTelemetry.fallbackActivations,
    executionPriorityStarvationEvents: marketDataRuntimeTelemetry.executionPriorityStarvationEvents,
    maxDataStalenessMs: {
      price: marketDataRuntimeTelemetry.maxPriceStalenessMs,
      discovery: marketDataRuntimeTelemetry.maxDiscoveryStalenessMs,
    },
    thresholdStatus: {
      executionPriorityStarvation: marketDataRuntimeTelemetry.executionPriorityStarvationEvents === 0 ? 'PASS' : 'FAIL',
      maxProviderRejectionRate: maxProviderRejectionRatePct < 10 ? 'PASS' : maxProviderRejectionRatePct <= 20 ? 'WARN' : 'FAIL',
      priceStaleness: marketDataRuntimeTelemetry.maxPriceStalenessMs <= 60_000 ? 'PASS' : 'FAIL',
      discoveryStaleness: marketDataRuntimeTelemetry.maxDiscoveryStalenessMs <= 300_000 ? 'PASS' : 'FAIL',
    },
    recoveryTimeMsByProvider: Object.fromEntries(marketDataRuntimeTelemetry.recoveryTimeMs),
  }, 'Market-data runtime telemetry');
}

function applyToolVisibility(): void {
  toolVisibility.applyToolVisibility(toolCircuitBreaker.getBlockedTools(tickCount));
}

function setDependencyAvailability(dependency: 'database' | 'market-data', available: boolean): void {
  toolVisibility.setDependencyAvailability(dependency, available, toolCircuitBreaker.getBlockedTools(tickCount));
  setCapabilityDegradation(runtimeState, dependency, !available);
}

function refreshToolCircuits(): void {
  const { reopened } = toolCircuitBreaker.refresh(tickCount);
  for (const tool of reopened) {
    logger.info({ tool, tickCount }, 'Tool circuit closed');
  }
  applyToolVisibility();
}

function recordToolFailure(tool: string): void {
  const result = toolCircuitBreaker.recordFailure(tool, tickCount);
  if (result.opened) {
    logger.warn({ tool, reopenAtTick: result.reopenAtTick }, 'Tool circuit opened');
    applyToolVisibility();
  }
}

function recordToolSuccess(tool: string): void {
  toolCircuitBreaker.recordSuccess(tool);
}

function toolResultIndicatesFailure(toolResult: string): boolean {
  try {
    const parsed = JSON.parse(toolResult) as { ok?: boolean };
    return parsed.ok === false;
  } catch {
    return false;
  }
}

applyToolVisibility();

// The runtime-authorised tool set is derived from the active runtime descriptor.
// It is re-evaluated on each tick so refresh messages can tighten or expand access.
function allowedTools(): Set<string> {
  return new Set(getVisibleToolNames(runtimeState));
}

function refreshCapabilityPolicy(): void {
  capabilityEngine.replaceGrants(buildCapabilityGrants(runtimeState.runtimeDescriptor.toolPolicy));
}

// ---------------------------------------------------------------------------
// Redis Streams transport
// ---------------------------------------------------------------------------

const parsedRedisUrl = new URL(REDIS_URL);
const redis = new Redis({
  host: parsedRedisUrl.hostname || 'localhost',
  port: parseInt(parsedRedisUrl.port || '6379', 10),
  ...(parsedRedisUrl.password && { password: decodeURIComponent(parsedRedisUrl.password) }),
  ...(parsedRedisUrl.protocol === 'rediss:' && { tls: {} }),
  lazyConnect: false,
  maxRetriesPerRequest: 3,
});

const INBOUND_STREAM = `agent:inbound:${AGENT_ID}`;
const OUTBOUND_STREAM = `agent:outbound:${AGENT_ID}`;
const CONSUMER_GROUP = 'agent-runtime';
const CONSUMER_NAME = `agent-${AGENT_ID}-${process.pid}`;

// ---------------------------------------------------------------------------
// Database (optional — enables direct bot tool access)
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env['DATABASE_URL'];
const db = DATABASE_URL ? createDatabase(DATABASE_URL) : null;
const botRepo = db ? new BotRepository(db) : null;
if (!DATABASE_URL) {
  logger.warn('DATABASE_URL not set — list_bots, get_bot_status, stop_bot, start_bot, adjust_bot_config, get_analytics, list_positions will be unavailable');
  for (const tool of DATABASE_DEPENDENT_TOOLS) {
    permanentlyExcludedTools.add(tool);
  }
  applyToolVisibility();
}

// ---------------------------------------------------------------------------
// Market data (optional — enables search_tokens and check_regime tools)
// ---------------------------------------------------------------------------

let marketDataConfig: MarketDataConfig | null = null;
if (MARKET_DATA_CONFIG_RAW) {
  try {
    marketDataConfig = JSON.parse(MARKET_DATA_CONFIG_RAW) as MarketDataConfig;
  } catch (err) {
    logger.warn({ err }, 'Failed to parse MARKET_DATA_CONFIG_JSON — market-data tools will be unavailable');
  }
}

let marketDataRegistry: ProviderRegistry | null = null;
if (marketDataConfig) {
  marketDataRegistry = createProviderRegistry(marketDataConfig, { redisClient: redis });
} else {
  logger.warn('MARKET_DATA_CONFIG_JSON not set — market-data intelligence tools will be unavailable');
  for (const tool of MARKET_DATA_TOOLS) {
    permanentlyExcludedTools.add(tool);
  }
  applyToolVisibility();
}

function filterSearchResults(
  rawResults: TokenInfo[],
  options?: { network?: string; minLiquidityUsd?: number; limit?: number },
) {
  const minLiquidityUsd = options?.minLiquidityUsd ?? 10_000;
  const limit = options?.limit ?? 10;
  const network = options?.network?.toLowerCase();
  const filtered = rawResults
    .filter((token: TokenInfo) => token.liquidityUsd >= minLiquidityUsd)
    .filter((token: TokenInfo) => !network || token.network.toLowerCase() === network)
    .sort((left: TokenInfo, right: TokenInfo) => right.liquidityUsd - left.liquidityUsd);

  const deduped: typeof filtered = [];
  const seen = new Set<string>();
  for (const token of filtered) {
    const key = `${token.network}:${token.address}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(token);
  }

  return deduped.slice(0, limit);
}

function estimateLlmCostUsd(model: string, tokensUsed: number): number {
  const normalizedModel = model.toLowerCase();
  let blendedRatePerMillion = 6;

  if (/(haiku|mini|flash)/.test(normalizedModel)) {
    blendedRatePerMillion = 1.5;
  } else if (/(sonnet|gpt-4o|gpt-4\.1|o3)/.test(normalizedModel)) {
    blendedRatePerMillion = 6;
  } else if (/(opus|o1|gpt-5)/.test(normalizedModel)) {
    blendedRatePerMillion = 20;
  }

  return (tokensUsed / 1_000_000) * blendedRatePerMillion;
}

function providerFreshness(
  freshness: { isStale: boolean; ageMs: number },
  provider: string,
  note?: string,
) {
  return freshness.isStale
    ? { state: 'stale' as const, ageMs: freshness.ageMs, provider, note }
    : { state: 'fresh' as const, ageMs: freshness.ageMs, provider, note };
}

function extractTradingProviders(): Set<string> {
  return new Set(
    (runtimeState.runtimeDescriptor.grantedBindingsByFamily['trading'] ?? [])
      .map((binding) => binding.provider.toLowerCase()),
  );
}

async function refreshVenueIntelligence(): Promise<void> {
  if (!marketDataRegistry) {
    recordVenueSignals(runtimeState, []);
    return;
  }

  const tradingProviders = extractTradingProviders();
  const trackedPerpsSymbols = collectPerpsTrackedSymbols(sessionMetrics).slice(0, 3);
  const trackedDexTargets = collectDexTrackedTargets(sessionMetrics, agentConfig.dexWatchlistSymbols).slice(0, 3);
  const signals: Array<Parameters<typeof recordVenueSignals>[1][number]> = [];

  if (trackedPerpsSymbols.length > 0 && (tradingProviders.has('hyperliquid') || tradingProviders.has('bybit'))) {
    try {
      recordMarketDataAttempt('hyperliquid');
      const assetContexts = await marketDataRegistry.hyperliquid.assetContexts();
      recordMarketDataRecovery('hyperliquid');
      const assetMap = new Map(assetContexts.data.map((asset) => [asset.asset.toUpperCase(), asset] as const));
      for (const symbol of trackedPerpsSymbols) {
        const asset = assetMap.get(symbol);
        if (!asset) {
          signals.push({
            kind: 'perps',
            instrument: symbol,
            venue: 'hyperliquid',
            fields: [{ label: 'Status', value: 'unavailable' }],
            freshness: { state: 'unavailable', provider: 'hyperliquid', note: 'asset context unavailable' },
          });
          continue;
        }

        let longShortRatio: number | null = null;
        let bybitRatioUnavailable = false;
        if (tradingProviders.has('bybit')) {
          try {
            recordMarketDataAttempt('bybit');
            const ratioResult = await marketDataRegistry.bybit.longShortRatio(`${symbol}USDT`);
            longShortRatio = ratioResult.data[0]?.longShortRatio ?? null;
            recordMarketDataRecovery('bybit');
          } catch (err) {
            logger.warn({ err, symbol }, 'Failed to fetch Bybit crowding ratio for venue intelligence');
            bybitRatioUnavailable = true;
            recordMarketDataFallback();
            recordMarketDataRejection('bybit', { priority: 'execution' });
          }
        }

        signals.push({
          kind: 'perps',
          instrument: symbol,
          venue: tradingProviders.has('bybit') ? 'hyperliquid+bybit' : 'hyperliquid',
          fields: [
            { label: 'Funding', value: asset.fundingRate === null ? 'unavailable' : `${(asset.fundingRate * 100).toFixed(4)}%` },
            { label: 'Open interest', value: asset.openInterest === null ? 'unavailable' : asset.openInterest.toFixed(2) },
            { label: 'Mark/oracle spread', value: asset.markOracleSpreadPct === null ? 'unavailable' : `${asset.markOracleSpreadPct.toFixed(3)}%` },
            { label: '24h volume', value: asset.volume24hUsd === null ? 'unavailable' : `$${asset.volume24hUsd.toFixed(0)}` },
            { label: '24h change', value: asset.priceChange24hPct === null ? 'unavailable' : `${asset.priceChange24hPct.toFixed(2)}%` },
            { label: 'Long/short ratio', value: longShortRatio === null ? 'unavailable' : longShortRatio.toFixed(2) },
          ],
          freshness: bybitRatioUnavailable
            ? providerFreshness(assetContexts.meta.freshness, 'hyperliquid', 'Bybit ratio unavailable')
            : providerFreshness(assetContexts.meta.freshness, 'hyperliquid'),
        });
        if (assetContexts.meta.freshness.ageMs > 0) {
          recordSignalStaleness('price', assetContexts.meta.freshness.ageMs);
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to refresh perps venue intelligence');
      recordMarketDataRejection('hyperliquid', { priority: 'execution' });
      for (const symbol of trackedPerpsSymbols) {
        signals.push({
          kind: 'perps',
          instrument: symbol,
          venue: 'hyperliquid',
          fields: [{ label: 'Status', value: 'unavailable' }],
          freshness: { state: 'unavailable', provider: 'hyperliquid', note: 'venue intelligence fetch failed' },
        });
      }
    }
  }

  if (trackedDexTargets.length > 0 && (tradingProviders.has('jupiter') || tradingProviders.has('1inch'))) {
    // Key: `${network}:${SYMBOL}` to avoid cross-chain ticker collisions (e.g. USDC on Solana vs Ethereum).
    let discoveryByNetworkSymbol = new Map<string, Awaited<ReturnType<ProviderRegistry['discovery']['discover']>>['data'][number]>();
    let discoveryFreshness: ReturnType<typeof providerFreshness> | null = null;
    try {
      recordMarketDataAttempt('aggregated-discovery');
      const discoveryResult = await marketDataRegistry.discovery.discover({ maxResults: 25 });
      recordMarketDataRecovery('aggregated-discovery');
      discoveryFreshness = providerFreshness(discoveryResult.meta.freshness, discoveryResult.meta.provider);
      recordSignalStaleness('discovery', discoveryResult.meta.freshness.ageMs);
      discoveryByNetworkSymbol = buildDiscoveryNetworkMap(discoveryResult.data);
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch DEX discovery context for venue intelligence');
      recordMarketDataRejection('aggregated-discovery', { priority: 'discovery' });
    }

    for (const target of trackedDexTargets.slice(0, 2)) {
      try {
        recordMarketDataAttempt('dexscreener');
        const searchResult = await marketDataRegistry.dexscreener.search(target.symbol);
        recordMarketDataRecovery('dexscreener');
        const filteredSearchResults = target.network
          ? searchResult.data.filter((token) => token.network.toLowerCase() === target.network)
          : searchResult.data;
        const topToken = filterSearchResults(filteredSearchResults, { limit: 1 })[0];
        const position = findDexPositionForTarget(sessionMetrics.openPositions, target);
        // Look up using the search-result network so we only attach discovery context from
        // the same chain as the token DexScreener actually returned.
        const discoveryToken = topToken
          ? (discoveryByNetworkSymbol.get(`${topToken.network.toLowerCase()}:${topToken.symbol.toUpperCase()}`) ?? null)
          : null;
        if (!topToken) {
          signals.push({
            kind: 'dex',
            instrument: target.symbol,
            venue: 'dexscreener',
            fields: [{ label: 'Status', value: 'unavailable' }],
            freshness: { state: 'unavailable', provider: 'dexscreener', note: 'token not found' },
          });
          continue;
        }

        signals.push({
          kind: 'dex',
          instrument: `${topToken.symbol} (${topToken.network})`,
          venue: 'dexscreener',
          fields: [
            { label: 'Price', value: `$${topToken.priceUsd.toFixed(6)}` },
            { label: 'Held size', value: position?.size ?? 'unavailable' },
            {
              label: 'Held USD value',
              value: position ? `$${(Number(position.size) * topToken.priceUsd).toFixed(2)}` : 'unavailable',
            },
            { label: 'Liquidity', value: `$${topToken.liquidityUsd.toFixed(0)}` },
            { label: '24h volume', value: `$${topToken.volume24hUsd.toFixed(0)}` },
            { label: '24h change', value: `${topToken.priceChange24hPct.toFixed(2)}%` },
            {
              label: 'Pool age',
              value: discoveryToken?.poolCreatedAt
                ? `${Math.max(0, Math.round((Date.now() - new Date(discoveryToken.poolCreatedAt).getTime()) / 3_600_000))}h`
                : 'unavailable',
            },
            {
              label: 'Discovery freshness',
              value: discoveryFreshness ? discoveryFreshness.state : 'unavailable',
            },
            {
              label: 'Discovery vectors',
              value: discoveryToken?.discoveryVectors.join(', ') ?? 'unavailable',
            },
          ],
          freshness: providerFreshness(
            searchResult.meta.freshness,
            searchResult.meta.provider,
            discoveryFreshness?.state === 'stale' ? 'discovery list stale' : undefined,
          ),
        });
      } catch (err) {
        logger.warn({ err, target }, 'Failed to refresh DEX venue intelligence');
        recordMarketDataRejection('dexscreener', { priority: 'discovery' });
        signals.push({
          kind: 'dex',
          instrument: target.symbol,
          venue: 'dexscreener',
          fields: [{ label: 'Status', value: 'unavailable' }],
          freshness: { state: 'unavailable', provider: 'dexscreener', note: 'dex intelligence fetch failed' },
        });
      }
    }
  }

  recordVenueSignals(runtimeState, signals);
  logMarketDataTelemetry();
}

async function publishToInbound(type: string, payload: Record<string, unknown>): Promise<void> {
  const envelope = {
    schemaVersion: 'v1',
    messageId: crypto.randomUUID(),
    correlationId: SESSION_ID!,
    initiatorType: 'agent',
    initiatorId: AGENT_ID!,
    agentId: AGENT_ID!,
    type,
    createdAt: new Date().toISOString(),
    payload,
  };
  await redis.xadd(INBOUND_STREAM, '*', 'envelope', JSON.stringify(envelope));
}

async function sendHeartbeat(status: 'starting' | 'ready' | 'busy' | 'degraded', reasonCode?: string): Promise<void> {
  try {
    await publishToInbound(AGENT_MESSAGE_TYPES.RUNTIME_HEARTBEAT, {
      sessionId: SESSION_ID!,
      status,
      ...(reasonCode ? { reasonCode } : {}),
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to send heartbeat');
  }
}

// At startup, claim any entries in the PEL that were delivered to a previous
// container incarnation (different PID → different consumer name) but never
// acknowledged before that container died. We steal entries idle > 30 s and
// ACK them immediately. The agent will receive fresh context on its first tick;
// stale snapshots / feedback from the previous run do not need to be replayed.
async function drainStalePendingEntries(): Promise<void> {
  const IDLE_THRESHOLD_MS = 30_000;
  let cursor = '0-0';
  let recovered = 0;

  // Ensure the group exists before claiming.
  await redis.xgroup('CREATE', OUTBOUND_STREAM, CONSUMER_GROUP, '0', 'MKSTREAM').catch((err: unknown) => {
    if (err instanceof Error && !err.message.includes('BUSYGROUP')) throw err;
  });

  for (;;) {
    const result = await redis.xautoclaim(
      OUTBOUND_STREAM, CONSUMER_GROUP, CONSUMER_NAME,
      IDLE_THRESHOLD_MS, cursor, 'COUNT', 100,
    ) as [string, Array<[string, string[]]>, string[]];

    const [nextCursor, entries] = result;

    for (const [msgId] of entries) {
      await redis.xack(OUTBOUND_STREAM, CONSUMER_GROUP, msgId).catch(() => { /* ignore */ });
      recovered++;
    }

    if (nextCursor === '0-0') break;
    cursor = nextCursor;
  }

  if (recovered > 0) {
    logger.warn({ recovered }, 'ACKed stale pending entries from previous container incarnation');
  }
}

// Read pending messages from the outbound stream (platform → agent)
async function readOutboundMessages(): Promise<Array<Record<string, unknown>>> {
  return readAgentOutboundMessages(redis, {
    outboundStream: OUTBOUND_STREAM,
    consumerGroup: CONSUMER_GROUP,
    consumerName: CONSUMER_NAME,
    blockMs: OUTBOUND_READ_BLOCK_MS,
    count: 10,
  });
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

function parseToolCalls(llmResponse: string): ToolCall[] {
  const sanitizedResponse = stripReasoningContent(llmResponse);
  const calls: ToolCall[] = [];
  let i = 0;

  // Depth-tracking scanner: handles nested objects inside `args` that the old
  // flat regex /[^{}]/ could not match (e.g. create_bot's config sub-object).
  while (i < sanitizedResponse.length) {
    const start = sanitizedResponse.indexOf('{', i);
    if (start === -1) break;

    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;

    for (let j = start; j < sanitizedResponse.length; j++) {
      const ch = sanitizedResponse[j]!;
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = j; break; }
      }
    }

    if (end === -1) break; // Unclosed brace — stop scanning

    const candidate = sanitizedResponse.slice(start, end + 1);
    try {
      const parsed = JSON.parse(candidate) as { tool?: string; args?: Record<string, unknown> };
      if (typeof parsed.tool === 'string' && parsed.args && typeof parsed.args === 'object') {
        calls.push({ tool: parsed.tool, args: parsed.args });
      }
    } catch {
      // Not a valid JSON object or not a tool call — skip
    }

    i = end + 1;
  }

  return calls;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMergeConfig(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = merged[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      merged[key] = deepMergeConfig(current, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

async function executeTool(call: ToolCall): Promise<string | null> {
  // Hard runtime gate: reject any tool not declared in the active skill set.
  // The model was only told about allowed tools, but we enforce it here too so
  // a jailbreak or prompt injection cannot invoke undeclared capabilities.
  if (!allowedTools().has(call.tool)) {
    logger.warn({ tool: call.tool, agentId: AGENT_ID }, 'Tool not in active skill set — ignoring');
    return `tool rejected: ${call.tool} is not available in the current skill set`;
  }

  logger.info({ tool: call.tool, args: call.args }, 'Executing tool');

  switch (call.tool) {
    case 'send_message': {
      await publishToInbound(AGENT_MESSAGE_TYPES.SEND_MESSAGE, {
        body: call.args['body'] as string ?? 'No message body',
        subject: call.args['subject'] as string | undefined,
      });
      return JSON.stringify({ ok: true, note: 'message queued for delivery' });
    }

    case 'set_memory': {
      const key = call.args['key'];
      const value = call.args['value'];
      if (typeof key === 'string' && key.length > 0 && value !== undefined) {
        await redis.hset(`agent:memory:${AGENT_ID}`, key, JSON.stringify(value));
        logger.debug({ key }, 'Memory entry set');
        return JSON.stringify({ ok: true, key });
      }
      return JSON.stringify({ ok: false, note: 'key or value missing' });
    }

    case 'artifact_publish': {
      const artifactId = crypto.randomUUID();
      await publishToInbound(AGENT_MESSAGE_TYPES.ARTIFACT_PUBLISH, {
        artifactId,
        artifactType: call.args['artifactType'] as string ?? 'text',
        contentType: call.args['contentType'] as string ?? 'text/plain',
        summary: call.args['summary'] as string ?? '',
        location: call.args['location'],
        metadata: call.args['metadata'],
      });
      return JSON.stringify({ ok: true, artifactId });
    }

    case 'submit_decision': {
      sessionMetrics.decisionsSubmitted++;
      const decisionId = crypto.randomUUID();
      await publishToInbound(AGENT_MESSAGE_TYPES.DECISION_SUBMIT, {
        decisionId,
        instrumentId: call.args['instrumentId'] as string ?? '',
        intent: call.args['intent'] as string ?? 'go_flat',
        targetSize: call.args['targetSize'] as string ?? '0',
        limitPrice: call.args['limitPrice'] as string | undefined,
        rationaleSummary: call.args['rationaleSummary'] as string ?? 'Agent decision',
        confidence: call.args['confidence'] as number | undefined,
      });
      return JSON.stringify({ ok: true, decisionId, note: 'decision submitted to engine' });
    }

    case 'create_bot': {
      await publishToInbound(AGENT_MESSAGE_TYPES.MANAGE_BOT, {
        action: 'create_and_start',
        venueAccountId: call.args['venueAccountId'] as string | undefined,
        config: call.args['config'] as Record<string, unknown> | undefined,
        rationale: call.args['rationale'] as string | undefined,
      });
      return JSON.stringify({ ok: true, note: 'bot creation submitted — you will see it in the bot list on the next tick' });
    }

    case 'list_bots': {
      if (!botRepo) return JSON.stringify({ ok: false, note: 'direct db access not available' });
      const daysFilter = typeof call.args['days'] === 'number' ? call.args['days'] : undefined;
      const since = daysFilter ? new Date(Date.now() - daysFilter * 24 * 60 * 60 * 1000) : undefined;
      const botRows = await botRepo.getBotsByCreator('agent', AGENT_ID!, since);
      return JSON.stringify({
        ok: true,
        bots: botRows.map((b) => ({
          id: b.id,
          status: b.status,
          strategyPreset: (b.config as Record<string, unknown>)?.['strategyPreset'] ?? null,
          symbol: (b.config as Record<string, unknown>)?.['symbol'] ?? null,
          createdAt: b.createdAt.toISOString(),
        })),
      });
    }

    case 'get_bot_status': {
      if (!botRepo) return JSON.stringify({ ok: false, note: 'direct db access not available' });
      const targetBotId = call.args['botId'] as string | undefined;
      if (!targetBotId) return JSON.stringify({ ok: false, note: 'botId is required' });
      const bot = await botRepo.getBotById(targetBotId);
      if (!bot || bot.creatorType !== 'agent' || bot.creatorId !== AGENT_ID) {
        return JSON.stringify({ ok: false, note: `bot ${targetBotId} not found or not owned by this agent` });
      }
      return JSON.stringify({
        ok: true,
        id: bot.id,
        status: bot.status,
        strategyPreset: (bot.config as Record<string, unknown>)?.['strategyPreset'] ?? null,
        symbol: (bot.config as Record<string, unknown>)?.['symbol'] ?? null,
        config: bot.config,
        startedAt: bot.startedAt?.toISOString() ?? null,
        stoppedAt: bot.stoppedAt?.toISOString() ?? null,
      });
    }

    case 'stop_bot': {
      if (!botRepo) return JSON.stringify({ ok: false, note: 'direct db access not available' });
      const stopBotId = call.args['botId'] as string | undefined;
      if (!stopBotId) return JSON.stringify({ ok: false, note: 'botId is required' });
      const stopTarget = await botRepo.getBotById(stopBotId);
      if (!stopTarget || stopTarget.creatorType !== 'agent' || stopTarget.creatorId !== AGENT_ID) {
        return JSON.stringify({ ok: false, note: `bot ${stopBotId} not found or not owned by this agent` });
      }
      const previousStatus = stopTarget.status;

      if (previousStatus !== 'running') {
        await botRepo.markBotStopped(stopBotId);
        return JSON.stringify({ ok: true, botId: stopBotId, previousStatus, note: 'bot was not running' });
      }

      await botRepo.markBotStopped(stopBotId);
      try {
        // Signal the running job to self-terminate without polling.
        await redis.publish(`bot:stop:${stopBotId}`, '1');
      } catch (err) {
        logger.error({ err, botId: stopBotId }, 'Failed to publish bot:stop signal — restoring previous runtime state');
        try {
          await botRepo.restoreBotRuntimeState({
            botId: stopBotId,
            status: stopTarget.status,
            startedAt: stopTarget.startedAt,
            stoppedAt: stopTarget.stoppedAt,
          });
        } catch (rollbackErr) {
          logger.error({ rollbackErr, botId: stopBotId }, 'CRITICAL: failed to restore bot state after stop signal failure');
        }
        return JSON.stringify({ ok: false, botId: stopBotId, previousStatus, note: 'failed to signal bot stop' });
      }

      return JSON.stringify({ ok: true, botId: stopBotId, previousStatus, note: 'bot stopped' });
    }

    case 'start_bot': {
      if (!botRepo) return JSON.stringify({ ok: false, note: 'direct db access not available' });
      const startBotId = call.args['botId'] as string | undefined;
      if (!startBotId) return JSON.stringify({ ok: false, note: 'botId is required' });
      const startTarget = await botRepo.getBotById(startBotId);
      if (!startTarget || startTarget.creatorType !== 'agent' || startTarget.creatorId !== AGENT_ID) {
        return JSON.stringify({ ok: false, note: `bot ${startBotId} not found or not owned by this agent` });
      }
      if (startTarget.status === 'running') {
        return JSON.stringify({ ok: false, note: `bot ${startBotId} is already running` });
      }
      await botRepo.markBotRunning(startBotId);
      try {
        // Enqueue BullMQ start job via broker (agent container does not have direct BullMQ access)
        await publishToInbound(AGENT_MESSAGE_TYPES.MANAGE_BOT, {
          action: 'start',
          botId: startBotId,
          rationale: call.args['rationale'] as string | undefined,
        });
      } catch (err) {
        logger.error({ err, botId: startBotId }, 'Failed to enqueue direct bot start — restoring previous runtime state');
        try {
          await botRepo.restoreBotRuntimeState({
            botId: startBotId,
            status: startTarget.status,
            startedAt: startTarget.startedAt,
            stoppedAt: startTarget.stoppedAt,
          });
        } catch (rollbackErr) {
          logger.error({ rollbackErr, botId: startBotId }, 'CRITICAL: failed to restore bot state after start enqueue failure');
        }
        return JSON.stringify({ ok: false, botId: startBotId, note: 'failed to submit bot start' });
      }

      return JSON.stringify({ ok: true, botId: startBotId, status: 'running', note: 'bot start submitted' });
    }

    case 'adjust_bot_config': {
      if (!botRepo) return JSON.stringify({ ok: false, note: 'direct db access not available' });
      const configBotId = call.args['botId'] as string | undefined;
      const configOverride = call.args['config'] as Record<string, unknown> | undefined;
      if (!configBotId) return JSON.stringify({ ok: false, note: 'botId is required' });
      if (!configOverride || typeof configOverride !== 'object') return JSON.stringify({ ok: false, note: 'config is required' });
      const configTarget = await botRepo.getBotById(configBotId);
      if (!configTarget || configTarget.creatorType !== 'agent' || configTarget.creatorId !== AGENT_ID) {
        return JSON.stringify({ ok: false, note: `bot ${configBotId} not found or not owned by this agent` });
      }
      const merged = deepMergeConfig(configTarget.config as Record<string, unknown>, configOverride);
      await botRepo.updateBotConfig(configBotId, merged);
      return JSON.stringify({ ok: true, botId: configBotId, note: 'config updated — takes effect on next bot tick' });
    }

    case 'get_analytics': {
      if (!botRepo) return JSON.stringify({ ok: false, note: 'direct db access not available' });
      const analyticsBotId = call.args['botId'] as string | undefined;
      const analyticsDays = typeof call.args['days'] === 'number' ? Math.min(call.args['days'], 90) : 7;
      const analyticsSince = new Date(Date.now() - analyticsDays * 24 * 60 * 60 * 1000);
      const analytics = await botRepo.getAnalyticsByCreator('agent', AGENT_ID!, analyticsSince, analyticsBotId);
      const winRate = analytics.closedPositions > 0
        ? (analytics.winningPositions / analytics.closedPositions) * 100
        : 0;
      return JSON.stringify({
        ok: true,
        totalTrades: analytics.recentFills,
        winRate: Math.round(winRate * 100) / 100,
        totalPnlUsd: analytics.realizedPnlUsd,
        totalFeesUsd: analytics.totalFeesUsd,
        openPositions: analytics.openPositions,
        botCount: analytics.botCount,
        avgHoldTimeHours: analytics.avgHoldTimeHours,
        byBot: analytics.byBot,
        days: analyticsDays,
      });
    }

    case 'list_positions': {
      if (!botRepo) return JSON.stringify({ ok: false, note: 'direct db access not available' });
      const positionsBotId = call.args['botId'] as string | undefined;
      const openPositions = await botRepo.getOpenPositionsByCreator('agent', AGENT_ID!, positionsBotId);
      return JSON.stringify({
        ok: true,
        note: 'unrealizedPnl not available — mark prices are not cached in the agent process',
        positions: openPositions.map((p) => ({
          botId: p.actorId,
          instrumentId: p.symbol,
          side: p.side,
          size: p.size,
          entryPrice: p.entryPrice,
          openedAt: p.openedAt.toISOString(),
        })),
      });
    }

    case 'code_execute': {
      // Enforce capability policy before executing — rate limit, concurrency, and enable/disable.
      const policyDenied = capabilityEngine.checkAccess('code_execute', AGENT_ID!, SESSION_ID!);
      if (policyDenied) {
        addToHistory('user', `code_execute denied by capability policy: ${policyDenied}`);
        logger.warn({ agentId: AGENT_ID, reason: policyDenied }, 'code_execute denied by capability policy');
        break;
      }
      capabilityEngine.recordStart('code_execute', SESSION_ID!);
      const codeStartMs = Date.now();
      let codeSuccess = false;

      // Code execution runs locally inside this container — no broker round-trip needed.
      // In Docker mode, sandbox-exec.sh provides network namespace isolation (blocks RFC 1918,
      // allows public internet, uses public DNS). Falls back to direct node in stub/dev mode.
      const code = call.args['code'] as string ?? '';
      const description = call.args['description'] as string | undefined;
      const SANDBOX_SCRIPT = '/usr/local/bin/sandbox-exec.sh';
      const SANDBOX_DIR = '/tmp/agent-sandbox';
      const scriptPath = `${SANDBOX_DIR}/script.js`;
      // Read limits from the effective capability grant so operator/user policy changes
      // govern execution timeout and output size, not just rate/concurrency.
      const codeGrant = capabilityEngine.getGrant('code_execute');
      const TIMEOUT_MS = codeGrant?.limits?.timeoutMs ?? 60_000;
      const MAX_OUTPUT = codeGrant?.limits?.maxResponseBytes ?? (50 * 1024);

      let stdout = '';
      let stderr = '';
      let success = false;

      try {
        await rm(SANDBOX_DIR, { recursive: true, force: true });
        await mkdir(SANDBOX_DIR, { recursive: true });
        await writeFile(scriptPath, code, 'utf8');

        const hasSandbox = await access(SANDBOX_SCRIPT).then(() => true).catch(() => false);
        let sandboxBin: string;
        let sandboxArgs: string[];
        if (hasSandbox) {
          // sandbox-exec.sh passes $@ to `exec ip netns exec <ns> "$@"`,
          // so args become the full command inside the namespace.
          sandboxBin = SANDBOX_SCRIPT;
          sandboxArgs = ['node', scriptPath];
        } else {
          sandboxBin = 'node';
          sandboxArgs = [scriptPath];
        }

        const result = await execFileAsync(sandboxBin, sandboxArgs, {
          timeout: TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT * 2,
          env: hasSandbox
            ? { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', TIMEOUT: String(Math.ceil(TIMEOUT_MS / 1000)) }
            : process.env,
        });
        stdout = String(result.stdout || '').slice(0, MAX_OUTPUT);
        success = true;
        codeSuccess = true;
      } catch (err) {
        const execErr = err as { stdout?: string; stderr?: string; message?: string };
        stdout = String(execErr.stdout || '').slice(0, MAX_OUTPUT);
        stderr = String(execErr.stderr || execErr.message || 'execution failed').slice(0, 10 * 1024);
      } finally {
        capabilityEngine.recordEnd('code_execute', SESSION_ID!, {
          capability: 'code_execute',
          agentId: AGENT_ID!,
          sessionId: SESSION_ID!,
          timestamp: new Date().toISOString(),
          durationMs: Date.now() - codeStartMs,
          inputSummary: `${code.length} bytes`,
          outputSummary: success ? `${stdout.length} bytes` : `error: ${stderr.slice(0, 100)}`,
          success: codeSuccess,
        });
        // Per-execution stdout is already bounded by MAX_OUTPUT (derived from
        // the capability grant's maxResponseBytes). Session-level download budget
        // enforcement would require hooking the network layer inside the sandbox
        // process — out of scope for the in-process SandboxEnforcer.
      }

      const label = description ? ` (${description})` : '';
      const resultContent = success
        ? `code_execute${label} result:\n${stdout || '(no output)'}`
        : `code_execute${label} failed:\nstderr: ${stderr}\nstdout: ${stdout || '(no output)'}`;
      return resultContent;
    }

    case 'search_tokens': {
      if (!marketDataRegistry) {
        return JSON.stringify({ ok: false, error: 'market_data_not_configured', note: 'Market data is not configured for this agent.' });
      }
      const query = call.args['query'] as string | undefined;
      if (!query) return JSON.stringify({ ok: false, error: 'query is required' });
      try {
        recordMarketDataAttempt('dexscreener');
        const searchResult = await marketDataRegistry.dexscreener.search(query);
        const results = filterSearchResults(searchResult.data, {
          network: call.args['network'] as string | undefined,
          minLiquidityUsd: call.args['minLiquidityUsd'] as number | undefined,
          limit: call.args['limit'] as number | undefined,
        });
        return JSON.stringify({ ok: true, tokens: results, freshness: searchResult.meta.freshness });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown error';
        if (message.includes('Rate limit exceeded')) {
          recordMarketDataRejection('dexscreener', { priority: 'discovery' });
          return JSON.stringify({ ok: false, error: 'rate_limit', note: 'Try again in a moment.' });
        }
        logger.warn({ err, tool: 'search_tokens' }, 'search_tokens failed');
        return JSON.stringify({ ok: false, error: message });
      }
    }

    case 'discover_tokens': {
      if (!marketDataRegistry) {
        return JSON.stringify({ ok: false, error: 'market_data_not_configured', note: 'Market data is not configured for this agent.' });
      }
      try {
        const result = await executeDiscoverTokensTool(marketDataRegistry, call.args, { onAttempt: recordMarketDataAttempt });
        return JSON.stringify(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown error';
        if (message.includes('Rate limit exceeded')) {
          recordMarketDataRejection('aggregated-discovery', { priority: 'discovery' });
          return JSON.stringify({ ok: false, error: 'rate_limit', note: 'Try again next tick.' });
        }
        logger.warn({ err, tool: 'discover_tokens' }, 'discover_tokens failed');
        return JSON.stringify({ ok: false, error: message });
      }
    }

    case 'check_regime': {
      if (!marketDataRegistry) {
        return JSON.stringify({ ok: false, error: 'market_data_not_configured', note: 'Market data is not configured for this agent.' });
      }
      const params = call.args as RegimeParams;
      try {
        const result = await evaluateRegime(params, (symbol) =>
          (recordMarketDataAttempt('binance'), marketDataRegistry!.binance.candles(symbol, { interval: '1h', limit: 200 })).then((response) => response.data),
        );
        return JSON.stringify({ ok: true, ...result });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown error';
        if (message.includes('Rate limit exceeded')) {
          recordMarketDataRejection('binance', { priority: 'execution' });
          return JSON.stringify({ ok: false, error: 'rate_limit', note: 'Try again in a moment.' });
        }
        logger.warn({ err, tool: 'check_regime' }, 'check_regime failed');
        return JSON.stringify({ ok: false, error: message });
      }
    }

    case 'get_funding_rates': {
      if (!marketDataRegistry) {
        return JSON.stringify({ ok: false, error: 'market_data_not_configured', note: 'Market data is not configured for this agent.' });
      }
      try {
        const result = await executeFundingRatesTool(marketDataRegistry, call.args, { onAttempt: recordMarketDataAttempt });
        return JSON.stringify(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown error';
        logger.warn({ err, tool: 'get_funding_rates' }, 'get_funding_rates failed');
        return JSON.stringify({ ok: false, error: message });
      }
    }

    case 'get_market_overview': {
      if (!marketDataRegistry) {
        return JSON.stringify({ ok: false, error: 'market_data_not_configured', note: 'Market data is not configured for this agent.' });
      }
      try {
        const result = await executeMarketOverviewTool(marketDataRegistry, call.args, { onAttempt: recordMarketDataAttempt });
        return JSON.stringify(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown error';
        logger.warn({ err, tool: 'get_market_overview' }, 'get_market_overview failed');
        return JSON.stringify({ ok: false, error: message });
      }
    }

    default:
      logger.warn({ tool: call.tool }, 'Unknown tool — ignoring');
      return `unknown tool: ${call.tool}`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Conversation history
// ---------------------------------------------------------------------------

interface ConversationMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const conversationHistory: ConversationMessage[] = [];

function addToHistory(role: 'user' | 'assistant', content: string, options?: { truncateToToolBudget?: boolean }): void {
  const normalizedContent = options?.truncateToToolBudget
    ? content.slice(0, runtimeState.runtimeDescriptor.budgets.maxToolResultChars)
    : content;

  conversationHistory.push({ role, content: normalizedContent });
  // Keep only the most recent messages
  while (conversationHistory.length > runtimeState.runtimeDescriptor.budgets.maxHistoryMessages) {
    conversationHistory.shift();
  }
}

// ---------------------------------------------------------------------------
// Main reasoning loop
// ---------------------------------------------------------------------------

let running = true;
let tickCount = 0;
// Prevents concurrent tick execution when an LLM call takes longer than TICK_INTERVAL_MS.
let tickInFlight = false;
let previousContextHash: string | null = null;
let previousFullUserContext: string | null = null;
let scoutTickCount = 0;
let scoutEscalationCount = 0;
let effectiveTickIntervalMs = costProfile.tickIntervalMs;
let previousRegimePass: boolean | null = null;
// Hoisted so both runTick() and the heartbeat interval can trigger a clean shutdown.
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let tickTimer: ReturnType<typeof setTimeout> | undefined;

async function handleRuntimeFailure(
  source: Parameters<typeof classifyRuntimeError>[0],
  error: unknown,
): Promise<void> {
  const previewClassification = classifyRuntimeError(source, error);
  logger.error({ classification: previewClassification, err: error }, 'Agent runtime failure classified');

  const outcome = await processRuntimeFailure(source, error, {
    failureBackoff,
    effectiveTickIntervalMs,
    setDependencyAvailability,
    sendHeartbeat,
    shutdown,
    onBackoff: ({ consecutiveFailures, nextIntervalMs }) => {
      logger.warn({ consecutiveFailures, effectiveTickIntervalMs: nextIntervalMs }, 'Temporarily backing off tick interval after repeated failures');
    },
  });

  effectiveTickIntervalMs = outcome.nextTickIntervalMs;
}

function handleTickSuccess(): void {
  const recovery = failureBackoff.recordSuccess();
  if (recovery.recovered) {
    logger.info('Resetting consecutive failure counter after successful tick');
  }
  effectiveTickIntervalMs = recovery.nextIntervalMs;
}

function parseNumericValue(value: unknown): number | null {
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

function extractTickSignals(incomingMessages: Array<Record<string, unknown>>): {
  latestPrice: number | null;
  portfolioPnlUsd: number | null;
  positionSide: string | null;
} {
  let latestPrice: number | null = null;
  let portfolioPnlUsd: number | null = null;
  let positionSide: string | null = sessionMetrics.lastPositionSide;

  for (let index = incomingMessages.length - 1; index >= 0; index--) {
    const message = incomingMessages[index]!;
    const type = message['type'];
    const payload = message['payload'];
    if (type !== 'instance.context.snapshot' || !payload || typeof payload !== 'object') {
      continue;
    }

    const payloadRecord = payload as Record<string, unknown>;
    latestPrice = parseNumericValue(payloadRecord['price']) ?? latestPrice;
    portfolioPnlUsd = parseNumericValue(payloadRecord['pnl']) ?? portfolioPnlUsd;

    const position = payloadRecord['position'];
    if (position && typeof position === 'object') {
      const rawSide = (position as Record<string, unknown>)['side'];
      positionSide = typeof rawSide === 'string' ? rawSide : positionSide;
    } else if (position === null) {
      positionSide = 'flat';
    }

    break;
  }

  return { latestPrice, portfolioPnlUsd, positionSide };
}

function scheduleNextTick(delayMs = effectiveTickIntervalMs): void {
  clearTimeout(tickTimer);
  if (!running) {
    return;
  }

  tickTimer = setTimeout(() => {
    if (!running || tickInFlight) {
      scheduleNextTick(effectiveTickIntervalMs);
      return;
    }

    tickInFlight = true;
    void (async () => {
      try {
        await runTick();
      } catch (err) {
        logger.error({ err }, 'Uncaught error in tick — continuing');
      } finally {
        tickInFlight = false;
        scheduleNextTick(effectiveTickIntervalMs);
      }
    })();
  }, delayMs);
}

/**
 * Unified shutdown path used by expiry, SIGTERM, and SIGINT.
 * Idempotent: clears timers (safe to call even if never set), drains Redis, exits.
 */
async function shutdown(reason: string): Promise<void> {
  logger.info({ reason }, 'Agent runtime shutting down');
  running = false;
  clearInterval(heartbeatTimer);
  clearTimeout(tickTimer);
  await sendHeartbeat('degraded', reason).catch(() => { /* ignore */ });
  await publishToInbound(AGENT_MESSAGE_TYPES.RUNTIME_SESSION_ENDED, {
    sessionId: SESSION_ID!,
    reasonCode: reason,
  }).catch(() => { /* ignore */ });
  await redis.quit().catch(() => { /* ignore */ });
  process.exit(0);
}

async function runTick(): Promise<void> {
  tickCount++;
  refreshToolCircuits();
  logger.info({ tickCount }, 'Agent tick starting');

  // Check session wall-clock expiry before each tick.
  if (sandboxEnforcer.isExpired(SESSION_ID!)) {
    await shutdown('wall_clock_expired');
    return; // unreachable — process.exit() called in shutdown()
  }

  await sendHeartbeat('busy');

  try {
    // Read incoming platform messages (context snapshots, decisions, etc.)
    const incomingMessages = await Promise.race([
      readOutboundMessages(),
      new Promise<Array<Record<string, unknown>>>((resolve) => setTimeout(() => resolve([]), OUTBOUND_READ_TIMEOUT_MS)),
    ]);

    for (const message of incomingMessages) {
      applyRuntimeMessage(runtimeState, message);
    }

    if (incomingMessages.some((message) => message['type'] === 'agent.runtime.config_update')) {
      toolVisibility.snapshotToolBaselines();
      applyToolVisibility();
    }

    let hasOpenPositions = Boolean(sessionMetrics.lastPositionSide && sessionMetrics.lastPositionSide !== 'flat');
    if (botRepo) {
      try {
        const openPositions = await botRepo.getOpenPositionsByCreator('agent', AGENT_ID!);
        hasOpenPositions = openPositions.length > 0;
        setDependencyAvailability('database', true);
      } catch (err) {
        logger.warn({ err }, 'Failed to resolve open positions for tick gating — falling back to cached runtime state');
        setDependencyAvailability('database', false);
      }
    }

    const tickSignals = extractTickSignals(incomingMessages);

    const skipDecision = await shouldSkipTick(
      {
        tickNumber: tickCount,
        hasOpenPositions,
        tradingHours,
        now: new Date(),
        positionSide: tickSignals.positionSide ?? (hasOpenPositions ? sessionMetrics.lastPositionSide ?? 'open' : 'flat'),
        latestPrice: tickSignals.latestPrice,
        portfolioPnlUsd: tickSignals.portfolioPnlUsd,
        previousContextHash,
        baseTickIntervalMs: costProfile.tickIntervalMs,
        currentTickIntervalMs: effectiveTickIntervalMs,
        enabledGates: costProfile.enabledGates,
      },
      {
        evaluateRegime: marketDataRegistry
          ? async () => {
            const params: RegimeParams = {};
            return evaluateRegime(params, (symbol) =>
              (recordMarketDataAttempt('binance'), marketDataRegistry!.binance.candles(symbol, { interval: '1h', limit: 200 })).then((providerResult) => providerResult.data),
            );
          }
          : undefined,
        fetchVolatilityCandles: marketDataRegistry
          ? async () => {
            recordMarketDataAttempt('binance');
            return marketDataRegistry!.binance.candles('BTC', { interval: '1h', limit: 24 }).then((providerResult) => providerResult.data);
          }
          : undefined,
      },
    );

    previousContextHash = skipDecision.contextHash ?? previousContextHash;
    recordRegimeEvaluation(
      runtimeState,
      skipDecision.regime ?? null,
      skipDecision.regime
        ? { state: 'fresh', provider: 'binance' }
        : { state: 'unavailable', note: marketDataRegistry ? 'regime not evaluated' : 'market-data registry unavailable' },
    );
    if (skipDecision.nextTickIntervalMs !== effectiveTickIntervalMs) {
      logger.info({ fromMs: effectiveTickIntervalMs, toMs: skipDecision.nextTickIntervalMs, volatilityPct: skipDecision.volatilityPct }, 'Adjusted agent tick interval');
      effectiveTickIntervalMs = skipDecision.nextTickIntervalMs;
    }

    if (skipDecision.skip) {
      logger.info({ tickCount, reason: skipDecision.reason, gate: skipDecision.gate }, 'Skipping agent tick before LLM dispatch');
      await sendHeartbeat('ready');
      return;
    }

    await refreshVenueIntelligence().then(() => setDependencyAvailability('market-data', true)).catch(async (err) => {
      await handleRuntimeFailure('market-data', err);
      recordVenueSignals(runtimeState, []);
    });
    recordPerformanceInputs(runtimeState, {
      drawdownPct: sessionMetrics.portfolio.drawdownPct,
      netPnlUsd: (sessionMetrics.portfolio.realizedPnlUsd ?? 0) + (sessionMetrics.portfolio.unrealizedPnlUsd ?? 0),
    });

    // Build context for this tick.
    const fullUserContext = buildTickUserContext(runtimeState, []);
    const incrementalContext = buildIncrementalContext({
      previousContext: previousFullUserContext,
      currentContext: fullUserContext,
      tickNumber: tickCount,
    });
    previousFullUserContext = fullUserContext;
    logger.info({ mode: incrementalContext.mode, estimatedTokens: incrementalContext.estimatedTokens }, 'Prepared tick context payload');
    let userContext = incrementalContext.content;

    refreshCapabilityPolicy();
    if (tickCount === 1) {
      userContext += '\n\nThis is your first tick. Start working towards your goal.';
    }

    // Build the prompt
    const systemPrompt = composeSystemPrompt(runtimeState);
    // Persist the compiled prompt so the API can serve GET /agents/:id/prompt
    redis.set(`agent:prompt:${AGENT_ID}`, systemPrompt, 'EX', 3600).catch((err: unknown) => {
      logger.warn({ err }, 'Failed to persist system prompt to Redis');
    });
    const readOnlyScoutTools = getVisibleToolNames(runtimeState).filter((tool) => !new Set([
      'submit_decision',
      'create_bot',
      'stop_bot',
      'start_bot',
      'adjust_bot_config',
    ]).has(tool));

    const scoutSystemPrompt = buildScoutSystemPrompt({
      agentId: AGENT_ID!,
      goal: agentGoal,
      readOnlyTools: readOnlyScoutTools,
    });

    scoutTickCount++;
    const scoutResultWithRetry = await callLlmWithRetry(
      {
        provider: LLM_PROVIDER!,
        model: agentConfig.scoutModel ?? resolveDefaultScoutModel(LLM_PROVIDER!, LLM_MODEL),
        maxTokens: 256,
        timeoutMs: LLM_TIMEOUT_MS,
        baseUrl: LLM_BASE_URL,
      },
      {
        messages: [
          { role: 'system', content: scoutSystemPrompt },
          { role: 'user', content: userContext },
        ],
        maxTokens: 256,
        temperature: 0,
        thinking: 'none',
      },
      {
        onRetry: ({ attempt, delayMs, classification }) => {
          logger.warn({ phase: 'scout', attempt, delayMs, reasonCode: classification.reasonCode }, 'Retrying scout LLM call after backoff');
        },
      },
    );
    const scoutResult = scoutResultWithRetry.result;

    if (scoutResult.ok) {
      recordSessionCost(runtimeState, {
        tokensUsed: scoutResult.data.tokensUsed,
        thinkingTokens: scoutResult.data.thinkingTokens,
        costUsd: estimateLlmCostUsd(agentConfig.scoutModel ?? resolveDefaultScoutModel(LLM_PROVIDER!, LLM_MODEL), scoutResult.data.tokensUsed),
      });
    }

    if (!scoutResult.ok) {
      const scoutFailure = classifyRuntimeError('llm', scoutResult.error);
      if (scoutFailure.mode === 'fatal') {
        await handleRuntimeFailure('llm', scoutResult.error);
        return;
      }
      logger.warn({ error: scoutResult.error, attempts: scoutResultWithRetry.attempts }, 'Scout LLM call failed — falling back to judge');
    } else {
      const scoutDecision = parseScoutDecision(scoutResult.data.content);
      if (scoutDecision.disposition === 'hold') {
        const escalationRate = scoutTickCount > 0 ? scoutEscalationCount / scoutTickCount : 0;
        logger.info({ metric: 'agent.escalation_rate', escalationRate, reason: scoutDecision.reason }, 'Scout held the tick');
        handleTickSuccess();
        await sendHeartbeat('ready');
        return;
      }

      scoutEscalationCount++;
      const escalationRate = scoutTickCount > 0 ? scoutEscalationCount / scoutTickCount : 0;
      logger.info({ metric: 'agent.escalation_rate', escalationRate, reason: scoutDecision.reason }, 'Scout escalated to judge');
      userContext = `${fullUserContext}\n\nScout escalation reason: ${scoutDecision.reason ?? 'unspecified'}`;
    }

    addToHistory('user', userContext);
    const recentHistory = conversationHistory.slice(-10);
    const messages: ConversationMessage[] = [
      { role: 'system', content: systemPrompt },
      ...recentHistory,
    ];

    const thinkingDecision = classifyTickThinking({
      hasOpenPositions,
      previousRegimePass,
      regimePass: skipDecision.regime?.pass ?? null,
      incomingMessagesCount: incomingMessages.length,
      userMessageReceived: incomingMessages.some((message) => message['type'] === 'agent.user.message' || message['type'] === 'user.message'),
      drawdownPct: sessionMetrics.performance.drawdownPct ?? extractDrawdownPct(sessionMetrics.lastPnlSummary),
    });
    const judgeThinking = costProfile.defaultThinking === 'deep'
      ? { thinking: 'deep' as const, reason: 'cost_profile_premium' }
      : thinkingDecision;
    previousRegimePass = skipDecision.regime?.pass ?? previousRegimePass;
    logger.info({ thinking: judgeThinking.thinking, reason: judgeThinking.reason }, 'Resolved tick thinking level');

    // Call the LLM
    const llmResultWithRetry = await callLlmWithRetry(
      {
        provider: LLM_PROVIDER!,
        model: costProfile.judgeModel,
        maxTokens: LLM_MAX_TOKENS,
        timeoutMs: LLM_TIMEOUT_MS,
        baseUrl: LLM_BASE_URL,
      },
      {
        messages,
        maxTokens: LLM_MAX_TOKENS,
        temperature: 0.3,
        thinking: judgeThinking.thinking,
      },
      {
        onRetry: ({ attempt, delayMs, classification }) => {
          logger.warn({ phase: 'judge', attempt, delayMs, reasonCode: classification.reasonCode }, 'Retrying judge LLM call after backoff');
        },
      },
    );
    const llmResult = llmResultWithRetry.result;

    if (!llmResult.ok) {
      await handleRuntimeFailure('llm', llmResult.error);
      return;
    }

    const assistantResponse = stripReasoningContent(llmResult.data.content);
    recordSessionCost(runtimeState, {
      tokensUsed: llmResult.data.tokensUsed,
      thinkingTokens: llmResult.data.thinkingTokens,
      costUsd: estimateLlmCostUsd(costProfile.judgeModel, llmResult.data.tokensUsed),
    });
    addToHistory('assistant', assistantResponse);

    logger.info({ tokensUsed: llmResult.data.tokensUsed, thinkingTokens: llmResult.data.thinkingTokens ?? 0, latencyMs: llmResult.data.latencyMs }, 'LLM response received');
    logger.debug({ response: assistantResponse.slice(0, 500) }, 'LLM response preview');

    // Parse and execute tool calls
    const toolCalls = parseToolCalls(assistantResponse);
    for (const call of toolCalls) {
      let toolResult: string | null = null;
      try {
        toolResult = await executeTool(call);
      } catch (err) {
        logger.warn({ err, tool: call.tool }, 'Tool execution threw unexpectedly');
        toolResult = JSON.stringify({ ok: false, error: 'tool_failed', note: 'Tool timed out or failed. Skip or retry later.' });
      }
      if (toolResult) {
        addToHistory('user', toolResult, { truncateToToolBudget: true });
        if (toolResultIndicatesFailure(toolResult)) {
          recordToolFailure(call.tool);
        } else {
          recordToolSuccess(call.tool);
        }
      }
    }

    handleTickSuccess();
    await sendHeartbeat('ready');
  } catch (err) {
    const source = err instanceof Error && /redis|xreadgroup|xadd|connection is closed|econn/i.test(err.message)
      ? 'redis'
      : 'tool';
    await handleRuntimeFailure(source, err);
  }
}

async function main(): Promise<void> {
  logger.info({ agentId: AGENT_ID, sessionId: SESSION_ID, model: LLM_MODEL, skillIds: runtimeDescriptor.resolvedSkills.map((skill) => skill.id).filter((id) => id !== 'base') }, 'Agent runtime starting');
  runtimeState.sessionStartMs = Date.now();

  // Connect to Redis
  await redis.ping();
  logger.info('Redis connected');

  // Drain any entries left pending in the PEL by a previous container incarnation.
  await drainStalePendingEntries();

  // Register session with the sandbox enforcer so wall-clock and budget tracking begins.
  sandboxEnforcer.registerSession(SESSION_ID!);

  // Signal starting
  await sendHeartbeat('starting');

  // Wait for Redis to be fully ready before first tick
  await new Promise<void>((resolve) => setTimeout(resolve, 1000));
  await sendHeartbeat('ready');

  // Heartbeat interval — keep the session alive between ticks.
  // Also checks wall-clock expiry so shutdown is timely even across long tick gaps.
  heartbeatTimer = setInterval(() => {
    if (sandboxEnforcer.isExpired(SESSION_ID!)) {
      logger.warn({ sessionId: SESSION_ID }, 'Session wall-clock limit exceeded — shutting down');
      void shutdown('wall_clock_expired');
      return;
    }
    void sendHeartbeat('ready').catch((err: unknown) => logger.warn({ err }, 'Heartbeat error'));
  }, HEARTBEAT_INTERVAL_MS);

  // Main reasoning loop — serialized: skip the interval fire if the previous tick
  // is still in flight (slow LLM response, long tool chain, etc.).
  // Run the first tick immediately — hold the in-flight flag so the interval
  // timer cannot start a concurrent tick if the first one takes longer than TICK_INTERVAL_MS.
  tickInFlight = true;
  try {
    await runTick();
  } finally {
    tickInFlight = false;
    scheduleNextTick(effectiveTickIntervalMs);
  }

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Agent runtime crashed');
  process.exit(1);
});
