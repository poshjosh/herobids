import { z } from 'zod';
import { AgentWakeSourceSchema } from '../agent-protocol.js';
import { ok, err, type Result } from '../result.js';
import {
  getStrategyParameters,
  initStrategyRegistry,
  validateStrategyParams,
} from './strategy-parameters.js';

// Supported venues for live rollout
export const SUPPORTED_LIVE_VENUES = ['hyperliquid', 'bybit', 'jupiter', '1inch'] as const;
export type SupportedLiveVenue = typeof SUPPORTED_LIVE_VENUES[number];

export const SWAP_VENUES = ['jupiter', '1inch'] as const;
export const ORDERBOOK_VENUES = ['hyperliquid', 'bybit'] as const;
export type SwapVenue = typeof SWAP_VENUES[number];
export type OrderbookVenue = typeof ORDERBOOK_VENUES[number];

export const SUPPORTED_TOKEN_SAFETY_NETWORKS = [
  'solana',
  'ethereum',
  'optimism',
  'polygon',
  'base',
  'arbitrum',
  'avalanche',
] as const;
export type SupportedTokenSafetyNetwork = typeof SUPPORTED_TOKEN_SAFETY_NETWORKS[number];
export const TokenSafetyNetworkSchema = z.enum(SUPPORTED_TOKEN_SAFETY_NETWORKS);

const ONE_INCH_TOKEN_SAFETY_NETWORK_BY_CHAIN_ID: Record<number, SupportedTokenSafetyNetwork> = {
  1: 'ethereum',
  10: 'optimism',
  137: 'polygon',
  8453: 'base',
  42161: 'arbitrum',
};

export function inferOneInchTokenSafetyNetwork(chainId: number | undefined): SupportedTokenSafetyNetwork | undefined {
  if (chainId == null) {
    return undefined;
  }

  return ONE_INCH_TOKEN_SAFETY_NETWORK_BY_CHAIN_ID[chainId];
}

// --- Operator Config (loaded from YAML + env at startup) ---

export const VenueConfigSchema = z.object({
  baseUrl: z.string().url(),
  wsUrl: z.string().url().optional(),
  wsPublicUrl: z.string().url().optional(),
  wsTestnetPublicUrl: z.string().url().optional(),
  wsPrivateUrl: z.string().url().optional(),
  wsTestnetPrivateUrl: z.string().url().optional(),
  testnetBaseUrl: z.string().url().optional(),
  testnetWsUrl: z.string().url().optional(),
  /** When true, the adapter uses testnet/sandbox endpoints. Defaults to false (mainnet). */
  testnet: z.boolean().optional(),
  rpcUrl: z.string().url().optional(),
  chainId: z.number().int().positive().optional(),
  tokenSafetyNetwork: TokenSafetyNetworkSchema.optional(),
  rateLimitPerSec: z.number().min(1).default(10),
  timeoutMs: z.number().min(1000).default(30_000),
  confirmationTimeoutMs: z.number().min(1000).default(60_000),
  routerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Must be a valid EVM address (0x + 40 hex chars)').optional(),
  /** Operator-owned developer-platform key. Never stored in user credentials. */
  apiKey: z.string().min(1).optional(),
  /** Enables platform-managed direct wallet creation for this venue. */
  walletGeneration: z.object({
    enabled: z.boolean().default(false),
  }).default({}),
});

export const ReconciliationConfigSchema = z.object({
  intervalMs: z.number().min(5000).default(30_000),
  driftAlertOnly: z.boolean().default(true),
  /** Position size drift threshold (absolute). Diffs within this are 'acceptable'. Default: 0 (exact match required) */
  positionDriftThreshold: z.string().default('0'),
  /** Balance drift threshold (absolute). Diffs within this are 'acceptable'. Default: 0 */
  balanceDriftThreshold: z.string().default('0'),
  /** If true, attempt to auto-correct acceptable drift by syncing local state to venue. Default: false */
  autoCorrect: z.boolean().default(false),
  /** Swap venue: alert if balance differs from expected by more than this %. Default: 1.0 */
  swapDriftThresholdPct: z.number().min(0).default(1.0),
});

export const PublicStreamConfigSchema = z.object({
  reconnectBaseMs: z.number().min(100).default(1_000),
  reconnectMaxMs: z.number().min(1000).default(30_000),
  maxReconnectAttempts: z.number().min(1).default(20),
  depthLevels: z.number().min(1).max(50).default(5),
});

export const MarkingConfigSchema = z.object({
  stalenessThresholdMs: z.number().min(10_000).default(300_000),
  oracleBaseUrl: z.string().url().optional(),
  oracleTimeoutMs: z.number().min(1000).default(10_000),
  oracleVsCurrency: z.string().min(1).default('usd'),
});

export const BacktestingConfigSchema = z.object({
  warmupLookbackBars: z.number().int().min(1).default(200),
  maxDataGapMs: z.number().min(1).default(60_000),
  persistJournal: z.boolean().default(true),
  concurrency: z.number().int().min(1).default(2),
});

export const EvaluationThresholdsSchema = z.object({
  toolFailureRatePct: z.number().min(0).max(100).default(20),
  highDrawdownPct: z.number().min(0).max(100).default(20),
  negativeExpectancyFlag: z.boolean().default(true),
  veryShortHoldSec: z.number().min(1).default(30),
  rateLimitAnomalyCount: z.number().int().min(1).default(5),
  veryShortSessionSec: z.number().min(1).default(60),
});

export const EvaluationConfigSchema = z.object({
  storageRoot: z.string().default('app-data/evaluation-output'),
  concurrency: z.number().int().min(1).default(2),
  maxRuntimeMs: z.number().int().min(1_000).default(120_000),
  maxAttempts: z.number().int().min(1).max(10).default(3),
  thresholds: EvaluationThresholdsSchema.default({}),
});

export const MarketDataRecordingConfigSchema = z.object({
  enabled: z.boolean().default(false),
  captureTrades: z.boolean().default(true),
  captureTopOfBook: z.boolean().default(true),
  captureCandles: z.boolean().default(true),
});

// ── Per-agent wake preferences ──────────────────────────────────────────────

export const WakePreferencesSchema = z.object({
  /** Monitor-owned sources this agent subscribes to. If absent, agent receives all sources.
   *  Send `null` for the whole object (PATCH) or omit the field (POST) to clear/reset. */
  subscribedSources: z.array(AgentWakeSourceSchema).min(1).transform(arr => [...new Set(arr)]).optional(),
});

export type WakePreferences = z.infer<typeof WakePreferencesSchema>;

export const TradingHoursConfigSchema = z.object({
  /** Allowed UTC hours for agent ticks. Empty or omitted means always active. */
  allowedHoursUtc: z.array(z.number().int().min(0).max(23)).default([]),
  /** Optional weekend low-liquidity pause: Sat 00:00 UTC through Sun 12:00 UTC. */
  weekendPause: z.boolean().default(false),
});

export const LlmRetryConfigSchema = z.object({
  maxRetries: z.number().int().min(0).default(2),
  timeoutBackoffMs: z.array(z.number().int().min(0)).default([5_000, 15_000]),
  serverErrorBackoffMs: z.number().int().min(0).default(10_000),
  defaultRateLimitBackoffMs: z.number().int().min(0).default(60_000),
});

export const LlmScoutConfigSchema = z.object({
  /** Max ms the scout can hold without escalating before a forced escalation. Unset = no limit.
   *  YAML blank values parse as null — nullish() accepts both null and undefined and normalises to undefined. */
  maxHoldDurationMs: z.number().int().min(0).nullish().transform((v) => v ?? undefined),
});

/** Operator model defaults — the final fallback tier for model selection.
 *  Used when neither the agent nor the user has explicit model selection.
 *  Also populates initial values in UI forms (Settings page, agent create/edit).
 *  All fields are optional: absent/empty = no operator default, frontend falls back to first multi-provider. */
export const ModelDefaultsSchema = z.object({
  provider: z.string().min(1).optional(),
  lightModel: z.string().min(1).optional(),
  heavyModel: z.string().min(1).optional(),
}).optional();

const AgentRuntimeLlmScoutControlsSchema = z.object({
  maxTurns: z.number().int().min(1).default(10),
  maxTokens: z.number().int().min(1).default(1_024),
  temperature: z.number().min(0).max(2).default(0),
});
const LlmJudgeConfigSchema = z.object({
  maxTurns: z.number().int().min(1).default(25),
  temperature: z.number().min(0).max(2).default(0.3),
});

export const LlmThinkingConfigSchema = z.object({
  lightBudgetTokens: z.number().int().min(0).default(2_048),
  deepBudgetTokens: z.number().int().min(0).default(10_240),
});

// ── Per-agent runtime policy ────────────────────────────────────────────────

export const TRADING_SESSION_NAMES = [
  'asia',
  'london',
  'ny-morning',
  'ny-mid',
  'ny-afternoon',
] as const;
export type TradingSessionName = typeof TRADING_SESSION_NAMES[number];
export const TradingSessionNameSchema = z.enum(TRADING_SESSION_NAMES);

/** Operator ceilings — the absolute max any agent can be configured with.
 *  For ordered string enums like reasoning levels, the ceiling caps the position
 *  in the enum array (e.g. scoutReasoningMax: 'medium' allows 'none', 'low', 'medium' but not 'high'). */
export const RUNTIME_POLICY_CEILINGS = {
  scoutMaxTurns: 500,
  judgeMaxTurns: 1_000,
  scoutMaxTokens: 4_096,
  judgeMaxTokens: 16_384,
  lightThinkingTokens: 8_192,
  deepThinkingTokens: 32_768,
  scoutReasoningMax: 'medium' as const,
  judgeReasoningMax: 'high' as const,
  maxHistoryMessages: 80,
  maxHistoryTokens: 160_000,
  maxRecentToolMessages: 24,
  maxToolResultChars: 16_000,
  maxVisibleToolSchemas: 256,
  maxContextBlockChars: 16_000,
  toolResultFullRetentionTurns: 10,
  toolResultMaxStaleChars: 2_000,
  maxHoldDurationMs: 86_400_000, // 24 hours
} as const;

export const REASONING_LEVEL_ORDER = ['none', 'low', 'medium', 'high'] as const;
function reasoningLevelIndex(level: string): number {
  return REASONING_LEVEL_ORDER.indexOf(level as typeof REASONING_LEVEL_ORDER[number]);
}

/** Returns the subset of reasoning levels allowed up to (and including) the given ceiling. */
export function getAllowedReasoningLevels(ceiling: ReasoningLevel): readonly ReasoningLevel[] {
  const maxIdx = reasoningLevelIndex(ceiling);
  return REASONING_LEVEL_ORDER.slice(0, maxIdx + 1);
}

/** Coarse reasoning level — backend maps to provider-specific wire format. */
export const ReasoningLevelSchema = z.enum(['none', 'low', 'medium', 'high']);
export type ReasoningLevel = z.infer<typeof ReasoningLevelSchema>;

/**
 * Per-agent overrides for runtime policy fields.
 * Every field is optional + nullable — undefined means "use style default",
 * null means "explicitly clear/reset to style default".
 */
export const AgentRuntimePolicyOverridesSchema = z.object({
  scoutMaxTurns: z.number().int().min(1).max(RUNTIME_POLICY_CEILINGS.scoutMaxTurns).nullable().optional(),
  judgeMaxTurns: z.number().int().min(1).max(RUNTIME_POLICY_CEILINGS.judgeMaxTurns).nullable().optional(),
  scoutMaxTokens: z.number().int().min(1).max(RUNTIME_POLICY_CEILINGS.scoutMaxTokens).nullable().optional(),
  judgeMaxTokens: z.number().int().min(1).max(RUNTIME_POLICY_CEILINGS.judgeMaxTokens).nullable().optional(),
  lightThinkingTokens: z.number().int().min(0).max(RUNTIME_POLICY_CEILINGS.lightThinkingTokens).nullable().optional(),
  deepThinkingTokens: z.number().int().min(0).max(RUNTIME_POLICY_CEILINGS.deepThinkingTokens).nullable().optional(),
  allowedHoursUtc: z.array(z.number().int().min(0).max(23)).nullable().optional(),
  weekendPause: z.boolean().nullable().optional(),
  maxHistoryMessages: z.number().int().min(1).max(RUNTIME_POLICY_CEILINGS.maxHistoryMessages).nullable().optional(),
  maxHistoryTokens: z.number().int().min(1).max(RUNTIME_POLICY_CEILINGS.maxHistoryTokens).nullable().optional(),
  maxRecentToolMessages: z.number().int().min(1).max(RUNTIME_POLICY_CEILINGS.maxRecentToolMessages).nullable().optional(),
  maxToolResultChars: z.number().int().min(1).max(RUNTIME_POLICY_CEILINGS.maxToolResultChars).nullable().optional(),
  maxVisibleToolSchemas: z.number().int().min(1).max(RUNTIME_POLICY_CEILINGS.maxVisibleToolSchemas).nullable().optional(),
  maxContextBlockChars: z.number().int().min(1).max(RUNTIME_POLICY_CEILINGS.maxContextBlockChars).nullable().optional(),
  toolResultFullRetentionTurns: z.number().int().min(0).max(RUNTIME_POLICY_CEILINGS.toolResultFullRetentionTurns).nullable().optional(),
  toolResultMaxStaleChars: z.number().int().min(1).max(RUNTIME_POLICY_CEILINGS.toolResultMaxStaleChars).nullable().optional(),
  maxHoldDurationMs: z.number().int().min(0).max(RUNTIME_POLICY_CEILINGS.maxHoldDurationMs).nullable().optional(),
  tradingSessions: z.array(TradingSessionNameSchema).nullable().optional(),
  scoutReasoning: ReasoningLevelSchema.nullable().optional()
    .refine(
      (val) => {
        if (val === undefined || val === null) return true;
        return reasoningLevelIndex(val) <= reasoningLevelIndex(RUNTIME_POLICY_CEILINGS.scoutReasoningMax);
      },
      { message: `scoutReasoning must not exceed operator ceiling (${RUNTIME_POLICY_CEILINGS.scoutReasoningMax})` },
    ),
  judgeReasoning: ReasoningLevelSchema.nullable().optional()
    .refine(
      (val) => {
        if (val === undefined || val === null) return true;
        return reasoningLevelIndex(val) <= reasoningLevelIndex(RUNTIME_POLICY_CEILINGS.judgeReasoningMax);
      },
      { message: `judgeReasoning must not exceed operator ceiling (${RUNTIME_POLICY_CEILINGS.judgeReasoningMax})` },
    ),
  adaptScoutReasoning: z.boolean().nullable().optional(),
  adaptJudgeReasoning: z.boolean().nullable().optional(),
}).default({});

export type AgentRuntimePolicyOverrides = z.infer<typeof AgentRuntimePolicyOverridesSchema>;

/** Agent style — the primary user-facing knob for runtime behaviour. */
export const AgentStyleSchema = z.enum(['careful', 'balanced', 'bold']);
export type AgentStyleValue = z.infer<typeof AgentStyleSchema>;

/** Agent permission level — controls tool visibility and sandbox config. */
export const PermissionLevelSchema = z.enum(['restricted', 'standard', 'full']);
export type PermissionLevel = z.infer<typeof PermissionLevelSchema>;

/**
 * Full resolved runtime policy for an agent.
 * Every field is guaranteed present — resolved from style defaults + overrides.
 */
