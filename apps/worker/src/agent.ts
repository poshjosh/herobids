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
import pino from 'pino';
import { AGENT_MESSAGE_TYPES, AgentRuntimePolicySchema, BASE_SKILL, BOT_MANAGEMENT_SKILL, FILE_MANAGEMENT_SKILL, PROGRAMMING_SKILL, RISK_MONITORING_SKILL, TASK_MANAGEMENT_SKILL, TRADING_SKILL, WEB_ACCESS_SKILL, type ToolContext, AGENT_RUNTIME_ACTIVITY_TYPES, type AgentRiskDefaultsConfig, type AgentRiskOverrides, resolveAgentRiskContract, validateRiskOverride, type ResolvedAgentRiskContract } from '@herobids/domain';
import { createDatabase, BotRepository, AgentRepository } from '@herobids/db';
import { createUsageBillingService } from './usage-billing-service.js';
import type { AgentRuntimePolicy, RuntimeDescriptor, SkillDefinition } from '@herobids/domain';
import { type LlmToolDefinition } from '@herobids/llm';
import {
  createProviderRegistry,
  createPriceService,
  type MarketDataConfig,
  type ProviderRegistry,
  type PriceService,
  type TokenInfo,
  evaluateRegime,
  type RegimeParams,
} from '@herobids/market-data';
import { buildCapabilityGrants, buildCapabilityPolicyEngine } from './agents/capability-policy.js';
import { SandboxEnforcer } from './agents/sandbox-enforcer.js';
import { OUTBOUND_READ_BLOCK_MS, OUTBOUND_READ_TIMEOUT_MS, readOutboundMessages as readAgentOutboundMessages } from './agents/outbound-message-reader.js';
import { buildIncrementalContext } from './context-diff.js';
import { resolveAgentCostProfile, type CostPreset } from './cost-profile.js';
import { createPromptTimingContext } from './prompt-timing-context.js';
import { buildToolResultMetadata } from './tool-result-metadata.js';
import {
  applyRuntimeMessage,
  buildSystemPrompt as composeSystemPrompt,
  buildTickUserContext,
  buildVenueLines,
  createRuntimeCompositionState,
  getVisibleToolNames,
  recordPerformanceInputs,
  recordRegimeEvaluation,
  recordSessionCost,
  setCapabilityDegradation,
  setToolCapabilityDegradation,
  recordVenueSignals,
  recordActiveWatchSummary,
  summarizeActiveWatches,
  type RuntimeActiveWatch,
  type RuntimeActiveWatchSummary,
  type RuntimeCompositionState,
} from './runtime-composition.js';
import { deriveTradingTickWorkPlan } from './agent-capabilities.js';
import { shouldSkipTick, type TickSkipDecision, type TradingHoursConfig } from './tick-gates.js';
import { buildScoutSystemPrompt, parseScoutDecision, type ScoutDecision } from './scout-dispatch.js';
import { resolvePreScoutDecision } from './scout-gating.js';
import { classifyRuntimeError } from './runtime-errors.js';
import { FailureBackoffController, ToolCircuitBreaker, toolResultIndicatesFailure } from './runtime-resilience.js';
import { processRuntimeFailure } from './runtime-degradation.js';
import { createRuntimeToolVisibilityController, DATABASE_DEPENDENT_TOOLS, MARKET_DATA_TOOLS } from './runtime-tool-visibility.js';
import { buildTickGateState } from './tick-gate-state.js';
import { classifyTickThinking, extractDrawdownPct } from './tick-thinking.js';
import { buildDiscoveryAddressMap, collectDexTrackedTargets, collectPerpsTrackedSymbols, findDexPositionForTarget } from './venue-intelligence.js';
import { createToolRegistry } from './tools/index.js';
import { extractCeilings, extractCreatorInput } from './agent-risk-limits.js';
import { getWorkspacePaths } from './tools/workspace.js';
import { runStructuredToolLoop } from './structured-tool-loop.js';
import { resolveEffectiveLlmSelection, type UserModelDefaults } from './llm-selection.js';
import { getWakeRescheduleDelay, resolveNextTickDelay } from './agent-wake-scheduler.js';

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
const AGENT_RUNTIME_CONFIG_RAW = process.env['AGENT_RUNTIME_CONFIG_JSON'];
const LLM_MODEL = process.env['LLM_MODEL'] ?? 'claude-sonnet-4-5';
const LLM_PROVIDER = process.env['LLM_PROVIDER'];
const LLM_BASE_URL = process.env['LLM_BASE_URL'];
const LLM_MAX_TOKENS = parseInt(process.env['LLM_MAX_TOKENS'] ?? '4096', 10);
const LLM_TIMEOUT_MS = parseInt(process.env['LLM_TIMEOUT_MS'] ?? '60000', 10);
const TICK_INTERVAL_MS = parseInt(process.env['TICK_INTERVAL_MS'] ?? '900000', 10);
const HEARTBEAT_INTERVAL_MS = parseInt(process.env['HEARTBEAT_INTERVAL_MS'] ?? '5000', 10);
const SERVER_COST_USD_PER_HOUR = Number(process.env['LLM_SERVER_COST_USD_PER_HOUR'] ?? '0.02');
const TRADING_HOURS_RAW = process.env['TRADING_HOURS_JSON'];

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
  name?: string;
  prompt?: string;
  goal?: string;
  executionMode?: string;
  provider?: string;
  lightModel?: string;
  heavyModel?: string;
  costPreset?: CostPreset;
  dailySpendBudgetUsd?: number;
  dexWatchlistSymbols?: string[];
  dailyTokenBudget?: number;
  dailyLossLimit?: string;
  maxBots?: number;
  maxSlippageBps?: number;
  maxOpenPositions?: number;
  maxPositionSizePct?: number | string;
  stopLossPct?: number | string;
  stopLossCooldownMs?: number;
  tickIntervalMs?: number;
  capital?: string;
  telegramChatId?: string;
  runtimeDescriptor?: RuntimeDescriptor;
  userModelDefaults?: UserModelDefaults | null;
  userId?: string;
  usageBillingPlanId?: string;
  usageBillingIncludedCreditMicrousd?: number;
  usageBillingSoftCapMicrousd?: number | null;
  usageBillingHardCapMicrousd?: number | null;
  agentRiskDefaults?: {
    maxOpenPositions: number;
    maxPositionSizePct: number;
    stopLossMaxUnrealizedLossPct: number;
    stopLossCooldownMs: number;
    maxPositionSize: number;
    maxOrderNotionalMultiplier: number;
    dailyMaxLossPct: number;
  };
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

// Parse operator agentRuntime config forwarded from worker.
// Missing or malformed config is fatal.
function parseAgentRuntimePolicy(raw: string | undefined): AgentRuntimePolicy {
  if (!raw) {
    logger.fatal('Missing AGENT_RUNTIME_CONFIG_JSON');
    process.exit(1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    logger.fatal({ raw }, 'Failed to parse AGENT_RUNTIME_CONFIG_JSON');
    process.exit(1);
  }

  try {
    return AgentRuntimePolicySchema.parse(parsed);
  } catch (error) {
    logger.fatal({ err: error }, 'Invalid AGENT_RUNTIME_CONFIG_JSON');
    process.exit(1);
  }
}

const agentRuntimePolicy = parseAgentRuntimePolicy(AGENT_RUNTIME_CONFIG_RAW);

// SandboxEnforcer enforces the session wall-clock limit and network limits in-process.
// Container-level limits (memory, cpu, storage) are enforced by Docker cgroups/ulimits.
const sandboxEnforcer = new SandboxEnforcer(agentRuntimePolicy.sandboxDefaults);

try {
  agentConfig = JSON.parse(AGENT_CONFIG_RAW) as AgentConfig;
} catch {
  logger.fatal({ AGENT_CONFIG_RAW }, 'Failed to parse AGENT_CONFIG');
  process.exit(1);
}

const agentGoal = agentConfig.prompt ?? agentConfig.goal ?? 'No goal provided';
const skillIds = agentConfig.runtimeDescriptor?.resolvedSkills
  .map((skill) => skill.id)
  .filter((skillId) => skillId !== 'base')
  ?? [];
const initialToolPolicy = agentConfig.runtimeDescriptor?.toolPolicy ?? parseToolPolicy(TOOL_POLICY_RAW);
const tradingHours = parseTradingHours(TRADING_HOURS_RAW);
const { provider: resolvedProvider, heavyModel: resolvedHeavyModel, lightModel: resolvedLightModel } = resolveEffectiveLlmSelection({
  agentConfig,
  operatorProvider: LLM_PROVIDER!,
  operatorHeavyModel: LLM_MODEL,
  defaultScoutModels: agentRuntimePolicy.llm.scout.defaultModels,
});
const costProfile = resolveAgentCostProfile({
  provider: resolvedProvider,
  heavyModel: resolvedHeavyModel,
  lightModel: resolvedLightModel,
  costPreset: agentConfig.costPreset,
  dailyBudgetUsd: agentConfig.dailySpendBudgetUsd,
  baseTickIntervalMs: TICK_INTERVAL_MS,
  tickIntervalMs: agentConfig.tickIntervalMs,
});

// ---------------------------------------------------------------------------
// Skill resolution
// ---------------------------------------------------------------------------

const ALL_SKILLS_BY_ID: Record<string, SkillDefinition> = {
  base: BASE_SKILL,
  'bot-management': BOT_MANAGEMENT_SKILL,
  'file-management': FILE_MANAGEMENT_SKILL,
  programming: PROGRAMMING_SKILL,
  trading: TRADING_SKILL,
  'risk-monitoring': RISK_MONITORING_SKILL,
  'web-access': WEB_ACCESS_SKILL,
  'task-management': TASK_MANAGEMENT_SKILL,
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
    name: agentConfig.name ?? AGENT_ID!,
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
    budgets: { ...agentRuntimePolicy.defaultBudgets },
  };
}

