import type { NomadClient } from './nomad-client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('service-registry');

// ── Interface ───────────────────────────────────────────────────────────────

/**
 * Resolves infrastructure service URLs at runtime.
 *
 * The worker uses a ServiceRegistry to look up service addresses (browser
 * pool, future pools) instead of hard-coding URLs. Implementations vary by
 * runtime backend:
 *
 * - **StaticServiceRegistry** — reads URLs from operator config. Used with
 *   Docker Compose where service names are predictable.
 * - **NomadServiceRegistry** — queries the Nomad service catalog with a TTL
 *   cache. Used on Nomad clusters where services get dynamic IPs.
 * - **CompositeServiceRegistry** — static first, Nomad fallback. Operator
 *   overrides always win; dynamic discovery fills the gaps.
 */
export interface ServiceRegistry {
  /**
   * Resolve a service name to a URL.
   *
   * @returns The service URL (e.g. `http://10.0.1.5:3000`), or `null` if
   *   the service cannot be resolved.
   */
  resolve(serviceName: string): Promise<string | null>;
}

// ── Static ──────────────────────────────────────────────────────────────────

/**
 * Resolves services from a static map of name → URL.
 * Used in Docker Compose environments where service names are stable.
 */
export class StaticServiceRegistry implements ServiceRegistry {
  private readonly urls: ReadonlyMap<string, string>;

  constructor(urls: Record<string, string>) {
    this.urls = new Map(
      Object.entries(urls).filter(([, url]) => url.length > 0),
    );
  }

  async resolve(serviceName: string): Promise<string | null> {
    return this.urls.get(serviceName) ?? null;
  }
}

// ── Nomad ───────────────────────────────────────────────────────────────────

interface CacheEntry {
  url: string;
  expiresAt: number;
}

/**
 * Resolves services by querying the Nomad native service catalog
 * (`GET /v1/service/<name>`).
 *
 * Results are cached with a configurable TTL to avoid hitting Nomad on
 * every agent launch. A failed lookup returns `null` and does not cache
 * the failure — the next call retries.
 */
export class NomadServiceRegistry implements ServiceRegistry {
  private readonly client: NomadClient;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(client: NomadClient, cacheTtlMs = 60_000) {
    this.client = client;
    this.cacheTtlMs = cacheTtlMs;
  }

  async resolve(serviceName: string): Promise<string | null> {
    // Check cache
    const cached = this.cache.get(serviceName);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.url;
    }

    // Query Nomad
    const resolved = await this.client.resolveService(serviceName);
    if (!resolved) {
      // Don't cache failures — allow retry on next call
      this.cache.delete(serviceName);
      return null;
    }

    const url = `http://${resolved.address}:${resolved.port}`;
    this.cache.set(serviceName, { url, expiresAt: Date.now() + this.cacheTtlMs });
    logger.info({ serviceName, url, ttlMs: this.cacheTtlMs }, 'Service resolved from Nomad');
    return url;
  }
}

// ── Composite ───────────────────────────────────────────────────────────────

/**
 * Tries a static registry first, falls back to a dynamic registry.
 *
 * Operator-configured URLs (from `config/default.yaml`) always win.
 * When the static URL is empty or absent, the dynamic registry (Nomad
 * service discovery) fills in the address.
 */
export class CompositeServiceRegistry implements ServiceRegistry {
  private readonly primary: ServiceRegistry;
  private readonly fallback: ServiceRegistry;

  constructor(primary: ServiceRegistry, fallback: ServiceRegistry) {
    this.primary = primary;
    this.fallback = fallback;
  }

  async resolve(serviceName: string): Promise<string | null> {
    const url = await this.primary.resolve(serviceName);
    if (url) return url;
    return this.fallback.resolve(serviceName);
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Build the appropriate ServiceRegistry based on the runtime backend.
 *
 * - `docker` / `stub` → StaticServiceRegistry (operator URLs only).
 * - `nomad` → CompositeServiceRegistry (static override + Nomad discovery).
 */
export function buildServiceRegistry(
  runtimeBackend: 'docker' | 'nomad' | 'stub',
  staticUrls: Record<string, string>,
  nomadClient?: NomadClient,
): ServiceRegistry {
  const staticRegistry = new StaticServiceRegistry(staticUrls);

  if (runtimeBackend === 'nomad' && nomadClient) {
    const nomadRegistry = new NomadServiceRegistry(nomadClient);
    return new CompositeServiceRegistry(staticRegistry, nomadRegistry);
  }

  return staticRegistry;
}
