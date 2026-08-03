import { z } from 'zod';
import {
  StrategySchema,
} from './config/schema.js';
import {
  TransitionModeSchema,
  MarketAssessmentPresetRankingSchema,
  MarketAssessmentIdentitySchema,
} from './market-assessment.js';

// ── Preset Transition Tool Parameter Schemas ──────────────────────────────

export const ChangeStrategyPresetParamsSchema = z.object({
  assessmentArtifactId: z.string().min(1).describe('Exact assessment artifact ID from assess_strategy_preset. Required for audit trail.'),
  targetPreset: z.string().min(1),
  mode: TransitionModeSchema,
  reason: z.string().optional(),
});

// ── Multi-Instrument Preset Assessment ────────────────────────────────────

export const AssessStrategyPresetParamsSchema = z.object({
  symbols: z.array(z.string().min(1)).min(1).max(50)
    .describe('Trading symbols to assess (e.g. ["BTC", "ETH", "SOL"]). All symbols share the same venueFamily and instrumentKind.'),
  venueFamily: z.string().min(1)
    .describe('Venue family to scope the assessment (e.g. "hyperliquid", "bybit", "jupiter"). Required.'),
  instrumentKind: z.enum(['orderbook', 'perp', 'swap', 'dex']).optional()
    .describe('Instrument kind shared across all requested symbols. Defaults to "orderbook" when omitted.'),
  idempotencyKey: z.string().optional()
    .describe('Client-provided idempotency key. Reuses cached results without new charges.'),
});

export type AssessStrategyPresetParams = z.infer<typeof AssessStrategyPresetParamsSchema>;

// ── Per-Instrument Response Types ─────────────────────────────────────────

export const AssessmentBillingSchema = z.object({
  billed: z.boolean(),
  requestId: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
  source: z.enum(['new_run', 'cache_hit', 'fresh_reuse', 'failed', 'truncated']),
});

export const AssessmentResultEntrySchema = z.object({
  success: z.boolean(),
  symbol: z.string(),
  canonicalIdentity: MarketAssessmentIdentitySchema.optional(),
  assessment: z.object({
    artifactId: z.string(),
    assessedAt: z.string(),
    expiresAt: z.string(),
    marketSummary: z.string().nullable(),
    regimeSummary: z.string().nullable(),
    scanHealthSummary: z.string().nullable(),
    rankings: z.array(MarketAssessmentPresetRankingSchema),
    recommendedPreset: z.string().nullable(),
    allowedPresets: z.array(z.string()),
    freshnessNote: z.string(),
    confidence: z.number(),
    urgency: z.enum(['low', 'medium', 'high']),
  }).optional(),
  transitionReference: z.object({
    assessmentArtifactId: z.string(),
  }).optional(),
  billing: AssessmentBillingSchema.optional(),
  error: z.string().optional(),
  errorCode: z.string().optional(),
});

export const AssessStrategyPresetResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    requestedInstrumentCount: z.number().int().min(0),
    assessedInstrumentCount: z.number().int().min(0),
    maxInstrumentsPerRequest: z.number().int().min(1),
    message: z.string().optional(),
    results: z.array(AssessmentResultEntrySchema),
  }).optional(),
  error: z.string().optional(),
  errorCode: z.string().optional(),
});

export type AssessmentBilling = z.infer<typeof AssessmentBillingSchema>;
export type AssessmentResultEntry = z.infer<typeof AssessmentResultEntrySchema>;
export type AssessStrategyPresetResponse = z.infer<typeof AssessStrategyPresetResponseSchema>;

export type ChangeStrategyPresetParams = z.infer<typeof ChangeStrategyPresetParamsSchema>;

/**
 * Tool Schema Registry — maps dot-path schema names to JSON Schemas with
 * examples and version info. Used by GET /api/v1/tool-schemas and the
 * agent-facing get_schema tool.
 */

export interface SchemaEntry {
  /** JSON Schema Draft 7 */
  schema: Record<string, unknown>;
  /** A minimal valid example payload */
  example: unknown;
  /** Schema version for cache-busting */
  version: string;
  /** Human-readable description */
  description: string;
}