const runtimeDescriptor = agentConfig.runtimeDescriptor
  ? {
    ...agentConfig.runtimeDescriptor,
    name: agentConfig.runtimeDescriptor.name ?? agentConfig.name ?? agentConfig.runtimeDescriptor.agentId,
    budgets: { ...agentRuntimePolicy.defaultBudgets },
  }
  : buildFallbackRuntimeDescriptor();
const workspacePaths = getWorkspacePaths(AGENT_ID!);
const runtimeState: RuntimeCompositionState = createRuntimeCompositionState(runtimeDescriptor, {
  workspaceRoot: workspacePaths.root,
});
runtimeState.metrics.sessionCosts.estimatedServerCostUsdPerHour = Number.isFinite(SERVER_COST_USD_PER_HOUR)
  ? SERVER_COST_USD_PER_HOUR
  : runtimeState.metrics.sessionCosts.estimatedServerCostUsdPerHour;
const sessionMetrics = runtimeState.metrics;
let capabilityEngine = buildCapabilityPolicyEngine(runtimeState.runtimeDescriptor.toolPolicy);
const permanentlyExcludedTools = new Set<string>();
const toolCircuitBreaker = new ToolCircuitBreaker({
  failureThreshold: agentRuntimePolicy.toolCircuitBreaker?.failureThreshold,
  reopenAfterTicks: agentRuntimePolicy.toolCircuitBreaker?.reopenAfterTicks,
});
const failureBackoff = new FailureBackoffController({
  baseIntervalMs: costProfile.tickIntervalMs,
  backoffThreshold: agentRuntimePolicy.failureBackoff?.backoffThreshold,
  maxFailures: agentRuntimePolicy.failureBackoff?.maxFailures,
  maxIntervalMs: agentRuntimePolicy.failureBackoff?.maxIntervalMs,
});
const toolVisibility = createRuntimeToolVisibilityController(() => runtimeState.runtimeDescriptor, permanentlyExcludedTools);
// Declared here (before functions that reference it at module-init call sites)
// even though the main loop increments it later.
let tickCount = 0;

class TickGateUnexpectedError extends Error {
  constructor(public readonly cause: unknown) {
    super('Unexpected tick-gate failure');
    this.name = 'TickGateUnexpectedError';
  }
}
let scoutTickCount = 0;
let scoutEscalationCount = 0;
let lastEscalationTimestamp = 0;
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

applyToolVisibility();

// The runtime-authorised tool set is derived from the active runtime descriptor.
// It is re-evaluated on each tick so refresh messages can tighten or expand access.
function allowedTools(): Set<string> {
  return new Set(getVisibleToolNames(runtimeState));
}

function refreshCapabilityPolicy(): void {
  capabilityEngine.replaceGrants(buildCapabilityGrants(runtimeState.runtimeDescriptor.toolPolicy));
}

function getTradingTickWorkPlan() {
  return deriveTradingTickWorkPlan(runtimeState.runtimeDescriptor.resolvedSkills, marketDataRegistry != null);
}

function isRuntimeActiveWatchSummary(value: unknown): value is RuntimeActiveWatchSummary {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const summary = value as Partial<RuntimeActiveWatchSummary>;
  return typeof summary.totalCount === 'number'
    && typeof summary.uniqueCount === 'number'
    && typeof summary.overflowCount === 'number'
    && Array.isArray(summary.lines)
    && summary.lines.every((line) => typeof line === 'string');
}

function parseRuntimeActiveWatch(raw: string): RuntimeActiveWatch | null {
  try {
    const parsed = JSON.parse(raw) as Partial<RuntimeActiveWatch> & {
      thresholdPrice?: unknown;
      lastConditionMet?: unknown;
      lastCheckedAt?: unknown;
    };

    if (
      typeof parsed.watchId !== 'string'
      || typeof parsed.symbol !== 'string'
      || typeof parsed.chain !== 'string'
      || parsed.condition !== 'above' && parsed.condition !== 'below'
      || typeof parsed.thresholdPrice !== 'number'
      || (parsed.note !== undefined && typeof parsed.note !== 'string')
      || (parsed.lastConditionMet !== null && parsed.lastConditionMet !== true && parsed.lastConditionMet !== false)
      || (parsed.lastCheckedAt !== undefined && typeof parsed.lastCheckedAt !== 'string')
    ) {
      return null;
    }

    return {
      watchId: parsed.watchId,
      symbol: parsed.symbol,
      chain: parsed.chain,
      condition: parsed.condition,
      thresholdPrice: parsed.thresholdPrice,
      ...(parsed.note !== undefined ? { note: parsed.note } : {}),
      lastConditionMet: parsed.lastConditionMet,
      ...(parsed.lastCheckedAt !== undefined ? { lastCheckedAt: parsed.lastCheckedAt } : {}),
    };
  } catch {
    return null;
  }
}

