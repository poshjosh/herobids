import { KNOWN_LLM_PROVIDERS as KNOWN_PROVIDERS, PROVIDER_DEFINITIONS, getLlmProviderModels, validateLlmModelSelection } from '@herobids/domain';
import type { LlmProviderDefinition } from '@herobids/domain';
import { discoverOllamaModels, normalizeOllamaCatalogUrl } from './ollama-model-discovery.js';

// --- Provider catalog metadata ---

export interface ModelPricingMetadata {
  label: string;
  source: 'openrouter' | 'local';
  inputUsdPer1M?: string;
  outputUsdPer1M?: string;
  requestUsd?: string;
}

export interface ProviderModelEntry {
  id: string;
  pricing?: ModelPricingMetadata;
}

export interface ProviderCatalogEntry {
  provider: string;
  models: ProviderModelEntry[];
  isMultiProvider?: boolean;
}

// Provider metadata is now owned by domain — see PROVIDER_DEFINITIONS in @herobids/domain.
const PROVIDER_METADATA = PROVIDER_DEFINITIONS;

// --- Operator context ---

/** Operator-level LLM config context passed to all catalog helpers. */
export interface OperatorLlmCatalogContext {
  provider: string;
  model: string;
  baseUrl?: string;
  catalogTimeoutMs: number;
  catalogCacheTtlMs: number;
  catalogLocality: 'auto' | 'local' | 'remote';
}

interface OpenRouterModelPricing {
  prompt?: string;
  completion?: string;
  request?: string;
}

interface OpenRouterModelRecord {
  id: string;
  pricing?: OpenRouterModelPricing;
}

interface OpenRouterModelsResponse {
  data?: OpenRouterModelRecord[];
}

interface OpenRouterPricingCacheEntry {
  catalog: OpenRouterCatalog;
  fetchedAt: number;
}

interface OpenRouterCatalog {
  modelIds: string[];
  pricingByModel: Record<string, OpenRouterModelPricing>;
}

interface ParsedOpenRouterPricing {
  promptPerToken: number;
  completionPerToken: number;
  requestUsd?: number;
}

const openRouterPricingCache = new Map<string, OpenRouterPricingCacheEntry>();
const openRouterPricingInFlight = new Map<string, Promise<OpenRouterCatalog>>();

// --- Internal helpers ---

function resolveApiKey(provider: string): string | undefined {
  return process.env[`LLM_API_KEY_${provider.toUpperCase()}`] ?? process.env['LLM_API_KEY'];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function formatDecimalLabel(value: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
    useGrouping: false,
  });
}

function parseUsdDecimal(raw: string | undefined): number | null {
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseOpenRouterPricing(pricing: OpenRouterModelPricing): ParsedOpenRouterPricing | null {
  const promptPerToken = parseUsdDecimal(pricing.prompt);
  const completionPerToken = parseUsdDecimal(pricing.completion);

  if (promptPerToken === null || completionPerToken === null) {
    return null;
  }

  const requestUsd = parseUsdDecimal(pricing.request);
  return {
    promptPerToken,
    completionPerToken,
    ...(requestUsd === null ? {} : { requestUsd }),
  };
}

function asUsdPer1M(raw: string | undefined): string | undefined {
  const value = parseUsdDecimal(raw);
  if (value === null) {
    return undefined;
  }
  return (value * 1_000_000).toFixed(6);
}

function asValidatedUsd(raw: string | undefined): string | undefined {
  return parseUsdDecimal(raw) === null ? undefined : raw;
}

function hasOpenRouterCatalogEntries(catalog: OpenRouterCatalog): boolean {
  return catalog.modelIds.length > 0 || Object.keys(catalog.pricingByModel).length > 0;
}

function isFreeOpenRouterPricing(pricing: OpenRouterModelPricing): boolean {
  const parsed = parseOpenRouterPricing(pricing);
  if (!parsed) {
    return false;
  }
  if (parsed.promptPerToken !== 0 || parsed.completionPerToken !== 0) {
    return false;
  }

  if (pricing.request === undefined) {
    return true;
  }

  return parseUsdDecimal(pricing.request) === 0;
}

function resolveOpenRouterBaseUrl(context: OperatorLlmCatalogContext): string {
  if (context.provider === 'openrouter' && context.baseUrl) {
    return context.baseUrl;
  }
  return 'https://openrouter.ai/api/v1';
}

function toOpenRouterModelsUrl(baseUrl: string): string | null {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }

    const cleanPath = parsed.pathname.replace(/\/+$/, '');
    const rootPath = cleanPath.endsWith('/v1') ? cleanPath.slice(0, -3) : cleanPath;
    const modelsUrl = new URL(parsed.origin);
    modelsUrl.pathname = `${rootPath}/v1/models`;
    return modelsUrl.toString();
  } catch {
    return null;
  }
}

