import { z } from 'zod';
import type { AgentTool, ToolResult, TradingToolContext } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';
import { mapReadResultToToolResult, mapWriteResultToToolResult } from './external-backend-result.js';
import { resolveSelectedVenueAccountId, selectedAccountUnavailable } from './risk-limits.js';

// Thin proxies to Traderton's strategy-preset review tools. Traderton owns the
// assessment, creator policy, artifact freshness, cooldowns and the change itself;
// these tools only validate the wire shape, add the platform-resolved venue
// account where Traderton scopes the call by account, and map the result.

/** Deadline for the change_strategy_preset boundary write (invoke + poll), in ms. Same value as adjust_risk_limits. */
const CHANGE_STRATEGY_PRESET_DEADLINE_MS = 30_000;

/** Fail-closed result when the Traderton boundary is not configured. No local fallback exists. */
const BOUNDARY_NOT_READY: ToolResult = {
  success: false,
  error: 'trading boundary not configured',
  errorCode: 'precondition.not_ready',
  fault: false,
};

// --- list_strategy_presets ---

const ListStrategyPresetsParamsSchema = z.object({
  // describe() goes before optional(): the OpenAI-target schema drops a description set on the optional wrapper.
  // Source of truth for these values: Traderton's ListStrategyPresetsParamsSchema
  // (packages/worker/src/tools/preset-assessment.ts). Keep in step by hand. @poshjosh/contracts
  // has no standalone export for them. If Traderton adds a tier, this enum rejects it locally
  // with the allowed values listed, so drift is loud, not silent.
  styleTier: z
    .enum(['economy', 'standard', 'premium'])
    .describe('Style tier to list. Omit to list all tiers.')
    .optional(),
});

const listStrategyPresetsTool: AgentTool<TradingToolContext> = {
  name: 'list_strategy_presets',
  description:
    'List the strategy presets you can choose from: key, name, description, strategy type, signal bias and behavior version. Read only. Use it to learn preset keys before assess_strategy_preset or change_strategy_preset.',
  parametersSchema: ListStrategyPresetsParamsSchema,
  parameters: convertZodToJsonSchema(ListStrategyPresetsParamsSchema),
  category: 'read-config',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    if (!ctx.externalBackend) return BOUNDARY_NOT_READY;
    // The catalog is venue-independent, so no venue account is resolved or sent.
    const { styleTier } = params as z.infer<typeof ListStrategyPresetsParamsSchema>;
    const result = await ctx.externalBackend.invoke({
      toolName: 'list_strategy_presets',
      payload: styleTier ? { styleTier } : {},
    });
    return mapReadResultToToolResult(result);
  },
};

// --- assess_strategy_preset ---

const AssessStrategyPresetParamsSchema = z.object({
  symbols: z
    .array(z.string().min(1))
    .min(1)
    .max(50)
    .describe(
      'Trading symbols to assess, for example ["BTC", "ETH"]. When you were woken for a review, use the candidate symbols. Symbols beyond the platform cap are ignored and the response reports the cap (maxInstrumentsPerRequest).',
    ),
  venueFamily: z
    .string()
    .min(1)
    .describe(
      'Venue family to assess against, for example "hyperliquid". Required. When you were woken for a review, use the venue family shown for the candidate.',
    ),
  // Source of truth for these values: Traderton's AssessStrategyPresetParamsSchema
  // (packages/domain/src/preset-assessment.ts). Keep in step by hand. @poshjosh/contracts only
  // has them inside MarketAssessmentIdentitySchema, not as a standalone enum. Traderton validates
  // with the same z.enum, so loosening this to a string would only move the rejection to a round
  // trip and hide the valid choices from the model's tool schema.
  instrumentKind: z
    .enum(['orderbook', 'perp', 'swap', 'dex'])
    .describe('Instrument kind shared by all symbols: orderbook, perp, swap or dex. Defaults to orderbook when omitted.')
    .optional(),
});

const assessStrategyPresetTool: AgentTool<TradingToolContext> = {
  name: 'assess_strategy_preset',
  description:
    'Get computed data to decide whether to switch your strategy preset, for one or more symbols: market evidence, a scorecard and flags for each preset, an artifactId and expiresAt. Data only: no recommendation and no narrative, and it is free. Pass the artifactId to change_strategy_preset. The crypto-trading skill explains how to read the flags.',
  parametersSchema: AssessStrategyPresetParamsSchema,
  parameters: convertZodToJsonSchema(AssessStrategyPresetParamsSchema),
  category: 'read-market-data',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    if (!ctx.externalBackend) return BOUNDARY_NOT_READY;

    const resolution = await resolveSelectedVenueAccountId(ctx);
    if (resolution.status !== 'ready') return selectedAccountUnavailable(resolution);

    const { symbols, venueFamily, instrumentKind } = params as z.infer<typeof AssessStrategyPresetParamsSchema>;
    const result = await ctx.externalBackend.invoke({
      toolName: 'assess_strategy_preset',
      payload: {
        symbols,
        venueFamily,
        ...(instrumentKind ? { instrumentKind } : {}),
        venueAccountId: resolution.venueAccountId,
      },
    });
    return mapReadResultToToolResult(result);
  },
};

// --- change_strategy_preset ---

const ChangeStrategyPresetParamsSchema = z.object({
  assessmentArtifactId: z
    .string()
    .min(1)
    .describe('The artifactId returned by assess_strategy_preset. It must not have expired.'),
  targetPreset: z
    .string()
    .min(1)
    .describe('Key of the preset to switch to, as listed by list_strategy_presets or shown in the assessment.'),
  // Source of truth: Traderton's ChangeStrategyPresetParamsSchema (packages/domain/src/preset-assessment.ts).
  // Single-valued today, so the likeliest to drift: if Traderton adds a mode, update this enum in step.
  mode: z.enum(['entries_only']).describe('Only entries_only is supported.'),
  reason: z
    .string()
    .min(1)
    .describe('Why you are changing preset, in your own words. It is shown to the creator on the review screen. Required.'),
});

const changeStrategyPresetTool: AgentTool<TradingToolContext> = {
  name: 'change_strategy_preset',
  description:
    "Switch your active strategy preset. Needs the artifactId from a recent assess_strategy_preset call (it must not have expired), the target preset key, mode entries_only and a reason. The creator's policy and cooldowns are enforced by the trading backend, and a refusal comes back as an error with the reason.",
  parametersSchema: ChangeStrategyPresetParamsSchema,
  parameters: convertZodToJsonSchema(ChangeStrategyPresetParamsSchema),
  category: 'write-database',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    if (!ctx.externalBackendWrite) return BOUNDARY_NOT_READY;

    const resolution = await resolveSelectedVenueAccountId(ctx);
    if (resolution.status !== 'ready') return selectedAccountUnavailable(resolution);

    const { assessmentArtifactId, targetPreset, mode, reason } = params as z.infer<typeof ChangeStrategyPresetParamsSchema>;
    // No idempotency key here: the subject-bound write boundary mints a fresh one
    // per invokeAndAwait, so one tool execution is one logical write.
    const result = await ctx.externalBackendWrite.invokeAndAwait({
      toolName: 'change_strategy_preset',
      payload: { assessmentArtifactId, targetPreset, mode, reason, venueAccountId: resolution.venueAccountId },
      deadlineMs: CHANGE_STRATEGY_PRESET_DEADLINE_MS,
    });
    return mapWriteResultToToolResult(result);
  },
};

export const strategyPresetTools: AgentTool<TradingToolContext>[] = [
  listStrategyPresetsTool,
  assessStrategyPresetTool,
  changeStrategyPresetTool,
];