export interface ResolvedAgentRuntimePolicy {
  scoutMaxTurns: number;
  judgeMaxTurns: number;
  scoutMaxTokens: number;
  judgeMaxTokens: number;
  lightThinkingTokens: number;
  deepThinkingTokens: number;
  allowedHoursUtc: number[];
  weekendPause: boolean;
  maxHistoryMessages: number;
  maxHistoryTokens: number;
  maxRecentToolMessages: number;
  maxToolResultChars: number;
  maxVisibleToolSchemas: number;
  maxContextBlockChars: number;
  toolResultFullRetentionTurns: number;
  toolResultMaxStaleChars: number;
  maxHoldDurationMs: number | undefined;
  tradingSessions: TradingSessionName[] | null;
  scoutReasoning: ReasoningLevel;
  judgeReasoning: ReasoningLevel;
  adaptScoutReasoning: boolean;
  adaptJudgeReasoning: boolean;
}

/**
 * Style → defaults mapping. Mirrors the frontend STYLE_CONFIG.
 * Includes costPreset and tick defaults for completeness, but these
 * are stored separately (not part of runtime_policy_overrides).
 */
export const AGENT_STYLE_RUNTIME_DEFAULTS: Record<AgentStyleValue, ResolvedAgentRuntimePolicy & { costPreset: string; tickIntervalMins: string; dailySpendBudgetUsd: string; openPositionEscalationToJudgePolicy: string }> = {
  careful: {
    costPreset: 'minimal',
    tickIntervalMins: '90',
    dailySpendBudgetUsd: '3',
    openPositionEscalationToJudgePolicy: 'never',
    scoutMaxTurns: 10,
    judgeMaxTurns: 25,
    scoutMaxTokens: 512,
    judgeMaxTokens: 2_048,
    lightThinkingTokens: 1_024,
    deepThinkingTokens: 4_096,
    scoutReasoning: 'none',
    judgeReasoning: 'low',
    adaptScoutReasoning: true,
    adaptJudgeReasoning: true,
    allowedHoursUtc: [14, 15, 16, 17, 18, 19, 20],
    weekendPause: false,
    tradingSessions: null,
    maxHistoryMessages: 10,
    maxHistoryTokens: 20_000,
    maxRecentToolMessages: 3,
    maxToolResultChars: 2_000,
    maxVisibleToolSchemas: 32,
    maxContextBlockChars: 2_000,
    toolResultFullRetentionTurns: 2,
    toolResultMaxStaleChars: 250,
    maxHoldDurationMs: 27_000_000, // 450 min (5 × tick interval)
  },
  balanced: {
    costPreset: 'standard',
    tickIntervalMins: '30',
    dailySpendBudgetUsd: '10',
    openPositionEscalationToJudgePolicy: 'uncovered_or_triggered',
    scoutMaxTurns: 30,
    judgeMaxTurns: 75,
    scoutMaxTokens: 1_024,
    judgeMaxTokens: 4_096,
    lightThinkingTokens: 2_048,
    deepThinkingTokens: 10_240,
    scoutReasoning: 'none',
    judgeReasoning: 'medium',
    adaptScoutReasoning: true,
    adaptJudgeReasoning: true,
    allowedHoursUtc: [],
    weekendPause: false,
    tradingSessions: null,
    maxHistoryMessages: 20,
    maxHistoryTokens: 40_000,
    maxRecentToolMessages: 6,
    maxToolResultChars: 4_000,
    maxVisibleToolSchemas: 64,
    maxContextBlockChars: 4_000,
    toolResultFullRetentionTurns: 3,
    toolResultMaxStaleChars: 500,
    maxHoldDurationMs: 5_400_000, // 90 min (3 × tick interval)
  },
  bold: {
    costPreset: 'premium',
    tickIntervalMins: '10',
    dailySpendBudgetUsd: '30',
    openPositionEscalationToJudgePolicy: 'always',
    scoutMaxTurns: 100,
    judgeMaxTurns: 300,
    scoutMaxTokens: 2_048,
    judgeMaxTokens: 8_192,
    lightThinkingTokens: 4_096,
    deepThinkingTokens: 20_480,
    scoutReasoning: 'low',
    judgeReasoning: 'high',
    adaptScoutReasoning: true,
    adaptJudgeReasoning: true,
    allowedHoursUtc: [],
    weekendPause: false,
    tradingSessions: null,
    maxHistoryMessages: 40,
    maxHistoryTokens: 80_000,
    maxRecentToolMessages: 12,
    maxToolResultChars: 8_000,
    maxVisibleToolSchemas: 128,
    maxContextBlockChars: 8_000,
    toolResultFullRetentionTurns: 5,
    toolResultMaxStaleChars: 1_000,
    maxHoldDurationMs: 600_000, // 10 min (1 × tick interval)
  },
};

/**
 * Resolve the effective runtime policy for an agent.
 * Style defaults form the base; runtime_policy_overrides win on a per-field basis.
 * Falls back to 'balanced' style when the style is invalid or missing.
 */
export function resolveAgentRuntimePolicy(
  style: string | undefined | null,
  overrides: AgentRuntimePolicyOverrides | undefined | null,
): ResolvedAgentRuntimePolicy {
  const effectiveStyle: AgentStyleValue = (
    style === 'careful' || style === 'balanced' || style === 'bold'
  ) ? style : 'balanced';

  const defaults = AGENT_STYLE_RUNTIME_DEFAULTS[effectiveStyle];
  const o = overrides ?? {};

  return {
    scoutMaxTurns: o.scoutMaxTurns ?? defaults.scoutMaxTurns,
    judgeMaxTurns: o.judgeMaxTurns ?? defaults.judgeMaxTurns,
    scoutMaxTokens: o.scoutMaxTokens ?? defaults.scoutMaxTokens,
    judgeMaxTokens: o.judgeMaxTokens ?? defaults.judgeMaxTokens,
    lightThinkingTokens: o.lightThinkingTokens ?? defaults.lightThinkingTokens,
    deepThinkingTokens: o.deepThinkingTokens ?? defaults.deepThinkingTokens,
    allowedHoursUtc: o.allowedHoursUtc ?? defaults.allowedHoursUtc,
    weekendPause: o.weekendPause ?? defaults.weekendPause,
    maxHistoryMessages: o.maxHistoryMessages ?? defaults.maxHistoryMessages,
    maxHistoryTokens: o.maxHistoryTokens ?? defaults.maxHistoryTokens,
    maxRecentToolMessages: o.maxRecentToolMessages ?? defaults.maxRecentToolMessages,
    maxToolResultChars: o.maxToolResultChars ?? defaults.maxToolResultChars,
    maxVisibleToolSchemas: o.maxVisibleToolSchemas ?? defaults.maxVisibleToolSchemas,
    maxContextBlockChars: o.maxContextBlockChars ?? defaults.maxContextBlockChars,
    toolResultFullRetentionTurns: o.toolResultFullRetentionTurns ?? defaults.toolResultFullRetentionTurns,
    toolResultMaxStaleChars: o.toolResultMaxStaleChars ?? defaults.toolResultMaxStaleChars,
    maxHoldDurationMs: o.maxHoldDurationMs ?? defaults.maxHoldDurationMs,
    tradingSessions: o.tradingSessions ?? defaults.tradingSessions,
    scoutReasoning: o.scoutReasoning ?? defaults.scoutReasoning,
    judgeReasoning: o.judgeReasoning ?? defaults.judgeReasoning,
    adaptScoutReasoning: o.adaptScoutReasoning ?? defaults.adaptScoutReasoning,
    adaptJudgeReasoning: o.adaptJudgeReasoning ?? defaults.adaptJudgeReasoning,
  };
}

export const LlmCatalogConfigSchema = z.object({
  /** Short fetch timeout for catalog discovery — independent of llm.timeoutMs which is tuned for generation */
  timeoutMs: z.number().min(100).default(3_000),
  /** In-memory cache TTL for discovered catalogs (ms). Stale entries are retained as fallback; not deleted on expiry. */
  cacheTtlMs: z.number().min(1000).default(86_400_000),
});

export const OpenRouterProviderControlsSchema = z.object({
  /** Whether to allow third-party data collection on OpenRouter. 'deny' prevents providers from training on prompts. */
  dataCollection: z.enum(['allow', 'deny']).default('deny'),
  /** Zero Data Retention — when true, no prompts or completions are stored by OpenRouter or downstream providers. */
  zdr: z.boolean().default(true),
  /** Whether to allow fallback to alternative models if the primary is unavailable. */
  allowFallbacks: z.boolean().optional(),
  /** Restrict routing to only these provider slugs. */
  only: z.array(z.string()).optional(),
  /** Preferred provider ordering for routing. */
  order: z.array(z.string()).optional(),
});

export const LlmRuntimeConfigSchema = z.object({
  provider: z.string().default('openrouter'),
  model: z.string().default('anthropic/claude-sonnet-4-5'),
  /** Base URL override — leave unset to use provider default (e.g. set to http://host.docker.internal:11434/v1 for Ollama) */
  baseUrl: z.string().optional(),
  maxTokens: z.number().int().min(1).default(4096),
  timeoutMs: z.number().min(1000).default(60_000),
  /** OpenRouter request-level privacy and routing controls. Emitted in the `provider` object of every OpenRouter request body. */
  openRouterProviderControls: OpenRouterProviderControlsSchema.default({}),
  /** Catalog discovery settings — controls model listing for dynamic providers like Ollama */
  catalog: LlmCatalogConfigSchema.default({}),
  /** Agent reasoning loop interval in ms. How often the agent calls the LLM to reassess and act. */
  tickIntervalMs: z.number().int().min(5_000).default(900_000),
  /** Agent heartbeat cadence in ms. Must be well below the health-monitor stale threshold. */
  heartbeatIntervalMs: z.number().int().min(1_000).default(5_000),
  /** Operator-configured server cost used in the agent performance summary. */
  serverCostUsdPerHour: z.number().min(0).default(0.02),
  tradingHours: TradingHoursConfigSchema.optional(),
  retry: LlmRetryConfigSchema.default({}),
  scout: LlmScoutConfigSchema.default({}),
  thinking: LlmThinkingConfigSchema.default({}),
});

export const LlmValidationConfigSchema = z.object({
  requirePinnedModel: z.boolean().default(true),
  minReplayContexts: z.number().int().min(1).default(100),
  maxDecisionDivergencePct: z.number().min(0).max(100).default(20),
  maxPnlRegressionPct: z.number().min(0).max(100).default(10),
});

export const ApiConfigSchema = z.object({
  publicBaseUrl: z.string().url().default('http://api:3000'),
});

export const AgentCostEstimatesSchema = z.object({
  minimal: z.number().min(0).default(0.12),
  standard: z.number().min(0).default(0.21),
  premium: z.number().min(0).default(0.31),
}).default({});

export const AgentRiskDefaultsSchema = z.object({
  /** @deprecated Use dailyMaxLossPct (percent of equity) instead. Ratio-based loss limit. */
  dailyLossLimitDefaultRatio: z.number().min(0).max(1).default(0.05),
  maxOpenPositions: z.number().min(1).default(10),
  maxPositionSizePct: z.number().min(0).max(100).default(100),
  maxPositionSize: z.number().min(0).default(1_000_000),
  stopLossPct: z.number().min(0).max(100).default(10),
  dailyMaxLossPct: z.number().min(0).max(100).default(20),
  stopLossCooldownMs: z.number().min(0).default(300_000),
  maxOrderNotionalMultiplier: z.number().min(0).default(1),
  botConfigInvalidHaltThreshold: z.number().int().min(1).default(1),
  botExecutionErrorHaltThreshold: z.number().int().min(1).default(5),
  botLlmProviderErrorHaltThreshold: z.number().int().min(1).default(1),
  /** Consecutive no_context failures before hardening retryable → false.
   *  Only applies after the actor has proven it CAN fetch context (first successful fetch). */
  agentDecisionNoContextThreshold: z.number().int().min(1).default(10),
  /** Consecutive swap.instrument_format failures before hardening retryable → false. */
  agentDecisionSwapInstrumentFormatThreshold: z.number().int().min(1).default(5),
  maxDrawdown: z.number().min(0).default(1_000_000_000),
  /** Operator default and ceiling for peak-to-current equity drawdown (percent).
   *  Used when the creator did not set maxDrawdownPct. Agent may adjust downward at runtime. */
  maxDrawdownPct: z.number().min(0).max(100).default(20),
  /** Interval in ms for the periodic per-trade stop-loss / take-profit monitor loop. */
  perTradeLevelMonitorIntervalMs: z.number().min(1000).default(5000),
  /** Operator default for agent max concurrent bots. Used when the agent row has no maxBots override. */
  maxBots: z.number().int().min(1).default(5),
}).default({});

export const AgentApprovalsConfigSchema = z.object({
  /** Max lifetime of a pending trade approval before it expires (ms). Default: 24 hours. */
  ttlMs: z.number().int().min(60_000).default(86_400_000),
  /** Rate limit for approval resolution checks per minute. */
  resolveRateLimitPerMinute: z.number().int().min(1).default(20),
}).default({});

export const StreamConfigSchema = z.object({
  private: z.object({
    reconnectBaseMs: z.number().min(100).default(1_000),
    reconnectMaxMs: z.number().min(1000).default(30_000),
    maxReconnectAttempts: z.number().min(1).default(10),
  }).default({}),
  public: PublicStreamConfigSchema.default({}),
});

export const TelegramChannelConfigSchema = z.object({
  /** Telegram chat ID (numeric string or @channel) */
  chatId: z.string().min(1),
  /** Event type prefixes to route to this channel */
  eventPrefixes: z.array(z.string().min(1)).default(['risk.', 'execution.', 'stream.', 'instance.', 'reconciliation.']),
  /** Minimum severity to route: info | warn | critical */
  minSeverity: z.enum(['info', 'warn', 'critical']).default('warn'),
});

export const AlertsConfigSchema = z.object({
  /** Master switch for alert dispatching */
  enabled: z.boolean().default(false),
  /** How often the dispatcher polls for new events (ms) */
  dispatchIntervalMs: z.number().min(1000).default(10_000),
  /** Default cooldown between duplicate alerts for the same event type (ms) */
  defaultCooldownMs: z.number().min(0).default(300_000),
  /** Max events to process per dispatch cycle */
  maxBatchSize: z.number().min(1).default(20),
  /** Max delivery attempts before marking permanently failed */
  maxRetries: z.number().min(1).default(3),
  telegram: z.object({
    /** Bot token resolved from TELEGRAM_BOT_TOKEN env var */
    botToken: z.string().default(''),
    /** Shared secret token Telegram includes in webhook requests */
    webhookSecret: z.string().default(''),
    /** Public HTTPS webhook endpoint registered with Telegram */
    webhookUrl: z.string().url().optional(),
    /** Telegram channel routing rules */
    channels: z.array(TelegramChannelConfigSchema).default([]),
  }).default({}),
  email: z.object({
    /** Outbound email provider. Only 'ses' is supported. Override: EMAIL_PROVIDER */
    provider: z.enum(['ses']).optional(),
    /** Deprecated — formerly Resend API key. Retained for schema compat; no runtime effect. */
    apiKey: z.string().default(''),
    /** Sender email address for outbound delivery. Override: EMAIL_FROM_EMAIL */
    fromEmail: z.string().default(''),
    /** Optional reply-to address. Override: EMAIL_REPLY_TO_EMAIL */
    replyToEmail: z.string().optional(),
    /** Request timeout in ms. Override: EMAIL_TIMEOUT_MS */
    timeoutMs: z.number().int().min(1000).default(10_000),
    /** Absolute URL to the brand wordmark/logo image used in email headers.
     *  When set, the renderer includes an <img> above the typographic header.
     *  When omitted, only the typographic 'OpenAIdom' header is shown.
     *  Override: EMAIL_BRAND_IMAGE_URL */
    brandImageUrl: z.string().url().optional(),
    /** SES-specific configuration. Credentials are sourced from the standard
     *  AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY env vars. */
    ses: z.object({
      /** AWS region for SES endpoint. Override: AWS_REGION */
      region: z.string().default('us-east-1'),
      /** Optional SES configuration set name. Override: SES_CONFIGURATION_SET_NAME */
      configurationSetName: z.string().optional(),
    }).default({}),
  }).default({}),
});

