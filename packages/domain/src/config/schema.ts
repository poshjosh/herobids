import { z } from 'zod';

// --- Operator Config (loaded from YAML + env at startup) ---

export const VenueConfigSchema = z.object({
  baseUrl: z.string().url(),
  wsUrl: z.string().url().optional(),
  rateLimitPerSec: z.number().min(1).default(10),
  timeoutMs: z.number().min(1000).default(30_000),
});

export const ReconciliationConfigSchema = z.object({
  intervalMs: z.number().min(5000).default(30_000),
  driftAlertOnly: z.boolean().default(true),
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
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

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

export const StrategyConfigSchema = z.object({
  type: z.string(),
  params: z.record(z.unknown()).default({}),
});

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
});

export type TradingInstanceConfig = z.infer<typeof TradingInstanceConfigSchema>;
export type RiskConfig = z.infer<typeof RiskConfigSchema>;
export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;
