import { getProviderModelIds, validateLlmModelSelection, type ProvidersYaml, type ModelPricing } from '@herobids/domain';
import { llmPricingSnapshots, type Database } from '@herobids/db';
import { eq, and } from 'drizzle-orm';
import { discoverOllamaModels } from './ollama-model-discovery.js';

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

// --- Internal helpers ---

// Legacy OpenRouter pricing types used by UI formatting helpers (deriveLatestVariants, mapOpenRouterModelPricingMetadata).
// These are kept for compatibility with existing presentation logic.
// New code should work with ModelPricing from @herobids/domain and convert via modelPricingToOpenRouter().

interface OpenRouterModelPricing {
  prompt?: string;
  completion?: string;
  request?: string;
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

// --- :latest tag derivation ---

/**
 * Compare two dot-separated version strings in descending order.
 * "5.5" > "5.4" > "4.1" > "4"
 */
function compareVersionsDesc(a: string, b: string): number {
  const aParts = a.split('.').map(Number);
  const bParts = b.split('.').map(Number);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const av = aParts[i] ?? 0;
    const bv = bParts[i] ?? 0;
    if (av !== bv) return bv - av; // descending
  }
  return 0;
}

/** Family extraction pattern: strip trailing -<version> where version is DIGITS[.DIGITS]* */
const FAMILY_VERSION_RE = /^(.+)-(\d+(?:\.\d+)*)$/;

/**
 * Derive :latest tag variants from a raw OpenRouter model catalog.
 *
 * OpenRouter's /v1/models endpoint returns individually-versioned model IDs
 * (e.g. openai/gpt-5.5, anthropic/claude-sonnet-4.6) but does NOT include
 * :latest aliases.  This function generates :latest entries so they appear in
 * the UI model picker and pass validation.
 *
 * Only major-level :latest aliases are produced (e.g. openai/gpt-5:latest).
 * Broader family-level aliases (e.g. openai/gpt:latest) are intentionally
 * excluded because they have no corresponding entries in the static pricing
 * fallback, which would cause validation failures when the dynamic catalog
 * is unavailable.
 *
 * Pricing is copied from the highest-versioned member of each group.
 */
