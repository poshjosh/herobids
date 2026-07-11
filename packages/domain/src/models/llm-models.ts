import { z } from 'zod';
import { ReasoningLevelSchema, type ReasoningLevel } from '../config/schema.js';

// ── Provider Registry (single source of truth) ──────────────────────────────

/** Provider-side pricing for a single model (what the provider charges). */
export interface ModelPricing {
  /** USD per 1 million input / prompt tokens */
  inputUsdPerM: number;
  /** USD per 1 million output / completion tokens */
  outputUsdPerM: number;
  /**
   * USD per 1 million reasoning / thinking tokens.
   * Defaults to `outputUsdPerM` when absent.
   */
  reasoningUsdPerM?: number;
  /**
   * USD per 1 million prompt-cache read tokens.
   * When absent, `llm.cached_input_tokens` rate card items are not seeded
   * and cache reads are not charged until explicit pricing is available.
   */
  cacheReadUsdPerM?: number;
}

export const ModelPricingSchema = z.object({
  inputUsdPerM: z.number().positive(),
  outputUsdPerM: z.number().positive(),
  reasoningUsdPerM: z.number().positive().optional(),
  cacheReadUsdPerM: z.number().nonnegative().optional(),
});

const RawProviderConfigSchema = z.object({
  catalogMode: z.enum(['static', 'dynamic']),
  baseUrl: z.string().url().optional(),
  devOnly: z.boolean().optional(),
  isMultiProvider: z.boolean().optional(),
  fetchUrl: z.string().url().optional(),
  pricingSource: z.enum(['openrouter', 'inline', 'none']).optional(),
  models: z.record(z.string(), z.object({
    inputUsdPerM: z.number().positive().optional(),
    outputUsdPerM: z.number().positive().optional(),
    reasoningUsdPerM: z.number().positive().optional(),
    cacheReadUsdPerM: z.number().nonnegative().optional(),
  })),
});

/**
 * Refine rule:
 * - `pricingSource: 'inline'` (or absent with catalogMode: 'static'): every model MUST have pricing.
 * - `pricingSource: 'openrouter'`: pricing comes from the DB — models MAY omit pricing fields.
 * - `pricingSource: 'none'`: no pricing expected (e.g. ollama).
 * - `catalogMode: 'dynamic'`: no pricing validation (prices come from worker fetch).
 */
export const ProviderConfigSchema = RawProviderConfigSchema.refine(
  (config) => {
    const effectivePricingSource = config.pricingSource ??
      (config.catalogMode === 'static' ? 'inline' : 'none');

    if (effectivePricingSource === 'inline') {
      return Object.values(config.models).every(
        (m) => m.inputUsdPerM != null && m.outputUsdPerM != null,
      );
    }
    return true;
  },
  { message: 'Static providers with inline pricing must have inputUsdPerM and outputUsdPerM for every model' },
);

