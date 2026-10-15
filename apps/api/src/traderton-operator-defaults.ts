// Boundary-sourced operator defaults reader with an in-process TTL cache.
//
// C2.1 consumption half: traderton is the sole authority for the 17-field
// `agentRiskDefaults` block. herobids reads it via the `get_operator_defaults`
// boundary tool (owner-scoped, no venue) and caches the parsed result so the
// display-only auto-fill endpoint (`GET /agents/risk-defaults`) does not hit the
// boundary on every render. Failures are NOT cached — the next call retries.
//
// The shape mirrors `loadBoundaryObject` in exports-traderton.js but normalizes
// the payload through `AgentRiskDefaultsSchema` BEFORE caching, so callers get
// typed data (not a raw record).

import {
  AgentRiskDefaultsSchema,
  type AgentRiskDefaultsConfig,
} from '@herobids/domain';
import {
  mapNonSuccessToError,
  type ReadBoundaryError,
  type TradertonReadBoundary,
} from './routes/exports-traderton.js';

/** Default TTL: operator defaults change rarely; a long cache is safe for a display fallback. */
const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

/** The operator-defaults payload herobids consumes: the agent risk defaults. */
export type OperatorDefaults = AgentRiskDefaultsConfig;

interface CacheEntry {
  data: OperatorDefaults;
  fetchedAt: number;
}

let cachedEntry: CacheEntry | null = null;
let cachedTtlMs: number | null = null;

/**
 * Read operator defaults (risk) over the Traderton boundary, cached with a TTL.
 *
 * - Invokes `get_operator_defaults` with an empty payload `{}`.
 * - On success, validates + normalizes the payload through
 *   `AgentRiskDefaultsSchema`. A parse failure becomes a `502` ReadBoundaryError.
 * - Caches ONLY `{ ok: true }` successes keyed by TTL; failures never cache.
 *
 * The cache key is the TTL duration (not the boundary identity): a single global
 * entry is sufficient because operator defaults are operator-global, not
 * per-subject. Callers that need to bypass the cache (e.g. tests) can pass a
 * distinct `ttlMs`.
 */
// No in-flight dedup: a concurrent cold-cache stampede is acceptable for a
// low-frequency display endpoint with a long TTL. The cache key is `ttlMs`, so
// differing `opts.ttlMs` values form distinct entries.
export async function loadOperatorRiskDefaults(
  boundary: TradertonReadBoundary,
  opts?: { ttlMs?: number },
): Promise<{ ok: true; data: OperatorDefaults } | { ok: false; error: ReadBoundaryError }> {
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const now = Date.now();

  if (cachedEntry && cachedTtlMs === ttlMs && now - cachedEntry.fetchedAt < ttlMs) {
    return { ok: true, data: cachedEntry.data };
  }

  const result = await boundary.invoke({ toolName: 'get_operator_defaults', payload: {} });
  if (result.kind !== 'success') {
    return { ok: false, error: mapNonSuccessToError(result) };
  }

  const riskParsed = AgentRiskDefaultsSchema.safeParse(result.data);
  // Note: `AgentRiskDefaultsSchema` declares full per-field `.default(...)`, so a
  // semantically-empty `{}` from a misconfigured boundary parses successfully and
  // yields the schema defaults — this branch only fires on a wrongly-typed field
  // (e.g. a string where a number is expected).
  if (!riskParsed.success) {
    return {
      ok: false,
      error: {
        status: 502,
        code: 'risk_defaults.invalid_response',
        message: 'Traderton returned invalid operator risk defaults',
      },
    };
  }

  const data: OperatorDefaults = riskParsed.data;
  cachedEntry = { data, fetchedAt: now };
  cachedTtlMs = ttlMs;
  return { ok: true, data };
}

/** Exposed for tests — clears the in-memory cache. */
export function clearOperatorRiskDefaultsCache(): void {
  cachedEntry = null;
  cachedTtlMs = null;
}