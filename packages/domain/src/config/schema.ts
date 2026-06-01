import { z } from 'zod';

// Supported venues for live rollout
export const SUPPORTED_LIVE_VENUES = ['hyperliquid', 'bybit'] as const;
export type SupportedLiveVenue = typeof SUPPORTED_LIVE_VENUES[number];

// --- Operator Config (loaded from YAML + env at startup) ---

export const VenueConfigSchema = z.object({
  baseUrl: z.string().url(),
  wsUrl: z.string().url().optional(),
  wsPublicUrl: z.string().url().optional(),
  rpcUrl: z.string().url().optional(),
  chainId: z.number().int().positive().optional(),
  rateLimitPerSec: z.number().min(1).default(10),
  timeoutMs: z.number().min(1000).default(30_000),
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
  instrumentToCoinId: z.record(z.string(), z.string()).optional(),
});

export const BacktestingConfigSchema = z.object({
  warmupLookbackBars: z.number().int().min(1).default(200),
  maxDataGapMs: z.number().min(1).default(60_000),
  persistJournal: z.boolean().default(true),
});

export const MarketDataRecordingConfigSchema = z.object({
  enabled: z.boolean().default(false),
  captureTrades: z.boolean().default(true),
  captureTopOfBook: z.boolean().default(true),
  captureCandles: z.boolean().default(true),
});

export const LlmValidationConfigSchema = z.object({
  requirePinnedModel: z.boolean().default(true),
  minReplayContexts: z.number().int().min(1).default(100),
  maxDecisionDivergencePct: z.number().min(0).max(100).default(20),
  maxPnlRegressionPct: z.number().min(0).max(100).default(10),
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
});

export const AuthConfigSchema = z.object({
  /** Public-facing base URL (used for OAuth callback construction) */
  publicBaseUrl: z.string().url().default('http://localhost:3000'),
  /** JWT signing secret — override: AUTH_JWT_SECRET */
  jwtSecret: z.string().min(32).default('change-me-in-production-this-is-32-chars!!'),
  /** JWT token TTL in seconds */
  jwtTtlSecs: z.number().min(60).default(86_400),
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
    liveEnabled: z.boolean().default(false),
  })).default({
    free: {
      maxPortfolios: 3,
      maxVenueAccounts: 5,
      maxCredentials: 5,
      maxTradingInstances: 5,
      maxConcurrentBacktests: 3,
      liveEnabled: false,
    },
  }),
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

export const AppConfigSchema = z.object({
  app: z.object({
    port: z.number().default(3000),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  }),
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
  llmValidation: LlmValidationConfigSchema.default({}),
  liveRollout: LiveRolloutConfigSchema.default({}),
  alerts: AlertsConfigSchema.default({}),
  auth: AuthConfigSchema.default({}),
  plans: PlansConfigSchema.default({}),
}).superRefine((data, ctx) => {
  if (!(data.plans.defaultPlanId in data.plans.plans)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `plans.defaultPlanId '${data.plans.defaultPlanId}' does not exist in the plans map — check config`,
      path: ['plans', 'defaultPlanId'],
    });
  }
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type BacktestingConfig = z.infer<typeof BacktestingConfigSchema>;
export type MarketDataRecordingConfig = z.infer<typeof MarketDataRecordingConfigSchema>;
export type LlmValidationConfig = z.infer<typeof LlmValidationConfigSchema>;
export type LiveRolloutConfig = z.infer<typeof LiveRolloutConfigSchema>;
export type AlertsConfig = z.infer<typeof AlertsConfigSchema>;
export type AuthConfig = z.infer<typeof AuthConfigSchema>;
export type PlansConfig = z.infer<typeof PlansConfigSchema>;
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

export const TradingInstanceConfigSchema = z.object({
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
    const swapVenues = ['jupiter', '1inch'];
    const orderbookVenues = ['hyperliquid', 'bybit'];
    if (data.venueType === 'swap') return swapVenues.includes(data.venue);
    return orderbookVenues.includes(data.venue);
  },
  { message: 'venue must match venueType: swap venues are [jupiter, 1inch], orderbook venues are [hyperliquid, bybit]', path: ['venue'] },
);

export type TradingInstanceConfig = z.infer<typeof TradingInstanceConfigSchema>;
export type RiskConfig = z.infer<typeof RiskConfigSchema>;
export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;
export type MomentumParams = z.infer<typeof MomentumParamsSchema>;
export type LlmParams = z.infer<typeof LlmParamsSchema>;
