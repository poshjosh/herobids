/**
 * Ollama-specific model discovery client.
 *
 * Ollama exposes a native catalog endpoint at GET /api/tags that is NOT part of
 * the OpenAI-compatible API surface. This module implements discovery specifically
 * for Ollama and must not be used for generic OpenAI-compatible providers, hosted
 * API gateways, or any other endpoint.
 *
 * The fetch target is derived solely from the operator-configured llm.baseUrl
 * and is never influenced by user input or agent payloads (SSRF mitigation).
 */

import { z } from 'zod';
import type { Result } from '@herobids/domain';
import { ok, err } from '@herobids/domain';

// --- Types ---

export type OllamaDiscoveryErrorCode =
  | 'catalog.invalid_base_url'
  | 'catalog.timeout'
  | 'catalog.network_error'
  | 'catalog.invalid_response';

export interface OllamaDiscoveryError {
  code: OllamaDiscoveryErrorCode;
  message: string;
}

export interface OllamaDiscoverySuccess {
  models: string[];
  /** 'dynamic' = live fetch or stale cache. 'fallback' = cold-start failure with no prior cache. */
  source: 'dynamic' | 'fallback';
}

// --- Zod schema for /api/tags response ---

const OllamaTagsResponseSchema = z.object({
  models: z.array(
    z.object({
      name: z.string().min(1),
    }).passthrough(),
  ),
});

// --- In-memory soft-expiry cache ---

interface CacheEntry {
  models: string[];
  fetchedAt: number;
}

const ollamaModelCache = new Map<string, CacheEntry>();
// In-flight deduplication: concurrent callers during a cache miss share one pending fetch
const inFlight = new Map<string, Promise<Result<string[], OllamaDiscoveryError>>>();

// --- URL normalization ---

/**
 * Normalise a chat baseUrl (which may end in /v1) into the Ollama /api/tags catalog URL.
 *
 * Normalization rules:
 *   - Must be http: or https: scheme.
 *   - Trailing slash is removed from the path.
 *   - Terminal /v1 segment is stripped (Ollama native endpoint lives above the OpenAI compat path).
 *   - /api/tags is appended.
 *   - Query string and hash are dropped.
 *
 * Examples:
 *   http://host.docker.internal:11434/v1  →  http://host.docker.internal:11434/api/tags
 *   http://host.docker.internal:11434/v1/ →  http://host.docker.internal:11434/api/tags
 *   https://proxy.example.com/ollama/v1   →  https://proxy.example.com/ollama/api/tags
 *   http://localhost:11434                →  http://localhost:11434/api/tags
 */
export function normalizeOllamaCatalogUrl(baseUrl: string): Result<string, OllamaDiscoveryError> {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return err({ code: 'catalog.invalid_base_url', message: `Cannot parse configured baseUrl as a URL: ${baseUrl}` });
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return err({
      code: 'catalog.invalid_base_url',
      message: `Unsupported scheme '${parsed.protocol}' in configured baseUrl — must be http or https`,
    });
  }

  // Remove trailing slashes then strip the terminal /v1 segment if present
  let path = parsed.pathname.replace(/\/+$/, '');
  if (path.endsWith('/v1')) {
    path = path.slice(0, -3);
  }

  const catalogUrl = new URL(parsed.origin);
  catalogUrl.pathname = path + '/api/tags';
  // Drop query and hash — derived URL must come from operator config only
  return ok(catalogUrl.toString());
}

// --- Internal fetch helper ---

async function fetchOllamaTags(
  catalogUrl: string,
  timeoutMs: number,
): Promise<Result<string[], OllamaDiscoveryError>> {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, timeoutMs);

  try {
    const res = await fetch(catalogUrl, {
      signal: controller.signal,
      redirect: 'error',
    });
    clearTimeout(timer);

    if (!res.ok) {
      return err({ code: 'catalog.network_error', message: `Ollama /api/tags returned HTTP ${res.status}` });
    }

    const body: unknown = await res.json();
    const parsed = OllamaTagsResponseSchema.safeParse(body);
    if (!parsed.success) {
      return err({ code: 'catalog.invalid_response', message: 'Unexpected /api/tags response shape' });
    }

    const models = [...new Set(parsed.data.models.map((m) => m.name))].sort();
    return ok(models);
  } catch (e) {
    clearTimeout(timer);
    const name = (e as Error).name;
    if (name === 'AbortError') {
      return err({ code: 'catalog.timeout', message: `Ollama catalog fetch timed out after ${timeoutMs}ms` });
    }
    return err({
      code: 'catalog.network_error',
      message: `Ollama catalog fetch failed: ${(e as Error).message}`,
    });
  }
}

