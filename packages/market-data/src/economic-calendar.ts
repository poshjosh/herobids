import type {
  EconomicEvent,
  EconomicCalendarResult,
  EconomicCalendarError,
  EconomicCalendarProvider,
  Result,
} from '@herobids/domain';
import { ok, err } from '@herobids/domain';
import type { RequestGate } from './types.js';
import { fetchText } from './http.js';
import type { ProviderResponseCache } from './cache.js';

// ============================================================================
// Config interfaces
// ============================================================================

export interface ForexFactoryAdapterConfig {
  baseUrl: string;
  requestTimeoutMs: number;
  requestsPerMinute: number;
  userAgent: string;
  rateLimiter: RequestGate;
  fetchFn?: typeof fetch;
  /** Optional LLM-based HTML parser. When provided, replaces the built-in regex parser. */
  parseHtmlFn?: (html: string) => Promise<EconomicEvent[]>;
}

export interface CompositeEconomicCalendarConfig {
  daysForward: number;
  minImpact: 'high' | 'medium' | 'low';
  currencies: string[];
  maxEvents: number;
  forexFactory: ForexFactoryAdapterConfig;
  /** Optional Redis-backed cache shared across agent runtimes. */
  cache?: ProviderResponseCache;
  /** Cache TTL in milliseconds. Defaults to 3 hours. */
  cacheTtlMs?: number;
}

// ============================================================================
// Constants
// ============================================================================

const IMPACT_RANK: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

const SOURCE_FOREX_FACTORY = 'forex-factory';

// ============================================================================
// Shared helpers
// ============================================================================

function applyFilters(
  events: EconomicEvent[],
  options?: {
    daysForward?: number;
    currencies?: string[];
    minImpact?: 'high' | 'medium' | 'low';
    maxEvents?: number;
  },
): EconomicEvent[] {
  let filtered = events;

  if (options?.minImpact) {
    const minRank = IMPACT_RANK[options.minImpact] ?? 0;
    filtered = filtered.filter(
      (e) => (IMPACT_RANK[e.impact] ?? 0) >= minRank,
    );
  }

  if (options?.currencies && options.currencies.length > 0) {
    const currencySet = new Set(options.currencies.map((c) => c.toUpperCase()));
    filtered = filtered.filter((e) => currencySet.has(e.currency.toUpperCase()));
  }

  if (options?.daysForward !== undefined) {
    const now = Date.now();
    const cutoff = now + options.daysForward * 24 * 60 * 60 * 1000;
    filtered = filtered.filter((e) => {
      const eventTime = new Date(e.time).getTime();
      return eventTime >= now && eventTime <= cutoff;
    });
  }

  if (options?.maxEvents !== undefined && options.maxEvents > 0) {
    filtered = filtered.slice(0, options.maxEvents);
  }

  return filtered;
}

// ============================================================================
// ForexFactoryCalendarAdapter
// ============================================================================

export class ForexFactoryCalendarAdapter implements EconomicCalendarProvider {
  constructor(private readonly config: ForexFactoryAdapterConfig) {}

  async getUpcomingEvents(
    options?: {
      daysForward?: number;
      currencies?: string[];
      minImpact?: 'high' | 'medium' | 'low';
      maxEvents?: number;
    },
  ): Promise<Result<EconomicCalendarResult, EconomicCalendarError>> {
    try {
      await this.config.rateLimiter.acquire();

      const html = await this.fetchText(`${this.config.baseUrl}/calendar`);

      if (!this.config.parseHtmlFn) {
        return err({
          code: 'economic-calendar.no_parser',
          message: 'No HTML parser configured — set parseHtmlFn in adapter config',
        });
      }

      const allEvents = await this.config.parseHtmlFn(html);
      const filtered = applyFilters(allEvents, options);

      return ok({
        events: filtered,
        fetchedAt: new Date().toISOString(),
        sources: [SOURCE_FOREX_FACTORY],
      });
    } catch (error) {
      return err({
        code: 'economic-calendar.fetch_failed',
        message: `Forex Factory fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private async fetchText(url: string): Promise<string> {
    return fetchText({
      url,
      timeoutMs: this.config.requestTimeoutMs,
      headers: {
        'User-Agent': this.config.userAgent,
        Accept: 'text/html',
      },
      fetchFn: this.config.fetchFn,
    });
  }
}

// ============================================================================
// CompositeEconomicCalendarProvider
// ============================================================================

export class CompositeEconomicCalendarProvider implements EconomicCalendarProvider {
  private readonly ffAdapter: ForexFactoryCalendarAdapter;

  constructor(private readonly config: CompositeEconomicCalendarConfig) {
    this.ffAdapter = new ForexFactoryCalendarAdapter(config.forexFactory);
  }

  async getUpcomingEvents(
    options?: {
      daysForward?: number;
      currencies?: string[];
      minImpact?: 'high' | 'medium' | 'low';
      maxEvents?: number;
    },
  ): Promise<Result<EconomicCalendarResult, EconomicCalendarError>> {
    const effectiveDaysForward = options?.daysForward ?? this.config.daysForward;
    const effectiveMinImpact = options?.minImpact ?? this.config.minImpact;
    const effectiveCurrencies = options?.currencies ?? this.config.currencies;
    const effectiveMaxEvents = options?.maxEvents ?? this.config.maxEvents;

    const cache = this.config.cache;
    const cacheTtlMs = this.config.cacheTtlMs ?? 10_800_000;
    const cacheKey = `economic-calendar:${effectiveDaysForward}:${effectiveMinImpact}:${effectiveCurrencies.join(',')}`;

    // Check cache first
    if (cache) {
      try {
        const cached = await cache.get<EconomicCalendarResult>(cacheKey);
        if (cached && !cached.isStale) {
          return ok(cached.value);
        }
        if (cached && cached.isStale) {
          const result = await this.fetchFromSource(effectiveDaysForward, effectiveMinImpact, effectiveCurrencies, effectiveMaxEvents);
          if (result.ok) {
            await cache.set(cacheKey, result.data, { ttlMs: cacheTtlMs });
            return result;
          }
          console.warn('Economic calendar refresh failed, serving stale cache');
          return ok(cached.value);
        }
      } catch {
        // Cache error — proceed with direct fetch
      }
    }

    const result = await this.fetchFromSource(effectiveDaysForward, effectiveMinImpact, effectiveCurrencies, effectiveMaxEvents);
    if (result.ok && cache) {
      try {
        await cache.set(cacheKey, result.data, { ttlMs: cacheTtlMs });
      } catch {
        // Cache write failed — non-fatal
      }
    }
    return result;
  }

  private async fetchFromSource(
    daysForward: number,
    minImpact: 'high' | 'medium' | 'low',
    currencies: string[],
    maxEvents: number,
  ): Promise<Result<EconomicCalendarResult, EconomicCalendarError>> {
    const result = await this.ffAdapter.getUpcomingEvents({
      daysForward,
      currencies,
      minImpact,
    });

    if (!result.ok) {
      return err({
        code: 'economic-calendar.fetch_failed',
        message: result.error.message,
      });
    }

    // Sort by time ascending
    const sorted = [...result.data.events].sort((a, b) => a.time.localeCompare(b.time));
    const truncated = sorted.slice(0, maxEvents);

    return ok({
      events: truncated,
      fetchedAt: new Date().toISOString(),
      sources: [SOURCE_FOREX_FACTORY],
    });
  }
}
