import { z } from 'zod';

// Supported venues for live rollout
export const SUPPORTED_LIVE_VENUES = ['hyperliquid', 'bybit'] as const;
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
  rpcUrl: z.string().url().optional(),
  chainId: z.number().int().positive().optional(),
  tokenSafetyNetwork: TokenSafetyNetworkSchema.optional(),
  rateLimitPerSec: z.number().min(1).default(10),
  timeoutMs: z.number().min(1000).default(30_000),
  confirmationTimeoutMs: z.number().min(1000).default(60_000),
  routerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Must be a valid EVM address (0x + 40 hex chars)').optional(),
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
  instrumentToCoinId: z.record(z.string(), z.string()).optional(),
});

export const BacktestingConfigSchema = z.object({
  warmupLookbackBars: z.number().int().min(1).default(200),
  maxDataGapMs: z.number().min(1).default(60_000),
  persistJournal: z.boolean().default(true),
  concurrency: z.number().int().min(1).default(2),
});

export const MarketDataRecordingConfigSchema = z.object({
  enabled: z.boolean().default(false),
  captureTrades: z.boolean().default(true),
  captureTopOfBook: z.boolean().default(true),
  captureCandles: z.boolean().default(true),
});

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
  defaultModels: z.object({
    anthropic: z.string().default('claude-3-5-haiku-latest'),
    openai: z.string().default('gpt-4.1-mini'),
    openrouter: z.string().default('openai/gpt-4.1-mini'),
  }).default({}),
  /** Max ms the scout can hold without escalating before a forced escalation. Unset = no limit. */
  maxHoldDurationMs: z.number().int().min(0).optional(),
});

export const LlmThinkingConfigSchema = z.object({
  lightBudgetTokens: z.number().int().min(0).default(2_048),
  deepBudgetTokens: z.number().int().min(0).default(10_240),
});

export const LlmCatalogConfigSchema = z.object({
  /** Short fetch timeout for catalog discovery — independent of llm.timeoutMs which is tuned for generation */
  timeoutMs: z.number().min(100).default(3_000),
  /** In-memory cache TTL for discovered catalogs (ms). Stale entries are retained as fallback; not deleted on expiry. */
  cacheTtlMs: z.number().min(1000).default(86_400_000),
  /** Pricing-locality policy for self-hosted providers: auto = strict local-host heuristic, local = always local, remote = never local. */
  locality: z.enum(['auto', 'local', 'remote']).default('auto'),
});

export const LlmRuntimeConfigSchema = z.object({
  provider: z.string().default('openrouter'),
  model: z.string().default('anthropic/claude-sonnet-4-5'),
  /** Base URL override — leave unset to use provider default (e.g. set to http://host.docker.internal:11434/v1 for Ollama) */
  baseUrl: z.string().optional(),
  maxTokens: z.number().int().min(1).default(4096),
  timeoutMs: z.number().min(1000).default(60_000),
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
    /** Telegram channel routing rules */
    channels: z.array(TelegramChannelConfigSchema).default([]),
  }).default({}),
  email: z.object({
    /** Resend API key — override: RESEND_API_KEY */
    apiKey: z.string().default(''),
    /** Sender email address (must be verified in Resend) */
    fromEmail: z.string().default(''),
    /** Optional reply-to address */
    replyToEmail: z.string().optional(),
    /** Request timeout in ms */
    timeoutMs: z.number().int().min(1000).default(10_000),
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
});

