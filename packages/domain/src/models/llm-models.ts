import { z } from 'zod';

// ── Provider Registry (single source of truth) ──────────────────────────────

export interface LlmProviderDefinition {
  id: string;
  models: string[];
  catalogMode: 'static' | 'dynamic';
  devOnly?: boolean;
  isMultiProvider?: boolean;
}

/**
 * Single source of truth for all LLM providers.
 * To add a provider, add one entry here — KNOWN_LLM_PROVIDERS
 * and LLM_PROVIDER_MODELS are derived automatically.
 * The record key MUST match the `id` field.
 */
export const PROVIDER_DEFINITIONS = {
  openai: {
    id: 'openai',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
    catalogMode: 'static',
  },
  anthropic: {
    id: 'anthropic',
    models: ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-3-5'],
    catalogMode: 'static',
  },
  openrouter: {
    id: 'openrouter',
    models: ['anthropic/claude-sonnet-4-5', 'openai/gpt-4o', 'meta-llama/llama-3.3-70b-instruct'],
    catalogMode: 'dynamic',
    isMultiProvider: true,
  },
  together: {
    id: 'together',
    models: ['meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo', 'mistralai/Mixtral-8x7B-Instruct-v0.1'],
    catalogMode: 'static',
  },
  fireworks: {
    id: 'fireworks',
    models: ['accounts/fireworks/models/llama-v3p1-70b-instruct'],
    catalogMode: 'static',
  },
  mistral: {
    id: 'mistral',
    models: ['mistral-large-latest', 'mistral-small-latest'],
    catalogMode: 'static',
  },
  cohere: {
    id: 'cohere',
    models: ['command-r-plus', 'command-r'],
    catalogMode: 'static',
  },
  google: {
    id: 'google',
    models: ['gemini-1.5-pro', 'gemini-1.5-flash'],
    catalogMode: 'static',
  },
  ollama: {
    id: 'ollama',
    models: ['qwen3:8b', 'qwen3.6:35b-a3b-q4_K_M'],
    catalogMode: 'dynamic',
    devOnly: true,
  },
} as const satisfies Record<string, LlmProviderDefinition>;

export type LlmProviderId = keyof typeof PROVIDER_DEFINITIONS;

export const KNOWN_LLM_PROVIDERS = Object.keys(PROVIDER_DEFINITIONS) as readonly LlmProviderId[];

/**
 * Derived from PROVIDER_DEFINITIONS for backward compatibility.
 * Prefer PROVIDER_DEFINITIONS[provider].models for new code.
 */
export const LLM_PROVIDER_MODELS: Record<LlmProviderId, string[]> =
  Object.fromEntries(
    Object.entries(PROVIDER_DEFINITIONS).map(([id, def]) => [id, def.models]),
  ) as Record<LlmProviderId, string[]>;

// ── Helpers ─────────────────────────────────────────────────────────────────

function isKnownLlmProvider(provider: string): provider is LlmProviderId {
  return Object.prototype.hasOwnProperty.call(PROVIDER_DEFINITIONS, provider);
}

export function getLlmProviderModels(provider: string): string[] {
  return isKnownLlmProvider(provider) ? LLM_PROVIDER_MODELS[provider] : [];
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