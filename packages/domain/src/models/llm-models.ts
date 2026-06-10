import { z } from 'zod';

export const KNOWN_LLM_PROVIDERS = ['openai', 'anthropic', 'openrouter', 'together', 'fireworks', 'mistral', 'cohere', 'google'] as const;

export const LLM_PROVIDER_MODELS: Record<(typeof KNOWN_LLM_PROVIDERS)[number], string[]> = {
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
  anthropic: ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-3-5'],
  openrouter: ['anthropic/claude-sonnet-4-5', 'openai/gpt-4o', 'meta-llama/llama-3.3-70b-instruct'],
  together: ['meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo', 'mistralai/Mixtral-8x7B-Instruct-v0.1'],
  fireworks: ['accounts/fireworks/models/llama-v3p1-70b-instruct'],
  mistral: ['mistral-large-latest', 'mistral-small-latest'],
  cohere: ['command-r-plus', 'command-r'],
  google: ['gemini-1.5-pro', 'gemini-1.5-flash'],
};

function isKnownLlmProvider(provider: string): provider is keyof typeof LLM_PROVIDER_MODELS {
  return Object.prototype.hasOwnProperty.call(LLM_PROVIDER_MODELS, provider);
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