export const ProvidersYamlSchema = z.object({
  providers: z.record(z.string(), ProviderConfigSchema),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ProvidersYaml = z.infer<typeof ProvidersYamlSchema>;

export interface LlmProviderDefinition {
  id: string;
  /**
   * Model registry. Keys are model IDs.
   * Values are pricing when known, or an empty object when pricing is not available.
   * `getProviderModelIds` returns `Object.keys(models)`.
   * `getLlmModelPricing` checks whether `inputUsdPerM` is present on the value.
   */
  models: Record<string, Partial<ModelPricing>>;
  catalogMode: 'static' | 'dynamic';
  devOnly?: boolean;
  isMultiProvider?: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Returns model IDs for a provider from the loaded config. */
export function getProviderModelIds(
  providerConfig: ProviderConfig | undefined,
): string[] {
  if (!providerConfig) return [];
  return Object.keys(providerConfig.models);
}

/** Returns pricing for a specific model from a pricing snapshot. */
export function getLlmModelPricing(
  snapshot: Record<string, Partial<ModelPricing>> | null,
  modelId: string,
): ModelPricing | undefined {
  if (!snapshot) return undefined;
  const m = snapshot[modelId];
  if (!m || m.inputUsdPerM === undefined || m.outputUsdPerM === undefined) return undefined;
  return m as ModelPricing;
}

/**
 * Generates rate card seed items for every model that has known pricing.
 * Pricing is expressed as µUSD per 1 000 tokens (priceMicrousd / perUnit = 1 000).
 * These items should be seeded alongside catch-all rate card items so that
 * per-model charges take precedence over the generic fallback.
 */
export function getLlmModelRateCardItems(
  providerId: string,
  snapshot: Record<string, Partial<ModelPricing>> | null,
  options?: { fallbackCacheReadPct?: number },
): Array<{
  meterKey: string;
  provider: string;
  modelPattern: string;
  priceMicrousd: number;
  perUnit: number;
}> {
  const items: Array<{
    meterKey: string;
    provider: string;
    modelPattern: string;
    priceMicrousd: number;
    perUnit: number;
  }> = [];
  if (!snapshot) return items;

  const perUnit = 1_000;

  for (const [modelId, m] of Object.entries(snapshot)) {
    if (m.inputUsdPerM === undefined || m.outputUsdPerM === undefined) continue;
    const reasoningUsdPerM = m.reasoningUsdPerM ?? m.outputUsdPerM;
    items.push(
      {
        meterKey: 'llm.input_tokens',
        provider: providerId,
        modelPattern: modelId,
        priceMicrousd: Math.round(m.inputUsdPerM * perUnit),
        perUnit,
      },
      {
        meterKey: 'llm.output_tokens',
        provider: providerId,
        modelPattern: modelId,
        priceMicrousd: Math.round(m.outputUsdPerM * perUnit),
        perUnit,
      },
      {
        meterKey: 'llm.reasoning_tokens',
        provider: providerId,
        modelPattern: modelId,
        priceMicrousd: Math.round(reasoningUsdPerM * perUnit),
        perUnit,
      },
    );
    // Use explicit cache-read price when available; otherwise fall back to a
    // configurable fraction of the input rate (fallbackCacheReadPct).  When no
    // fallback is configured, skip the item so cache reads are not charged.
    const effectiveCacheReadUsdPerM =
      m.cacheReadUsdPerM ??
      (options?.fallbackCacheReadPct !== undefined
        ? m.inputUsdPerM * (options.fallbackCacheReadPct / 100)
        : undefined);
    if (effectiveCacheReadUsdPerM !== undefined) {
      items.push({
        meterKey: 'llm.cached_input_tokens',
        provider: providerId,
        modelPattern: modelId,
        priceMicrousd: Math.round(effectiveCacheReadUsdPerM * perUnit),
        perUnit,
      });
    }
  }

  return items;
}

const CurrentAiModelConfigSchema = z.object({
  provider: z.string().min(1),
  lightModel: z.string().min(1),
  heavyModel: z.string().min(1),
  scoutReasoning: ReasoningLevelSchema.nullable().optional(),
  judgeReasoning: ReasoningLevelSchema.nullable().optional(),
  adaptScoutReasoning: z.boolean().nullable().optional(),
  adaptJudgeReasoning: z.boolean().nullable().optional(),
});

const ClearedAiModelConfigSchema = z.object({
  provider: z.null(),
  lightModel: z.null(),
  heavyModel: z.null(),
  scoutReasoning: z.null().optional(),
  judgeReasoning: z.null().optional(),
  adaptScoutReasoning: z.null().optional(),
  adaptJudgeReasoning: z.null().optional(),
});

export interface LlmModelSelection {
  provider: string;
  lightModel: string;
  heavyModel: string;
  scoutReasoning?: ReasoningLevel | null;
  judgeReasoning?: ReasoningLevel | null;
  adaptScoutReasoning?: boolean | null;
  adaptJudgeReasoning?: boolean | null;
}

export interface PersistedAiModelConfig {
  provider: string;
  lightModel: string;
  heavyModel: string;
  scoutReasoning?: ReasoningLevel | null;
  judgeReasoning?: ReasoningLevel | null;
  adaptScoutReasoning?: boolean | null;
  adaptJudgeReasoning?: boolean | null;
}

export function validateLlmModelSelection(
  selection: LlmModelSelection,
  providerConfig: ProviderConfig | undefined,
): Array<{ code: 'custom'; path: string[]; message: string }> {
  const issues: Array<{ code: 'custom'; path: string[]; message: string }> = [];
  if (!providerConfig) {
    issues.push({ code: 'custom', path: ['provider'], message: 'Selected provider is not available on this platform' });
    return issues;
  }

  // For dynamic providers or openrouter-derived providers (model list comes from DB),
  // defer validation to the API layer.
  if (providerConfig.catalogMode === 'dynamic' || providerConfig.pricingSource === 'openrouter') {
    return issues;
  }

  const modelIds = Object.keys(providerConfig.models);

  if (!modelIds.includes(selection.lightModel)) {
    issues.push({ code: 'custom', path: ['lightModel'], message: `Unknown model "${selection.lightModel}" for ${selection.provider}` });
  }

  if (!modelIds.includes(selection.heavyModel)) {
    issues.push({ code: 'custom', path: ['heavyModel'], message: `Unknown model "${selection.heavyModel}" for ${selection.provider}` });
  }

  return issues;
}

/**
 * Normalize a persisted AI model config from DB JSONB.
 *
 * @param raw - The raw JSONB value from the database.
 * @param providerConfig - Provider config for model validation.
 *   **TODO(Phase 4c): Make this parameter required once all consumers are updated.**
 *   When omitted, model validation is skipped — callers MUST pass providerConfig
 *   to maintain the previous validation behaviour.
 *
 * @deprecated Single-argument usage (without providerConfig) silently skips
 *   model validation. Always pass providerConfig.
 */
export function normalizePersistedAiModelConfig(
  raw: unknown,
  providerConfig?: ProviderConfig,
): PersistedAiModelConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const explicit = CurrentAiModelConfigSchema.safeParse(raw);
  if (explicit.success) {
    if (providerConfig) {
      const issues = validateLlmModelSelection(explicit.data, providerConfig);
      if (issues.length > 0) return null;
    }
    return explicit.data;
  }

  const cleared = ClearedAiModelConfigSchema.safeParse(raw);
  if (cleared.success) {
    return null;
  }

  return null;
}