export const PlansConfigSchema = z.object({
  /** Default plan applied to new users */
  defaultPlanId: z.string().default('free'),
  /** Plan definitions keyed by plan ID */
  plans: z.record(z.string(), z.object({
    maxPortfolios: z.number().min(1).default(3),
    maxVenueAccounts: z.number().min(1).default(5),
    maxCredentials: z.number().min(1).default(5),
    maxTradingInstances: z.number().min(1).default(5),
    maxConcurrentBacktests: z.number().min(1).default(3),
    maxAgents: z.number().min(0).default(5),
    liveEnabled: z.boolean().default(false),
  })).default({
    free: {
      maxPortfolios: 3,
      maxVenueAccounts: 5,
      maxCredentials: 5,
      maxTradingInstances: 5,
      maxConcurrentBacktests: 3,
      maxAgents: 5,
      liveEnabled: false,
    },
  }),
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
  /** URL the browser lands on after successful checkout */
  checkoutSuccessUrl: z.string().url().default('http://localhost:5173/billing?session=success'),
  /** URL the browser lands on if checkout is cancelled */
  checkoutCancelUrl: z.string().url().default('http://localhost:5173/billing?session=cancelled'),
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
    candles: MarketDataBudgetSchema.default({
      requestsPerMinute: 15,
      burstCapacity: 15,
      maxWaitMs: 5_000,
      cacheTtlMs: 60_000,
    }),
    discovery: MarketDataBudgetSchema.default({
      requestsPerMinute: 10,
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
  }).default({}),
  binance: z.object({
    baseUrl: z.string().url().default('https://api.binance.com'),
    requestsPerMinute: z.number().min(1).default(200),
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
  tokenSafety: TokenSafetyConfigSchema.default({}),
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
  }).default({}),
});

