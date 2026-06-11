import { KNOWN_LLM_PROVIDERS as KNOWN_PROVIDERS, LLM_PROVIDER_MODELS, getLlmProviderModels, validateLlmModelSelection } from '@herobids/domain';
import { discoverOllamaModels, normalizeOllamaCatalogUrl } from './ollama-model-discovery.js';

// --- Provider catalog metadata ---

type LlmProviderCatalogMode = 'static' | 'dynamic';

interface LlmProviderMetadata {
  catalogMode: LlmProviderCatalogMode;
  staticModels: string[];
}

const PROVIDER_METADATA: Record<string, LlmProviderMetadata> = {
  openai: { catalogMode: 'static', staticModels: LLM_PROVIDER_MODELS.openai },
  anthropic: { catalogMode: 'static', staticModels: LLM_PROVIDER_MODELS.anthropic },
  openrouter: { catalogMode: 'static', staticModels: LLM_PROVIDER_MODELS.openrouter },
  together: { catalogMode: 'static', staticModels: LLM_PROVIDER_MODELS.together },
  fireworks: { catalogMode: 'static', staticModels: LLM_PROVIDER_MODELS.fireworks },
  mistral: { catalogMode: 'static', staticModels: LLM_PROVIDER_MODELS.mistral },
  cohere: { catalogMode: 'static', staticModels: LLM_PROVIDER_MODELS.cohere },
  google: { catalogMode: 'static', staticModels: LLM_PROVIDER_MODELS.google },
  ollama: { catalogMode: 'dynamic', staticModels: LLM_PROVIDER_MODELS.ollama },
};

// --- Operator context ---

/** Operator-level LLM config context passed to all catalog helpers. */
export interface OperatorLlmCatalogContext {
  provider: string;
  model: string;
  baseUrl?: string;
  catalogTimeoutMs: number;
  catalogCacheTtlMs: number;
}

// --- Internal helpers ---

function resolveApiKey(provider: string): string | undefined {
  return process.env[`LLM_API_KEY_${provider.toUpperCase()}`] ?? process.env['LLM_API_KEY'];
}

function isProviderExplicitlyConfigured(provider: string): boolean {
  return !!process.env[`LLM_API_KEY_${provider.toUpperCase()}`];
}

function getConfiguredProviders(): string[] {
  return KNOWN_PROVIDERS.filter(isProviderExplicitlyConfigured);
}

function hasUsableDynamicCatalogConfig(context: OperatorLlmCatalogContext): boolean {
  if (context.provider !== 'ollama' || !context.baseUrl) {
    return false;
  }

  return normalizeOllamaCatalogUrl(context.baseUrl).ok;
}

// --- Exported catalog helpers ---

/** Construct a catalog context from the resolved operator LLM config. */
export function makeCatalogContext(llmConfig: {
  provider: string;
  model: string;
  baseUrl?: string;
  catalog: { timeoutMs: number; cacheTtlMs: number };
}): OperatorLlmCatalogContext {
  return {
    provider: llmConfig.provider,
    model: llmConfig.model,
    baseUrl: llmConfig.baseUrl,
    catalogTimeoutMs: llmConfig.catalog.timeoutMs,
    catalogCacheTtlMs: llmConfig.catalog.cacheTtlMs,
  };
}

export function getAvailableProviders(context: OperatorLlmCatalogContext): string[] {
  const explicit = getConfiguredProviders();
  const meta = PROVIDER_METADATA[context.provider];

  // Dynamic providers are only available when the operator explicitly selected them
  // and configured a usable catalog URL.
  if (meta?.catalogMode === 'dynamic' && hasUsableDynamicCatalogConfig(context) && !explicit.includes(context.provider)) {
    return [...explicit, context.provider];
  }
  if (resolveApiKey(context.provider) && !explicit.includes(context.provider)) {
    return [...explicit, context.provider];
  }
  return explicit;
}

