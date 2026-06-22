import { z } from 'zod';

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
}

export interface LlmProviderDefinition {
  id: string;
  /**
   * Model registry. Keys are model IDs.
   * Values are pricing when known, or an empty object when pricing is not available.
   * `getLlmProviderModels` returns `Object.keys(models)`.
   * `getLlmModelPricing` checks whether `inputUsdPerM` is present on the value.
   */
  models: Record<string, Partial<ModelPricing>>;
  catalogMode: 'static' | 'dynamic';
  devOnly?: boolean;
  isMultiProvider?: boolean;
}

/**
 * Single source of truth for all LLM providers.
 * To add a provider, add one entry here — KNOWN_LLM_PROVIDERS
 * is derived automatically.
 * The record key MUST match the `id` field.
 */
export const PROVIDER_DEFINITIONS = {
  openai: {
    id: 'openai',
    catalogMode: 'static',
    models: {
      'gpt-5.5':      { inputUsdPerM: 5,    outputUsdPerM: 30 },
      'gpt-5.4':      { inputUsdPerM: 2.5,  outputUsdPerM: 15 },
      'gpt-5':        { inputUsdPerM: 2,    outputUsdPerM: 8 },
      'o3':           { inputUsdPerM: 2,    outputUsdPerM: 8 },
      'gpt-4.1':      { inputUsdPerM: 2,    outputUsdPerM: 8 },
      'gpt-5.4-mini': { inputUsdPerM: 0.75, outputUsdPerM: 4.5 },
      'gpt-5-mini':   { inputUsdPerM: 0.75, outputUsdPerM: 4.5 },
      'gpt-4o':       { inputUsdPerM: 2.5,  outputUsdPerM: 10 },
      'o4-mini':      { inputUsdPerM: 1.1,  outputUsdPerM: 4.4 },
      'gpt-4.1-mini': { inputUsdPerM: 0.4,  outputUsdPerM: 1.6 },
      'gpt-4.1-nano': { inputUsdPerM: 0.1,  outputUsdPerM: 0.4 },
      'gpt-4o-mini':  { inputUsdPerM: 0.15, outputUsdPerM: 0.6 },
      'gpt-5-nano':   { inputUsdPerM: 0.2,  outputUsdPerM: 1.25 },
      'gpt-5.4-nano': { inputUsdPerM: 0.2,  outputUsdPerM: 1.25 },
    },
  },
  anthropic: {
    id: 'anthropic',
    catalogMode: 'static',
    models: {
      'claude-opus-4-8':   { inputUsdPerM: 5,   outputUsdPerM: 25 },
      'claude-opus-4-7':   { inputUsdPerM: 5,   outputUsdPerM: 25 },
      'claude-opus-4-5':   { inputUsdPerM: 15,  outputUsdPerM: 75 },
      'claude-sonnet-4-6': { inputUsdPerM: 3,   outputUsdPerM: 15 },
      'claude-sonnet-4-5': { inputUsdPerM: 3,   outputUsdPerM: 15 },
      'claude-haiku-4-5':  { inputUsdPerM: 1,   outputUsdPerM: 5 },
      'claude-haiku-3-5':  { inputUsdPerM: 0.8, outputUsdPerM: 4 },
    },
  },
  deepseek: {
    id: 'deepseek',
    catalogMode: 'static',
    models: {
      'deepseek-v4-flash': { inputUsdPerM: 0.14, outputUsdPerM: 0.28 },
      'deepseek-v4-pro':   { inputUsdPerM: 0.43, outputUsdPerM: 0.87 },
      'deepseek-r1':       { inputUsdPerM: 0.7,  outputUsdPerM: 2.5 },
      'deepseek-chat':     { inputUsdPerM: 0.32, outputUsdPerM: 0.89 },
    },
  },
  openrouter: {
    id: 'openrouter',
    catalogMode: 'dynamic',
    isMultiProvider: true,
    models: {
      // tier1_premium
      'anthropic/claude-opus-4.8':            { inputUsdPerM: 5,     outputUsdPerM: 25 },
      'anthropic/claude-opus-4.7':            { inputUsdPerM: 5,     outputUsdPerM: 25 },
      'openai/gpt-5.5':                       { inputUsdPerM: 5,     outputUsdPerM: 30 },
      'openai/gpt-5.4':                       { inputUsdPerM: 2.5,   outputUsdPerM: 15 },
      'google/gemini-3.1-pro-preview':        { inputUsdPerM: 2,     outputUsdPerM: 12 },
      'google/gemini-2.5-pro':                { inputUsdPerM: 1.25,  outputUsdPerM: 10 },
      'x-ai/grok-4.3':                        { inputUsdPerM: 1.25,  outputUsdPerM: 2.5 },
      'x-ai/grok-4':                          { inputUsdPerM: 3,     outputUsdPerM: 15 },
      'moonshotai/kimi-k2.6':                 { inputUsdPerM: 0.74,  outputUsdPerM: 3.49 },
      'minimax/minimax-m1':                   { inputUsdPerM: 0.4,   outputUsdPerM: 2.2 },
      'xiaomi/mimo-v2.5-pro':                 { inputUsdPerM: 1,     outputUsdPerM: 3 },
      // tier2_mid
      'anthropic/claude-sonnet-4.6':          { inputUsdPerM: 3,     outputUsdPerM: 15 },
      'anthropic/claude-sonnet-4.5':          { inputUsdPerM: 3,     outputUsdPerM: 15 },
      'openai/gpt-4.1':                       { inputUsdPerM: 2,     outputUsdPerM: 8 },
      'openai/gpt-5-mini':                    { inputUsdPerM: 0.25,  outputUsdPerM: 2 },
      'openai/o3':                            { inputUsdPerM: 2,     outputUsdPerM: 8 },
      'openai/o4-mini':                       { inputUsdPerM: 1.1,   outputUsdPerM: 4.4 },
      'google/gemini-3-flash-preview':        { inputUsdPerM: 0.5,   outputUsdPerM: 3 },
      'google/gemini-2.5-flash':              { inputUsdPerM: 0.3,   outputUsdPerM: 2.5 },
      'deepseek/deepseek-r1':                 { inputUsdPerM: 0.7,   outputUsdPerM: 2.5 },
      'deepseek/deepseek-v4-pro':             { inputUsdPerM: 0.43,  outputUsdPerM: 0.87 },
      'qwen/qwen3.6-plus':                    { inputUsdPerM: 0.325, outputUsdPerM: 1.95 },
      'qwen/qwen3-max':                       { inputUsdPerM: 0.78,  outputUsdPerM: 3.9 },
      'x-ai/grok-4-fast':                     { inputUsdPerM: 0.2,   outputUsdPerM: 0.5 },
      'moonshotai/kimi-k2.5':                 { inputUsdPerM: 0.44,  outputUsdPerM: 2 },
      'minimax/minimax-m2.7':                 { inputUsdPerM: 0.3,   outputUsdPerM: 1.2 },
      // tier3_budget
      'anthropic/claude-haiku-4.5':           { inputUsdPerM: 1,     outputUsdPerM: 5 },
      'openai/gpt-4.1-mini':                  { inputUsdPerM: 0.4,   outputUsdPerM: 1.6 },
      'openai/gpt-4o-mini':                   { inputUsdPerM: 0.15,  outputUsdPerM: 0.6 },
      'openai/gpt-4.1-nano':                  { inputUsdPerM: 0.1,   outputUsdPerM: 0.4 },
      'openai/gpt-5-nano':                    { inputUsdPerM: 0.05,  outputUsdPerM: 0.4 },
      'google/gemini-3.1-flash-lite-preview': { inputUsdPerM: 0.25,  outputUsdPerM: 1.5 },
      'google/gemini-2.5-flash-lite':         { inputUsdPerM: 0.1,   outputUsdPerM: 0.4 },
      'deepseek/deepseek-v4-flash':           { inputUsdPerM: 0.14,  outputUsdPerM: 0.28 },
      'deepseek/deepseek-chat':               { inputUsdPerM: 0.32,  outputUsdPerM: 0.89 },
      'meta-llama/llama-4-maverick':          { inputUsdPerM: 0.15,  outputUsdPerM: 0.6 },
      'x-ai/grok-4.1-fast':                   { inputUsdPerM: 0.2,   outputUsdPerM: 0.5 },
      'qwen/qwen3-235b-a22b':                 { inputUsdPerM: 0.45,  outputUsdPerM: 1.82 },
      'minimax/minimax-m2.5':                 { inputUsdPerM: 0.15,  outputUsdPerM: 1.15 },
      'minimax/minimax-m2.1':                 { inputUsdPerM: 0.29,  outputUsdPerM: 0.95 },
      'minimax/minimax-m2':                   { inputUsdPerM: 0.255, outputUsdPerM: 1 },
      'minimax/minimax-01':                   { inputUsdPerM: 0.2,   outputUsdPerM: 1.1 },
      'tencent/hy3-preview':                  { inputUsdPerM: 0.066, outputUsdPerM: 0.26 },
      'meta-llama/llama-3.3-70b-instruct':    { inputUsdPerM: 0.06,  outputUsdPerM: 0.06 },
    },
  },
  google: {
    id: 'google',
    catalogMode: 'static',
    models: {
      'gemini-3.1-pro-preview':        { inputUsdPerM: 2,     outputUsdPerM: 12 },
      'gemini-2.5-pro':                { inputUsdPerM: 1.25,  outputUsdPerM: 10 },
      'gemini-3-flash-preview':        { inputUsdPerM: 0.5,   outputUsdPerM: 3 },
      'gemini-2.5-flash':              { inputUsdPerM: 0.3,   outputUsdPerM: 2.5 },
      'gemini-3.1-flash-lite-preview': { inputUsdPerM: 0.25,  outputUsdPerM: 1.5 },
      'gemini-2.5-flash-lite':         { inputUsdPerM: 0.1,   outputUsdPerM: 0.4 },
      'gemini-1.5-pro':                { inputUsdPerM: 1.25,  outputUsdPerM: 5 },
      'gemini-1.5-flash':              { inputUsdPerM: 0.075, outputUsdPerM: 0.3 },
    },
  },
  ollama: {
    id: 'ollama',
    catalogMode: 'dynamic',
    devOnly: true,
    models: {
      'qwen3:8b':                {},
      'qwen3.6:35b-a3b-q4_K_M': {},
    },
  },
} as const satisfies Record<string, LlmProviderDefinition>;