async function loadActiveWatchSummary(agentId: string): Promise<RuntimeActiveWatchSummary | null> {
  try {
    const summaryKey = `agent:watches:summary:${agentId}`;
    const cachedSummary = await redis.hget(summaryKey, 'summary');
    if (cachedSummary) {
      try {
        const parsed = JSON.parse(cachedSummary) as unknown;
        if (isRuntimeActiveWatchSummary(parsed)) {
          return parsed;
        }
        logger.warn({ agentId }, 'Cached active watch summary was malformed — rebuilding from source watches');
      } catch (err) {
        logger.warn({ err, agentId }, 'Failed to parse cached active watch summary — rebuilding from source watches');
      }
    }

    const rawWatches = await redis.hgetall(`agent:watches:${agentId}`);
    const watches = Object.values(rawWatches ?? {})
      .map(parseRuntimeActiveWatch)
      .filter((watch): watch is RuntimeActiveWatch => watch !== null);

    if (watches.length === 0) {
      return null;
    }

    return summarizeActiveWatches(watches);
  } catch (err) {
    logger.warn({ err, agentId }, 'Failed to load active watch summary for tick context');
    return null;
  }
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
const wakeRedis = redis.duplicate();

const INBOUND_STREAM = `agent:inbound:${AGENT_ID}`;
const OUTBOUND_STREAM = `agent:outbound:${AGENT_ID}`;
const CONSUMER_GROUP = 'agent-runtime';
const CONSUMER_NAME = `agent-${AGENT_ID}-${process.pid}`;
const WAKE_CONSUMER_GROUP = 'agent-market-wake';
const WAKE_CONSUMER_NAME = `agent-market-wake-${AGENT_ID}-${process.pid}`;
const WAKE_SIGNAL_POLL_MS = agentRuntimePolicy.wake.pollMs;

// ---------------------------------------------------------------------------
// Database (optional — enables direct bot tool access)
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env['DATABASE_URL'];
const db = DATABASE_URL ? createDatabase(DATABASE_URL) : null;
const botRepo = db ? new BotRepository(db) : null;
const agentRepo = db ? new AgentRepository(db) : null;
if (!DATABASE_URL) {
  logger.warn('DATABASE_URL not set — list_bots, get_bot_status, stop_bot, start_bot, adjust_bot_config, get_analytics, list_positions will be unavailable');
  for (const tool of DATABASE_DEPENDENT_TOOLS) {
    permanentlyExcludedTools.add(tool);
  }
}

const scoutLoopConfig = agentRuntimePolicy.llm.scout;
const judgeLoopConfig = agentRuntimePolicy.llm.judge;
const marketIntelligencePolicy = agentRuntimePolicy.marketIntelligence;

const DEFAULT_RATE_CARD_NAME = process.env['USAGE_BILLING_RATE_CARD'] ?? 'default';
const RUNTIME_CHARGE_WINDOW_MS = parseInt(process.env['USAGE_BILLING_RUNTIME_WINDOW_MS'] ?? '60000', 10);

const usageBillingService = createUsageBillingService(db, {
  userId: agentConfig.userId ?? '',
  agentId: AGENT_ID!,
  sessionId: SESSION_ID!,
  skillId: runtimeDescriptor.resolvedSkills.find((skill) => skill.id !== 'base')?.id ?? null,
  planId: agentConfig.usageBillingPlanId,
  includedCreditMicrousd: agentConfig.usageBillingIncludedCreditMicrousd,
  softCapMicrousd: agentConfig.usageBillingSoftCapMicrousd,
  hardCapMicrousd: agentConfig.usageBillingHardCapMicrousd,
  defaultRateCardName: DEFAULT_RATE_CARD_NAME,
  runtimeChargeWindowMs: RUNTIME_CHARGE_WINDOW_MS,
  enabled: !!agentConfig.userId,
});

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

// Price service — built on top of the provider registry.
// Only available when market data is configured.
const priceService: PriceService | null = marketDataRegistry
  ? createPriceService(marketDataRegistry)
  : null;

// ---------------------------------------------------------------------------
// Tool Registry
// ---------------------------------------------------------------------------

const toolRegistry = createToolRegistry();

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
  const trackedPerpsSymbols = collectPerpsTrackedSymbols(sessionMetrics).slice(0, marketIntelligencePolicy.maxTrackedPerps);
  const trackedDexTargets = collectDexTrackedTargets(
    sessionMetrics,
    agentConfig.dexWatchlistSymbols,
  ).slice(0, marketIntelligencePolicy.maxTrackedDexTargets);
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
    // Key: `${network}:${address}` — address-based keying prevents same-symbol fakes from inheriting metadata.
    let discoveryByNetworkAddress = new Map<string, Awaited<ReturnType<ProviderRegistry['discovery']['discover']>>['data'][number]>();
    let discoveryFreshness: ReturnType<typeof providerFreshness> | null = null;
    try {
      recordMarketDataAttempt('aggregated-discovery');
      const discoveryResult = await marketDataRegistry.discovery.discover({ maxResults: 25 });
      recordMarketDataRecovery('aggregated-discovery');
      discoveryFreshness = providerFreshness(discoveryResult.meta.freshness, discoveryResult.meta.provider);
      recordSignalStaleness('discovery', discoveryResult.meta.freshness.ageMs);
      discoveryByNetworkAddress = buildDiscoveryAddressMap(discoveryResult.data);
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch DEX discovery context for venue intelligence');
      recordMarketDataRejection('aggregated-discovery', { priority: 'discovery' });
    }

    for (const target of trackedDexTargets.slice(0, marketIntelligencePolicy.maxRefreshedDexTargetsPerTick)) {
      try {
        recordMarketDataAttempt('dexscreener');
        const searchResult = await marketDataRegistry.dexscreener.search(target.symbol);
        recordMarketDataRecovery('dexscreener');
        const filteredSearchResults = target.network
          ? searchResult.data.filter((token) => token.network.toLowerCase() === target.network)
          : searchResult.data;
        const topToken = filterSearchResults(filteredSearchResults, { limit: 1 })[0];
        const position = findDexPositionForTarget(sessionMetrics.openPositions, target);
        // Join discovery metadata by network:address to prevent same-symbol fakes from inheriting metadata.
        const discoveryToken = topToken
          ? (discoveryByNetworkAddress.get(`${topToken.network.toLowerCase()}:${topToken.address.toLowerCase()}`) ?? null)
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

/**
 * Publish a typed runtime activity audit event into the inbound stream.
 * Fire-and-forget — errors are swallowed so instrumentation never disrupts the tick.
 */
function emitActivityEvent(type: string, payload: Record<string, unknown>): void {
  publishToInbound(type, payload).catch((err: unknown) => {
    logger.warn({ err, type }, 'Failed to emit activity event');
  });
}

function emitToolResultEvent(params: {
  phase: 'scout' | 'judge';
  toolName: string;
  status: 'ok' | 'error';
  correlationId: string;
  summary?: string;
  metadata?: Record<string, unknown>;
}): void {
  emitActivityEvent(AGENT_RUNTIME_ACTIVITY_TYPES.TOOL_RESULT, {
    tickId: currentTickId,
    phase: params.phase,
    toolName: params.toolName,
    status: params.status,
    correlationId: params.correlationId,
    summary: params.summary,
    ...(params.metadata ? { metadata: params.metadata } : {}),
  });
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

async function ensureWakeSignalConsumerGroup(): Promise<void> {
  await wakeRedis.xgroup('CREATE', OUTBOUND_STREAM, WAKE_CONSUMER_GROUP, '$', 'MKSTREAM').catch((err: unknown) => {
    if (err instanceof Error && !err.message.includes('BUSYGROUP')) throw err;
  });
}

function requestWakeDrivenTick(reason: string): void {
  wakePending = true;

  const nextDelayMs = getWakeRescheduleDelay({
    running,
    tickInFlight,
    nextTickDueAt,
    now: Date.now(),
    effectiveTickIntervalMs,
    wakeMinIntervalMs: WAKE_MIN_INTERVAL_MS,
  });

  if (nextDelayMs !== null) {
    logger.info({ scheduledDelay: nextDelayMs }, reason);
    scheduleNextTick(nextDelayMs);
  }
}

async function pollWakeSignals(): Promise<void> {
  if (!running || wakePollInFlight) {
    return;
  }

  wakePollInFlight = true;
  try {
    for (;;) {
      const result = await wakeRedis.xreadgroup(
        'GROUP', WAKE_CONSUMER_GROUP, WAKE_CONSUMER_NAME,
        'COUNT', 10,
        'BLOCK', WAKE_SIGNAL_POLL_MS,
        'STREAMS', OUTBOUND_STREAM, '>',
      ) as Array<[string, Array<[string, string[]]>]> | null;

      if (!running) {
        return;
      }

      if (!result) {
        continue;
      }

      for (const [, entries] of result) {
        for (const [msgId, fields] of entries) {
          const envelopeIdx = fields.indexOf('envelope');
          if (envelopeIdx < 0 || !fields[envelopeIdx + 1]) {
            await wakeRedis.xack(OUTBOUND_STREAM, WAKE_CONSUMER_GROUP, msgId).catch(() => { /* ignore */ });
            continue;
          }

          try {
            const envelope = JSON.parse(fields[envelopeIdx + 1]!) as Record<string, unknown>;
            if (envelope['type'] === 'agent.market.wake') {
              requestWakeDrivenTick('Received market wake signal between ticks');
            }
          } catch {
            // Ignore malformed envelopes.
          }

          await wakeRedis.xack(OUTBOUND_STREAM, WAKE_CONSUMER_GROUP, msgId).catch(() => { /* ignore */ });
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to poll market wake signals');
  } finally {
    wakePollInFlight = false;
  }
}

function startWakeSignalPolling(): void {
  if (wakePollInFlight) {
    return;
  }
  void pollWakeSignals();
}

function stopWakeSignalPolling(): void {
  wakePollInFlight = false;
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Risk Contract Operations — provides agent tools access to risk limits
// ---------------------------------------------------------------------------

function buildRiskContractOps(): ToolContext['riskContractOps'] {
  if (!agentRepo || !agentConfig.agentRiskDefaults) {
    return undefined;
  }

  const defaults = agentConfig.agentRiskDefaults as AgentRiskDefaultsConfig;
  const ceilings = extractCeilings(defaults);

  return {
    async getContract(): Promise<ResolvedAgentRiskContract> {
      const overrides = await agentRepo!.getRiskOverrides(AGENT_ID!);
      const creatorInput = extractCreatorInput({
        capital: agentConfig.capital ?? null,
        dailyLossLimit: agentConfig.dailyLossLimit ?? null,
        maxOpenPositions: agentConfig.maxOpenPositions ?? null,
        maxPositionSizePct: agentConfig.maxPositionSizePct ?? null,
        stopLossPct: agentConfig.stopLossPct ?? null,
        stopLossCooldownMs: agentConfig.stopLossCooldownMs ?? null,
      });
      return resolveAgentRiskContract(creatorInput, ceilings, overrides);
    },

    async adjustOverrides(proposedChanges: Record<string, number | null>): Promise<{ ok: boolean; error?: string; contract?: ResolvedAgentRiskContract }> {
      const currentOverrides = await agentRepo!.getRiskOverrides(AGENT_ID!);
      const creatorInput = extractCreatorInput({
        capital: agentConfig.capital ?? null,
        dailyLossLimit: agentConfig.dailyLossLimit ?? null,
        maxOpenPositions: agentConfig.maxOpenPositions ?? null,
        maxPositionSizePct: agentConfig.maxPositionSizePct ?? null,
        stopLossPct: agentConfig.stopLossPct ?? null,
        stopLossCooldownMs: agentConfig.stopLossCooldownMs ?? null,
      });
      const currentContract = resolveAgentRiskContract(creatorInput, ceilings, currentOverrides);

      // Validate all proposed changes
      const errors: string[] = [];
      for (const [field, value] of Object.entries(proposedChanges)) {
        if (!(field in currentContract)) {
          errors.push(`Unknown risk field: '${field}'`);
          continue;
        }
        const validationError = validateRiskOverride(
          field as keyof ResolvedAgentRiskContract,
          currentContract,
          value,
        );
        if (validationError) {
          errors.push(validationError);
        }
      }

      if (errors.length > 0) {
        return { ok: false, error: errors.join('; ') };
      }

      // Apply changes to overrides
      const newOverrides: AgentRiskOverrides = { ...currentOverrides };
      for (const [field, value] of Object.entries(proposedChanges)) {
        if (value == null) {
          // Reset to default by removing override
          delete (newOverrides as Record<string, unknown>)[field];
        } else {
          (newOverrides as Record<string, number>)[field] = value;
        }
      }

      await agentRepo!.setRiskOverrides(AGENT_ID!, newOverrides);

      // Return updated contract
      const updatedContract = resolveAgentRiskContract(creatorInput, ceilings, newOverrides);
      return { ok: true, contract: updatedContract };
    },
  };
}

interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

async function executeTool(call: ToolCall, phase: 'scout' | 'judge' = 'judge'): Promise<string | null> {
  const toolCorrelationId = crypto.randomUUID();

  const rejectToolCall = (message: string, options?: { fault?: boolean }): string => {
    emitActivityEvent(AGENT_RUNTIME_ACTIVITY_TYPES.TOOL_CALL, {
      tickId: currentTickId,
      phase,
      toolName: call.tool,
      correlationId: toolCorrelationId,
    });
    emitToolResultEvent({
      phase,
      toolName: call.tool,
      status: 'error',
      correlationId: toolCorrelationId,
      summary: message.slice(0, 500),
    });
    return JSON.stringify({ ok: false, error: message, retryable: false, fault: options?.fault !== false });
  };

  // Hard runtime gate: reject any tool not declared in the active skill set.
  // The model was only told about allowed tools, but we enforce it here too so
  // a jailbreak or prompt injection cannot invoke undeclared capabilities.
  if (!allowedTools().has(call.tool)) {
    // Distinguish circuit-open (temporary) from genuinely absent (permanent) so the model
    // knows not to retry this turn vs never call the tool.
    if (toolCircuitBreaker.getBlockedTools(tickCount).has(call.tool)) {
      logger.warn({ tool: call.tool, agentId: AGENT_ID }, 'Tool circuit open — ignoring');
      return rejectToolCall(
        `tool circuit open: ${call.tool} is temporarily suspended due to repeated errors. Do not retry this turn. Use other tools or conclude the tick.`,
        { fault: false },
      );
    }
    if (toolVisibility.getDegradedExcludedTools().has(call.tool)) {
      logger.warn({ tool: call.tool, agentId: AGENT_ID }, 'Tool temporarily unavailable due to runtime degradation — ignoring');
      return rejectToolCall(
        `tool degraded: ${call.tool} is temporarily unavailable due to a runtime limitation. Do not retry it this session.`,
        { fault: false },
      );
    }
    logger.warn({ tool: call.tool, agentId: AGENT_ID }, 'Tool not in active skill set — ignoring');
    return rejectToolCall(`tool rejected: ${call.tool} is not available in the current skill set`, { fault: false });
  }

  logger.info({ tool: call.tool, args: call.args }, 'Executing tool');

  const tool = toolRegistry.get(call.tool);
  if (!tool) {
    logger.warn({ tool: call.tool }, 'Unknown tool — not in registry');
    return rejectToolCall(`unknown tool: ${call.tool}`);
  }

  const toolBotRepo = botRepo
    ? {
        getBotsByCreator: botRepo.getBotsByCreator.bind(botRepo),
        getBotById: botRepo.getBotById.bind(botRepo),
        markBotStopped: botRepo.markBotStopped.bind(botRepo),
        markBotRunning: botRepo.markBotRunning.bind(botRepo),
        restoreBotRuntimeState: botRepo.restoreBotRuntimeState.bind(botRepo),
        updateBotConfig: botRepo.updateBotConfig.bind(botRepo),
        getAnalyticsByCreator: botRepo.getAnalyticsByCreator.bind(botRepo),
        getOpenPositionsByCreator: async (creatorType: string, creatorId: string, botId?: string) => {
          const openPositions = await botRepo.getOpenPositionsByCreator(creatorType, creatorId, botId);
          return openPositions.map((position) => {
            if (!position.actorId) {
              throw new Error(`Invariant violation: open position ${position.id} is missing actorId`);
            }
            return {
              actorType: position.actorType,
              actorId: position.actorId,
              symbol: position.symbol,
              side: position.side,
              size: position.size,
              entryPrice: position.entryPrice,
              openedAt: position.openedAt,
            };
          });
        },
      }
    : undefined;

  // Build tool context from agent runtime state
  const toolContext: ToolContext = {
    agentId: AGENT_ID!,
    sessionId: SESSION_ID!,
    phase,
    redis: {
      hset: redis.hset.bind(redis),
      hget: redis.hget.bind(redis),
      hgetall: redis.hgetall.bind(redis),
      hdel: redis.hdel.bind(redis),
      publish: redis.publish.bind(redis),
    },
    publishToInbound,
    botRepo: toolBotRepo,
    marketDataRegistry: marketDataRegistry ?? undefined,
    marketDataConfig: marketDataConfig as unknown as Record<string, unknown> ?? undefined,
    recordMarketDataAttempt,
    recordMarketDataRejection,
    capabilityEngine,
    sessionMetrics,
    priceService: priceService ?? undefined,
    riskContractOps: buildRiskContractOps(),
  };

  try {
    // Validate parameters at the registry boundary before dispatching.
    // Tools receive pre-validated data and trust it without re-parsing.
    const validation = tool.parametersSchema.safeParse(call.args);
    emitActivityEvent(AGENT_RUNTIME_ACTIVITY_TYPES.TOOL_CALL, {
      tickId: currentTickId,
      phase,
      toolName: call.tool,
      correlationId: toolCorrelationId,
    });

    if (!validation.success) {
      const errorMessage = `invalid parameters: ${validation.error.issues.map(({ path, message }) => `${path.length > 0 ? path.join('.') : 'root'}: ${message}`).join('; ')}`;
      logger.warn({ tool: call.tool, errors: validation.error.flatten() }, 'Tool parameter validation failed');
      emitToolResultEvent({
        phase,
        toolName: call.tool,
        status: 'error',
        correlationId: toolCorrelationId,
        summary: errorMessage.slice(0, 500),
      });
      return JSON.stringify({
        ok: false,
        error: errorMessage,
        retryable: false,
        fault: false,
      });
    }

    const result = await tool.execute(validation.data, toolContext);

    if (!result.success) {
      if (call.tool === 'execute_code' && result.errorCode === 'execute_code.sandbox_infrastructure_error') {
        toolVisibility.setToolAvailability('execute_code', false, toolCircuitBreaker.getBlockedTools(tickCount));
        setToolCapabilityDegradation(runtimeState, 'execute_code', true);
      }
      const errorResult = JSON.stringify({
        ok: false,
        error: result.error ?? 'tool execution failed',
        errorCode: result.errorCode,
        retryable: result.retryable,
        // Preserve fault classification: default to true (assume fault) unless explicitly false.
        fault: result.fault !== false,
      });
      emitToolResultEvent({
        phase,
        toolName: call.tool,
        status: 'error',
        correlationId: toolCorrelationId,
        summary: (result.error ?? 'tool execution failed').slice(0, 500),
      });
      return errorResult;
    }

    // For tools that return ToolResult, serialize the data
    const serialized = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
    emitToolResultEvent({
      phase,
      toolName: call.tool,
      status: 'ok',
      correlationId: toolCorrelationId,
      summary: serialized.slice(0, 500),
      metadata: buildToolResultMetadata(call.tool, result.data),
    });
    return serialized;
  } catch (err) {
    logger.error({ err, tool: call.tool }, 'Tool execution threw unexpected error');
    const message = err instanceof Error ? err.message : 'unknown error';
    emitToolResultEvent({
      phase,
      toolName: call.tool,
      status: 'error',
      correlationId: toolCorrelationId,
      summary: message.slice(0, 500),
    });
    return JSON.stringify({ ok: false, error: message, retryable: false });
  }
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
// tickCount, scoutTickCount, scoutEscalationCount are declared earlier (before
// module-level applyToolVisibility() calls that reference them).
// Prevents concurrent tick execution when an LLM call takes longer than TICK_INTERVAL_MS.
let tickInFlight = false;
/** Correlation ID for activity events within the current tick — set at the start of each tick. */
let currentTickId = '';
let previousContextHash: string | null = null;
let previousFullUserContext: string | null = null;
let effectiveTickIntervalMs = costProfile.tickIntervalMs;
let previousRegimePass: boolean | null = null;
let scoutHoldDeadlineAtMs = 0;
// Hoisted so both runTick() and the heartbeat interval can trigger a clean shutdown.
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let tickTimer: ReturnType<typeof setTimeout> | undefined;
// Wake scheduling state — bounded early tick support
let wakePending = false;
const WAKE_MIN_INTERVAL_MS = agentRuntimePolicy.wake.minIntervalMs; // sourced from agentRuntimePolicy.wake.minIntervalMs
let lastWakeTickAt = 0;
let nextTickDueAt = 0;
let wakePollInFlight = false;

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

function scheduleNextTick(delayMs = effectiveTickIntervalMs): void {
  clearTimeout(tickTimer);
  if (!running) {
    nextTickDueAt = 0;
    return;
  }

  const holdLimitedDelayMs = scoutHoldDeadlineAtMs > 0
    ? Math.max(0, Math.min(delayMs, scoutHoldDeadlineAtMs - Date.now()))
    : delayMs;

  const delayDecision = resolveNextTickDelay({
    requestedDelayMs: holdLimitedDelayMs,
    wakePending,
    tickInFlight,
    now: Date.now(),
    lastWakeTickAt,
    wakeMinIntervalMs: WAKE_MIN_INTERVAL_MS,
  });
  const actualDelay = delayDecision.actualDelayMs;
  wakePending = delayDecision.wakePending;
  lastWakeTickAt = delayDecision.lastWakeTickAt;
  if (delayDecision.wakeTriggered) {
    logger.info({ scheduledDelay: actualDelay }, 'Scheduling early tick due to wake request');
  }

  nextTickDueAt = delayDecision.nextTickDueAt;
  tickTimer = setTimeout(() => {
    nextTickDueAt = 0;
    if (!running || tickInFlight) {
      scheduleNextTick(effectiveTickIntervalMs);
      return;
    }

    tickInFlight = true;
    // A firing tick processes current market state, satisfying any pending wake.
    // Wakes arriving during execution will re-set this via requestWakeDrivenTick.
    wakePending = false;
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
  }, actualDelay);
}

/**
 * Unified shutdown path used by expiry, SIGTERM, and SIGINT.
 * Idempotent: clears timers (safe to call even if never set), drains Redis, exits.
 *
 * Drain contract: after stopping new work we wait up to SHUTDOWN_DRAIN_TIMEOUT_MS
 * for any in-flight tick to complete before proceeding. This budget must stay within
 * the Docker stop timeout (?t=10) so the process exits cleanly before Docker sends
 * SIGKILL. Remaining time after drain is used for cleanup (Redis quit, session_ended).
 */
const SHUTDOWN_DRAIN_TIMEOUT_MS = 8_000;

let shuttingDown = false;

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ reason }, 'Agent runtime shutting down');
  running = false;
  clearInterval(heartbeatTimer);
  clearTimeout(tickTimer);
  stopWakeSignalPolling();
  nextTickDueAt = 0;

  // Drain in-flight tick: wait up to SHUTDOWN_DRAIN_TIMEOUT_MS for any active tick
  // to finish before tearing down Redis connections and exiting.
  if (tickInFlight) {
    logger.info({ drainTimeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS }, 'Waiting for in-flight tick to drain before shutdown');
    const drainDeadline = Date.now() + SHUTDOWN_DRAIN_TIMEOUT_MS;
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (!tickInFlight || Date.now() >= drainDeadline) {
          clearInterval(poll);
          if (tickInFlight) {
            logger.warn({ reason }, 'Drain timeout reached — proceeding with shutdown while tick still in flight');
          } else {
            logger.info({ reason }, 'In-flight tick drained cleanly');
          }
          resolve();
        }
      }, 50);
    });
  }

  usageBillingService?.closeRuntimeWindow();
  await sendHeartbeat('degraded', reason).catch(() => { /* ignore */ });
  await publishToInbound(AGENT_MESSAGE_TYPES.RUNTIME_SESSION_ENDED, {
    sessionId: SESSION_ID!,
    reasonCode: reason,
  }).catch(() => { /* ignore */ });
  await wakeRedis.quit().catch(() => { /* ignore */ });
  await redis.quit().catch(() => { /* ignore */ });
  process.exit(0);
}

async function runTick(): Promise<void> {
  tickCount++;
  refreshToolCircuits();
  logger.info({ tickCount }, 'Agent tick starting');

  const tickId = crypto.randomUUID();
  currentTickId = tickId;

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

    const tradingTickWorkPlan = getTradingTickWorkPlan();

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

    const tickGateState = buildTickGateState({
      tickNumber: tickCount,
      incomingMessages,
      hasOpenPositions,
      lastKnownPositionSide: sessionMetrics.lastPositionSide,
      tradingHours,
      now: new Date(),
      previousContextHash,
      baseTickIntervalMs: costProfile.tickIntervalMs,
      currentTickIntervalMs: effectiveTickIntervalMs,
      enabledGates: costProfile.enabledGates,
    });

    if (tickGateState.hasWakeSignal) {
      logger.info({ tickCount }, 'Processing market wake signal');
    }

    emitActivityEvent(AGENT_RUNTIME_ACTIVITY_TYPES.TICK_STARTED, {
      tickId,
      trigger: tickCount === 1 ? 'initial' : tickGateState.hasWakeSignal ? 'wake' : 'scheduled',
      positionSide: sessionMetrics.lastPositionSide ?? undefined,
      hasWakeSignal: tickGateState.hasWakeSignal,
    });

    let skipDecision: TickSkipDecision;
    try {
      skipDecision = await shouldSkipTick(
        tickGateState,
        {
          evaluateRegime: tradingTickWorkPlan.shouldEvaluateRegime
            ? async () => {
              const params: RegimeParams = {};
              return evaluateRegime(params, (symbol) =>
                (recordMarketDataAttempt('binance'), marketDataRegistry!.binance.candles(symbol, { interval: '1h', limit: 200 })).then((providerResult) => providerResult.data),
              );
            }
            : undefined,
          fetchVolatilityCandles: tradingTickWorkPlan.shouldFetchVolatilityCandles
            ? async () => {
              recordMarketDataAttempt('binance');
              return marketDataRegistry!.binance.candles('BTC', { interval: '1h', limit: 24 }).then((providerResult) => providerResult.data);
            }
            : undefined,
        },
      );
    } catch (err: unknown) {
      throw new TickGateUnexpectedError(err);
    }

    // Context hash is stored in a local variable; only persisted to previousContextHash
    // after the judge actually runs (Fix B: prevents context_unchanged gate from locking
    // the agent after a scout hold where no work was done).
    const tickContextHash = skipDecision.contextHash ?? previousContextHash;
    if (tradingTickWorkPlan.shouldRecordRegimeEvaluation) {
      recordRegimeEvaluation(
        runtimeState,
        skipDecision.regime ?? null,
        skipDecision.regime
          ? { state: 'fresh', provider: 'binance' }
          : { state: 'unavailable', note: marketDataRegistry ? 'regime not evaluated' : 'market-data registry unavailable' },
      );
    }
    if (skipDecision.degraded) {
      logger.warn({ degradationReason: skipDecision.degradationReason }, 'Tick gate degraded — helper dependency unavailable, using fallback interval');
    }
    if (skipDecision.nextTickIntervalMs !== effectiveTickIntervalMs) {
      logger.info({ fromMs: effectiveTickIntervalMs, toMs: skipDecision.nextTickIntervalMs, volatilityPct: skipDecision.volatilityPct }, 'Adjusted agent tick interval');
      effectiveTickIntervalMs = skipDecision.nextTickIntervalMs;
    }

    if (skipDecision.skip) {
      const maxHoldMs = agentRuntimePolicy.llm.scout.maxHoldDurationMs;
      const holdDurationExceeded = maxHoldMs !== undefined
        && skipDecision.reason === 'context_unchanged'
        && lastEscalationTimestamp > 0
        && Date.now() - lastEscalationTimestamp >= maxHoldMs;

      if (!holdDurationExceeded) {
        if (maxHoldMs !== undefined && lastEscalationTimestamp > 0 && Date.now() - lastEscalationTimestamp >= maxHoldMs) {
          scoutHoldDeadlineAtMs = 0;
        }
        logger.info({ tickCount, reason: skipDecision.reason, gate: skipDecision.gate }, 'Skipping agent tick before LLM dispatch');
        emitActivityEvent(AGENT_RUNTIME_ACTIVITY_TYPES.TICK_SKIPPED, {
          tickId,
          reason: skipDecision.reason ?? 'unknown',
          gate: skipDecision.gate ?? undefined,
          trigger: tickCount === 1 ? 'initial' : tickGateState.hasWakeSignal ? 'wake' : 'scheduled',
          positionSide: sessionMetrics.lastPositionSide ?? undefined,
        });
        await sendHeartbeat('ready');
        return;
      }

      logger.info({
        tickCount,
        reason: skipDecision.reason,
        gate: skipDecision.gate,
        maxHoldMs,
        msSinceLastEscalation: Date.now() - lastEscalationTimestamp,
      }, 'Bypassing agent tick skip — max scout hold duration exceeded');
    }

    if (tradingTickWorkPlan.shouldRefreshVenueIntelligence) {
      await refreshVenueIntelligence().then(() => setDependencyAvailability('market-data', true)).catch(async (err) => {
        await handleRuntimeFailure('market-data', err);
        recordVenueSignals(runtimeState, []);
      });
    } else {
      recordVenueSignals(runtimeState, []);
    }

    if (tradingTickWorkPlan.shouldRecordPerformanceInputs) {
      recordPerformanceInputs(runtimeState, {
        drawdownPct: sessionMetrics.portfolio.drawdownPct,
        netPnlUsd: (sessionMetrics.portfolio.realizedPnlUsd ?? 0) + (sessionMetrics.portfolio.unrealizedPnlUsd ?? 0),
      });
    }

    // Snapshot before buildTickUserContext clears currentReminder.
    const reminderScheduledBy = runtimeState.metrics.currentReminder?.scheduledBy ?? null;

    if (tradingTickWorkPlan.hasTradingCapability) {
      recordActiveWatchSummary(runtimeState, await loadActiveWatchSummary(AGENT_ID!));
    } else {
      recordActiveWatchSummary(runtimeState, null);
    }

    // Build context for this tick.
    const fullUserContext = buildTickUserContext(runtimeState, []);
    const incrementalContext = buildIncrementalContext({
      previousContext: previousFullUserContext,
      currentContext: fullUserContext,
      tickNumber: tickCount,
      fullContextEveryTicks: agentRuntimePolicy.contextDiff!.fullContextEveryTicks,
      maxDiffTokens: agentRuntimePolicy.contextDiff!.maxDiffTokens,
      maxChangedLines: agentRuntimePolicy.contextDiff!.maxChangedLines,
    });
    previousFullUserContext = fullUserContext;
    logger.info({ mode: incrementalContext.mode, estimatedTokens: incrementalContext.estimatedTokens }, 'Prepared tick context payload');
    let userContext = incrementalContext.content;

    refreshCapabilityPolicy();
    if (tickCount === 1) {
      userContext += '\n\nThis is your first tick. Start working towards your goal.';
    }

    // Build the prompt
    const promptNowMs = Date.now();
    const promptTiming = createPromptTimingContext({
      currentTimeMs: promptNowMs,
      nominalTickIntervalMs: costProfile.tickIntervalMs,
      expectedNextTickAtMs: nextTickDueAt > 0 ? nextTickDueAt : promptNowMs + effectiveTickIntervalMs,
    });
    const visibleToolDefs = toolRegistry.getDefinitions([...allowedTools()]);
    const toolGuidanceByName: Record<string, string> = {};
    for (const def of visibleToolDefs) {
      if (def.promptGuidance) {
        toolGuidanceByName[def.name] = def.promptGuidance;
      }
    }
    const judgeSystemPromptKey = `agent:prompt:${AGENT_ID}`;
    const scoutSystemPromptKey = `agent:prompt:scout:${AGENT_ID}`;
    const scoutUserContextPromptKey = `agent:prompt:user-context:${AGENT_ID}`;
    const judgeUserContextPromptKey = `agent:prompt:judge-user-context:${AGENT_ID}`;
    const systemPrompt = composeSystemPrompt(runtimeState, promptTiming, toolGuidanceByName);
    // Persist the compiled prompt so the API can serve GET /agents/:id/prompt
    redis.set(judgeSystemPromptKey, systemPrompt, 'EX', 3600).catch((err: unknown) => {
      logger.warn({ err }, 'Failed to persist system prompt to Redis');
    });

    const preScoutResolution = resolvePreScoutDecision({ tickCount, reminderScheduledBy });
    let resolvedScoutDecision: ScoutDecision;
    let isSoftLimited = false;
    if (preScoutResolution.decision) {
      redis.del(scoutSystemPromptKey, scoutUserContextPromptKey).catch((err: unknown) => {
        logger.warn({ err }, 'Failed to clear skipped scout prompt surfaces from Redis');
      });
      resolvedScoutDecision = preScoutResolution.decision;
    } else {
      scoutTickCount++;
      // Scout tools: auto-derived from registry — all tools with 'read-*' categories
      const readOnlyScoutTools = toolRegistry.getReadOnlyToolNames()
        .filter((tool) => allowedTools().has(tool)); // Only visible tools
      const readOnlyScoutDefinitions: LlmToolDefinition[] = toolRegistry.getDefinitions(readOnlyScoutTools).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));

      const scoutSystemPrompt = buildScoutSystemPrompt({
        agentId: AGENT_ID!,
        name: runtimeState.runtimeDescriptor.name,
        goal: runtimeState.runtimeDescriptor.goal,
        readOnlyTools: readOnlyScoutTools,
        timing: promptTiming,
        workspaceRoot: runtimeState.context.workspaceRoot ?? undefined,
        venueLines: buildVenueLines(runtimeState),
      });
      redis.set(scoutSystemPromptKey, scoutSystemPrompt, 'EX', 3600).catch((err: unknown) => {
        logger.warn({ err }, 'Failed to persist scout system prompt to Redis');
      });
      redis.set(scoutUserContextPromptKey, userContext, 'EX', 3600).catch((err: unknown) => {
        logger.warn({ err }, 'Failed to persist scout user-context to Redis');
      });

      emitActivityEvent(AGENT_RUNTIME_ACTIVITY_TYPES.LLM_DISPATCH, {
        tickId,
        phase: 'scout',
        model: resolvedLightModel,
        maxTurns: scoutLoopConfig.maxTurns,
      });

      // Check commercial spend state before dispatching LLM calls.
      // Hard-limited accounts skip the tick to avoid accumulating charges.
      if (usageBillingService && await usageBillingService.isHardLimited()) {
        logger.warn({ agentId: AGENT_ID, sessionId: SESSION_ID }, 'Account is hard-limited — skipping tick');
        emitActivityEvent(AGENT_RUNTIME_ACTIVITY_TYPES.LLM_DISPATCH, {
          tickId,
          phase: 'scout',
          model: resolvedLightModel,
          maxTurns: 0,
        });
        emitActivityEvent(AGENT_RUNTIME_ACTIVITY_TYPES.TICK_SKIPPED, {
          tickId,
          reason: 'billing.limit_exceeded',
          gate: 'billing',
          trigger: tickCount === 1 ? 'initial' : tickGateState.hasWakeSignal ? 'wake' : 'scheduled',
          positionSide: sessionMetrics.lastPositionSide ?? undefined,
        });
        return;
      }

      // Soft-limited accounts proceed but with degraded behavior (scout-only, no escalation).
      isSoftLimited = usageBillingService ? await usageBillingService.isSoftLimited() : false;
      if (isSoftLimited) {
        logger.info({ agentId: AGENT_ID, sessionId: SESSION_ID }, 'Account is soft-limited — proceeding with degraded tick (scout only)');
        emitActivityEvent(AGENT_RUNTIME_ACTIVITY_TYPES.TICK_SKIPPED, {
          tickId,
          reason: 'billing.soft_limit_reached',
          gate: 'billing',
          trigger: tickCount === 1 ? 'initial' : tickGateState.hasWakeSignal ? 'wake' : 'scheduled',
          positionSide: sessionMetrics.lastPositionSide ?? undefined,
        });
      }

      const scoutLoopResult = await runStructuredToolLoop({
        providerConfig: {
          provider: resolvedProvider,
          model: resolvedLightModel,
          maxTokens: scoutLoopConfig.maxTokens,
          timeoutMs: LLM_TIMEOUT_MS,
          baseUrl: LLM_BASE_URL,
        },
        requestBase: {
          maxTokens: scoutLoopConfig.maxTokens,
          temperature: scoutLoopConfig.temperature,
          thinking: 'none',
        },
        maxTurns: scoutLoopConfig.maxTurns,
        initialMessages: [
          { role: 'system', content: scoutSystemPrompt },
          { role: 'user', content: userContext },
        ],
        tools: readOnlyScoutDefinitions,
        retryPolicy: agentRuntimePolicy.llm.retry,
        executeTool: async (toolCall) => {
          const allowedReadOnlyTool = readOnlyScoutTools.includes(toolCall.name);

          if (!allowedReadOnlyTool) {
            logger.warn({ tool: toolCall.name, phase: 'scout' }, 'Scout attempted write or unavailable tool — rejecting');
            const rejectedToolCorrelationId = crypto.randomUUID();
            emitActivityEvent(AGENT_RUNTIME_ACTIVITY_TYPES.TOOL_CALL, {
              tickId: currentTickId,
              phase: 'scout',
              toolName: toolCall.name,
              correlationId: rejectedToolCorrelationId,
            });
            emitToolResultEvent({
              phase: 'scout',
              toolName: toolCall.name,
              status: 'error',
              correlationId: rejectedToolCorrelationId,
              summary: `tool rejected: ${toolCall.name}`,
            });
            return JSON.stringify({ ok: false, error: `tool rejected: ${toolCall.name}`, retryable: false, fault: false });
          }

          try {
            return await executeTool({ tool: toolCall.name, args: toolCall.args }, 'scout');
          } catch (err) {
            logger.warn({ err, tool: toolCall.name, phase: 'scout' }, 'Scout tool execution threw unexpectedly');
            return JSON.stringify({ ok: false, error: 'tool_failed', note: 'Tool timed out or failed. Skip or retry later.' });
          }
        },
        onAssistantTurn: ({ result, turnIndex }) => {
          recordSessionCost(runtimeState, {
            tokensUsed: result.data.tokensUsed,
            thinkingTokens: result.data.thinkingTokens,
            costUsd: estimateLlmCostUsd(resolvedLightModel, result.data.tokensUsed),
          });
          usageBillingService?.recordLlmUsage({
            provider: result.data.provider,
            model: result.data.model,
            responseId: result.data.responseId,
            inputTokens: result.data.inputTokens,
            outputTokens: result.data.outputTokens,
            thinkingTokens: result.data.thinkingTokens,
            tokensUsed: result.data.tokensUsed,
            phase: 'scout',
            turnIndex,
          });
        },
        onRetry: ({ attempt, delayMs, classification }) => {
          logger.warn({ phase: 'scout', attempt, delayMs, reasonCode: classification.reasonCode }, 'Retrying scout tool turn after backoff');
        },
        onBeforeTurn: ({ turnsRemaining }) => {
          if (turnsRemaining === 1) {
            return {
              message: 'This is your final tool call round — respond with JSON only, with disposition "hold" or "escalate" and a short reason. Do not request any more tools.',
              toolChoice: 'none',
            };
          }
          if (turnsRemaining === 2) {
            return 'You have 2 tool call rounds left. Consolidate your remaining calls now.';
          }
          return undefined;
        },
      });

      emitActivityEvent(AGENT_RUNTIME_ACTIVITY_TYPES.LLM_COMPLETED, {
        tickId,
        phase: 'scout',
        model: resolvedLightModel,
        turnsUsed: scoutLoopResult.ok ? scoutLoopResult.turnsUsed : 0,
        finishReason: !scoutLoopResult.ok ? 'error' : scoutLoopResult.terminatedByLimit ? 'turn_limit' : 'stop',
      });

      if (!scoutLoopResult.ok) {
        const scoutFailure = classifyRuntimeError('llm', scoutLoopResult.error);
        if (scoutFailure.mode === 'fatal') {
          redis.del(judgeUserContextPromptKey).catch((err: unknown) => {
            logger.warn({ err }, 'Failed to clear stale judge prompt surfaces from Redis after fatal scout failure');
          });
          await handleRuntimeFailure('llm', scoutLoopResult.error);
          return;
        }
        logger.warn({ error: scoutLoopResult.error }, 'Scout tool loop failed — falling back to judge');
      }

      if (scoutLoopResult.ok && scoutLoopResult.terminatedByLimit) {
        logger.warn({ phase: 'scout' }, 'Scout tool loop reached its turn limit');
      }

      resolvedScoutDecision = !scoutLoopResult.ok || scoutLoopResult.terminatedByLimit
        ? { disposition: 'escalate', reason: 'scout_tool_loop_limit' }
        : parseScoutDecision(scoutLoopResult.assistantResponse);
    }

    // Soft-limited: suppress escalation to planner/judge to reduce token spend
    if (isSoftLimited && resolvedScoutDecision.disposition === 'escalate') {
      logger.info({ agentId: AGENT_ID, reason: resolvedScoutDecision.reason }, 'Soft-limit active — suppressing escalation to judge');
      resolvedScoutDecision = { disposition: 'hold', reason: 'billing.soft_limit_reached' };
    }

    if (resolvedScoutDecision.disposition === 'hold') {
      const maxHoldMs = agentRuntimePolicy.llm.scout.maxHoldDurationMs;
      if (!isSoftLimited && maxHoldMs != null && lastEscalationTimestamp > 0 && (Date.now() - lastEscalationTimestamp) >= maxHoldMs) {
        resolvedScoutDecision = { disposition: 'escalate', reason: 'max_hold_duration_exceeded' };
        logger.info({ maxHoldMs, msSinceLastEscalation: Date.now() - lastEscalationTimestamp }, 'Overriding scout hold — max hold duration exceeded');
      } else {
        redis.del(judgeUserContextPromptKey).catch((err: unknown) => {
          logger.warn({ err }, 'Failed to clear skipped judge prompt surfaces from Redis');
        });
        const escalationRate = scoutTickCount > 0 ? scoutEscalationCount / scoutTickCount : 0;
        logger.info({ metric: 'agent.escalation_rate', escalationRate, reason: resolvedScoutDecision.reason }, 'Scout held the tick');
        emitActivityEvent(AGENT_RUNTIME_ACTIVITY_TYPES.SCOUT_HELD, {
          tickId,
          reason: resolvedScoutDecision.reason ?? 'unspecified',
        });
        handleTickSuccess();
        await sendHeartbeat('ready');
        return;
      }
    }

    if (preScoutResolution.source === 'scout') {
      scoutEscalationCount++;
      const escalationRate = scoutTickCount > 0 ? scoutEscalationCount / scoutTickCount : 0;
      logger.info({ metric: 'agent.escalation_rate', escalationRate, reason: resolvedScoutDecision.reason }, 'Scout escalated to judge');
      emitActivityEvent(AGENT_RUNTIME_ACTIVITY_TYPES.SCOUT_ESCALATED, {
        tickId,
        reason: resolvedScoutDecision.reason ?? 'unspecified',
      });
    } else {
      logger.info({ reason: resolvedScoutDecision.reason, source: preScoutResolution.source }, 'Escalated to judge before scout dispatch');
      emitActivityEvent(AGENT_RUNTIME_ACTIVITY_TYPES.SCOUT_ESCALATED, {
        tickId,
        reason: resolvedScoutDecision.reason ?? 'unspecified',
      });
    }
    userContext = `${fullUserContext}\n\nEscalation reason: ${resolvedScoutDecision.reason ?? 'unspecified'}`;
    redis.set(judgeUserContextPromptKey, userContext, 'EX', 3600).catch((err: unknown) => {
      logger.warn({ err }, 'Failed to persist judge user-context to Redis');
    });

    addToHistory('user', userContext);
    const recentHistory = conversationHistory.slice(-10);
    const judgeToolDefinitions: LlmToolDefinition[] = toolRegistry.getDefinitions([...allowedTools()]).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string; toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }> }> = [
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
      drawdownThresholdPct: agentRuntimePolicy.thinking.drawdownThresholdPct,
    });
    const judgeThinking = costProfile.defaultThinking === 'deep'
      ? { thinking: 'deep' as const, reason: 'cost_profile_premium' }
      : thinkingDecision;
    previousRegimePass = skipDecision.regime?.pass ?? previousRegimePass;
    logger.info({ thinking: judgeThinking.thinking, reason: judgeThinking.reason }, 'Resolved tick thinking level');

    emitActivityEvent(AGENT_RUNTIME_ACTIVITY_TYPES.LLM_DISPATCH, {
      tickId,
      phase: 'judge',
      model: costProfile.heavyModel,
      maxTurns: judgeLoopConfig.maxTurns,
    });

    const judgeLoopResult = await runStructuredToolLoop({
      providerConfig: {
        provider: resolvedProvider,
        model: costProfile.heavyModel,
        maxTokens: LLM_MAX_TOKENS,
        timeoutMs: LLM_TIMEOUT_MS,
        baseUrl: LLM_BASE_URL,
        thinking: agentRuntimePolicy.llm.thinking,
      },
      requestBase: {
        maxTokens: LLM_MAX_TOKENS,
        temperature: judgeLoopConfig.temperature,
        thinking: judgeThinking.thinking,
      },
      maxTurns: judgeLoopConfig.maxTurns,
      initialMessages: messages,
      tools: judgeToolDefinitions,
      retryPolicy: agentRuntimePolicy.llm.retry,
      executeTool: async (toolCall) => executeTool({ tool: toolCall.name, args: toolCall.args }),
      onAssistantTurn: ({ result, assistantResponse, toolCalls, turnIndex }) => {
        recordSessionCost(runtimeState, {
          tokensUsed: result.data.tokensUsed,
          thinkingTokens: result.data.thinkingTokens,
          costUsd: estimateLlmCostUsd(costProfile.heavyModel, result.data.tokensUsed),
        });
        usageBillingService?.recordLlmUsage({
          provider: result.data.provider,
          model: result.data.model,
          responseId: result.data.responseId,
          inputTokens: result.data.inputTokens,
          outputTokens: result.data.outputTokens,
          thinkingTokens: result.data.thinkingTokens,
          tokensUsed: result.data.tokensUsed,
          phase: 'judge',
          turnIndex,
        });
        logger.info({ tokensUsed: result.data.tokensUsed, thinkingTokens: result.data.thinkingTokens ?? 0, latencyMs: result.data.latencyMs, toolCalls: toolCalls.length }, 'LLM response received');
        logger.debug({ response: assistantResponse.slice(0, 500) }, 'LLM response preview');
        if (toolCalls.length === 0) {
          addToHistory('assistant', assistantResponse);
        }
      },
      onToolResult: ({ toolCall, toolResult }) => {
        if (toolResult) {
          addToHistory('user', toolResult, { truncateToToolBudget: true });
          if (toolResultIndicatesFailure(toolResult)) {
            recordToolFailure(toolCall.name);
          } else {
            recordToolSuccess(toolCall.name);
          }
        }
      },
      onRetry: ({ attempt, delayMs, classification }) => {
        logger.warn({ phase: 'judge', attempt, delayMs, reasonCode: classification.reasonCode }, 'Retrying judge LLM call after backoff');
      },
    });

    emitActivityEvent(AGENT_RUNTIME_ACTIVITY_TYPES.LLM_COMPLETED, {
      tickId,
      phase: 'judge',
      model: costProfile.heavyModel,
      turnsUsed: judgeLoopResult.ok ? judgeLoopResult.turnsUsed : 0,
      finishReason: !judgeLoopResult.ok ? 'error' : judgeLoopResult.terminatedByLimit ? 'turn_limit' : 'stop',
    });

    if (!judgeLoopResult.ok) {
      scoutHoldDeadlineAtMs = 0;
      await handleRuntimeFailure('llm', judgeLoopResult.error);
      return;
    }

    if (judgeLoopResult.terminatedByLimit) {
      scoutHoldDeadlineAtMs = 0;
      logger.warn({ phase: 'judge' }, 'Judge tool loop reached its turn limit');
      await sendHeartbeat('degraded', 'llm.tool_loop_limit');
      return;
    }

    // Only persist context hash after judge ran — prevents context_unchanged gate
    // from locking the agent when the scout held and no work was done.
    lastEscalationTimestamp = Date.now();
    scoutHoldDeadlineAtMs = agentRuntimePolicy.llm.scout.maxHoldDurationMs != null
      ? lastEscalationTimestamp + agentRuntimePolicy.llm.scout.maxHoldDurationMs
      : 0;
    previousContextHash = tickContextHash;

    handleTickSuccess();
    await sendHeartbeat('ready');
  } catch (err: unknown) {
    if (err instanceof TickGateUnexpectedError) {
      throw err.cause instanceof Error ? err.cause : new Error(String(err.cause));
    }
    // Safety-net catch for the remaining tick phases: message ingestion, context building,
    // prompt assembly, tool execution, and transport. Tick-gate and venue-intelligence
    // failures are handled by their own inner catches above and do not reach here.
    const source =
      err instanceof Error && /redis|xreadgroup|xadd|connection is closed|econn/i.test(err.message)
        ? 'redis'
        : 'tool';
    await handleRuntimeFailure(source, err);
  }
}