export async function getProviderModels(provider: string, context: OperatorLlmCatalogContext): Promise<string[]> {
  const meta = PROVIDER_METADATA[provider];
  if (meta?.catalogMode === 'dynamic') {
    const result = await discoverOllamaModels({
      baseUrl: context.baseUrl,
      configuredModel: context.model,
      timeoutMs: context.catalogTimeoutMs,
      cacheTtlMs: context.catalogCacheTtlMs,
    });
    if (result.ok) {
      return result.data.models;
    }
    // Invalid base URL scheme — log and expose only the configured model
    console.warn(`[llm-catalog] Ollama discovery error (${result.error.code}): ${result.error.message}. Exposing configured model only.`);
    return [context.model];
  }
  return getLlmProviderModels(provider);
}

export async function validateAiModelSelection(
  selection: { provider: string; lightModel: string; heavyModel: string },
  context: OperatorLlmCatalogContext,
): Promise<Array<{ code: 'custom'; path: string[]; message: string }>> {
  const available = new Set(getAvailableProviders(context));
  if (!available.has(selection.provider)) {
    return [{ code: 'custom', path: ['provider'], message: 'Selected provider is not available on this platform' }];
  }

  const meta = PROVIDER_METADATA[selection.provider];
  if (meta?.catalogMode === 'dynamic') {
    // Validate against the live-discovered catalog (with soft-expiry cache and static fallback)
    const models = await getProviderModels(selection.provider, context);
    const issues: Array<{ code: 'custom'; path: string[]; message: string }> = [];
    if (!models.includes(selection.lightModel)) {
      issues.push({ code: 'custom', path: ['lightModel'], message: 'Selected economy model is not available for this provider' });
    }
    if (!models.includes(selection.heavyModel)) {
      issues.push({ code: 'custom', path: ['heavyModel'], message: 'Selected premium model is not available for this provider' });
    }
    return issues;
  }

  return validateLlmModelSelection(selection);
}

/**
 * Revalidate a persisted user model selection against the live catalog.
 * For dynamic providers (Ollama) this checks that the selected model is still
 * present in the discovered catalog. For static providers it delegates to domain.
 * Returns the selection unchanged if valid, or null if it should be ignored.
 */
export async function revalidatePersistedSelection(
  selection: { provider: string; lightModel: string; heavyModel: string },
  context: OperatorLlmCatalogContext,
): Promise<{ provider: string; lightModel: string; heavyModel: string } | null> {
  const meta = PROVIDER_METADATA[selection.provider];
  if (meta?.catalogMode !== 'dynamic') {
    // Static providers are validated by the domain normalizer already
    return selection;
  }

  // Dynamic provider — check availability first
  if (!getAvailableProviders(context).includes(selection.provider)) {
    return null;
  }

  // Then validate model names against the live-discovered catalog
  const models = await getProviderModels(selection.provider, context);
  if (!models.includes(selection.lightModel) || !models.includes(selection.heavyModel)) {
    return null;
  }
  return selection;
}

export function normalizeAgentModelPolicy(policy: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!policy) {
    return null;
  }

  const normalized: Record<string, unknown> = { ...policy };
  const provider = typeof normalized.provider === 'string' && normalized.provider.length > 0 ? normalized.provider : null;
  const lightModel = typeof normalized.lightModel === 'string' && normalized.lightModel.length > 0 ? normalized.lightModel : null;
  const heavyModel = typeof normalized.heavyModel === 'string' && normalized.heavyModel.length > 0 ? normalized.heavyModel : null;

  if (!provider) {
    delete normalized.provider;
    delete normalized.lightModel;
    delete normalized.heavyModel;
    return Object.keys(normalized).length > 0 ? normalized : null;
  }

  normalized.provider = provider;

  if (lightModel) {
    normalized.lightModel = lightModel;
  } else {
    delete normalized.lightModel;
  }

  if (heavyModel) {
    normalized.heavyModel = heavyModel;
  } else {
    delete normalized.heavyModel;
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}