export const AgentRuntimeConfigSchema = z.object({
  failureBackoff: z.object({
    backoffThreshold: z.number().int().min(1).default(3),
    maxFailures: z.number().int().min(1).default(5),
    maxIntervalMs: z.number().int().min(1000).default(1_800_000),
  }).default({}),
  toolCircuitBreaker: z.object({
    failureThreshold: z.number().int().min(1).default(3),
    reopenAfterTicks: z.number().int().min(1).default(5),
  }).default({}),
  thinking: z.object({
    drawdownThresholdPct: z.number().min(-100).max(0).default(-2),
  }).default({}),
  contextDiff: z.object({
    fullContextEveryTicks: z.number().int().min(1).default(10),
    maxDiffTokens: z.number().int().min(1).default(200),
    maxChangedLines: z.number().int().min(1).default(12),
  }).default({}),
  defaultBudgets: z.object({
    maxHistoryMessages: z.number().int().min(1),
    maxRecentToolMessages: z.number().int().min(1),
    maxToolResultChars: z.number().int().min(1),
    maxVisibleToolSchemas: z.number().int().min(1),
    maxContextBlockChars: z.number().int().min(1),
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
  tools: z.object({
    codeExecute: z.object({
      defaultTimeoutMs: z.number().int().min(1000).default(60_000),
      defaultMaxOutputBytes: z.number().int().min(1).default(51_200),
    }).default({}),
    webAccess: WebAccessToolsConfigSchema.default({}),
  }).default({}),
});

export const AgentRuntimePolicySchema = AgentRuntimeConfigSchema.extend({
  llm: z.object({
    catalog: LlmCatalogConfigSchema.default({}),
    retry: LlmRetryConfigSchema.default({}),
    scout: LlmScoutConfigSchema.default({}),
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
});

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
  venues: z.record(VenueConfigSchema).default({}),
  execution: z.object({
    defaultSlippageBps: z.number().min(0).default(50),
    orderTimeoutMs: z.number().min(1000).default(30_000),
    maxRetries: z.number().min(0).default(3),
    shadowPollIntervalMs: z.number().int().min(100).default(2_000),
    shadowQuoteSlippageBps: z.number().min(0).default(50),
  }),
  risk: z.object({
    globalMaxDrawdownPct: z.number().min(0).max(100).default(20),
    maxOpenPositions: z.number().min(1).default(10),
    maxPositionSizePct: z.number().min(0).max(100).default(25),
  }),
  reconciliation: ReconciliationConfigSchema.default({}),
  streams: StreamConfigSchema.default({}),
  marking: MarkingConfigSchema.default({}),
  backtesting: BacktestingConfigSchema.default({}),
  marketDataRecording: MarketDataRecordingConfigSchema.default({}),
  marketData: MarketDataConfigSchema.optional(),
  marketIntelligence: MarketIntelligenceConfigSchema.default({}),
  worker: WorkerConfigSchema.default({}),
  agentRuntime: AgentRuntimeConfigSchema,
  llm: LlmRuntimeConfigSchema.default({}),
  llmValidation: LlmValidationConfigSchema.default({}),
  liveRollout: LiveRolloutConfigSchema.default({}),
  alerts: AlertsConfigSchema.default({}),
  auth: AuthConfigSchema.default({}),
  plans: PlansConfigSchema.default({}),
  billing: BillingConfigSchema.default({}),
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
export type AgentRuntimeConfig = z.infer<typeof AgentRuntimeConfigSchema>;
export type AgentRuntimePolicy = z.infer<typeof AgentRuntimePolicySchema>;
export type BacktestingConfig = z.infer<typeof BacktestingConfigSchema>;
export type MarketDataRecordingConfig = z.infer<typeof MarketDataRecordingConfigSchema>;
export type LlmRuntimeConfig = z.infer<typeof LlmRuntimeConfigSchema>;
export type LlmValidationConfig = z.infer<typeof LlmValidationConfigSchema>;
export type LiveRolloutConfig = z.infer<typeof LiveRolloutConfigSchema>;
export type MarketDataConfig = z.infer<typeof MarketDataConfigSchema>;
export type TokenSafetyConfig = z.infer<typeof TokenSafetyConfigSchema>;
export type MarketIntelligenceConfig = z.infer<typeof MarketIntelligenceConfigSchema>;
export type AlertsConfig = z.infer<typeof AlertsConfigSchema>;
export type AuthConfig = z.infer<typeof AuthConfigSchema>;
export type PlansConfig = z.infer<typeof PlansConfigSchema>;
export type BillingConfig = z.infer<typeof BillingConfigSchema>;
export type StripeConfig = z.infer<typeof StripeConfigSchema>;
export type CreemConfig = z.infer<typeof CreemConfigSchema>;
export type TelegramChannelConfig = z.infer<typeof TelegramChannelConfigSchema>;

// --- Trading Instance Config (stored in Postgres JSONB, per-instance) ---

export const RiskConfigSchema = z.object({
  maxPositionSizePct: z.number().min(0).max(100).optional(),
  maxPositionSize: z.string().optional(),
  maxOpenPositions: z.number().min(1).optional(),
  maxDrawdown: z.string().optional(),
  dailyMaxLossPct: z.number().min(0).max(100).optional(),
  stopLossCooldownMs: z.number().min(0).optional(),
  maxOrderNotional: z.string().optional(),
  minSwapTokenLiquidityUsd: z.number().min(0).optional(),
  minSwapTokenVolume24hUsd: z.number().min(0).optional(),
  minSwapTokenAgeHours: z.number().min(0).optional(),
  allowSwapTokenSafetyOverride: z.boolean().optional(),
});

export const MomentumParamsSchema = z.object({
  lookbackPeriod: z.number().int().min(2).default(5),
  threshold: z.number().min(0).default(0.02),
  positionSize: z.string().default('1'),
  instrumentId: z.string().optional(),
});

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

export const StrategyConfigSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('momentum'), params: MomentumParamsSchema.default({}) }),
  z.object({ type: z.literal('llm'), params: LlmParamsSchema }),
]);

export const ExecutionConfigSchema = z.object({
  mode: z.enum(['paper', 'shadow', 'live']).default('paper'),
  slippageBps: z.number().min(0).optional(),
});

export const BotConfigSchema = z.object({
  strategy: StrategyConfigSchema,
  risk: RiskConfigSchema.default({}),
  execution: ExecutionConfigSchema.default({}),
  venue: z.string(),
  symbol: z.string(),
  venueType: z.enum(['orderbook', 'swap']).default('orderbook'),
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
    // Enforce venue string matches venueType to prevent config/adapter mismatch
    if (data.venueType === 'swap') return (SWAP_VENUES as readonly string[]).includes(data.venue);
    return (ORDERBOOK_VENUES as readonly string[]).includes(data.venue);
  },
  { message: 'venue must match venueType: swap venues are [jupiter, 1inch], orderbook venues are [hyperliquid, bybit]', path: ['venue'] },
);

export type BotConfig = z.infer<typeof BotConfigSchema>;
export type RiskConfig = z.infer<typeof RiskConfigSchema>;
export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;
export type MomentumParams = z.infer<typeof MomentumParamsSchema>;
export type LlmParams = z.infer<typeof LlmParamsSchema>;