export const AuthConfigSchema = z.object({
  /** Public-facing base URL (used for OAuth callback construction) */
  publicBaseUrl: z.string().url().default('http://localhost:3000'),
  /** Frontend app origin — used for CORS and OAuth browser redirect */
  frontendOrigin: z.string().url().default('http://localhost:5173'),
  /** JWT signing secret — override: AUTH_JWT_SECRET */
  jwtSecret: z.string().min(32).default('change-me-in-production-this-is-32-chars!!'),
  /** JWT token TTL in seconds */
  jwtTtlSecs: z.number().min(60).default(86_400),
  /** Short-lived OAuth exchange code TTL in seconds (browser callback handoff) */
  exchangeCodeTtlSecs: z.number().min(30).max(600).default(60),
  /** Google OAuth client ID — override: GOOGLE_CLIENT_ID */
  googleClientId: z.string().default(''),
  /** Google OAuth client secret — override: GOOGLE_CLIENT_SECRET */
  googleClientSecret: z.string().default(''),
  /** Use Secure flag on session cookies (should be true in production / HTTPS) */
  secureCookie: z.boolean().default(false),

  // ── Login-link (magic link) settings ────────────────────────────────────

  /** Login-link token TTL in seconds (how long the magic link is valid) */
  loginLinkTtlSecs: z.number().min(60).default(600),
  /** Minimum seconds before a new login link can be sent to the same email */
  loginLinkResendCooldownSecs: z.number().min(10).default(60),
  /** Max login-link sends allowed within the rolling window for one email */
  loginLinkMaxSendsPerWindow: z.number().min(1).default(5),
  /** Rolling window duration in seconds for per-email rate limiting */
  loginLinkWindowSecs: z.number().min(60).default(3600),
  /** Max login-link sends allowed within the rolling window for one source IP */
  loginLinkMaxSendsPerIpWindow: z.number().min(1).default(10),
});

export const PlanUsagePackagingSchema = z.object({
  /** Monthly included credits in cents */
  includedCreditCents: z.number().int().min(0).default(0),
  /** Soft spend cap in cents — warn when balance reaches this level (balance-based; non-negative) */
  softCapCents: z.number().int().min(0).optional(),
  /** Hard spend cap in cents — block when balance reaches this level (balance-based; negative = allow overdraft) */
  hardCapCents: z.number().int().optional(),
  /** Credit top-up pack IDs available on this plan. Non-empty → top-ups enabled. */
  topUpPackIds: z.array(z.string()).default([]),
});

export const PlanSkillsEntitlementsSchema = z.object({
  canCreatePrivateSkills: z.boolean().default(true),
  canViewMarketplaceSkills: z.boolean().default(true),
  canPublishToMarketplace: z.boolean().default(true),
  autoPublishNonDraftSkills: z.boolean().default(false),
  canPriceSkills: z.boolean().default(false),
  canLikeMarketplaceSkills: z.boolean().default(true),
});

export const PlanAgentsEntitlementsSchema = z.object({
  canViewOwnPrompts: z.boolean().default(true),
});

export const PlanBlueprintsEntitlementsSchema = z.object({
  canViewMarketplaceBlueprints: z.boolean().default(true),
  canLikeMarketplaceBlueprints: z.boolean().default(true),
});

export const PlanLimitsEntitlementsSchema = z.object({
  maxAgents: z.number().min(0).default(5),
  maxBots: z.number().min(1).default(5),
  maxConnections: z.number().min(1).default(5),
  maxCredentials: z.number().min(1).default(5),
  maxBindings: z.number().min(1).default(5),
  maxVenueAccounts: z.number().min(1).default(5),
  maxConcurrentBacktests: z.number().min(0).default(3),
  liveEnabled: z.boolean().default(false),
});

export const PlanEntitlementsSchema = z.object({
  skills: PlanSkillsEntitlementsSchema.default({}),
  agents: PlanAgentsEntitlementsSchema.default({}),
  blueprints: PlanBlueprintsEntitlementsSchema.default({}),
  limits: PlanLimitsEntitlementsSchema.default({}),
});

export const PlansConfigSchema = z.object({
  /** Default plan applied to new users */
  defaultPlanId: z.string().default('free'),
  /** Plan definitions keyed by plan ID */
  plans: z.record(z.string(), z.object({
    /** Unified entitlements model for this plan */
    entitlements: PlanEntitlementsSchema.default({}),
    /** Usage packaging for this plan */
    usage: PlanUsagePackagingSchema.default({}),
  })).default({
    free: {
      entitlements: {
        skills: {
          canCreatePrivateSkills: false,
          canViewMarketplaceSkills: true,
          canPublishToMarketplace: true,
          autoPublishNonDraftSkills: true,
          canPriceSkills: false,
          canLikeMarketplaceSkills: true,
        },
        agents: {
          canViewOwnPrompts: true,
        },
        blueprints: {
          canViewMarketplaceBlueprints: true,
          canLikeMarketplaceBlueprints: true,
        },
        limits: {
          maxAgents: 5,
          maxBots: 5,
          maxConnections: 5,
          maxCredentials: 5,
          maxBindings: 5,
          maxVenueAccounts: 5,
          maxConcurrentBacktests: 3,
          liveEnabled: false,
        },
      },
      usage: {
        includedCreditCents: 0,
        topUpPackIds: [],
      },
    },
  }),
});

export const UsageBillingConfigSchema = z.object({
  /** Default currency for all billing accounts */
  defaultCurrency: z.string().default('USD'),
  /** Window size in ms for coarse agent runtime metering */
  runtimeChargeWindowMs: z.number().int().min(1000).default(60_000),
  /** Spend thresholds (as % of hard cap) at which to emit warnings */
  warningThresholdsPct: z.array(z.number().int().min(1).max(100)).default([50, 80, 100]),
  /** Default rate card name to activate when opening new billing periods */
  defaultRateCardName: z.string().default('default'),
  /** Seed items for the default rate card — priceMicrousd per perUnit quantity */
  defaultRateCardItems: z.array(z.object({
    meterKey: z.enum(['llm.input_tokens', 'llm.cached_input_tokens', 'llm.output_tokens', 'llm.reasoning_tokens', 'agent.runtime_ms', 'assessment.request', 'browser.session_ms']),
    /** Scope to a specific provider — omit to apply to all providers */
    provider: z.string().optional(),
    /** Exact model ID or glob with trailing * — omit to apply to all models */
    modelPattern: z.string().optional(),
    priceMicrousd: z.number().int().min(0),
    perUnit: z.number().int().min(1),
  })).default([
    { meterKey: 'agent.runtime_ms', priceMicrousd: 100, perUnit: 60_000 },
  ]),
  /**
   * Percentage of the input token rate to use as the cache-read rate when a
   * pricing snapshot has no explicit cacheReadUsdPerM.  Set to 0 to disable
   * the fallback and leave cache reads un-billed when pricing is absent.
   */
  fallbackCacheReadPct: z.number().min(0).max(100).default(75),
  /**
   * Percentage of maxTokens to bill as estimated output tokens when an LLM
   * call fails (timeout or server error) before returning a response.
   * Set to 0 to skip billing for failed calls.
   */
  failedRequestOutputPct: z.number().min(0).max(100).default(75),
  /** Whether credit top-up purchases are available globally */
  creditTopUpsEnabled: z.boolean().default(false),
  /** Provider top-up product mappings: provider → array of top-up packs */
  topUpProductsByProvider: z.record(
    z.enum(['creem', 'stripe', 'mock']),
    z.array(z.object({
      packId: z.string().min(1),
      externalId: z.string().min(1),
      cents: z.number().int().min(1),
    })),
  ).default({}),
}).superRefine((data, ctx) => {
  // Only enforce uniqueness within each provider — the same packId may
  // appear across providers because it represents the same logical product
  // (e.g. "$5 top-up"), just with different payment processing.
  for (const [provider, packs] of Object.entries(data.topUpProductsByProvider)) {
    const seen = new Set<string>();
    packs.forEach((pack, index) => {
      if (seen.has(pack.packId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `topUpProductsByProvider packId '${pack.packId}' must be unique within provider '${provider}'`,
          path: ['topUpProductsByProvider', provider, index, 'packId'],
        });
        return;
      }
      seen.add(pack.packId);
    });
  }
});

export const BillingProviderSchema = z.enum(['creem', 'stripe', 'mock']);
export type BillingProvider = z.infer<typeof BillingProviderSchema>;

export const BillingPlanPriceSchema = z.object({
  /** Stripe price ID for this plan+interval */
  stripePriceId: z.string().min(1),
  /** Billing interval */
  interval: z.enum(['month', 'year']),
  /** Display label shown in UI */
  displayLabel: z.string().min(1),
  /** Amount in cents for display (informational — Stripe is authoritative) */
  amountCents: z.number().int().min(0).optional(),
});

export const BillingPlanProductSchema = z.object({
  /** Creem product ID for this plan */
  creemProductId: z.string().min(1),
  /** Billing interval */
  interval: z.enum(['month', 'year']),
  /** Display label shown in UI */
  displayLabel: z.string().min(1),
  /** Amount in cents for display (informational — Creem is authoritative) */
  amountCents: z.number().int().min(0).optional(),
});

export const StripeConfigSchema = z.object({
  /** Stripe secret key — override: STRIPE_SECRET_KEY */
  secretKey: z.string().default(''),
  /** Stripe webhook signing secret — override: STRIPE_WEBHOOK_SECRET */
  webhookSecret: z.string().default(''),
  /** Stripe Customer Portal configuration ID (optional) */
  customerPortalConfigurationId: z.string().optional(),
  /** Map of internal plan IDs to their Stripe price entries */
  planPrices: z.record(z.string(), z.array(BillingPlanPriceSchema).min(1)).default({}),
});

export const CreemConfigSchema = z.object({
  /** Creem API key — override: CREEM_API_KEY */
  apiKey: z.string().default(''),
  /** Creem webhook signing secret — override: CREEM_WEBHOOK_SECRET */
  webhookSecret: z.string().default(''),
  /** Creem API base URL (auto-detected from key prefix if omitted) */
  apiBaseUrl: z.string().url().default('https://api.creem.io/v1'),
  /** Map of internal plan IDs to their Creem product entries */
  planProducts: z.record(z.string(), z.array(BillingPlanProductSchema).min(1)).default({}),
});

export const BillingConfigSchema = z.object({
  /**
   * @deprecated — removed. Use primaryProvider: 'mock' for dev/CI instead.
   * Presence of this key will cause a startup validation error.
   */
  enabled: z.boolean().optional(),
  /** Primary payment provider — use 'mock' for local dev/CI (no credentials needed) */
  primaryProvider: BillingProviderSchema.default('mock'),
  /** Fallback payment provider (optional) */
  fallbackProvider: BillingProviderSchema.optional(),
  /** Stripe configuration */
  stripe: StripeConfigSchema.default({}),
  /** Creem configuration */
  creem: CreemConfigSchema.default({}),
}).superRefine((data, ctx) => {
  if (data.enabled !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "billing.enabled is no longer supported — remove it and use primaryProvider: 'mock' for dev/CI, or 'creem'/'stripe' for production",
      path: ['enabled'],
    });
  }
});

export const MarketDataBudgetSchema = z.object({
  requestsPerMinute: z.number().int().min(1),
  burstCapacity: z.number().int().min(1).optional(),
  maxWaitMs: z.number().int().min(0).default(5_000),
  cacheTtlMs: z.number().int().min(0).default(0),
});

// --- Token Safety Config ---

export const CanonicalTokenEntrySchema = z.object({
  address: z.string().min(1),
  name: z.string().min(1),
  aliases: z.array(z.string().min(1)).default([]),
});

export const TokenSafetyDefaultsSchema = z.object({
  minLiquidityUsd: z.number().min(0).default(10_000),
  minVolume24hUsd: z.number().min(0).default(25_000),
  minTokenAgeHours: z.number().min(0).default(24),
  deadPoolMinAgeHours: z.number().min(1).default(24 * 30),
  deadPoolMaxVolume24hUsd: z.number().min(0).default(1_000),
  preferCanonical: z.boolean().default(true),
  requireCanonicalForKnownSymbols: z.boolean().default(true),
  includeBlockedSearchResults: z.boolean().default(false),
});

export const TokenSafetyTradeGuardSchema = z.object({
  enabled: z.boolean().default(true),
  liquidityMultiplier: z.number().min(1).default(200),
  allowOverrides: z.boolean().default(true),
  overrideTtlMs: z.number().int().min(60_000).default(300_000),
});

export const TokenSafetyConfigSchema = z.object({
  enabled: z.boolean().default(true),
  defaults: TokenSafetyDefaultsSchema.default({}),
  tradeGuard: TokenSafetyTradeGuardSchema.default({}),
  canonicalTokens: z.record(
    z.string(),
    z.record(z.string(), CanonicalTokenEntrySchema),
  ).default({}),
});