export type LlmProviderId = keyof typeof PROVIDER_DEFINITIONS;

export const KNOWN_LLM_PROVIDERS = Object.keys(PROVIDER_DEFINITIONS) as readonly LlmProviderId[];

// ── Helpers ─────────────────────────────────────────────────────────────────

function isKnownLlmProvider(provider: string): provider is LlmProviderId {
  return Object.prototype.hasOwnProperty.call(PROVIDER_DEFINITIONS, provider);
}

export function getLlmProviderModels(provider: string): string[] {
  if (!isKnownLlmProvider(provider)) return [];
  return Object.keys(PROVIDER_DEFINITIONS[provider].models);
}

/** Returns pricing data for a specific provider/model, or undefined if not known. */
export function getLlmModelPricing(provider: string, modelId: string): ModelPricing | undefined {
  if (!isKnownLlmProvider(provider)) return undefined;
  const m = (PROVIDER_DEFINITIONS[provider] as LlmProviderDefinition).models[modelId];
  if (!m || m.inputUsdPerM === undefined || m.outputUsdPerM === undefined) return undefined;
  return m as ModelPricing;
}

/**
 * Generates rate card seed items for every model that has known pricing.
 * Pricing is expressed as µUSD per 1 000 tokens (priceMicrousd / perUnit = 1 000).
 * These items should be seeded alongside catch-all rate card items so that
 * per-model charges take precedence over the generic fallback.
 */