async function main(): Promise<void> {
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });

  logger.info(
    {
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      provider: resolvedProvider,
      lightModel: resolvedLightModel,
      heavyModel: resolvedHeavyModel,
      skillIds: runtimeDescriptor.resolvedSkills.map((skill) => skill.id).filter((id) => id !== 'base'),
    },
    'Agent runtime starting',
  );
  runtimeState.sessionStartMs = Date.now();

  await redis.ping();
  logger.info('Redis connected');
  await wakeRedis.ping();
  logger.info('Wake-signal Redis connected');

  await drainStalePendingEntries();
  await ensureWakeSignalConsumerGroup();
  startWakeSignalPolling();

  sandboxEnforcer.registerSession(SESSION_ID!);

  await sendHeartbeat('starting');

  await new Promise<void>((resolve) => setTimeout(resolve, 1000));
  await sendHeartbeat('ready');

  heartbeatTimer = setInterval(() => {
    if (sandboxEnforcer.isExpired(SESSION_ID!)) {
      logger.warn({ sessionId: SESSION_ID }, 'Session wall-clock limit exceeded — shutting down');
      void shutdown('wall_clock_expired');
      return;
    }
    usageBillingService?.flushRuntimeWindow();
    void sendHeartbeat('ready').catch((err: unknown) => logger.warn({ err }, 'Heartbeat error'));
  }, HEARTBEAT_INTERVAL_MS);

  tickInFlight = true;
  try {
    await runTick();
  } finally {
    tickInFlight = false;
    scheduleNextTick(effectiveTickIntervalMs);
  }
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Agent runtime crashed');
  process.exit(1);
});