export const MarketDataConfigSchema = z.object({
  dexscreener: z.object({
    baseUrl: z.string().url().default('https://api.dexscreener.com'),
    search: MarketDataBudgetSchema.default({
      requestsPerMinute: 30,
      burstCapacity: 30,
      maxWaitMs: 5_000,
      cacheTtlMs: 15_000,
    }),
    discovery: MarketDataBudgetSchema.default({
      requestsPerMinute: 30,
      burstCapacity: 15,
      maxWaitMs: 5_000,
      cacheTtlMs: 300_000,
    }),
  }).default({}),
  geckoterminal: z.object({
    baseUrl: z.string().url().default('https://api.geckoterminal.com'),
    proBaseUrl: z.string().url().default('https://pro-api.coingecko.com').optional(),
    apiKey: z.string().optional(),
    candles: MarketDataBudgetSchema.default({
      requestsPerMinute: 15,
      burstCapacity: 15,
      maxWaitMs: 5_000,
      cacheTtlMs: 60_000,
    }),
    discovery: MarketDataBudgetSchema.default({
      requestsPerMinute: 60,
      burstCapacity: 5,
      maxWaitMs: 5_000,
      cacheTtlMs: 300_000,
    }),
  }).default({}),
  hyperliquid: z.object({
    baseUrl: z.string().url().default('https://api.hyperliquid.xyz'),
    intelligencePath: z.string().default('/info'),
    intelligence: MarketDataBudgetSchema.default({
      requestsPerMinute: 120,
      burstCapacity: 20,
      maxWaitMs: 2_000,
      cacheTtlMs: 60_000,
    }),
  }).default({}),
  bybit: z.object({
    baseUrl: z.string().url().default('https://api.bybit.com'),
    longShortRatioPath: z.string().default('/v5/market/account-ratio'),
    intelligence: MarketDataBudgetSchema.default({
      requestsPerMinute: 120,
      burstCapacity: 20,
      maxWaitMs: 2_000,
      cacheTtlMs: 60_000,
    }),
    tickers: MarketDataBudgetSchema.default({
      requestsPerMinute: 30,
      burstCapacity: 10,
      maxWaitMs: 2_000,
      cacheTtlMs: 30_000,
    }),
  }).default({}),
  binance: z.object({
    baseUrl: z.string().url().default('https://api.binance.com'),
    requestsPerMinute: z.number().min(1).default(200),
    /** Max ms to wait for the shared rate-limit token bucket to refill before giving up.
     *  Separate from marketData.timeoutMs (HTTP timeout). Binance has a high RPM
     *  (200) but a correspondingly large burst; after the burst drains the bucket,
     *  subsequent requests need ~300 ms each. A 30 s window gives adequate headroom. */
    maxWaitMs: z.number().int().min(1_000).default(30_000),
    /** Scanner capacity controls — prevent scanner candle traffic from exhausting
     *  the shared Binance rate-limit budget. Operator-config owned per config-layer rules. */
    scanner: z.object({
      /** Per-worker max scanner candle requests per minute.
       *  Default 50 RPM — derived from operator capacity calc (200 RPM binance budget,
       *  150 reserved for regime checks). */
      maxRequestsPerMinute: z.number().int().min(1).default(50),
      /** Max concurrent scanner agents across all workers. Used as a per-worker
       *  in-memory gate until a cross-worker Redis semaphore is added. */
      maxConcurrentScans: z.number().int().min(1).default(4),
      /** Max entry candidates selected per scan. Bounds Hyperliquid discovery
       *  results before they become candle requests. Open-position exit evaluation
       *  symbols are always preserved above this cap. */
      maxCandidates: z.number().int().min(1).default(20),
    }).default({}),
  }).default({}),
  birdeye: z.object({
    enabled: z.boolean().default(false),
    baseUrl: z.string().url().default('https://public-api.birdeye.so'),
    requestsPerMinute: z.number().int().min(1).default(60),
    apiKey: z.string().default(''),
    cacheTtlMs: z.number().int().min(0).default(3_600_000),
  }).default({}),
  coinMarketCap: z.object({
    enabled: z.boolean().default(false),
    baseUrl: z.string().url().default('https://pro-api.coinmarketcap.com'),
    requestsPerMinute: z.number().int().min(1).default(30),
    apiKey: z.string().default(''),
    cacheTtlMs: z.number().int().min(0).default(3_600_000),
  }).default({}),
  scrapfly: z.object({
    baseUrl: z.string().url().default('https://api.scrapfly.io/scrape'),
    asp: z.boolean().default(true),
    requestTimeoutMs: z.number().int().min(1_000).default(60_000),
  }).default({}),
  discovery: z.object({
    maxResults: z.number().int().min(1).max(100).default(50),
    geckoTerminalExtraPages: z.number().int().min(0).max(10).default(0),
    antistalenessCooldownHours: z.number().min(0).default(4),
    antistalenessTokenTtlHours: z.number().min(1).default(24),
  }).superRefine((data, ctx) => {
    if (data.antistalenessTokenTtlHours < data.antistalenessCooldownHours) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'antistalenessTokenTtlHours must be >= antistalenessCooldownHours',
        path: ['antistalenessTokenTtlHours'],
      });
    }
  }).default({}),
  tokenSafety: TokenSafetyConfigSchema.default({}),
  economicCalendar: z.object({
    enabled: z.boolean().default(false),
    daysForward: z.number().int().min(1).max(14).default(2),
    minImpact: z.enum(['high', 'medium', 'low']).default('medium'),
    currencies: z.array(z.string()).default([]),
    cacheTtlMs: z.number().int().min(0).default(10_800_000),
    maxEventsInContext: z.number().int().min(1).max(50).default(20),
    refreshIntervalMs: z.number().int().min(60_000).default(21_600_000),
    forexFactory: z.object({
      baseUrl: z.string().url().default('https://www.forexfactory.com'),
      requestTimeoutMs: z.number().int().min(1_000).default(10_000),
      requestsPerMinute: z.number().int().min(1).default(2),
      userAgent: z.string().min(1).default('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'),
    }).default({}),
  }).default({}),
  timeoutMs: z.number().min(1000).default(5000),
}).superRefine((data, ctx) => {
  if (data.birdeye.enabled && !data.birdeye.apiKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'marketData.birdeye.apiKey is required when birdeye.enabled is true',
      path: ['birdeye', 'apiKey'],
    });
  }
  if (data.coinMarketCap.enabled && !data.coinMarketCap.apiKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'marketData.coinMarketCap.apiKey is required when coinMarketCap.enabled is true',
      path: ['coinMarketCap', 'apiKey'],
    });
  }
});

export const WorkerConfigSchema = z.object({
  scanIntervalMs: z.number().int().min(100).default(5_000),
  concurrency: z.number().int().min(1).default(10),
  agents: z.object({
    healthCheckIntervalMs: z.number().int().min(100).default(2_000),
    botOrphanSweepIntervalMs: z.number().int().min(1000).default(60_000),
  }).default({}),
});

export const WebAccessToolsConfigSchema = z.object({
  tavily: z.object({
    baseUrl: z.string().url().default('https://api.tavily.com'),
    searchDepth: z.enum(['basic', 'advanced']).default('basic'),
    maxResults: z.number().int().min(1).max(10).default(5),
    timeoutMs: z.number().int().min(1000).default(15_000),
  }).default({}),
  browseUrl: z.object({
    maxResponseBytes: z.number().int().min(1024).default(512 * 1024),
    timeoutMs: z.number().int().min(1000).default(15_000),
    maxRedirects: z.number().int().min(0).max(10).default(3),
  }).default({}),
});

// ── Infrastructure Services ──────────────────────────────────────────────────

/**
 * Per-service entry: an optional static URL override.
 *
 * When `url` is non-empty, the worker uses it directly (Docker Compose path).
 * When `url` is empty and the runtime backend is Nomad, the worker resolves
 * the service address from the Nomad service catalog at startup.
 */
export const ServiceEntrySchema = z.object({
  /** Static URL override (e.g. 'http://browser-pool:3000'). Empty = resolve dynamically. */
  url: z.string().default(''),
}).default({});

/**
 * Declarative map of infrastructure service names to their config.
 *
 * Adding a new pool service means adding a key here and a corresponding
 * Nomad job — the ServiceRegistry resolves it automatically.
 */
export const ServicesConfigSchema = z.object({
  'browser-pool': ServiceEntrySchema,
}).default({});

export const BrowserPoolConfigSchema = z.object({
  enabled: z.boolean().default(false),
  url: z.string().default(''),
  apiKey: z.string().default(''),
  maxSessionDurationMs: z.number().int().positive().default(60_000),
  defaultViewport: z.object({
    width: z.number().int().positive().default(1280),
    height: z.number().int().positive().default(720),
  }).default({}),
}).default({});
// Note: browserPool.url is not strictly required when enabled — the worker's
// ServiceRegistry can resolve it dynamically from Nomad service discovery.
// The worker logs a warning if enabled but no URL is resolved at runtime.

export const HttpClientConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxResponseBytes: z.number().int().positive().default(51_200),
  denyList: z.array(z.string()).default([
    '10.*',
    '172.16.*', '172.17.*', '172.18.*', '172.19.*',
    '172.20.*', '172.21.*', '172.22.*', '172.23.*',
    '172.24.*', '172.25.*', '172.26.*', '172.27.*',
    '172.28.*', '172.29.*', '172.30.*', '172.31.*',
    '192.168.*',
    '169.254.*',
    '127.*',
    'localhost',
    '0.0.0.0',
    '[::1]',
  ]),
}).default({});

export const SessionCircuitBreakerSchema = z.object({
  enabled: z.boolean().default(true),
  strategyError: z.object({
    maxInWindow: z.number().int().min(1).default(10),
    windowMs: z.number().int().min(1000).default(60_000),
  }).default({}),
  drift: z.object({
    maxInWindow: z.number().int().min(1).default(5),
    windowMs: z.number().int().min(1000).default(300_000),
  }).default({}),
  streamDisconnect: z.object({
    maxInWindow: z.number().int().min(1).default(5),
    windowMs: z.number().int().min(1000).default(300_000),
  }).default({}),
  cooldownMs: z.number().int().min(10_000).default(300_000),
  maxTrips: z.number().int().min(1).default(3),
  probeIntervalMs: z.number().int().min(5_000).default(60_000),
});

export const AgentRuntimeConfigSchema = z.object({
  failureBackoff: z.object({
    backoffThreshold: z.number().int().min(1).default(3),
    maxFailures: z.number().int().min(1).default(5),
    maxIntervalMs: z.number().int().min(1000).default(1_800_000),
  }).default({}),
  toolCircuitBreaker: z.object({
    failureThreshold: z.number().int().min(1).default(3),
    reopenAfterTicks: z.number().int().min(1).default(1),
  }).default({}),
  sessionCircuitBreaker: SessionCircuitBreakerSchema.default({}),
  thinking: z.object({
    drawdownThresholdPct: z.number().min(-100).max(0).default(-2),
  }).default({}),
  llm: z.object({
    modelDefaults: ModelDefaultsSchema,
    scout: AgentRuntimeLlmScoutControlsSchema.default({}),
    judge: LlmJudgeConfigSchema.default({}),
  }).default({}),
  wake: z.object({
    minIntervalMs: z.number().int().min(1_000).default(15_000),
    pollMs: z.number().int().min(100).default(1_000),
  }).default({}),
  marketIntelligence: z.object({
    maxTrackedPerps: z.number().int().min(1).default(3),
    maxTrackedDexTargets: z.number().int().min(1).default(3),
    maxRefreshedDexTargetsPerTick: z.number().int().min(1).default(2),
  }).default({}),
  /** Hybrid-mode scanner signal deduplication — skip LLM wakes when signal fingerprints are unchanged. */
  scannerSignalDedup: z.object({
    enabled: z.boolean().default(true),
    topN: z.number().int().min(1).max(50).default(5),
    confidenceBucketSize: z.number().min(0.01).max(1).default(0.05),
    ttlSeconds: z.number().int().min(60).default(600),
  }).default({}),
  /** In-cycle bounded retry for transient candle fetch failures (rate limits, 5xx, timeouts). */
  candleFetchRetry: z.object({
    enabled: z.boolean().default(true),
    maxRetries: z.number().int().min(0).max(10).default(3),
    baseDelayMs: z.number().int().min(50).max(5000).default(250),
    maxDelayMs: z.number().int().min(100).max(10000).default(2000),
  }).default({}),
  /** Cross-scan circuit breaker for symbols that fail every retry across consecutive scans. */
  candleFetchBreaker: z.object({
    enabled: z.boolean().default(true),
    failScansBeforeOpen: z.number().int().min(1).max(20).default(3),
    baseSkipScans: z.number().int().min(1).max(50).default(2),
    maxSkipScans: z.number().int().min(1).max(100).default(8),
  }).default({}),
  /** Scanner subsystem configuration. Operator config — deploy/restart, not runtime. */
  scanner: z.object({
    /** Master kill-switch for swap (DEX) scanning. When false (default), swap-bound
     *  agents return no candidates — byte-for-byte identical to today's behaviour.
     *  Set to true to enable swap scanning globally; use per-venue flags for rollout. */
    swap: z.object({
      enabled: z.boolean().optional().default(false),
      /** Per-venue rollout flags. Absent/true = enabled when swap.enabled is true.
       *  false = this venue is explicitly disabled regardless of swap.enabled. */
      venues: z.object({
        jupiter: z.boolean().optional(),
        '1inch': z.boolean().optional(),
      }).optional(),
    }).optional().default({}),
  }).optional().default({}),
  /** Cross-session crash-loop guard — persist crash counters in Redis and block
   *  relaunch when an agent has crashed too many times within the sliding window. */
  crashLoopGuard: z.object({
    enabled: z.boolean().default(true),
    maxCrashesInWindow: z.number().int().min(1).default(3),
    windowMs: z.number().int().min(10_000).default(300_000),
  }).default({}),
  promptStyle: z.enum(['classic', 'enriched']).default('enriched'),
  promptEnrichment: z.object({
    memory: z.object({
      enabled: z.boolean().default(true),
      maxInlineKeys: z.number().int().min(1).max(50).default(12),
    }).default({}),
    judgeHistory: z.object({
      hybridMaxResponses: z.number().int().min(0).max(10).default(3),
      tickMaxDisplayed: z.number().int().min(1).max(30).default(10),
    }).default({}),
    configReference: z.object({
      enabled: z.boolean().default(true),
    }).default({}),
    queuedSignals: z.object({
      enabled: z.boolean().default(true),
      max: z.number().int().min(1).max(10).default(5),
    }).default({}),
    wakeEmphasis: z.object({
      enabled: z.boolean().default(true),
    }).default({}),
    activityTimeline: z.object({
      enabled: z.boolean().default(true),
      maxEvents: z.number().int().min(3).max(30).default(10),
    }).default({}),
  }).default({}),
  contextDiff: z.object({
    fullContextEveryTicks: z.number().int().min(1).default(10),
    maxDiffTokens: z.number().int().min(1).default(200),
    maxChangedLines: z.number().int().min(1).default(12),
  }).default({}),
  defaultBudgets: z.object({
    maxHistoryMessages: z.number().int().min(1),
    maxHistoryTokens: z.number().int().min(1),
    maxRecentToolMessages: z.number().int().min(1),
    maxToolResultChars: z.number().int().min(1),
    maxVisibleToolSchemas: z.number().int().min(1),
    maxContextBlockChars: z.number().int().min(1),
    toolResultFullRetentionTurns: z.number().int().min(0).optional(),
    toolResultMaxStaleChars: z.number().int().min(1).optional(),
  }),
  sandboxDefaults: z.object({
    cpuShares: z.number().int().min(1).default(256),
    memoryMb: z.number().int().min(64).default(512),
    maxWallClockMs: z.number().int().min(0).default(300_000),
    tempStorageMb: z.number().int().min(1).default(100),
    maxProcesses: z.number().int().min(1).default(10),
    maxRequestsPerMinute: z.number().int().min(1).default(60),
    maxConcurrentConnections: z.number().int().min(1).default(10),
    maxResponseBytes: z.number().int().min(1).default(10_485_760),
    maxTotalDownloadBytes: z.number().int().min(1).default(104_857_600),
  }).default({}),
  /**
   * Per-tier resource profiles for agent runtime containers.
   *
   * Each profile maps a plan tier (e.g. 'free', 'pro', 'enterprise') to
   * scheduler-level resource constraints: memory hard limit, scheduling
   * reservation, CPU shares, process limit, and temp storage.
   *
   * Fallback: when a tier has no matching profile, the launcher uses
   * {@link sandboxDefaults} as the final fallback.
   *
   * Operator config controls the absolute platform ceiling per tier.
   * Plan-specific product behaviour (e.g. enterprise-only dedicated nodes)
   * can evolve separately without changing these profiles.
   */
  resourceProfiles: z.record(z.string(), z.object({
    /** Hard memory limit in MB (OOM kill boundary). */
    memoryLimitMb: z.number().int().min(64),
    /**
     * Soft memory for scheduling decisions.
     * Must be ≤ memoryLimitMb. When unset, defaults to memoryLimitMb / 2.
     */
    memoryReservationMb: z.number().int().min(1).optional(),
    /** CPU shares (relative weight; e.g. 256 ≈ 0.25 vCPU on a 1024-scale). */
    cpuShares: z.number().int().min(1),
    /** Max number of PIDs / processes inside the runtime. */
    maxProcesses: z.number().int().min(1),
    /** Temp storage limit in MB (e.g. /tmp tmpfs size). */
    tempStorageMb: z.number().int().min(1),
    /** Wall-clock timeout in ms (0 = unlimited, runtime is killed after this). */
    maxWallClockMs: z.number().int().min(0).optional(),
  })).default({}).refine(
    (profiles) => {
      for (const [, profile] of Object.entries(profiles)) {
        if (profile.memoryReservationMb !== undefined && profile.memoryReservationMb > profile.memoryLimitMb) {
          return false;
        }
      }
      return true;
    },
    (profiles) => {
      for (const [tier, profile] of Object.entries(profiles)) {
        if (profile.memoryReservationMb !== undefined && profile.memoryReservationMb > profile.memoryLimitMb) {
          return {
            message: `agentRuntime.resourceProfiles.${tier}: memoryReservationMb (${profile.memoryReservationMb}) must be ≤ memoryLimitMb (${profile.memoryLimitMb})`,
          };
        }
      }
      // Should never reach here since refine only calls this when validation fails
      return { message: 'agentRuntime.resourceProfiles: memoryReservationMb must be ≤ memoryLimitMb' };
    },
  ),
  tools: z.object({
    codeExecute: z.object({
      defaultTimeoutMs: z.number().int().min(1000).default(60_000),
      defaultMaxOutputBytes: z.number().int().min(1).default(51_200),
    }).default({}),
    webAccess: WebAccessToolsConfigSchema.default({}),
    httpClient: HttpClientConfigSchema,
  }).default({}),
});