export function getLlmModelRateCardItems(): Array<{
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

  const perUnit = 1_000;

  for (const [providerId, def] of Object.entries(PROVIDER_DEFINITIONS)) {
    for (const [modelId, m] of Object.entries((def as LlmProviderDefinition).models)) {
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
    }
  }

  return items;
}

const CurrentAiModelConfigSchema = z.object({
  provider: z.string().min(1),
  lightModel: z.string().min(1),
  heavyModel: z.string().min(1),
});

const ClearedAiModelConfigSchema = z.object({
  provider: z.null(),
  lightModel: z.null(),
  heavyModel: z.null(),
});

export interface LlmModelSelection {
  provider: string;
  lightModel: string;
  heavyModel: string;
}

export interface PersistedAiModelConfig {
  provider: string;
  lightModel: string;
  heavyModel: string;
}

export function validateLlmModelSelection(selection: LlmModelSelection): Array<{ code: 'custom'; path: string[]; message: string }> {
  const issues: Array<{ code: 'custom'; path: string[]; message: string }> = [];
  if (!isKnownLlmProvider(selection.provider)) {
    issues.push({ code: 'custom', path: ['provider'], message: 'Selected provider is not available on this platform' });
    return issues;
  }

  // Ollama models are operator-installed and discovered at runtime.
  // Domain defers model validation to the API layer, which has access to the live catalog.
  if (selection.provider === 'ollama') {
    return issues;
  }

  const providerModels = getLlmProviderModels(selection.provider);

  if (!providerModels.includes(selection.lightModel)) {
    issues.push({ code: 'custom', path: ['lightModel'], message: 'Selected economy model is not available for this provider' });
  }

  if (!providerModels.includes(selection.heavyModel)) {
    issues.push({ code: 'custom', path: ['heavyModel'], message: 'Selected premium model is not available for this provider' });
  }

  return issues;
}

export function normalizePersistedAiModelConfig(raw: unknown): PersistedAiModelConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const explicit = CurrentAiModelConfigSchema.safeParse(raw);
  if (explicit.success) {
    const issues = validateLlmModelSelection(explicit.data);
    return issues.length === 0 ? explicit.data : null;
  }

  const cleared = ClearedAiModelConfigSchema.safeParse(raw);
  if (cleared.success) {
    return null;
  }

  return null;
}
