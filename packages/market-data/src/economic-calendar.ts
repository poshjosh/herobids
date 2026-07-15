import type {
  EconomicEvent,
  EconomicCalendarResult,
  EconomicCalendarError,
  EconomicCalendarProvider,
  Result,
} from '@herobids/domain';
import { ok, err } from '@herobids/domain';
import { parse as parseHtml, type HTMLElement } from 'node-html-parser';
import type { RequestGate } from './types.js';
import { fetchText } from './http.js';
import type { ProviderResponseCache } from './cache.js';

// ============================================================================
// Types
// ============================================================================

export type EconomicCalendarParserFn = (html: string) => Promise<EconomicEvent[]>;

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
  /** Optional HTML parser. When provided, replaces the built-in regex parser. */
  parseHtmlFn?: EconomicCalendarParserFn;
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
// DOM-based HTML parser
// ============================================================================

/**
 * Resolve impact level from a calendar row element.
 *
 * Forex Factory uses two impact indicator systems:
 * 1. Universal impact classes on an icon element:
 *    `universal-impact__impact-high`, `universal-impact__impact-medium`,
 *    `universal-impact__impact-low`
 * 2. Legacy color-based icon classes:
 *    `icon--ff-impact-red` (high), `icon--ff-impact-ora` (medium),
 *    `icon--ff-impact-yel` (low), `icon--ff-impact-gra` (none)
 *
 * Preference is given to the universal classes.
 */
function resolveImpact(row: HTMLElement): 'high' | 'medium' | 'low' {
  const iconEl = row.querySelector('.icon');
  if (iconEl) {
    const cls = iconEl.getAttribute('class') ?? '';
    if (/universal-impact__impact-high/.test(cls)) return 'high';
    if (/universal-impact__impact-medium/.test(cls)) return 'medium';
    if (/universal-impact__impact-low/.test(cls)) return 'low';
    // Legacy color-based fallback
    if (/icon--ff-impact-red/.test(cls)) return 'high';
    if (/icon--ff-impact-ora/.test(cls)) return 'medium';
    if (/icon--ff-impact-yel/.test(cls)) return 'low';
  }
  return 'medium';
}

/**
 * Create a DOM-based calendar parser using `node-html-parser`.
 *
 * Returns a function that parses Forex Factory calendar HTML and extracts
 * structured `EconomicEvent[]`. No LLM, no network — pure DOM extraction.
 */
export function createDomCalendarParser(): EconomicCalendarParserFn {
  return async (html: string): Promise<EconomicEvent[]> => {
    const root = parseHtml(html);
    const table = root.querySelector('table.calendar__table');
    if (!table) throw new Error('Calendar table not found');

    const events: EconomicEvent[] = [];
    const rows = table.querySelectorAll('tr.calendar__row');

    for (const row of rows) {
      // Skip day-breaker rows
      if (row.classList.contains('calendar__row--day-breaker')) continue;

      const time = row.querySelector('.calendar__time')?.textContent?.trim() ?? '';
      const currency = row.querySelector('.calendar__currency')?.textContent?.trim() ?? '';
      const event = row.querySelector('.calendar__event')?.textContent?.trim() ?? '';
      const forecast = row.querySelector('.calendar__forecast')?.textContent?.trim() || null;
      const previous = row.querySelector('.calendar__previous')?.textContent?.trim() || null;

      if (!event || !time) continue;

      events.push({
        time: normalizeTime(time),
        currency: currency.toUpperCase().slice(0, 3),
        event,
        impact: resolveImpact(row),
        forecast: forecast || null,
        previous: previous || null,
        sources: ['forex-factory'],
      });
    }

    return events;
  };
}

/**
 * Normalize time strings from Forex Factory format to ISO-8601 UTC.
 * Forex Factory displays times like "9:30am", "2:00pm", "All Day", "Tentative".
 * Returns the best-effort ISO string.
 */
function normalizeTime(raw: string): string {
  const trimmed = raw.trim();
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) return trimmed;

  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  const match = trimmed.match(/^(\d{1,2}):(\d{2})(am|pm)/i);
  if (match) {
    let hour = parseInt(match[1]!, 10);
    const min = match[2]!;
    const ampm = match[3]!.toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    return `${today}T${String(hour).padStart(2, '0')}:${min}:00Z`;
  }

  // "All Day", "Tentative", etc. — use noon UTC as a placeholder
  return `${today}T12:00:00Z`;
}

// ============================================================================
// LLM-based HTML parser factory
// ============================================================================

export interface LlmCalendarParserConfig {
  /** LLM API key (Bearer token). */
  apiKey?: string;
  /** LLM API base URL. Defaults to OpenAI-compatible /v1/chat/completions. */
  baseUrl?: string;
  /** Model identifier (e.g. 'gpt-4o-mini', 'qwen3:8b'). */
  model: string;
  /** Request timeout in milliseconds. */
  timeoutMs: number;
}