export function deriveLatestVariants(catalog: OpenRouterCatalog): OpenRouterCatalog {
  const { modelIds, pricingByModel } = catalog;
  const newModelIds = [...modelIds];
  const newPricingByModel = { ...pricingByModel };

  // --- Pass 1: family-level (strip trailing -<version>) ---
  // family → { version, modelId }[]
  const families = new Map<string, { version: string; modelId: string }[]>();

  for (const modelId of modelIds) {
    if (modelId.endsWith(':latest')) continue;
    const m = modelId.match(FAMILY_VERSION_RE);
    if (!m) continue;
    const family = m[1]!;
    const version = m[2]!;

    let entry = families.get(family);
    if (!entry) {
      entry = [];
      families.set(family, entry);
    }
    entry.push({ version, modelId });
  }

  // --- Pass 2: sub-family / major-level (strip .minor from version) ---
  // subFamily (family-major) → { version, modelId }[]
  const subFamilies = new Map<string, { version: string; modelId: string }[]>();

  for (const [, members] of families) {
    for (const member of members) {
      const dotIdx = member.version.indexOf('.');
      if (dotIdx === -1) continue; // no minor version to strip
      const major = member.version.slice(0, dotIdx);
      // Find the family this member belongs to — scan families for a hit.
      // We need the family prefix. Re-extract from the modelId.
      const m = member.modelId.match(FAMILY_VERSION_RE);
      if (!m) continue;
      const family = m[1]!;
      const subFamily = `${family}-${major}`;

      let sub = subFamilies.get(subFamily);
      if (!sub) {
        sub = [];
        subFamilies.set(subFamily, sub);
      }
      sub.push(member);
    }
  }

  // --- Emit :latest variants ---

  const emit = (latestId: string, members: { version: string; modelId: string }[]) => {
    if (members.length < 2) return; // pointless with a single version
    // Already have the highest first? Sort just to be safe.
    const sorted = [...members].sort((a, b) => compareVersionsDesc(a.version, b.version));
    const latestModelId = sorted[0]!.modelId;
    const latestPricing = pricingByModel[latestModelId];

    newModelIds.push(latestId);
    if (latestPricing) {
      newPricingByModel[latestId] = latestPricing;
    }
  };

  for (const [subFamily, members] of subFamilies) {
    emit(`${subFamily}:latest`, members);
  }

  return {
    modelIds: [...new Set(newModelIds)].sort(),
    pricingByModel: newPricingByModel,
  };
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

function buildOpenRouterPricingLabel(inputUsdPer1M: string | undefined, outputUsdPer1M: string | undefined): string {
  const input = inputUsdPer1M ? Number(inputUsdPer1M) : null;
  const output = outputUsdPer1M ? Number(outputUsdPer1M) : null;

  if (isFiniteNumber(input) && isFiniteNumber(output)) {
    return `$${formatDecimalLabel(input)} / $${formatDecimalLabel(output)}`;
  }
  return 'Usage-based';
}

/**
 * Convert a DB ModelPricing snapshot (numeric USD-per-1M) to the legacy
 * OpenRouterModelPricing string format used by UI formatting helpers.
 */
function modelPricingToOpenRouter(pricing: ModelPricing): OpenRouterModelPricing {
  return {
    prompt: (pricing.inputUsdPerM / 1_000_000).toFixed(10),
    completion: (pricing.outputUsdPerM / 1_000_000).toFixed(10),
  };
}

/**
 * Get the active pricing snapshot for a provider from the database.
 * Returns null if no active snapshot exists (worker hasn't fetched yet).
 */
async function getDbPricingSnapshot(
  db: Database,
  provider: string,
): Promise<Record<string, ModelPricing> | null> {
  const [row] = await db
    .select({ models: llmPricingSnapshots.models })
    .from(llmPricingSnapshots)
    .where(
      and(
        eq(llmPricingSnapshots.provider, provider),
        eq(llmPricingSnapshots.isActive, true),
      ),
    )
    .limit(1);

  return (row?.models as Record<string, ModelPricing>) ?? null;
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

// --- LlmCatalogDeps ---

/** Dependencies required by catalog functions after Phase 4 refactor. */
export interface LlmCatalogDeps {
  db: Database;
  providersYaml: ProvidersYaml;
  context: OperatorLlmCatalogContext;
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

export async function getAvailableProviders(deps: LlmCatalogDeps): Promise<string[]> {
  const providers: string[] = [];
  const isProduction = process.env['NODE_ENV'] === 'production';

  for (const [providerId, config] of Object.entries(deps.providersYaml.providers)) {
    // In production, only expose dynamic providers (static pricing goes stale)
    if (isProduction && config.catalogMode !== 'dynamic') continue;
    // Hide dev-only providers in production
    if (config.devOnly && isProduction) continue;

    // Dynamic providers must have an active pricing snapshot in production
    if (config.catalogMode === 'dynamic' && isProduction) {
      const hasSnapshot = !!(await getDbPricingSnapshot(deps.db, providerId));
      if (!hasSnapshot) continue;
    }

    providers.push(providerId);
  }

  return providers.sort();
}

export async function getProviderModels(provider: string, deps: LlmCatalogDeps): Promise<string[]> {
  const providerConfig = deps.providersYaml.providers[provider];

  if (provider === 'openrouter') {
    const snapshot = await getDbPricingSnapshot(deps.db, provider);
    if (snapshot) {
      const modelIds = Object.keys(snapshot);
      if (modelIds.length > 0) return modelIds;
    }
    // Fallback to static model list from providers.yaml
    return getProviderModelIds(providerConfig);
  }

  if (providerConfig?.catalogMode === 'dynamic') {
    // Ollama — live discovery
    const result = await discoverOllamaModels({
      baseUrl: deps.context.baseUrl,
      configuredModel: deps.context.model,
      timeoutMs: deps.context.catalogTimeoutMs,
      cacheTtlMs: deps.context.catalogCacheTtlMs,
    });
    if (result.ok) {
      return result.data.models;
    }
    console.warn(`[llm-catalog] Ollama discovery error (${result.error.code}): ${result.error.message}. Exposing configured model only.`);
    return [deps.context.model];
  }

  return getProviderModelIds(providerConfig);
}

export async function getProviderCatalogEntry(
  provider: string,
  deps: LlmCatalogDeps,
): Promise<ProviderCatalogEntry> {
  const providerConfig = deps.providersYaml.providers[provider];
  const isMultiProvider = providerConfig?.isMultiProvider === true ? true : undefined;

  if (provider === 'openrouter') {
    const snapshot = await getDbPricingSnapshot(deps.db, provider);
    const modelIds = snapshot ? Object.keys(snapshot) : getProviderModelIds(providerConfig);

    // Convert DB ModelPricing → legacy OpenRouterModelPricing format for UI helpers
    const pricingByModel: Record<string, OpenRouterModelPricing> = {};
    if (snapshot) {
      for (const [modelId, mp] of Object.entries(snapshot)) {
        pricingByModel[modelId] = modelPricingToOpenRouter(mp);
      }
    }

    // Apply :latest variant derivation (presentation logic)
    const enriched = deriveLatestVariants({ modelIds, pricingByModel });

    return {
      provider,
      models: mapProviderModels(
        enriched.modelIds,
        (modelId) => mapOpenRouterModelPricingMetadata(enriched.pricingByModel[modelId]),
      ).filter((m) => m.pricing !== undefined),
      isMultiProvider,
    };
  }

  const models = await getProviderModels(provider, deps);

  if (provider === 'ollama' && isLocalProviderEndpoint(deps.context.baseUrl, deps.context.catalogLocality)) {
    return {
      provider,
      models: mapProviderModels(models, () => ({ label: 'Free', source: 'local' })),
      isMultiProvider,
    };
  }

  // ⚠️ DO NOT add pricing for static providers here.
  //
  // Production policy (docs/features/2026/06/27/006-dynamic-llm-pricing/001-plan.md):
  //   "Production continues to expose only catalogMode: 'dynamic' providers (OpenRouter).
  //    Static providers remain dev-only."
  //
  // Static pricing from providers.yaml goes stale — only DB-snapshot pricing
  // (refreshed hourly from OpenRouter) is considered reliable for user display.
  // The UI's resolveModelPricing() already handles the case where pricing is
  // absent by falling back to a budget-target display.
  return {
    provider,
    models: mapProviderModels(models),
    isMultiProvider,
  };
}

export async function validateAiModelSelection(
  selection: { provider: string; lightModel: string; heavyModel: string },
  deps: LlmCatalogDeps,
): Promise<Array<{ code: 'custom'; path: string[]; message: string }>> {
  const available = await getAvailableProviders(deps);
  if (!available.includes(selection.provider)) {
    return [{ code: 'custom', path: ['provider'], message: 'Selected provider is not available on this platform' }];
  }

  const providerConfig = deps.providersYaml.providers[selection.provider];
  if (providerConfig?.catalogMode === 'dynamic') {
    // Validate against the live-discovered catalog (DB snapshot or Ollama discovery)
    const models = await getProviderModels(selection.provider, deps);
    const issues: Array<{ code: 'custom'; path: string[]; message: string }> = [];
    if (!models.includes(selection.lightModel)) {
      issues.push({ code: 'custom', path: ['lightModel'], message: 'Selected economy model is not available for this provider' });
    }
    if (!models.includes(selection.heavyModel)) {
      issues.push({ code: 'custom', path: ['heavyModel'], message: 'Selected premium model is not available for this provider' });
    }
    return issues;
  }

  return validateLlmModelSelection(selection, providerConfig);
}

/**
 * Revalidate a persisted user model selection against the live catalog.
 * For dynamic providers (Ollama, OpenRouter) this checks that the selected model is still
 * present in the discovered catalog. For static providers it delegates to domain.
 * Returns the selection unchanged if valid, or null if it should be ignored.
 */
export async function revalidatePersistedSelection(
  selection: { provider: string; lightModel: string; heavyModel: string },
  deps: LlmCatalogDeps,
): Promise<{ provider: string; lightModel: string; heavyModel: string } | null> {
  const providerConfig = deps.providersYaml.providers[selection.provider];
  if (!providerConfig || providerConfig.catalogMode !== 'dynamic') {
    // Static providers are validated by the domain normalizer already
    return selection;
  }

  // Dynamic provider — check availability first
  const available = await getAvailableProviders(deps);
  if (!available.includes(selection.provider)) {
    return null;
  }

  // Then validate model names against the live-discovered catalog
  const models = await getProviderModels(selection.provider, deps);
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