/**
 * Convert a Zod schema to JSON Schema Draft 7, preserving optionality.
 * Uses a simple inlined conversion to avoid the zod-to-json-schema dependency
 * in the domain package (domain has zero deps).
 */
function zodToJsonSchemaSimple(zodSchema: z.ZodType): Record<string, unknown> {
  if (zodSchema instanceof z.ZodObject) {
    const shape = zodSchema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, fieldSchema] of Object.entries(shape)) {
      properties[key] = zodToJsonSchemaSimple(fieldSchema);
      if (!fieldSchema.isOptional()) {
        required.push(key);
      }
    }

    const result: Record<string, unknown> = {
      type: 'object',
      properties,
    };
    if (required.length > 0) {
      result['required'] = required;
    }
    return result;
  }

  if (zodSchema instanceof z.ZodString) {
    const result: Record<string, unknown> = { type: 'string' };
    const def = (zodSchema as unknown as { _def: { checks: Array<{ kind: string; value?: unknown }>; minLength?: { value: number } | null; maxLength?: { value: number } | null } })._def;
    if (def.minLength?.value != null) result['minLength'] = def.minLength.value;
    if (def.maxLength?.value != null) result['maxLength'] = def.maxLength.value;
    return result;
  }

  if (zodSchema instanceof z.ZodNumber) {
    const result: Record<string, unknown> = { type: 'number' };
    const def = (zodSchema as unknown as { _def: { checks: Array<{ kind: string; value?: number }> } })._def;
    for (const check of def.checks) {
      if (check.kind === 'min' && check.value != null) result['minimum'] = check.value;
      if (check.kind === 'max' && check.value != null) result['maximum'] = check.value;
      if (check.kind === 'int') result['type'] = 'integer';
    }
    return result;
  }

  if (zodSchema instanceof z.ZodBoolean) {
    return { type: 'boolean' };
  }

  if (zodSchema instanceof z.ZodEnum) {
    const def = (zodSchema as unknown as { _def: { values: readonly string[] } })._def;
    return { type: 'string', enum: [...def.values] };
  }

  if (zodSchema instanceof z.ZodArray) {
    const def = (zodSchema as unknown as { _def: { type: z.ZodTypeAny } })._def;
    return {
      type: 'array',
      items: zodToJsonSchemaSimple(def.type),
    };
  }

  if (zodSchema instanceof z.ZodRecord) {
    return {
      type: 'object',
      additionalProperties: true,
    };
  }

  if (zodSchema instanceof z.ZodNullable) {
    const innerDef = (zodSchema as unknown as { _def: { innerType: z.ZodTypeAny } })._def;
    const inner = zodToJsonSchemaSimple(innerDef.innerType);
    return { ...inner, nullable: true };
  }

  if (zodSchema instanceof z.ZodOptional) {
    const innerDef = (zodSchema as unknown as { _def: { innerType: z.ZodTypeAny } })._def;
    return zodToJsonSchemaSimple(innerDef.innerType);
  }

  if (zodSchema instanceof z.ZodDefault) {
    const innerDef = (zodSchema as unknown as { _def: { innerType: z.ZodTypeAny; defaultValue: () => unknown } })._def;
    const inner = zodToJsonSchemaSimple(innerDef.innerType);
    return { ...inner, default: innerDef.defaultValue() };
  }

  if (zodSchema instanceof z.ZodLiteral) {
    const def = (zodSchema as unknown as { _def: { value: unknown } })._def;
    return { const: def.value };
  }

  if (zodSchema instanceof z.ZodEffects || zodSchema instanceof z.ZodPipeline) {
    // Unwrap effects/pipelines to inner type
    try {
      const innerDef = (zodSchema as unknown as { _def: { schema?: z.ZodTypeAny; in?: z.ZodTypeAny } })._def;
      const inner = innerDef.schema ?? innerDef.in;
      if (inner) return zodToJsonSchemaSimple(inner);
    } catch {
      // fall through
    }
  }

  if (zodSchema instanceof z.ZodUnion || zodSchema instanceof z.ZodDiscriminatedUnion) {
    try {
      const options = (zodSchema as unknown as { _def: { options: Map<string, z.ZodTypeAny> | z.ZodTypeAny[] } })._def.options;
      const optionList = options instanceof Map ? Array.from(options.values()) : options;
      return {
        anyOf: optionList.map((opt: z.ZodTypeAny) => zodToJsonSchemaSimple(opt)),
      };
    } catch {
      // fall through
    }
  }

  // Fallback for unknown types
  return {};
}