// --- Public API ---

function mergeModels(models: string[], configuredModel: string): string[] {
  return [...new Set([...models, configuredModel])].sort();
}

/**
 * Discover available Ollama models from the operator-configured /api/tags endpoint.
 *
 * Safety rules:
 *   - Only call when the operator provider is explicitly 'ollama'.
 *   - Target URL is derived solely from operator config; never from user input.
 *   - Uses a short dedicated timeout independent of llm.timeoutMs.
 *   - Soft-expiry cache: entries are marked stale on TTL but never deleted on expiry
 *     so previously-seen catalogs remain available as a fallback.
 *   - Cold-start failure (no cache, no successful fetch): returns only the
 *     operator-configured model — not the domain static list, which reflects hardcoded
 *     examples rather than what the operator has actually installed.
 *   - Concurrent callers during a cache miss share a single in-flight fetch.
 */
export async function discoverOllamaModels(config: {
  baseUrl?: string;
  configuredModel: string;
  timeoutMs: number;
  cacheTtlMs: number;
}): Promise<Result<OllamaDiscoverySuccess, OllamaDiscoveryError>> {
  // No baseUrl — cannot attempt discovery; expose only the configured model.
  // The static domain list contains example model names, not necessarily installed ones.
  if (!config.baseUrl) {
    return ok({ models: [config.configuredModel], source: 'fallback' });
  }

  const urlResult = normalizeOllamaCatalogUrl(config.baseUrl);
  if (!urlResult.ok) {
    // Invalid or unsupported scheme — surface error so the caller can log it
    return urlResult;
  }
  const catalogUrl = urlResult.data;

  const now = Date.now();
  const cached = ollamaModelCache.get(catalogUrl);

  // Fresh cache — return immediately without a network call
  if (cached && now - cached.fetchedAt < config.cacheTtlMs) {
    return ok({ models: mergeModels(cached.models, config.configuredModel), source: 'dynamic' });
  }

  // Stale or missing — deduplicate in-flight fetches
  let pending = inFlight.get(catalogUrl);
  if (!pending) {
    pending = fetchOllamaTags(catalogUrl, config.timeoutMs).then((result) => {
      inFlight.delete(catalogUrl);
      if (result.ok) {
        ollamaModelCache.set(catalogUrl, { models: result.data, fetchedAt: Date.now() });
      }
      return result;
    });
    inFlight.set(catalogUrl, pending);
  }

  const fetchResult = await pending;

  if (fetchResult.ok) {
    const entry = ollamaModelCache.get(catalogUrl);
    const models = entry ? mergeModels(entry.models, config.configuredModel) : mergeModels(fetchResult.data, config.configuredModel);
    return ok({ models, source: 'dynamic' });
  }

  // Fetch failed — try stale cache first
  if (cached) {
    console.warn(
      `[ollama-discovery] Re-fetch failed (${fetchResult.error.code}): ${fetchResult.error.message}. Serving stale catalog.`,
    );
    return ok({ models: mergeModels(cached.models, config.configuredModel), source: 'dynamic' });
  }

  // Cold-start failure — no cache and fetch failed; expose only the configured model
  console.warn(
    `[ollama-discovery] Cold-start failure (${fetchResult.error.code}): ${fetchResult.error.message}. Falling back to configured model only.`,
  );
  return ok({ models: [config.configuredModel], source: 'fallback' });
}

/** Exposed for tests — clears the in-memory cache and in-flight map. */
export function clearOllamaModelCache(): void {
  ollamaModelCache.clear();
  inFlight.clear();
}