export const AgentRuntimePolicySchema = AgentRuntimeConfigSchema.extend({
  llm: z.object({
    catalog: LlmCatalogConfigSchema.default({}),
    retry: LlmRetryConfigSchema.default({}),
    scout: LlmScoutConfigSchema.merge(AgentRuntimeLlmScoutControlsSchema).default({}),
    judge: LlmJudgeConfigSchema.default({}),
    thinking: LlmThinkingConfigSchema.default({}),
  }).default({}),
});

export const LiveRolloutConfigSchema = z.object({
  /** Master switch — must be true for any instance to run in live mode */
  enabled: z.boolean().default(false),
  /** Venues permitted to execute live orders (others are rejected at startup) */
  allowedVenues: z.array(z.enum(SUPPORTED_LIVE_VENUES)).default(['hyperliquid']),
  /** Require DB-backed credentials (reject env-var fallback for live mode) */
  requireDbCredentials: z.boolean().default(true),
  /** Hard cap on single-order notional (USD) during rollout — instance maxOrderNotional is clamped to this */
  maxInitialOrderNotionalUsd: z.string().default('50').refine(
    (v) => { const n = Number(v); return v === v.trim() && Number.isFinite(n) && n > 0; },
    { message: 'maxInitialOrderNotionalUsd must be a finite positive numeric string (no surrounding whitespace)' },
  ),
  /** Consecutive venue errors before circuit-breaker halts the actor */
  maxConsecutiveVenueErrors: z.number().int().min(1).default(3),
  /** Slippage alert threshold (bps) — log warning when fill deviates beyond this */
  slippageAlertBps: z.number().min(0).default(50),
  /** Timeout for stale live limit orders before cancellation is attempted */
  limitOrderTimeoutMs: z.number().int().min(1000).default(120_000),
  /** Timeout for live market orders that never reach terminal completion */
  marketOrderTimeoutMs: z.number().int().min(1000).default(30_000),
  /** Interval for live timeout scans in actor loops */
  timeoutCheckIntervalMs: z.number().int().min(1000).default(10_000),
  /** Fatal live crash policy: emergency flatten confirmed exposure or halt for manual intervention */
  crashPolicy: z.enum(['auto_go_flat', 'alert_manual_intervention']).default('alert_manual_intervention'),
});

export const MarketIntelligenceFamilySchema = z.object({
  enabled: z.boolean().default(true),
});

export const MarketIntelligenceConfigSchema = z.object({
  /** Master enable/disable for the entire market intelligence subsystem */
  enabled: z.boolean().default(true),
  /** Monitor evaluation interval in ms. Default: 5000 */
  evaluationIntervalMs: z.number().int().min(500).default(5_000),
  /** Discovery source poll interval in ms. Default: 30000 */
  discoveryPollMs: z.number().int().min(5_000).default(30_000),
  /** Regime source poll interval in ms. Default: 60000 */
  regimePollMs: z.number().int().min(5_000).default(60_000),
  /** Networks to scan for discovery. Default: ['solana'] */
  networks: z.array(z.string()).default(['solana']),
  /** Benchmark symbols for regime evaluation. Default: ['BTC'] */
  benchmarkSymbols: z.array(z.string()).default(['BTC']),
  /** Per-family toggles for the monitor */
  families: z.object({
    watchThresholds: MarketIntelligenceFamilySchema.default({}),
    discoveryDeltas: MarketIntelligenceFamilySchema.default({}),
    regimeChanges: MarketIntelligenceFamilySchema.default({}),
  }).default({}),
  /** Wake coalescing window in ms. Default: 3000 */
  wakeCoalescingWindowMs: z.number().int().min(500).default(3_000),
  /** Wake cooldown in ms. Default: 30000 */
  wakeCooldownMs: z.number().int().min(1_000).default(30_000),
  /** Per-source wake policy overrides (cooldown, mode). Unknown sources fall back to wakeCooldownMs. */
  wakePolicy: z.record(
    z.string(),
    z.object({
      cooldownMs: z.number().int().min(1_000).optional(),
      mode: z.enum(['wake', 'batched', 'context']).optional(),
    }),
  ).optional().default({}),
});

// ── Platform Assessor LLM Config ───────────────────────────────────────────

/** Score band thresholds for LLM ranking output. */
export const PlatformAssessmentScoreBandsSchema = z.object({
  /** Score ≥ this → band 'A'. Default: 80 */
  aMin: z.number().min(0).max(100).default(80),
  /** Score ≥ this → band 'B'. Default: 60 */
  bMin: z.number().min(0).max(100).default(60),
  /** Score ≥ this → band 'C'. Default: 40 */
  cMin: z.number().min(0).max(100).default(40),
  /** Score ≥ this → band 'D'. Default: 20 */
  dMin: z.number().min(0).max(100).default(20),
  /** Score < dMin → band 'F'. */
}).default({});

/** Recommendation policy — guards against low-confidence auto-recommendations. */
export const PlatformAssessmentRecommendationPolicySchema = z.object({
  /** Minimum confidence (0–1) required for the rank-1 preset to become the recommended preset.
   *  Below this threshold, recommendedPreset is set to null. Default: 0.6 */
  minConfidence: z.number().min(0).max(1).default(0.6),
  /** Minimum score (0–100) required for the rank-1 preset to become the recommended preset.
   *  Below this threshold, recommendedPreset is set to null. Default: 40 */
  minScoreForRecommendation: z.number().min(0).max(100).default(40),
  /** Minimum score for a preset to appear in allowedPresets. Default: 1 (score 0 = excluded). */
  minAllowedScore: z.number().min(0).max(100).default(1),
}).default({});

/** Platform-owned LLM configuration for assessment ranking.
 *  The platform assessor never falls back to an agent's LLM configuration. */
export const PlatformAssessmentLlmConfigSchema = z.object({
  /** LLM provider identifier (must exist in the loaded provider registry). Default: 'openrouter' */
  provider: z.string().min(1).default('openrouter'),
  /** Model ID. Default: 'anthropic/claude-fable-5' */
  model: z.string().min(1).default('anthropic/claude-fable-5'),
  /** HTTP request timeout in ms. Default: 30_000 */
  timeoutMs: z.number().int().min(1_000).default(30_000),
  /** Max output tokens for the LLM response. Default: 2_000 */
  maxTokens: z.number().int().min(1).default(2_000),
  /** Max input tokens for the prompt projection. Default: 4_000 */
  maxInputTokens: z.number().int().min(1).default(4_000),
  /** Base URL override (for testing or alternative endpoints). */
  baseUrl: z.string().url().optional(),
  /** Concurrency limit for assessment LLM calls. Default: 1 */
  maxConcurrency: z.number().int().min(1).default(1),
  /** Retry policy for provider calls. */
  retry: LlmRetryConfigSchema.default({}),
  /** Score band thresholds. */
  scoreBands: PlatformAssessmentScoreBandsSchema.default({}),
  /** Recommendation guard policy. */
  recommendationPolicy: PlatformAssessmentRecommendationPolicySchema.default({}),
}).default({});

export type PlatformAssessmentLlmConfig = z.infer<typeof PlatformAssessmentLlmConfigSchema>;

// ── Platform Assessor Config ───────────────────────────────────────────────

export const PlatformAssessorConfigSchema = z.object({
  /** Enable/disable the platform assessor. Default: true */
  enabled: z.boolean().default(true),
  /** Operator minimum floor for agent reviewIntervalMs. Default: 24 hours (86_400_000) */
  minReviewIntervalMs: z.number().int().positive().default(86_400_000),
  /** Optional daily cap on billed assessment requests per agent. */
  maxReviewRequestsPerDay: z.number().int().positive().default(4),
  /** Top N candidates the deterministic scanner pre-check considers. Default: 20 */
  scannerCandidateLimit: z.number().int().positive().default(20),
  /** Single resolved freshness for lookup and artifact expiry. Default: 6 hours (21_600_000) */
  cacheFreshnessMs: z.number().int().positive().default(21_600_000),
  /** Maximum concurrent assessments. Default: 1 */
  maxConcurrentAssessments: z.number().int().min(1).default(1),
  /** Maximum number of instruments accepted per assessment request.
   *  If the caller requests more, only the first N are assessed. Default: 3 */
  maxInstrumentsPerRequest: z.number().int().min(1).max(50).default(3),
  // ── Platform LLM configuration ───────────────────────────────────────
  /** Platform-owned LLM configuration for ranking. Never falls back to agent config. */
  llm: PlatformAssessmentLlmConfigSchema.default({}),
  // ── Evidence collection policies ──────────────────────────────────────
  /** Max age for collected evidence before considered stale. Default: 300_000 (5 min) */
  evidenceMaxAgeMs: z.number().int().positive().default(300_000),
  /** Timeout for evidence collection operations. Default: 15_000 (15s) */
  evidenceTimeoutMs: z.number().int().positive().default(15_000),
  /** Max evidence payload size. Default: 1_048_576 (1 MB) */
  evidencePayloadLimitBytes: z.number().int().positive().default(1_048_576),
  /** Candle collection policy. */
  candlePolicy: z.object({
    defaultInterval: z.enum(['5m', '15m', '1h', '4h', '1d']).default('15m'),
    minimumCandles: z.number().int().positive().default(48),
    maxCandles: z.number().int().positive().default(200),
  }).optional().default({}),
  /** ATR / volatility calculation policy. */
  atrPolicy: z.object({
    lookbackPeriods: z.number().int().positive().default(14),
    volatilityLowPercentile: z.number().min(0).max(100).default(25),
    volatilityHighPercentile: z.number().min(0).max(100).default(75),
    volatilityExtremePercentile: z.number().min(0).max(100).default(95),
    calculationVersion: z.string().default('1.0.0'),
  }).optional().default({}),
  /** Liquidity quality classification thresholds. */
  liquidityPolicy: z.object({
    goodSpreadBpsMax: z.number().nonnegative().default(5),
    goodDepthUsdMin: z.number().nonnegative().default(50_000),
    adequateSpreadBpsMax: z.number().nonnegative().default(25),
    adequateDepthUsdMin: z.number().nonnegative().default(10_000),
  }).optional().default({}),
  /** Breadth cohort configuration. Optional — unavailable until an operator configures a valid cohort. */
  breadthPolicy: z.object({
    movingAveragePeriods: z.array(z.enum(['50', '200'])).optional().default(['50']),
    minimumSymbols: z.number().int().positive().default(5),
    maxLookbackDays: z.number().int().positive().default(30),
  }).optional(),
  /** Per-venue-family source mappings. Operators can override defaults per venue family. */
  sourceMappings: z.record(
    z.string(),
    z.object({
      candleSource: z.enum(['geckoterminal', 'venue', 'none']),
      liquiditySource: z.enum(['orderbook', 'pool', 'discovery_cache', 'none']),
      breadthSource: z.enum(['geckoterminal', 'venue_cache', 'none']),
      regimeSource: z.enum(['benchmark', 'venue', 'none']),
    }),
  ).optional().default({}),
  // ── Deterministic Review Pre-Check Configuration ──────────────────────
  /** Configuration for the deterministic scanner pre-check that produces
   *  assessment review advice without LLM calls or billing. */
  preCheck: z.object({
    /** Signal count ratio threshold for preset-candidate mismatch flag.
     *  When a peer preset has >= this ratio × the current preset's signal
     *  count, the mismatch is flagged. Default: 2.0 */
    signalRatioThreshold: z.number().min(1.0).default(2.0),
    /** Lookback window for scan metrics comparison in ms. Default: 24h */
    scanMetricsLookbackMs: z.number().int().positive().default(86_400_000),
    /** Minimum signals a preset must generate to be considered "active"
     *  for comparison purposes. Default: 3 */
    minSignalsForActive: z.number().int().min(1).default(3),
    /** Minimum cooldown between review advice for the same (agent, identity).
     *  Default: 24h */
    identityCooldownMs: z.number().int().positive().default(86_400_000),
    /** How long persisted scanner candidate observations are retained
     *  for review. Must be >= identityCooldownMs. Default: 7 days */
    candidateRetentionMs: z.number().int().positive().default(604_800_000),
    /** Maximum candidate stale age — candidates older than this are ignored
     *  by the pre-check. Default: 24h */
    candidateMaxAgeMs: z.number().int().positive().default(86_400_000),
    /** Maximum review-advice payload size in bytes for the assessment_review
     *  wake. Exceeding candidates are trimmed. Default: 16 KB */
    maxAdvicePayloadSize: z.number().int().positive().default(16_384),
    /** Review-check lease duration in ms. A lease that expires before the
     *  check completes triggers recovery. Default: 60s */
    leaseDurationMs: z.number().int().positive().default(60_000),
    /** Timeout for the read-only billing preflight query in ms.
     *  Default: 5s */
    billingPreflightTimeoutMs: z.number().int().positive().default(5_000),
    /** Policy version for the deterministic review predicate.
     *  Increment when reason codes or eligibility logic change. */
    policyVersion: z.string().default('1.0.0'),
    /** Whether the pre-check compares peer presets for mismatch detection.
     *  When false, only freshness/cooldown/credit checks run.
     *  Default: true */
    enablePeerComparison: z.boolean().default(true),
  }).default({}),
}).default({});

export const SharedServicesConfigSchema = z.object({
  /** Redis hostname or IP reachable from agent runtimes. Default: 'redis' (Compose service name for local dev). */
  redisHost: z.string().default('redis'),
  /** Redis port. Default: 6379 */
  redisPort: z.number().int().min(1).max(65535).default(6379),
  /** Postgres hostname or IP reachable from agent runtimes. Default: 'postgres' (Compose service name for local dev). */
  postgresHost: z.string().default('postgres'),
  /** Postgres port. Default: 5432 */
  postgresPort: z.number().int().min(1).max(65535).default(5432),
  /** Postgres user for agent runtime connections. */
  postgresUser: z.string().default('herobids'),
  /** Postgres password for agent runtime connections. */
  postgresPassword: z.string().default('herobids'),
  /** Postgres database name for agent runtime connections. */
  postgresDatabase: z.string().default('herobids'),
});