// Registry of named schemas — lazy-initialized to avoid ESM ordering issues
// where imported Zod schemas (e.g. StrategySchema) may not be initialized yet
// at module evaluation time in certain deployment layouts (pnpm deploy --prod).
let _schemaRegistry: Record<string, SchemaEntry> | null = null;

function buildSchemaRegistry(): Record<string, SchemaEntry> {
  return {
  'create_bot.config.strategy': {
    schema: zodToJsonSchemaSimple(StrategySchema),
    example: {
      type: 'momentum',
      decisionMode: 'mechanical',
      params: {
        lookbackPeriod: 14,
        signalThreshold: 0.6,
      },
    },
    version: '1.0.0',
    description: 'Bot strategy configuration. type selects the trading style (momentum/range/contrarian/swing/scalper/dca). decisionMode selects the decision engine (mechanical/llm/hybrid). params are strategy-specific tuning parameters.',
  },

  'create_bot.config.strategy.params': {
    schema: {
      type: 'object',
      description: 'Strategy-specific parameters. The shape depends on the strategy type.',
      anyOf: [
        {
          type: 'object',
          description: 'Momentum strategy params',
          properties: {
            lookbackPeriod: { type: 'integer', minimum: 1, maximum: 200, description: 'Number of candles for indicator calculation' },
            signalThreshold: { type: 'number', minimum: 0, maximum: 1, description: 'Minimum signal strength to act (0-1)' },
            rsiPeriod: { type: 'integer', minimum: 2, maximum: 100, description: 'RSI calculation period' },
            rsiOversold: { type: 'integer', minimum: 0, maximum: 100, description: 'RSI oversold threshold' },
            rsiOverbought: { type: 'integer', minimum: 0, maximum: 100, description: 'RSI overbought threshold' },
          },
        },
        {
          type: 'object',
          description: 'DCA strategy params',
          properties: {
            intervalMs: { type: 'integer', minimum: 60000, description: 'Time between DCA buys in milliseconds' },
            amountPerBuy: { type: 'string', description: 'Buy amount as decimal string. In fixed mode this is a dollar amount. In percent_equity mode this is a percentage of account equity.' },
            amountPerBuyMode: { type: 'string', enum: ['fixed', 'percent_equity'], default: 'fixed', description: 'How to interpret amountPerBuy.' },
          },
        },
        {
          type: 'object',
          description: 'Range/Contrarian/Swing/Scalper strategy params',
          properties: {
            lookbackPeriod: { type: 'integer', minimum: 1, maximum: 200 },
            signalThreshold: { type: 'number', minimum: 0, maximum: 1 },
          },
        },
      ],
    },
    example: {
      lookbackPeriod: 14,
      signalThreshold: 0.6,
    },
    version: '1.0.0',
    description: 'Strategy-specific parameters. Shape depends on strategy type. Use get_schema("strategy-schemas") with ?type=momentum for detailed per-strategy schemas.',
  },

  'adjust_bot_config.config.strategy.params': {
    schema: {
      type: 'object',
      description: 'Partial strategy parameter updates. Only specify the keys you want to change. Shape depends on strategy type.',
      properties: {
        lookbackPeriod: { type: 'integer', minimum: 1, maximum: 200 },
        signalThreshold: { type: 'number', minimum: 0, maximum: 1 },
        rsiPeriod: { type: 'integer', minimum: 2, maximum: 100 },
        rsiOversold: { type: 'integer', minimum: 0, maximum: 100 },
        rsiOverbought: { type: 'integer', minimum: 0, maximum: 100 },
        intervalMs: { type: 'integer', minimum: 60000 },
        amountPerBuy: { type: 'string' },
      },
      additionalProperties: false,
    },
    example: {
      signalThreshold: 0.7,
      lookbackPeriod: 20,
    },
    version: '1.0.0',
    description: 'Partial strategy parameter updates for adjust_bot_config. Only include fields you want to change. Unspecified fields keep their current values.',
  },

  'create_bot.config.execution': {
    schema: zodToJsonSchemaSimple(
      z.object({
        mode: z.enum(['paper', 'shadow', 'live']).optional(),
        slippageBps: z.number().int().min(0).max(10000).optional(),
      })
    ),
    example: {
      mode: 'paper',
      slippageBps: 50,
    },
    version: '1.0.0',
    description: 'Execution configuration for bots. mode selects execution type. slippageBps is the allowed slippage in basis points (1 bps = 0.01%).',
  },

  'create_bot.config.execution.slippageBps': {
    schema: {
      type: 'integer',
      minimum: 0,
      maximum: 10000,
      description: 'Slippage tolerance in basis points. 1 bps = 0.01%. Common values: 10-50 for liquid pairs, 100-500 for volatile tokens. Default: 50 bps (configurable per venue).',
    },
    example: 50,
    version: '1.0.0',
    description: 'Slippage tolerance in basis points. Call get_schema("venue-defaults") for venue-specific recommendations.',
  },

  'adjust_bot_config.config.execution.slippageBps': {
    schema: {
      type: 'integer',
      minimum: 0,
      maximum: 10000,
      description: 'Slippage tolerance in basis points (partial update). Only specify if you want to change the current value.',
    },
    example: 50,
    version: '1.0.0',
    description: 'Slippage tolerance update for adjust_bot_config. Leave unspecified to keep current value.',
  },

  'create_bot.config.risk': {
    schema: zodToJsonSchemaSimple(
      z.object({
        maxPositionSizePct: z.number().min(0).max(100).optional(),
        stopLossPct: z.number().min(0).optional(),
        takeProfitPct: z.number().min(0).optional(),
        maxDrawdownPct: z.number().min(0).max(100).optional(),
        maxLeverage: z.number().min(1).optional(),
      }).passthrough()
    ),
    example: {
      maxPositionSizePct: 25,
      stopLossPct: 5,
      takeProfitPct: 15,
      maxDrawdownPct: 20,
    },
    version: '1.0.0',
    description: 'Risk configuration for bots. Controls position sizing, stop-loss, take-profit, and drawdown limits. The engine applies additional platform-level caps from operator config.',
  },

  'adjust_bot_config.config.risk': {
    schema: zodToJsonSchemaSimple(
      z.object({
        maxPositionSizePct: z.number().min(0).max(100).optional(),
        stopLossPct: z.number().min(0).optional(),
        takeProfitPct: z.number().min(0).optional(),
        maxDrawdownPct: z.number().min(0).max(100).optional(),
        maxLeverage: z.number().min(1).optional(),
      }).passthrough()
    ),
    example: {
      stopLossPct: 3,
    },
    version: '1.0.0',
    description: 'Partial risk configuration update for adjust_bot_config. Only include fields to change. Unspecified fields keep current values.',
  },

  'publish_artifact.location': {
    schema: {
      type: 'object',
      description: 'Storage location specification for artifacts.',
      oneOf: [
        {
          type: 'object',
          properties: {
            type: { type: 'string', const: 'workspace' },
            path: { type: 'string', description: 'Relative path within agent workspace' },
          },
          required: ['type', 'path'],
        },
        {
          type: 'object',
          properties: {
            type: { type: 'string', const: 's3' },
            bucket: { type: 'string', description: 'S3 bucket name' },
            key: { type: 'string', description: 'S3 object key' },
            region: { type: 'string', description: 'AWS region' },
          },
          required: ['type', 'bucket', 'key'],
        },
        {
          type: 'object',
          properties: {
            type: { type: 'string', const: 'url' },
            url: { type: 'string', format: 'uri', description: 'Public URL where artifact is hosted' },
          },
          required: ['type', 'url'],
        },
      ],
    },
    example: { type: 'workspace', path: 'reports/trade-analysis.json' },
    version: '1.0.0',
    description: 'Artifact storage location. Supported types: workspace (agent filesystem), s3 (AWS S3), url (external URL).',
  },

  'publish_artifact.metadata': {
    schema: {
      type: 'object',
      description: 'Arbitrary metadata for the published artifact.',
      properties: {
        title: { type: 'string', description: 'Human-readable title' },
        description: { type: 'string', description: 'Description of the artifact' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
        mimeType: { type: 'string', description: 'MIME type, e.g. "application/json"' },
      },
      additionalProperties: true,
    },
    example: {
      title: 'Trade Analysis Report',
      description: 'Momentum trade analysis for SOL/USDC',
      tags: ['analysis', 'momentum'],
      mimeType: 'application/json',
    },
    version: '1.0.0',
    description: 'Metadata for published artifacts. Include title, description, tags, and mimeType. Additional custom fields are allowed.',
  },

  'execute_code.dependencies': {
    schema: {
      type: 'array',
      description: 'List of npm package dependencies. Format: ["name@version", ...]. Only npm registry packages are allowed; Git URLs are rejected unless allowlisted.',
      items: {
        type: 'string',
        pattern: '^@?[a-z0-9][a-z0-9._-]*[a-z0-9]@[\\^~]?\\d+\\.\\d+\\.\\d+(-[a-z0-9.]+)?$',
        description: 'Package spec in "name@version" format, e.g. "lodash@4.17.21" or "@org/pkg@^1.0.0"',
      },
      maxItems: 20,
    },
    example: ['lodash@4.17.21', 'date-fns@^3.0.0'],
    version: '1.0.0',
    description: 'npm package dependencies for execute_code. Each entry must be "name@version" format. Max 20 dependencies. Git URLs are rejected.',
  },

  'submit_decision.targetSize': {
    schema: {
      type: 'string',
      pattern: '^\\d+(\\.\\d+)?$',
      description: 'Target position size as a decimal string. Use get_account_summary() to determine available capital and compute sizing. A typical starting range is 5–10% of capital. Required — must be provided.',
    },
    example: '0.5',
    version: '1.0.0',
    description: 'Target position size for submit_decision. Decimal string format. Call get_account_summary() to compute appropriate sizing.',
  },

  // ── Preset Assessment & Transition Tool Schemas ──────────────────────────

  'change_strategy_preset': {
    schema: zodToJsonSchemaSimple(ChangeStrategyPresetParamsSchema),
    example: { assessmentArtifactId: 'artifact-abc123', targetPreset: 'momentum', mode: 'entries_only', reason: 'Strong momentum regime detected' },
    version: '2.0.0',
    description: 'Apply a strategy preset change using an exact assessment artifact reference from assess_strategy_preset. Supports entries_only, entries_and_tighten_existing, and entries_and_full_transition modes. Records the transition event for audit.',
  },
  };
}

function getSchemaRegistry(): Record<string, SchemaEntry> {
  if (!_schemaRegistry) {
    _schemaRegistry = buildSchemaRegistry();
  }
  return _schemaRegistry;
}

/**
 * Get a schema entry by name. Returns undefined if not found.
 */
export function getToolSchema(name: string): SchemaEntry | undefined {
  return getSchemaRegistry()[name];
}

/**
 * List all registered schema names.
 */
export function listToolSchemaNames(): string[] {
  return Object.keys(getSchemaRegistry()).sort();
}

/**
 * Get all schema entries.
 */
export function getAllToolSchemas(): Record<string, SchemaEntry> {
  return { ...getSchemaRegistry() };
}
