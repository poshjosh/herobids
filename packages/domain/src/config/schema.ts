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
  /** Master switch — set true once a provider is configured */
  enabled: z.boolean().default(false),
  /** Primary payment provider */
  primaryProvider: BillingProviderSchema.default('creem'),
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
  billing: BillingConfigSchema.default({}),
}).superRefine((data, ctx) => {
  if (!(data.plans.defaultPlanId in data.plans.plans)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `plans.defaultPlanId '${data.plans.defaultPlanId}' does not exist in the plans map — check config`,
      path: ['plans', 'defaultPlanId'],
    });
  }
  // If billing is enabled, validate provider credentials and plan mappings
  if (data.billing.enabled) {
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
export type BacktestingConfig = z.infer<typeof BacktestingConfigSchema>;
export type MarketDataRecordingConfig = z.infer<typeof MarketDataRecordingConfigSchema>;
export type LlmValidationConfig = z.infer<typeof LlmValidationConfigSchema>;
export type LiveRolloutConfig = z.infer<typeof LiveRolloutConfigSchema>;
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
    const swapVenues = ['jupiter', '1inch'];
    const orderbookVenues = ['hyperliquid', 'bybit'];
    if (data.venueType === 'swap') return swapVenues.includes(data.venue);
    return orderbookVenues.includes(data.venue);
  },
  { message: 'venue must match venueType: swap venues are [jupiter, 1inch], orderbook venues are [hyperliquid, bybit]', path: ['venue'] },
);

export type BotConfig = z.infer<typeof BotConfigSchema>;
/** @deprecated Use BotConfigSchema */
export const TradingInstanceConfigSchema = BotConfigSchema;
/** @deprecated Use BotConfig */
export type TradingInstanceConfig = BotConfig;
export type RiskConfig = z.infer<typeof RiskConfigSchema>;
export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;
export type MomentumParams = z.infer<typeof MomentumParamsSchema>;
export type LlmParams = z.infer<typeof LlmParamsSchema>;