/** Shared-service connectivity config for agent runtimes. */
export type SharedServicesConfig = z.infer<typeof SharedServicesConfigSchema>;

// ── Nomad Runtime Backend ───────────────────────────────────────────────────

/**
 * Runtime backend selector — which scheduler the worker uses to place
 * agent containers. 'docker' is the default single-host path; 'nomad'
 * enables cluster scheduling through HashiCorp Nomad.
 */
export const RUNTIME_BACKENDS = ['docker', 'nomad', 'stub'] as const;
export type RuntimeBackend = typeof RUNTIME_BACKENDS[number];

export const NomadConfigSchema = z.object({
  /** Nomad API base URL (e.g. 'http://10.0.0.1:4646'). Required when runtimeBackend is 'nomad'. */
  addr: z.string().url().default('http://localhost:4646'),
  /** Nomad ACL token for authenticated API access. Required when runtimeBackend is 'nomad' (ACLs are always enabled in production). Override: NOMAD_TOKEN */
  token: z.string().nullable().optional(),
  /** Nomad region. Default: 'global'. */
  region: z.string().default('global'),
  /** Nomad datacenters for agent job placement. */
  datacenters: z.array(z.string()).default(['dc1']),
  /** Nomad namespace for agent jobs (isolates agent workloads from other Nomad jobs). */
  namespace: z.string().default('herobids-agents'),
  /** Agent Docker image used in the Nomad task config. Override: NOMAD_AGENT_IMAGE */
  agentImage: z.string().default('herobids-agent:latest'),
  /** Docker network for agent tasks. Leave empty for Nomad's default bridge network. */
  dockerNetwork: z.string().nullable().optional(),
  /**
   * Interval (ms) between termination polls.
   * The adapter polls Nomad allocation statuses to detect agent crashes.
   * Default: 30_000 (30 seconds).
   */
  terminationPollIntervalMs: z.number().int().min(5_000).default(30_000),
  /** Nomad API request timeout in ms. Default: 10_000 (10 seconds). */
  requestTimeoutMs: z.number().int().min(1_000).default(10_000),
});

export type NomadConfig = z.infer<typeof NomadConfigSchema>;

export const GmailIntegrationConfigSchema = z.object({
  clientId: z.string().default(''),
  clientSecret: z.string().default(''),
  redirectUri: z.string().default(''),
  dailySendLimit: z.number().int().min(1).max(500).default(50),
}).default({});

export const AppConfigSchema = z.object({
  app: z.object({
    port: z.number().default(3000),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  }),
  api: ApiConfigSchema.default({}),
  database: z.object({
    url: z.string(),
    poolMin: z.number().default(2),
    poolMax: z.number().default(10),
  }),
  redis: z.object({
    url: z.string().default('redis://localhost:6379'),
  }),
  /** Shared-service addresses passed to agent runtimes for cluster-safe connectivity. */
  sharedServices: SharedServicesConfigSchema.default({}),
  /**
   * Runtime backend selector — which scheduler the worker uses to place agent containers.
   * 'docker' = local Docker daemon (default, single-host).
   * 'nomad'  = HashiCorp Nomad cluster (multi-node orchestration).
   * 'stub'   = in-memory fake (local dev without any container runtime).
   * Override: RUNTIME_BACKEND env var.
   */
  runtimeBackend: z.enum(RUNTIME_BACKENDS).default('docker'),
  /** Nomad runtime backend config. Only used when runtimeBackend is 'nomad'. */
  nomad: NomadConfigSchema.default({}),
  venues: z.record(VenueConfigSchema).default({}),
  execution: z.object({
    defaultSlippageBps: z.number().min(0).default(50),
    orderTimeoutMs: z.number().min(1000).default(30_000),
    maxRetries: z.number().min(0).default(3),
    shadowPollIntervalMs: z.number().int().min(100).default(2_000),
    shadowQuoteSlippageBps: z.number().min(0).default(50),
  }),
  simulation: z.object({
    takerFeePct: z.number().min(0).default(0.001),
    makerFeePct: z.number().min(0).default(0.0005),
    paperSlippageBps: z.number().min(0).default(5),
  }).default({}),
  risk: z.object({
    globalMaxDrawdownPct: z.number().min(0).max(100).default(20),
    maxOpenPositions: z.number().min(1).default(10),
    maxPositionSizePct: z.number().min(0).max(100).default(25),
  }),
  agentRiskDefaults: AgentRiskDefaultsSchema,
  agentApprovals: AgentApprovalsConfigSchema,
  agentCostEstimates: AgentCostEstimatesSchema,
  reconciliation: ReconciliationConfigSchema.default({}),
  streams: StreamConfigSchema.default({}),
  marking: MarkingConfigSchema.default({}),
  backtesting: BacktestingConfigSchema.default({}),
  evaluation: EvaluationConfigSchema.default({}),
  marketDataRecording: MarketDataRecordingConfigSchema.default({}),
  marketData: MarketDataConfigSchema.optional(),
  marketIntelligence: MarketIntelligenceConfigSchema.default({}),
  platformAssessor: PlatformAssessorConfigSchema.default({}),
  worker: WorkerConfigSchema.default({}),
  agentRuntime: AgentRuntimeConfigSchema,
  llm: LlmRuntimeConfigSchema.default({}),
  llmValidation: LlmValidationConfigSchema.default({}),
  liveRollout: LiveRolloutConfigSchema.default({}),
  integrations: z.object({
    gmail: GmailIntegrationConfigSchema,
  }).default({}),
  alerts: AlertsConfigSchema.default({}),
  auth: AuthConfigSchema.default({}),
  plans: PlansConfigSchema.default({}),
  billing: BillingConfigSchema.default({}),
  usageBilling: UsageBillingConfigSchema.default({}),
  externalSkills: z.object({
    enabled: z.boolean().default(true),
    apiBaseUrl: z.string().url().default('http://skills-api:3456'),
    searchApiBaseUrl: z.string().url().default('https://skills.sh'),
    searchTimeoutMs: z.number().int().min(500).max(30000).default(10000),
    browseTimeoutMs: z.number().int().min(500).max(30000).default(5000),
    statsTimeoutMs: z.number().int().min(500).max(10000).default(3000),
  }).default({}),
  browserPool: BrowserPoolConfigSchema,
  /** Declarative service URL map — used by the ServiceRegistry for dynamic resolution. */
  services: ServicesConfigSchema,
}).superRefine((data, ctx) => {
  const oneInchConfig = data.venues['1inch'];
  if (
    data.marketData?.tokenSafety?.enabled
    && oneInchConfig
    && !oneInchConfig.tokenSafetyNetwork
    && oneInchConfig.chainId != null
    && !inferOneInchTokenSafetyNetwork(oneInchConfig.chainId)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `venues.1inch.chainId ${String(oneInchConfig.chainId)} requires venues.1inch.tokenSafetyNetwork when marketData.tokenSafety.enabled is true`,
      path: ['venues', '1inch', 'tokenSafetyNetwork'],
    });
  }

  for (const provider of ['jupiter', '1inch'] as const) {
    const venue = data.venues[provider];
    if (venue?.walletGeneration.enabled && !venue.apiKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `venues.${provider}.apiKey is required when venues.${provider}.walletGeneration.enabled is true`,
        path: ['venues', provider, 'apiKey'],
      });
    }
  }

  if (!(data.plans.defaultPlanId in data.plans.plans)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `plans.defaultPlanId '${data.plans.defaultPlanId}' does not exist in the plans map — check config`,
      path: ['plans', 'defaultPlanId'],
    });
  }
  // When a real provider is configured, validate its credentials and plan mappings
  const isRealProvider = (p: string | undefined) => p === 'stripe' || p === 'creem';
  if (isRealProvider(data.billing.primaryProvider) || isRealProvider(data.billing.fallbackProvider)) {
    const { primaryProvider, fallbackProvider, stripe, creem } = data.billing;

    // Validate primary provider credentials
    if (primaryProvider === 'stripe' || fallbackProvider === 'stripe') {
      if (!stripe.secretKey) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'billing.stripe.secretKey is required when Stripe is a configured provider',
          path: ['billing', 'stripe', 'secretKey'],
        });
      }
      if (!stripe.webhookSecret) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'billing.stripe.webhookSecret is required when Stripe is a configured provider',
          path: ['billing', 'stripe', 'webhookSecret'],
        });
      }
    }

    if (primaryProvider === 'creem' || fallbackProvider === 'creem') {
      if (!creem.apiKey) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'billing.creem.apiKey is required when Creem is a configured provider',
          path: ['billing', 'creem', 'apiKey'],
        });
      }
      if (!creem.webhookSecret) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'billing.creem.webhookSecret is required when Creem is a configured provider',
          path: ['billing', 'creem', 'webhookSecret'],
        });
      }
    }

    // Validate that primaryProvider !== fallbackProvider
    if (fallbackProvider && primaryProvider === fallbackProvider) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'billing.fallbackProvider must differ from billing.primaryProvider',
        path: ['billing', 'fallbackProvider'],
      });
    }

    // Every plan in stripe.planPrices must exist in plans.plans
    for (const planId of Object.keys(stripe.planPrices)) {
      if (!(planId in data.plans.plans)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `billing.stripe.planPrices references unknown plan '${planId}' — must exist in plans.plans`,
          path: ['billing', 'stripe', 'planPrices', planId],
        });
      }
    }

    // Every plan in creem.planProducts must exist in plans.plans
    for (const planId of Object.keys(creem.planProducts)) {
      if (!(planId in data.plans.plans)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `billing.creem.planProducts references unknown plan '${planId}' — must exist in plans.plans`,
          path: ['billing', 'creem', 'planProducts', planId],
        });
      }
    }

  // When runtimeBackend is 'nomad', validate that required Nomad fields are present.
  if (data.runtimeBackend === 'nomad') {
    if (!data.nomad.token) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'nomad.token is required when runtimeBackend is "nomad". Set NOMAD_TOKEN or configure nomad.token in operator config.',
        path: ['nomad', 'token'],
      });
    }
    if (!data.nomad.dockerNetwork) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'nomad.dockerNetwork is required when runtimeBackend is "nomad" (e.g. "bridge" or a custom network name).',
        path: ['nomad', 'dockerNetwork'],
      });
    }
  }

    // When both primary and fallback providers are real (non-mock), validate that
    // every plan/interval in the primary mapping also exists in the fallback.
    // Without this, a failover during checkout silently lands on the first
    // configured interval instead of the one the user selected.
    if (fallbackProvider && fallbackProvider !== 'mock' && primaryProvider !== 'mock') {
      const primaryIntervals: Record<string, string[]> = {};
      if (primaryProvider === 'stripe') {
        for (const [planId, prices] of Object.entries(stripe.planPrices)) {
          primaryIntervals[planId] = prices.map((p) => p.interval);
        }
      } else if (primaryProvider === 'creem') {
        for (const [planId, products] of Object.entries(creem.planProducts)) {
          primaryIntervals[planId] = products.map((p) => p.interval);
        }
      }

      for (const [planId, intervals] of Object.entries(primaryIntervals)) {
        for (const interval of intervals) {
          const fallbackHas =
            fallbackProvider === 'stripe'
              ? (stripe.planPrices[planId]?.some((p) => p.interval === interval) ?? false)
              : (creem.planProducts[planId]?.some((p) => p.interval === interval) ?? false);
          if (!fallbackHas) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `billing.${fallbackProvider} fallback is missing a '${interval}' entry for plan '${planId}' — failover would silently use a different interval`,
              path: ['billing', fallbackProvider === 'stripe' ? 'stripe' : 'creem', fallbackProvider === 'stripe' ? 'planPrices' : 'planProducts'],
            });
          }
        }
      }
    }
  }
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;
export type SessionCircuitBreakerConfig = z.infer<typeof SessionCircuitBreakerSchema>;
export type AgentRuntimeConfig = z.infer<typeof AgentRuntimeConfigSchema>;
export type AgentRuntimePolicy = z.infer<typeof AgentRuntimePolicySchema>;
/** Per-tier resource profile — maps plan tier IDs (e.g. 'free', 'pro') to resource constraints. */
export type AgentResourceProfilesConfig = AgentRuntimeConfig['resourceProfiles'];
export type ModelDefaults = z.infer<typeof ModelDefaultsSchema>;
export type BacktestingConfig = z.infer<typeof BacktestingConfigSchema>;
export type EvaluationConfig = z.infer<typeof EvaluationConfigSchema>;
export type EvaluationThresholds = z.infer<typeof EvaluationThresholdsSchema>;
export type MarketDataRecordingConfig = z.infer<typeof MarketDataRecordingConfigSchema>;
export type LlmRuntimeConfig = z.infer<typeof LlmRuntimeConfigSchema>;
export type OpenRouterProviderControlsConfig = z.infer<typeof OpenRouterProviderControlsSchema>;
export type LlmValidationConfig = z.infer<typeof LlmValidationConfigSchema>;
export type LiveRolloutConfig = z.infer<typeof LiveRolloutConfigSchema>;
export type SimulationConfig = AppConfig['simulation'];
export type AgentRiskDefaultsConfig = AppConfig['agentRiskDefaults'];
export type AgentCostEstimatesConfig = AppConfig['agentCostEstimates'];
export type MarketDataConfig = z.infer<typeof MarketDataConfigSchema>;
export type TokenSafetyConfig = z.infer<typeof TokenSafetyConfigSchema>;
export type MarketIntelligenceConfig = z.infer<typeof MarketIntelligenceConfigSchema>;
export type PlatformAssessorConfig = z.infer<typeof PlatformAssessorConfigSchema>;
export type AgentApprovalsConfig = z.infer<typeof AgentApprovalsConfigSchema>;
export type AlertsConfig = z.infer<typeof AlertsConfigSchema>;
export type AuthConfig = z.infer<typeof AuthConfigSchema>;
export type PlansConfig = z.infer<typeof PlansConfigSchema>;
export type BillingConfig = z.infer<typeof BillingConfigSchema>;
export type StripeConfig = z.infer<typeof StripeConfigSchema>;
export type CreemConfig = z.infer<typeof CreemConfigSchema>;
export type TelegramChannelConfig = z.infer<typeof TelegramChannelConfigSchema>;
export type GmailIntegrationConfig = z.infer<typeof GmailIntegrationConfigSchema>;
export type BrowserPoolConfig = z.infer<typeof BrowserPoolConfigSchema>;
export type ServiceEntry = z.infer<typeof ServiceEntrySchema>;
export type ServicesConfig = z.infer<typeof ServicesConfigSchema>;
export type HttpClientConfig = z.infer<typeof HttpClientConfigSchema>;
export type UsageBillingConfig = z.infer<typeof UsageBillingConfigSchema>;
export type PlanUsagePackaging = z.infer<typeof PlanUsagePackagingSchema>;
export type PlanEntitlements = z.infer<typeof PlanEntitlementsSchema>;
export type PlanSkillsEntitlements = z.infer<typeof PlanSkillsEntitlementsSchema>;
export type PlanAgentsEntitlements = z.infer<typeof PlanAgentsEntitlementsSchema>;
export type PlanBlueprintsEntitlements = z.infer<typeof PlanBlueprintsEntitlementsSchema>;
export type PlanLimitsEntitlements = z.infer<typeof PlanLimitsEntitlementsSchema>;

// --- Trading Instance Config (stored in Postgres JSONB, per-instance) ---

