import { z } from 'zod';

// ---- Types ----

export interface OpenRouterPricingResult {
  models: Record<string, { inputUsdPerM: number; outputUsdPerM: number; reasoningUsdPerM?: number; cacheReadUsdPerM?: number }>;
}

// ---- Zod Schemas ----

const OpenRouterPricingSchema = z.object({
  prompt: z.string().optional(),
  completion: z.string().optional(),
  request: z.string().optional(),
  cache_read: z.string().optional(),
});

const OpenRouterModelSchema = z.object({
  id: z.string().min(1),
  pricing: OpenRouterPricingSchema.optional(),
});

const OpenRouterModelsResponseSchema = z.object({
  data: z.array(OpenRouterModelSchema).optional(),
});

// ---- Public API ----

/**
 * Fetch live model pricing from OpenRouter's /v1/models endpoint.
 * Returns pricing in USD per 1M tokens. No caching — caller is responsible
 * for persisting results via llm_pricing_snapshots.
 *
 * @returns Pricing keyed by model ID (e.g. "openai/gpt-5.5"), or empty record on failure.
 */
export async function fetchOpenRouterPricing(params: {
  apiKey: string;
  fetchUrl: string;
  timeoutMs: number;
}): Promise<OpenRouterPricingResult> {
  const modelsUrl = toOpenRouterModelsUrl(params.fetchUrl);
  if (!modelsUrl) {
    return { models: {} };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs);

  try {
    const response = await fetch(modelsUrl, {
      signal: controller.signal,
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
      },
    });

    if (!response.ok) {
      console.warn(`[openrouter-pricing] HTTP ${response.status} from ${modelsUrl}`);
      return { models: {} };
    }

    const payload = OpenRouterModelsResponseSchema.parse(await response.json());
    const modelRecords = payload.data ?? [];

    const models: Record<string, { inputUsdPerM: number; outputUsdPerM: number; reasoningUsdPerM?: number; cacheReadUsdPerM?: number }> = {};

    for (const record of modelRecords) {
      if (!record.pricing) continue;

      const inputUsd = parseUsdDecimal(record.pricing.prompt);
      const outputUsd = parseUsdDecimal(record.pricing.completion);

      if (inputUsd === null || outputUsd === null) continue;

      // Convert per-token USD to per-1M-tokens USD
      const inputUsdPerM = inputUsd * 1_000_000;
      const outputUsdPerM = outputUsd * 1_000_000;

      if (!Number.isFinite(inputUsdPerM) || !Number.isFinite(outputUsdPerM)) continue;

      const cacheReadUsd = parseUsdDecimal(record.pricing.cache_read);
      const cacheReadUsdPerM = cacheReadUsd !== null && Number.isFinite(cacheReadUsd * 1_000_000)
        ? cacheReadUsd * 1_000_000
        : undefined;

      models[record.id] = {
        inputUsdPerM,
        outputUsdPerM,
        ...(cacheReadUsdPerM !== undefined ? { cacheReadUsdPerM } : {}),
      };
    }

    return { models };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[openrouter-pricing] Fetch failed: ${message}`);
    return { models: {} };
  } finally {
    clearTimeout(timeout);
  }
}

// ---- Internal helpers ----

function parseUsdDecimal(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function toOpenRouterModelsUrl(baseUrl: string): string | null {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const cleanPath = parsed.pathname.replace(/\/+$/, '');
    const rootPath = cleanPath.endsWith('/v1') ? cleanPath.slice(0, -3) : cleanPath;
    const modelsUrl = new URL(parsed.origin);
    modelsUrl.pathname = `${rootPath}/v1/models`;
    return modelsUrl.toString();
  } catch {
    return null;
  }
}