/**
 * Create an LLM-based HTML parser for economic calendar pages.
 *
 * Extracts the calendar `<table>` from raw HTML, sends it to an LLM for
 * structured extraction, and returns typed `EconomicEvent[]`.
 *
 * The returned function is suitable for use as `ForexFactoryAdapterConfig.parseHtmlFn`.
 */
export function createLlmCalendarParser(
  config: LlmCalendarParserConfig,
): (html: string) => Promise<EconomicEvent[]> {
  const baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
  const apiUrl = baseUrl.endsWith('/v1') ? `${baseUrl}/chat/completions` : `${baseUrl}/chat/completions`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }

  return async (html: string): Promise<EconomicEvent[]> => {
    // Use node-html-parser for reliable table extraction (handles nested
    // tables, malformed markup, and class variants better than regex).
    const root = parseHtml(html);
    const table = root.querySelector('table.calendar__table');
    const tableHtml = table?.outerHTML ?? html;

    const systemPrompt = `Extract economic calendar events from this HTML table.
Return a JSON array. Each event: { time: "ISO-8601 UTC", currency: "3-char code uppercase", event: "title", impact: "high|medium|low", forecast: string|null, previous: string|null }.
Omit day-breaker rows (colspan headers). Omit rows with no event data.
Only return JSON, no other text.`;

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: tableHtml },
        ],
        temperature: 0,
        max_tokens: 4096,
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`LLM API returned ${response.status}`);
    }

    const body = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty LLM response');

    // Extract JSON from response (may be wrapped in markdown code fences)
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array found in LLM response');

    const parsed = JSON.parse(jsonMatch[0]) as unknown[];
    if (!Array.isArray(parsed)) throw new Error('LLM response is not an array');

    return parsed.map((item: unknown) => {
      const e = item as Record<string, unknown>;
      return {
        time: String(e.time ?? new Date().toISOString()),
        currency: String(e.currency ?? '').toUpperCase(),
        event: String(e.event ?? ''),
        impact: (['high', 'medium', 'low'].includes(String(e.impact)) ? String(e.impact) : 'medium') as 'high' | 'medium' | 'low',
        forecast: e.forecast ? String(e.forecast) : null,
        previous: e.previous ? String(e.previous) : null,
        sources: ['forex-factory'],
      };
    });
  };
}

// ============================================================================
// Fallback parser — DOM first, LLM on failure
// ============================================================================

/**
 * Create a fallback calendar parser that tries DOM extraction first, then
 * falls back to LLM-based extraction if the DOM parser fails (e.g. Forex
 * Factory changed its markup).
 *
 * In the common case (DOM succeeds), the LLM is never called — zero cost,
 * sub-10ms. The LLM parser only activates when the DOM parser throws.
 */
export function createFallbackCalendarParser(
  llmConfig: LlmCalendarParserConfig,
): EconomicCalendarParserFn {
  const domParser = createDomCalendarParser();
  const llmParser = createLlmCalendarParser(llmConfig);

  return async (html: string): Promise<EconomicEvent[]> => {
    try {
      return await domParser(html);
    } catch (domError) {
      try {
        return await llmParser(html);
      } catch (llmError) {
        throw new Error(
          `Calendar parse failed: DOM (${(domError as Error).message}), LLM (${(llmError as Error).message})`,
        );
      }
    }
  };
}

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
      /** When true, never fetch from source — only serve cached data or empty events. */
      cacheOnly?: boolean;
    },
  ): Promise<Result<EconomicCalendarResult, EconomicCalendarError>> {
    const effectiveDaysForward = options?.daysForward ?? this.config.daysForward;
    const effectiveMinImpact = options?.minImpact ?? this.config.minImpact;
    const effectiveCurrencies = options?.currencies ?? this.config.currencies;
    const effectiveMaxEvents = options?.maxEvents ?? this.config.maxEvents;
    const cacheOnly = options?.cacheOnly ?? false;

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
          // Stale cache: if cacheOnly, serve stale (no fetch allowed).
          if (cacheOnly) {
            return ok(cached.value);
          }
          const result = await this.fetchFromSource(effectiveDaysForward, effectiveMinImpact, effectiveCurrencies, effectiveMaxEvents);
          if (result.ok) {
            await cache.set(cacheKey, result.data, { ttlMs: cacheTtlMs });
            return result;
          }
          console.warn('Economic calendar refresh failed, serving stale cache');
          return ok(cached.value);
        }
        // Cache miss: if cacheOnly, return empty events (no fetch allowed).
        if (cacheOnly) {
          return ok({
            events: [],
            fetchedAt: '',
            sources: [],
          });
        }
      } catch {
        // Cache error — if cacheOnly, return empty; otherwise proceed with direct fetch.
        if (cacheOnly) {
          return ok({
            events: [],
            fetchedAt: '',
            sources: [],
          });
        }
      }
    } else if (cacheOnly) {
      // No cache configured + cacheOnly — return empty.
      return ok({
        events: [],
        fetchedAt: '',
        sources: [],
      });
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