/**
 * Token-safety guardrails for swap/DEX venues.
 * Venue/DEX-specific — kept separate from the shared risk core.
 *
 * **Precedence:** When both `tokenSafety.*` and the deprecated
 * `risk.minSwapToken*` / `risk.allowSwapTokenSafetyOverride` fields are
 * present, `tokenSafety.*` takes precedence.
 */
export const TokenSafetySchema = z.object({
  /** Minimum token liquidity in USD. Tokens below this threshold are filtered out. */
  minLiquidityUsd: z.number().min(0).optional(),
  /** Minimum 24h trading volume in USD. Tokens below this threshold are filtered out. */
  minVolume24hUsd: z.number().min(0).optional(),
  /** Minimum token age in hours. Tokens younger than this are filtered out. */
  minAgeHours: z.number().min(0).optional(),
  /** Whether the agent/bot is allowed to issue token-safety overrides. */
  allowOverrides: z.boolean().optional(),
});
export type TokenSafety = z.infer<typeof TokenSafetySchema>;

export const RiskConfigSchema = z.preprocess(
  (input) => {
    // Accept legacy stopLossMaxUnrealizedLossPct as input alias → normalize to stopLossPct
    if (typeof input === 'object' && input !== null) {
      const obj = input as Record<string, unknown>;
      if ('stopLossMaxUnrealizedLossPct' in obj && !('stopLossPct' in obj)) {
        console.debug('RiskConfigSchema: normalizing legacy stopLossMaxUnrealizedLossPct to stopLossPct');
        return { ...obj, stopLossPct: obj['stopLossMaxUnrealizedLossPct'] };
      }
    }
    return input;
  },
  z.object({
    maxPositionSizePct: z.number().min(0).max(100).optional(),
    maxPositionSize: z.string().optional(),
    maxOpenPositions: z.number().min(1).optional(),
    maxDrawdown: z.string().optional(),
    dailyMaxLossPct: z.number().min(0).max(100).optional(),
    stopLossCooldownMs: z.number().min(0).optional(),
    stopLossPct: z.number().min(0).max(100).optional(),
    /**
     * Per-order notional cap (absolute, as a string — e.g. "1000" for $1,000).
     * Note: This is `z.string()` here, while `RiskPostureSchema.maxOrderNotional`
     * is `z.number()`. Reconciliation of this type mismatch is deferred.
     */
    maxOrderNotional: z.string().optional(),
    /**
     * @deprecated Use tokenSafety.minLiquidityUsd instead.
     * When both are present, tokenSafety.minLiquidityUsd takes precedence.
     */
    minSwapTokenLiquidityUsd: z.number().min(0).optional(),
    /**
     * @deprecated Use tokenSafety.minVolume24hUsd instead.
     * When both are present, tokenSafety.minVolume24hUsd takes precedence.
     */
    minSwapTokenVolume24hUsd: z.number().min(0).optional(),
    /**
     * @deprecated Use tokenSafety.minAgeHours instead.
     * When both are present, tokenSafety.minAgeHours takes precedence.
     */
    minSwapTokenAgeHours: z.number().min(0).optional(),
    /**
     * @deprecated Use tokenSafety.allowOverrides instead.
     * When both are present, tokenSafety.allowOverrides takes precedence.
     */
    allowSwapTokenSafetyOverride: z.boolean().optional(),
    maxNewPositionsPerDay: z.number().int().min(0).optional(),
    avoidParabolicMovePct: z.number().min(0).optional(),
  }),
);

/**
 * Risk playbook values forwarded from RiskConfigSchema into the strategy snapshot.
 * These are risk/safety guards consumed by MechanicalStrategy (and eventually
 * HybridStrategy) during evaluate(). The TradingActor must populate this on every
 * snapshot; if absent, the checks silently pass — which is correct when the user
 * did not configure those guards, but is a bug if the actor forgot to populate.
 */
export const RiskPlaybookSchema = z.object({
  maxNewPositionsPerDay: z.number().int().min(0).optional(),
  avoidParabolicMovePct: z.number().min(0).optional(),
}).default({});

export type RiskPlaybook = z.infer<typeof RiskPlaybookSchema>;

export const LlmParamsSchema = z.object({
  provider: z.string(),
  model: z.string(),
  promptVersion: z.string().optional(),
  maxTokens: z.number().int().min(1).default(1024),
  timeoutMs: z.number().min(1000).default(30_000),
  instrumentId: z.string().optional(),
  positionSize: z.string().default('1'),
  baseUrl: z.string().url().optional(),
});

// --- Indicator sub-schemas (Phase 0 — shared by TechnicalConfig and MechanicalParams) ---

/**
 * Regime filter params (mirrors RegimeParams from @herobids/market-data).
 * Defined here so domain has no dependency on market-data.
 */
export const RegimeParamsSchema = z.object({
  benchmarkSymbol: z.string().optional(),
  emaFast: z.number().int().positive().optional(),
  emaSlow: z.number().int().positive().optional(),
  emaTrend: z.number().int().positive().optional(),
  adxMin: z.number().min(0).optional(),
  emaAlignment: z.enum(['bullish', 'bearish', 'any']).optional(),
  marketStructure: z.enum(['higherHighs', 'lowerHighs', 'any']).optional(),
  priceAboveVwap: z.boolean().optional(),
  disableWhenChoppy: z.boolean().optional(),
});

export const RsiParamsSchema = z.object({
  enabled: z.boolean().default(true),
  period: z.number().int().min(2).default(14),
  healthyMin: z.number().default(40),
  healthyMax: z.number().default(70),
  overbought: z.number().default(80),
  weakBelow: z.number().default(30),
}).default({});

export const MacdParamsSchema = z.object({
  enabled: z.boolean().default(true),
  fast: z.number().int().default(12),
  slow: z.number().int().default(26),
  signal: z.number().int().default(9),
}).default({});

export const VolumeParamsSchema = z.object({
  enabled: z.boolean().default(true),
  strongRatio: z.number().default(1.5),
  weakRatio: z.number().default(0.5),
  recentBars: z.number().int().default(4),
  avgBars: z.number().int().default(20),
}).default({});

export const ChochParamsSchema = z.object({
  enabled: z.boolean().default(false),
  swingLookback: z.number().int().default(5),
  minSwingPct: z.number().default(0.01),
  minSwings: z.number().int().default(4),
  confirmBars: z.number().int().default(2),
  rejectOnBearish: z.boolean().default(false),
}).default({});

export const SupportResistanceParamsSchema = z.object({
  enabled: z.boolean().default(false),
  lookback: z.number().int().default(50),
  breakoutThreshold: z.number().default(0.005),
}).default({});

export const VwapParamsSchema = z.object({
  enabled: z.boolean().default(false),
  period: z.number().int().min(2).default(24),
}).default({});

export const PriceActionParamsSchema = z.object({
  enabled: z.boolean().default(true),
  minChange24hPct: z.number().default(3),
  maxChange24hPct: z.number().default(50),
}).default({});

export const ConfidenceWeightsSchema = z.object({
  rsiWeight: z.number().default(0.15),
  macdCrossoverWeight: z.number().default(0.20),
  macdIncreasingWeight: z.number().default(0.10),
  volumeWeight: z.number().default(0.15),
  breakoutWeight: z.number().default(0.15),
  chochBullishWeight: z.number().default(0.15),
  chochBearishPenalty: z.number().default(0.10),
  priceActionWeight: z.number().default(0.10),
  vwapWeight: z.number().default(0),
  minConfidence: z.number().default(0.45),
  minReasons: z.number().int().default(2),
}).default({});

export const IndicatorConfigSchema = z.object({
  rsi: RsiParamsSchema,
  macd: MacdParamsSchema,
  volume: VolumeParamsSchema,
  choch: ChochParamsSchema,
  supportResistance: SupportResistanceParamsSchema,
  vwap: VwapParamsSchema,
  priceAction: PriceActionParamsSchema,
  confidence: ConfidenceWeightsSchema,
});

export const SentimentConfigSchema = z.object({
  enabled: z.boolean().default(false),
  minDataPoints: z.number().int().min(1).default(5),
  positiveThreshold: z.number().min(0).max(1).default(0.2),
  negativeThreshold: z.number().min(-1).max(0).default(-0.2),
  maxBoost: z.number().min(0).max(0.5).default(0.1),
}).default({});

export const MechanicalParamsSchema = z.object({
  // Candle fetching
  candleInterval: z.enum(['5m', '15m', '1h', '4h', '1d']).default('15m'),
  candleLimit: z.number().int().min(20).max(500).default(48),
  minCandleCount: z.number().int().min(5).default(20),

  // Exit targets (strategy-level, not risk guards)
  stopLossPct: z.number().min(0).max(100),
  takeProfitPct: z.number().min(0),
  trailingStopPct: z.number().min(0).max(100).nullable().default(null),

  // Indicator suite
  indicators: IndicatorConfigSchema.default({}),

  // Signal interpretation
  signalBias: z.enum(['trend-following', 'mean-reverting']).default('trend-following'),

  // Sentiment
  sentiment: SentimentConfigSchema,

  // Position sizing
  positionSize: z.string().min(1),
  positionSizeMode: z.enum(['fixed', 'percent_equity']).default('fixed'),
});

export const HybridParamsSchema = z.object({
  mechanical: MechanicalParamsSchema,
  // Minimal LLM config — provider + dual-model selection (lightModel for signal, heavyModel for conviction)
  provider: z.string().optional(),
  lightModel: z.string().optional(),
  heavyModel: z.string().optional(),
  maxTokens: z.number().int().min(1).default(1024),
  timeoutMs: z.number().min(1000).default(30_000),
  baseUrl: z.string().url().optional(),
}).refine(
  (d) => (d.lightModel == null && d.heavyModel == null) || d.provider != null,
  { message: 'provider is required when lightModel or heavyModel is set', path: ['provider'] },
);

// Ensure strategy param validation is active in production imports.
initStrategyRegistry({
  mechanical: MechanicalParamsSchema,
  hybrid: HybridParamsSchema,
  llm: LlmParamsSchema,
  empty: z.object({}).strict(),
});

/**
 * Strategy schema — splits trading style (type) from decision engine (decisionMode).
 * - type: what market logic (momentum, range, contrarian, swing, scalper, dca)
 * - decisionMode: how decisions are made (mechanical, llm, hybrid)
 * - params: tuning parameters for the trading style (indicator thresholds, LLM config, etc.)
 *
 * decisionMode is optional for DCA (timer-driven, no signal evaluation) and
 * required for all other types.
 */
/**
 * Derive the strategyPreset display label from a strategy.type value.
 * strategyPreset is a UI/display concept only — never stored in config JSONB.
 *
 * Mapped types return their display label (currently identity — momentum → 'momentum').
 * Unmapped types fall through to the raw type string as a pass-through display label.
 * The pass-through is intentional: new trading styles added to the type enum
 * do not require a PRESET_MAP update before they appear in UI lists.
 */
export function deriveStrategyPreset(strategyType: string | undefined): string | null {
  if (!strategyType) return null;
  const PRESET_MAP: Record<string, string> = {
    momentum: 'momentum',
    mechanical: 'mechanical',
  };
  return PRESET_MAP[strategyType] ?? strategyType;
}

/**
 * Safely extract the strategy sub-object from a bot config (JSONB rows, agent payloads, etc.).
 * Returns { type, decisionMode, params } when config has a valid strategy block, or null.
 *
 * Prefer this helper over inline `as Record<string, unknown>` casts which silently
 * suppress type errors that the StrategySchema is meant to catch.
 */
export function extractStrategyFromConfig(
  config: unknown,
): { type: string; decisionMode?: string; params?: Record<string, unknown> } | null {
  if (config == null || typeof config !== 'object') return null;
  const c = config as Record<string, unknown>;
  const strategy = c['strategy'];
  if (strategy == null || typeof strategy !== 'object') return null;
  const s = strategy as Record<string, unknown>;
  if (typeof s['type'] !== 'string') return null;
  return {
    type: s['type'] as string,
    decisionMode: typeof s['decisionMode'] === 'string' ? s['decisionMode'] as string : undefined,
    params: s['params'] != null && typeof s['params'] === 'object' ? s['params'] as Record<string, unknown> : undefined,
  };
}

export const StrategySchema = z.object({
  type: z.enum(['momentum', 'range', 'contrarian', 'swing', 'scalper', 'dca']),
  decisionMode: z.enum(['mechanical', 'llm', 'hybrid']).optional(),
  params: z.record(z.unknown()).optional(),
}).refine(
  (s) => s.type === 'dca' || s.decisionMode !== undefined,
  { message: 'decisionMode is required for non-DCA strategies', path: ['decisionMode'] },
);

/**
 * Execution defaults — canonicalized from the agent executionMode / maxSlippageBps.
 * Shared by both bots and agents. This is the canonical name;
 * {@link ExecutionConfigSchema} is a deprecated alias.
 */
export const ExecutionDefaultsSchema = z.object({
  mode: z.enum(['paper', 'shadow', 'live']).default('paper'),
  slippageBps: z.number().min(0).nullable().optional(),
});
export type ExecutionDefaults = z.infer<typeof ExecutionDefaultsSchema>;

/** @deprecated Use {@link ExecutionDefaultsSchema} (canonical name) instead. Alias retained for backward compat. */
export const ExecutionConfigSchema = ExecutionDefaultsSchema;

// ── Shared domain value objects (agent + bot vocabulary) ──────────────────────

/**
 * Strategy identity — canonicalized from {@link StrategySchema}.
 * Required for bots; optional/absent for non-trading agents.
 *
 * Validates params through the {@link StrategyParameterRegistry} when a registry
 * entry exists for the (type, decisionMode) combination. Falls back to the base
 * schema's permissive `z.record(z.unknown())` when no registry entry is found
 * (e.g. for strategy types not yet registered).
 */
export const StrategyIdentitySchema = StrategySchema.superRefine((data, ctx) => {
  const entry = getStrategyParameters(data.type, data.decisionMode);
  if (!entry) return; // No registry entry — let the base schema handle it

  try {
    validateStrategyParams(data.type, data.decisionMode, data.params);
  } catch (e) {
    if (e instanceof z.ZodError) {
      for (const issue of e.issues) {
        ctx.addIssue({ ...issue, path: ['params', ...issue.path] });
      }
    } else if (e instanceof Error && e.message.startsWith('Unsupported strategy')) {
      // Unsupported type/decisionMode — let the base schema handle it
    } else {
      throw e;
    }
  }
});
export type StrategyIdentity = z.infer<typeof StrategyIdentitySchema>;

/**
 * Risk posture — the canonical nullable value shape shared by agents and bots.
 * Every field is optional/nullable: null or absent means "use operator default".
 * Token-safety guards (liquidity, volume, age, override) belong in TokenSafety,
 * not here.
 */