function buildOpenRouterPricingLabel(inputUsdPer1M: string | undefined, outputUsdPer1M: string | undefined): string {
  const input = inputUsdPer1M ? Number(inputUsdPer1M) : null;
  const output = outputUsdPer1M ? Number(outputUsdPer1M) : null;

  if (isFiniteNumber(input) && isFiniteNumber(output)) {
    return `$${formatDecimalLabel(input)} / $${formatDecimalLabel(output)}`;
  }
  return 'Usage-based';
}

async function fetchOpenRouterCatalog(
  context: OperatorLlmCatalogContext,
): Promise<OpenRouterCatalog> {
  const apiKey = resolveApiKey('openrouter');
  if (!apiKey) {
    return { modelIds: [], pricingByModel: {} };
  }

  const modelsUrl = toOpenRouterModelsUrl(resolveOpenRouterBaseUrl(context));
  if (!modelsUrl) {
    return { modelIds: [], pricingByModel: {} };
  }

  const now = Date.now();
  const cached = openRouterPricingCache.get(modelsUrl);
  if (cached && now - cached.fetchedAt < context.catalogCacheTtlMs) {
    return cached.catalog;
  }

  let pending = openRouterPricingInFlight.get(modelsUrl);
  if (!pending) {
    pending = (async (): Promise<OpenRouterCatalog> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), context.catalogTimeoutMs);

      try {
        const response = await fetch(modelsUrl, {
          signal: controller.signal,
          redirect: 'error',
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        });

        if (!response.ok) {
          console.warn(`[llm-catalog] OpenRouter model catalog returned HTTP ${response.status}.`);
          return { modelIds: [], pricingByModel: {} };
        }

        const payload = await response.json() as OpenRouterModelsResponse;
        const modelRecords = Array.isArray(payload.data) ? payload.data : [];
        const modelIds: string[] = [];
        const pricingByModel: Record<string, OpenRouterModelPricing> = {};

        for (const modelRecord of modelRecords) {
          if (typeof modelRecord.id !== 'string' || modelRecord.id.length === 0) {
            continue;
          }
          modelIds.push(modelRecord.id);
          if (!modelRecord.pricing || typeof modelRecord.pricing !== 'object') {
            continue;
          }

          pricingByModel[modelRecord.id] = {
            prompt: typeof modelRecord.pricing.prompt === 'string' ? modelRecord.pricing.prompt : undefined,
            completion: typeof modelRecord.pricing.completion === 'string' ? modelRecord.pricing.completion : undefined,
            request: typeof modelRecord.pricing.request === 'string' ? modelRecord.pricing.request : undefined,
          };
        }

        return {
          modelIds: [...new Set(modelIds)].sort(),
          pricingByModel,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[llm-catalog] OpenRouter pricing fetch failed: ${message}`);
        return { modelIds: [], pricingByModel: {} };
      } finally {
        clearTimeout(timeout);
      }
    })().then((result) => {
      openRouterPricingInFlight.delete(modelsUrl);
      if (hasOpenRouterCatalogEntries(result)) {
        openRouterPricingCache.set(modelsUrl, {
          catalog: result,
          fetchedAt: Date.now(),
        });
      }
      return result;
    });

    openRouterPricingInFlight.set(modelsUrl, pending);
  }

  const fetched = await pending;
  if (hasOpenRouterCatalogEntries(fetched)) {
    return fetched;
  }

  if (cached) {
    console.warn('[llm-catalog] OpenRouter pricing fetch failed. Serving stale pricing metadata.');
    return cached.catalog;
  }

  return { modelIds: [], pricingByModel: {} };
}

function mapOpenRouterModelPricingMetadata(pricing: OpenRouterModelPricing | undefined): ModelPricingMetadata | undefined {
  if (!pricing) {
    return undefined;
  }

  if (isFreeOpenRouterPricing(pricing)) {
    return {
      label: 'Free',
      source: 'openrouter',
      inputUsdPer1M: asUsdPer1M(pricing.prompt),
      outputUsdPer1M: asUsdPer1M(pricing.completion),
      requestUsd: asValidatedUsd(pricing.request),
    };
  }

  const parsed = parseOpenRouterPricing(pricing);
  if (!parsed) {
    return undefined;
  }

  if (
    parsed.promptPerToken === 0
    && parsed.completionPerToken === 0
    && pricing.request !== undefined
    && parseUsdDecimal(pricing.request) === null
  ) {
    return undefined;
  }

  return {
    label: buildOpenRouterPricingLabel(
      asUsdPer1M(pricing.prompt),
      asUsdPer1M(pricing.completion),
    ),
    source: 'openrouter',
    inputUsdPer1M: asUsdPer1M(pricing.prompt),
    outputUsdPer1M: asUsdPer1M(pricing.completion),
    requestUsd: asValidatedUsd(pricing.request),
  };
}

function mapProviderModels(
  modelIds: string[],
  resolvePricing: (modelId: string) => ModelPricingMetadata | undefined = () => undefined,
): ProviderModelEntry[] {
  return modelIds.map((modelId) => {
    const pricing = resolvePricing(modelId);
    return pricing ? { id: modelId, pricing } : { id: modelId };
  });
}

export function clearOpenRouterPricingCache(): void {
  openRouterPricingCache.clear();
  openRouterPricingInFlight.clear();
}

function isKnownLocalHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '0.0.0.0'
    || normalized === 'host.docker.internal';
}

function isLocalProviderEndpoint(baseUrl: string | undefined, locality: OperatorLlmCatalogContext['catalogLocality']): boolean {
  if (locality === 'local') {
    return true;
  }

  if (locality === 'remote') {
    return false;
  }

  if (!baseUrl) {
    return false;
  }

  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }

    return isKnownLocalHost(parsed.hostname);
  } catch {
    return false;
  }
}

function isProviderExplicitlyConfigured(provider: string): boolean {
  return !!process.env[`LLM_API_KEY_${provider.toUpperCase()}`];
}

function isProviderAllowed(provider: string): boolean {
  const meta = PROVIDER_METADATA[provider];
  if (meta?.devOnly && process.env['NODE_ENV'] === 'production') {
    return false;
  }
  return true;
}

function getConfiguredProviders(): string[] {
  return KNOWN_PROVIDERS.filter((p) => isProviderExplicitlyConfigured(p) && isProviderAllowed(p));
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
  catalog: { timeoutMs: number; cacheTtlMs: number; locality: 'auto' | 'local' | 'remote' };
}): OperatorLlmCatalogContext {
  return {
    provider: llmConfig.provider,
    model: llmConfig.model,
    baseUrl: llmConfig.baseUrl,
    catalogTimeoutMs: llmConfig.catalog.timeoutMs,
    catalogCacheTtlMs: llmConfig.catalog.cacheTtlMs,
    catalogLocality: llmConfig.catalog.locality,
  };
}

export function getAvailableProviders(context: OperatorLlmCatalogContext): string[] {
  const explicit = getConfiguredProviders();
  const meta = PROVIDER_METADATA[context.provider];

  // Dynamic providers (e.g. Ollama) are available whenever the operator explicitly
  // selected them and configured a usable catalog URL — regardless of environment.
  // This takes precedence over the devOnly restriction because the operator made
  // an explicit configuration choice.
  if (meta?.catalogMode === 'dynamic' && hasUsableDynamicCatalogConfig(context) && !explicit.includes(context.provider)) {
    return [...explicit, context.provider];
  }

  if (!isProviderAllowed(context.provider)) {
    return explicit;
  }

  if (resolveApiKey(context.provider) && !explicit.includes(context.provider)) {
    return [...explicit, context.provider];
  }
  return explicit;
}

export async function getProviderModels(provider: string, context: OperatorLlmCatalogContext): Promise<string[]> {
  if (provider === 'openrouter') {
    const catalog = await fetchOpenRouterCatalog(context);
    if (catalog.modelIds.length > 0) {
      return catalog.modelIds;
    }
    return getLlmProviderModels(provider);
  }

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

export async function getProviderCatalogEntry(
  provider: string,
  context: OperatorLlmCatalogContext,
): Promise<ProviderCatalogEntry> {
  const meta = PROVIDER_METADATA[provider];
  const isMultiProvider = meta?.isMultiProvider === true ? true : undefined;

  if (provider === 'openrouter') {
    const catalog = await fetchOpenRouterCatalog(context);
    const models = catalog.modelIds.length > 0 ? catalog.modelIds : getLlmProviderModels(provider);
    return {
      provider,
      models: mapProviderModels(models, (modelId) => mapOpenRouterModelPricingMetadata(catalog.pricingByModel[modelId])),
      isMultiProvider,
    };
  }

  const models = await getProviderModels(provider, context);

  if (provider === 'ollama' && isLocalProviderEndpoint(context.baseUrl, context.catalogLocality)) {
    return {
      provider,
      models: mapProviderModels(models, () => ({ label: 'Free', source: 'local' })),
      isMultiProvider,
    };
  }

  return {
    provider,
    models: mapProviderModels(models),
    isMultiProvider,
  };
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