export const RiskPostureSchema = z.object({
  /** Max position size as % of equity (0–100). Agent-mutable when not creator-configured. */
  maxPositionSizePct: z.number().min(0).max(100).optional().nullable(),
  /** Max number of open (non-flat) positions. Agent-mutable when not creator-configured. */
  maxOpenPositions: z.number().min(1).optional().nullable(),
  /** Stop-loss unrealized-loss guard as % of equity (0–100). 0 = disabled. Agent-mutable when not creator-configured. */
  stopLossPct: z.number().min(0).max(100).optional().nullable(),
  /** Cooldown in ms before re-entering an instrument after a stop-loss exit. 0 = disabled. Agent-mutable when not creator-configured. */
  stopLossCooldownMs: z.number().min(0).optional().nullable(),
  /** Daily realized-loss cap as % of equity (0–100). Creator-only — not agent-mutable. */
  dailyMaxLossPct: z.number().min(0).max(100).optional().nullable(),
  /** Peak-to-current equity drawdown cap as % of peak equity (0–100). Agent-mutable when not creator-configured. */
  maxDrawdownPct: z.number().min(0).max(100).optional().nullable(),
  /** Max new positions allowed per calendar day (0 = unlimited). Shared — promoted from bot-only. */
  maxNewPositionsPerDay: z.number().int().min(0).optional().nullable(),
  /** Parabolic-move guard: skip entry when 24h change exceeds this % (0 = disabled). */
  avoidParabolicMovePct: z.number().min(0).optional().nullable(),
  /** Per-order notional cap in USD (absolute, unavoidable). Creator-only — not agent-mutable. */
  maxOrderNotional: z.number().min(0).optional().nullable(),
});
export type RiskPosture = z.infer<typeof RiskPostureSchema>;

/**
 * Bot risk configuration — composed from canonical {@link RiskPostureSchema} fields.
 * All fields are optional numbers: present means enforce, absent means disabled.
 * Uses `.strict()` to reject unknown/legacy keys.
 * Does NOT include: legacy stopLossMaxUnrealizedLossPct alias, deprecated minSwapToken*
 * fields, allowSwapTokenSafetyOverride, absolute maxPositionSize/maxDrawdown strings.
 */
export const BotRiskSchema = z.object({
  maxPositionSizePct: z.number().min(0).max(100).optional(),
  maxOpenPositions: z.number().int().min(1).optional(),
  stopLossPct: z.number().min(0).max(100).optional(),
  stopLossCooldownMs: z.number().int().min(0).optional(),
  dailyMaxLossPct: z.number().min(0).max(100).optional(),
  maxDrawdownPct: z.number().min(0).max(100).optional(),
  maxNewPositionsPerDay: z.number().int().min(0).optional(),
  avoidParabolicMovePct: z.number().min(0).optional(),
  maxOrderNotional: z.number().min(0).optional(),
}).strict();
export type BotRisk = z.infer<typeof BotRiskSchema>;

export const BotConfigSchema = z.object({
  strategy: StrategySchema,
  risk: BotRiskSchema.default({}),
  execution: ExecutionDefaultsSchema.default({}),
  /** Token-safety guardrails for swap/DEX venues. Prefer this over the deprecated risk.* fields. */
  tokenSafety: TokenSafetySchema.optional(),
  venue: z.string().optional(),
  symbol: z.string(),
  venueType: z.enum(['orderbook', 'swap']).optional(),
  shadowPollIntervalMs: z.number().min(100).default(2000),
  /** Explicit swap asset identifiers — required for swap venues to avoid fragile symbol parsing */
  swapAssets: z.object({
    baseAsset: z.string(),
    quoteAsset: z.string(),
    /** Decimal places for the base asset (e.g. 9 for SOL). Required for raw-unit conversion. */
    baseDecimals: z.number().int().min(0).max(18),
    /** Decimal places for the quote asset (e.g. 6 for USDC). Required for raw-unit conversion. */
    quoteDecimals: z.number().int().min(0).max(18),
  }).optional(),
}).refine(
  (data) => data.venueType !== 'swap' || data.swapAssets !== undefined,
  { message: 'swapAssets is required when venueType is "swap"', path: ['swapAssets'] },
).refine(
  (data) => data.venueType !== 'swap' || data.execution.mode !== 'paper',
  { message: 'Swap venues cannot run in paper mode (no price source). Use shadow mode.', path: ['execution', 'mode'] },
).refine(
  (data) => {
    if (!data.venue || !data.venueType) return true; // venue/venueType are stamped by the broker
    // Enforce venue string matches venueType to prevent config/adapter mismatch
    if (data.venueType === 'swap') return (SWAP_VENUES as readonly string[]).includes(data.venue);
    return (ORDERBOOK_VENUES as readonly string[]).includes(data.venue);
  },
  { message: 'venue must match venueType: swap venues are [jupiter, 1inch], orderbook venues are [hyperliquid, bybit]', path: ['venue'] },
);

export type BotConfig = z.infer<typeof BotConfigSchema>;
/**
 * RiskConfig — the TypeScript type inferred from {@link RiskConfigSchema}.
 * Note: This type no longer includes the legacy `stopLossMaxUnrealizedLossPct`
 * field. Input data with that field is normalized to `stopLossPct` by the
 * schema's preprocess step.
 */
export type RiskConfig = z.infer<typeof RiskConfigSchema>;
export type StrategyConfig = z.infer<typeof StrategySchema>;
export type LlmParams = z.infer<typeof LlmParamsSchema>;
export type MechanicalParams = z.infer<typeof MechanicalParamsSchema>;
export type HybridParams = z.infer<typeof HybridParamsSchema>;

// --- Agent Technical Config (automation-agents Phase 3) ---

export const TechnicalConfigSchema = z.object({
  filters: z.object({
    venue: z.string(),
    venueType: z.enum(['orderbook', 'swap']),
    minVolume24hUsd: z.number().min(0).optional(),
    minLiquidityUsd: z.number().min(0).optional(),
    networks: z.array(z.string()).optional(),
    symbols: z.array(z.string()).optional(),
    excludeSymbols: z.array(z.string()).optional(),
    /** Canonical quote asset symbol for swap scanning (e.g. USDC, USDT).
     *  Defaults to 'USDC'. Must be a key in the operator-owned
     *  marketData.tokenSafety.canonicalTokens[network] map.
     *  Agent instance config (runtime, DB) — not operator config. */
    quoteAssetSymbol: z.string().optional().default('USDC'),
  }),
  regime: RegimeParamsSchema.optional(),
  indicators: IndicatorConfigSchema.default({}),
  candles: z.object({
    interval: z.enum(['5m', '15m', '1h', '4h', '1d']).default('15m'),
    limit: z.number().int().min(20).max(500).default(100),
  }).default({}),
  signalBias: z.enum(['trend-following', 'mean-reverting']).default('trend-following'),
  scanIntervalMs: z.number().int().min(10_000).default(60_000),
  scanBatchSize: z.number().int().min(1).max(50).default(5),
  autonomousExit: z.boolean().default(false),
});

/**
 * Strict variant of TechnicalConfigSchema used for worker startup validation
 * of persisted scanner-gated agent configuration. Removes ALL .default() calls
 * so that missing required fields are rejected rather than silently repaired.
 *
 * Inner defaults (candles.interval, candles.limit, indicator sub-fields) are
 * retained — the strict check only requires the parent objects to be present.
 *
 * Phase 1 (scanner-gated hardening): applied at worker startup for
 * scanner_gated hybrid agents before the scan loop is created.
 */
export const StrictTechnicalConfigSchema = z.object({
  filters: z.object({
    venue: z.string(),
    venueType: z.enum(['orderbook', 'swap']),
    minVolume24hUsd: z.number().min(0).optional(),
    minLiquidityUsd: z.number().min(0).optional(),
    networks: z.array(z.string()).optional(),
    symbols: z.array(z.string()).optional(),
    excludeSymbols: z.array(z.string()).optional(),
    quoteAssetSymbol: z.string().optional().default('USDC'),
  }),
  regime: RegimeParamsSchema.optional(),
  indicators: IndicatorConfigSchema,
  candles: z.object({
    interval: z.enum(['5m', '15m', '1h', '4h', '1d']).default('15m'),
    limit: z.number().int().min(20).max(500).default(100),
  }),
  signalBias: z.enum(['trend-following', 'mean-reverting']),
  scanIntervalMs: z.number().int().min(10_000),
  scanBatchSize: z.number().int().min(1).max(50),
  autonomousExit: z.boolean(),
});

export const IntelligenceConfigSchema = z.object({
  provider: z.string().optional(),
  lightModel: z.string().optional(),
  heavyModel: z.string().optional(),
  maxTokens: z.number().int().min(1).optional(),
  wakeIntervalMs: z.number().int().min(10_000).optional(),
});

// ── Platform Preset Assessment (002) ────────────────────────────────────────

export const AllowedPresetsPolicySchema = z.object({
  /** Preset keys the agent is allowed to use. Empty or absent = all presets in style tier. */
  allowed: z.array(z.string()).optional(),
  /** Style tier this agent is locked to. Defaults to the agent's style tier. */
  styleTier: z.enum(['economy', 'standard', 'premium']).optional(),
  /** When true, the agent can only use presets from its own style tier. */
  restrictToStyleTier: z.boolean().default(true),
});

export const PresetTransitionPolicySchema = z.object({
  /** Maximum preset switches per day. */
  maxSwitchesPerDay: z.number().int().min(1).max(50).default(5),
  /** Minimum time between switches in milliseconds. */
  minDwellTimeMs: z.number().int().min(600_000).default(3_600_000), // 1 hour, 10 min floor to prevent preset thrashing
  /** When true, switches with open positions require explicit transition action. */
  requireExplicitTransitionWithOpenPositions: z.boolean().default(true),
  /** Allowed transition modes for this agent.
   * `entries_and_full_transition` is gated for later rollout per D12. */
  allowedTransitionModes: z.array(
    z.enum(['entries_only', 'entries_and_tighten_existing'])
  ).default(['entries_only', 'entries_and_tighten_existing']),
  /** When true, the agent may defer or reject platform recommendations. */
  allowRejectPlatformRecommendations: z.boolean().default(true),
});

export const PlatformAssessmentOptInSchema = z.object({
  /** When true, this agent participates in shared platform assessment. */
  enabled: z.boolean().default(false),
  /** Minimum confidence threshold for this agent to consider a recommendation. */
  minConfidenceThreshold: z.number().min(0).max(1).optional(),
  /** Minimum score uplift threshold for this agent to consider a recommendation. */
  minScoreUpliftThreshold: z.number().min(0).max(100).optional(),
  /** Review interval in ms. Must be >= operator minReviewIntervalMs. Default resolved from operator config (24h). */
  reviewIntervalMs: z.number().int().positive().optional(),
});

// ── Hybrid mode split (004) ─────────────────────────────────────────────────

export const CapabilityModeSchema = z.enum(['intelligence', 'hybrid']);
export const HybridModeSchema = z.enum(['mixed', 'scanner_gated']);

export const AuthorizationModeSchema = z.enum(['direct', 'approval_required']);
export type AuthorizationMode = z.infer<typeof AuthorizationModeSchema>;

export const UnifiedAgentConfigSchema = z.object({
  technical: TechnicalConfigSchema.optional(),
  intelligence: IntelligenceConfigSchema.optional(),
  capabilityMode: CapabilityModeSchema.default('intelligence'),
  // hybridMode is intentionally .optional() — NOT .default('mixed').
  // Zod applies .default() before .superRefine(), so a .default('mixed')
  // would inject hybridMode onto every intelligence agent, causing the
  // cross-field validation below to reject all intelligence agents.
  // The 'mixed' default is instead applied at the repository layer
  // (packages/db/src/agent-repository.ts) and API layer (apps/api).
  hybridMode: HybridModeSchema.optional(),
  execution: z.object({
    mode: z.enum(['paper', 'shadow', 'live']).optional(),
    positionSizeMode: z.enum(['fixed', 'percent_equity']).optional(),
    fixedPositionSize: z.string().optional(),
  }).optional(),
  risk: z.object({
    maxPositions: z.number().int().min(1).optional(),
    maxPositionSizePct: z.number().min(0).max(100).optional(),
    dailyMaxLossPct: z.number().min(0).max(100).optional(),
    stopLossPct: z.number().min(0).optional(),
    takeProfitPct: z.number().min(0).optional(),
  }).optional(),
  // 002: Platform Preset Assessment
  allowedPresets: AllowedPresetsPolicySchema.optional(),
  presetTransition: PresetTransitionPolicySchema.optional(),
  platformAssessment: PlatformAssessmentOptInSchema.optional(),
  authorizationMode: AuthorizationModeSchema.default('direct'),
}).superRefine((data, ctx) => {
  // 004: capabilityMode='hybrid' requires technical config (the scanner)
  if (data.capabilityMode === 'hybrid' && !data.technical) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '"technical" config is required when capabilityMode is "hybrid"',
      path: ['capabilityMode'],
    });
  }

  // 004: capabilityMode='intelligence' must not set hybridMode
  if (data.capabilityMode === 'intelligence' && data.hybridMode !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '"hybridMode" must not be set when capabilityMode is "intelligence"',
      path: ['hybridMode'],
    });
  }
});

export type IntelligenceConfig = z.infer<typeof IntelligenceConfigSchema>;
export type RegimeParams = z.infer<typeof RegimeParamsSchema>;
export type RsiParams = z.infer<typeof RsiParamsSchema>;
export type MacdParams = z.infer<typeof MacdParamsSchema>;
export type VolumeParams = z.infer<typeof VolumeParamsSchema>;
export type ChochParams = z.infer<typeof ChochParamsSchema>;
export type SupportResistanceParams = z.infer<typeof SupportResistanceParamsSchema>;
export type ConfidenceWeights = z.infer<typeof ConfidenceWeightsSchema>;
export type IndicatorConfig = z.infer<typeof IndicatorConfigSchema>;
export type VwapParams = z.infer<typeof VwapParamsSchema>;
export type PriceActionParams = z.infer<typeof PriceActionParamsSchema>;
export type SentimentConfig = z.infer<typeof SentimentConfigSchema>;
export type TechnicalConfig = z.infer<typeof TechnicalConfigSchema>;
export type UnifiedAgentConfig = z.infer<typeof UnifiedAgentConfigSchema>;
export type CapabilityMode = z.infer<typeof CapabilityModeSchema>;
export type HybridMode = z.infer<typeof HybridModeSchema>;
export type AllowedPresetsPolicy = z.infer<typeof AllowedPresetsPolicySchema>;
export type PresetTransitionPolicy = z.infer<typeof PresetTransitionPolicySchema>;
export type PlatformAssessmentOptIn = z.infer<typeof PlatformAssessmentOptInSchema>;


// ── Wake Gate Config (deferred infra — type only) ──────────────────────────

/**
 * Configuration for the wake gate that decides whether a market assessment
 * should trigger a preset-review wake for an agent.
 *
 * NOTE: The full Zod schema (`WakeGateConfigSchema`) is deferred until the
 * scheduled wake path is implemented. Only the type is defined here so that
 * the engine's `wake-gate.ts` can compile.
 */
export interface WakeGateConfig {
  minIntervalBetweenWakesMs: number;
  maxWakesPerAgentPerDay: number;
  minScoreUplift: number;
  minConfidence: number;
  openPositionUpliftMultiplier: number;
  requireConsecutiveConfirmation: boolean;
  consecutiveConfirmationCount: number;
  minCurrentPresetScore: number;
  minScoreFloorForUpliftCalc: number;
}

/**
 * Validates that an agent's reviewIntervalMs meets the operator's minimum floor.
 * Returns err('config.review_interval_below_operator_floor') if violated.
 */
export function validateReviewInterval(
  reviewIntervalMs: number | undefined,
  operatorMinReviewIntervalMs: number,
): Result<void> {
  if (reviewIntervalMs !== undefined && reviewIntervalMs < operatorMinReviewIntervalMs) {
    return err({
      code: 'config.review_interval_below_operator_floor',
      message: `reviewIntervalMs (${reviewIntervalMs}ms) is below operator minimum (${operatorMinReviewIntervalMs}ms)`,
    });
  }
  return ok(undefined);
}
