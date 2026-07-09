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

const MONTH_ABBR: Record<string, number> = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

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

  // Filter by minimum impact
  if (options?.minImpact) {
    const minRank = IMPACT_RANK[options.minImpact] ?? 0;
    filtered = filtered.filter(
      (e) => (IMPACT_RANK[e.impact] ?? 0) >= minRank,
    );
  }

  // Filter by currencies (empty = all)
  if (options?.currencies && options.currencies.length > 0) {
    const currencySet = new Set(options.currencies.map((c) => c.toUpperCase()));
    filtered = filtered.filter((e) => currencySet.has(e.currency.toUpperCase()));
  }

  // Filter by lookahead window
  if (options?.daysForward !== undefined) {
    const now = Date.now();
    const cutoff = now + options.daysForward * 24 * 60 * 60 * 1000;
    filtered = filtered.filter((e) => {
      const eventTime = new Date(e.time).getTime();
      return eventTime >= now && eventTime <= cutoff;
    });
  }

  // Truncate to maxEvents
  if (options?.maxEvents !== undefined && options.maxEvents > 0) {
    filtered = filtered.slice(0, options.maxEvents);
  }

  return filtered;
}

function isEasternDaylightTime(year: number, month: number, day: number): boolean {
  // EDT: second Sunday in March to first Sunday in November
  const marchSecondSunday = nthSundayOfMonth(year, 3, 2);
  const novemberFirstSunday = nthSundayOfMonth(year, 11, 1);
  const date = new Date(year, month - 1, day);
  return date >= marchSecondSunday && date < novemberFirstSunday;
}

function nthSundayOfMonth(year: number, month: number, n: number): Date {
  const firstDay = new Date(year, month - 1, 1);
  const dayOfWeek = firstDay.getDay();
  const daysUntilSunday = (7 - dayOfWeek) % 7;
  const firstSunday = new Date(year, month - 1, 1 + daysUntilSunday);
  firstSunday.setDate(firstSunday.getDate() + (n - 1) * 7);
  return firstSunday;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
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
      const allEvents = this.parseCalendar(html);
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

  // ------------------------------------------------------------------
  // HTTP
  // ------------------------------------------------------------------

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

  // ------------------------------------------------------------------
  // HTML parsing
  // ------------------------------------------------------------------

  private parseCalendar(html: string): EconomicEvent[] {
    const events: EconomicEvent[] = [];

    // Find the calendar table — look for <table> with "calendar" in its class
    const tableRegex =
      /<\s*table[^>]*class\s*=\s*["'][^"']*calendar[^"']*["'][^>]*>([\s\S]*?)<\s*\/\s*table\s*>/i;
    const tableMatch = html.match(tableRegex);
    if (!tableMatch) return events;

    const tableHtml = tableMatch[1];
    if (!tableHtml) return events;

    // Try rows with the specific calendar__row class first
    let rows = this.extractCalendarRows(tableHtml);

    // Fallback: extract all <tr> elements (skip header rows with <th>)
    if (rows.length === 0) {
      rows = this.extractAllRows(tableHtml);
    }

    for (const rowHtml of rows) {
      const event = this.parseRow(rowHtml);
      if (event) events.push(event);
    }

    return events;
  }

  private extractCalendarRows(tableHtml: string): string[] {
    const rows: string[] = [];
    const rowRegex =
      /<\s*tr[^>]*class\s*=\s*["'][^"']*calendar__row[^"']*["'][^>]*>([\s\S]*?)<\s*\/\s*tr\s*>/gi;
    let match: RegExpExecArray | null;
    while ((match = rowRegex.exec(tableHtml)) !== null) {
      const rowContent = match[1];
      if (rowContent) rows.push(rowContent);
    }
    return rows;
  }

  private extractAllRows(tableHtml: string): string[] {
    const rows: string[] = [];
    const rowRegex = /<\s*tr[^>]*>([\s\S]*?)<\s*\/\s*tr\s*>/gi;
    let match: RegExpExecArray | null;
    while ((match = rowRegex.exec(tableHtml)) !== null) {
      const rowContent = match[1];
      if (!rowContent) continue;
      // Skip header rows that contain <th> elements
      if (/<\s*th[\s>]/i.test(rowContent)) continue;
      rows.push(rowContent);
    }
    return rows;
  }

  private parseRow(rowHtml: string): EconomicEvent | null {
    const cells = this.extractCells(rowHtml);
    if (cells.length < 4) return null;

    const dateStr = stripHtml(cells[0] ?? '');
    const timeStr = stripHtml(cells[1] ?? '');
    const currency = stripHtml(cells[2] ?? '');
    const eventName = stripHtml(cells[3] ?? '');
    const impactHtml = cells[4] ?? '';
    const forecast = cells[5] ? stripHtml(cells[5]) || null : null;
    const previous = cells[6] ? stripHtml(cells[6]) || null : null;

    // Validate required fields
    if (!dateStr || !currency || !eventName) return null;
    if (!/^[A-Z]{3}$/.test(currency)) return null;

    const isoTime = this.parseDateTime(dateStr, timeStr);
    if (!isoTime) return null;

    const impact = this.parseImpact(impactHtml);

    return {
      time: isoTime,
      currency,
      event: eventName,
      impact,
      forecast,
      previous,
      sources: [SOURCE_FOREX_FACTORY],
    };
  }

  private extractCells(rowHtml: string): string[] {
    const cells: string[] = [];
    const tdRegex = /<\s*td[^>]*>([\s\S]*?)<\s*\/\s*td\s*>/gi;
    let match: RegExpExecArray | null;
    while ((match = tdRegex.exec(rowHtml)) !== null) {
      const cellContent = match[1];
      if (cellContent) cells.push(cellContent);
    }
    return cells;
  }

  private parseImpact(cellHtml: string): 'high' | 'medium' | 'low' {
    // Impact is indicated by CSS classes on a span inside the impact cell.
    // Common patterns:
    //   <span class="calendar__impact-icon calendar__impact-icon--red"></span>
    //   <span class="icon icon--ff-impact-red"></span>
    //   <span class="icon icon--ff-impact-ora"></span>
    //   <span class="icon icon--ff-impact-yel"></span>
    // Check for keywords in class attributes.
    const classMatch = cellHtml.match(/class\s*=\s*["']([^"']*)["']/gi);
    if (classMatch) {
      const allClasses = classMatch
        .map((m) => {
          const inner = m.match(/["']([^"']*)["']/);
          return inner ? inner[1] : '';
        })
        .join(' ');
      const lower = allClasses.toLowerCase();
      if (/\bhigh\b/.test(lower) || /\bred\b/.test(lower)) return 'high';
      if (/\bmedium\b/.test(lower) || /\borange\b/.test(lower) || /\bora\b/.test(lower)) return 'medium';
      if (/\blow\b/.test(lower) || /\byellow\b/.test(lower) || /\byel\b/.test(lower)) return 'low';
    }

    // Check inline style for background-color hints
    if (/\b(?:red|#ff0000|#e74c3c)\b/i.test(cellHtml)) return 'high';
    if (/\b(?:orange|#ffa500|#f39c12)\b/i.test(cellHtml)) return 'medium';

    // Default to low if no impact indicator is found
    console.warn('Forex Factory impact indicator not recognized, defaulting to low:', cellHtml.slice(0, 100));
    return 'low';
  }

  private parseDateTime(dateStr: string, timeStr: string): string | null {
    const today = new Date();
    const currentYear = today.getUTCFullYear();

    // Parse date: "Wed Jul 9" or "Jul 9"
    const dateMatch = dateStr.match(/([A-Z][a-z]{2})\s+(\d{1,2})/);
    if (!dateMatch) return null;

    const monthAbbr = dateMatch[1]!;
    const month = MONTH_ABBR[monthAbbr];
    const day = parseInt(dateMatch[2]!, 10);
    if (!month || day < 1 || day > 31) return null;

    // Determine the correct year (handle Dec → Jan boundary)
    let year = currentYear;
    if (month === 12 && today.getUTCMonth() === 0) {
      year = currentYear - 1;
    } else if (month === 1 && today.getUTCMonth() === 11) {
      year = currentYear + 1;
    }

    // Parse time: "8:30am", "2:00pm", or "All Day", "Tentative"
    let hours = 12;
    let minutes = 0;

    if (/all\s*day/i.test(timeStr)) {
      // All-day events: use noon ET
    } else if (/tentative/i.test(timeStr)) {
      return null; // Skip tentative events with no fixed time
    } else {
      const timeMatch = timeStr.match(/(\d{1,2}):(\d{2})(am|pm)/i);
      if (timeMatch) {
        hours = parseInt(timeMatch[1]!, 10);
        minutes = parseInt(timeMatch[2]!, 10);
        const ampm = timeMatch[3]!.toLowerCase();
        if (ampm === 'pm' && hours !== 12) hours += 12;
        if (ampm === 'am' && hours === 12) hours = 0;
      }
      // If no time pattern matched, default to noon ET
    }

    // Convert ET to UTC
    const offsetHours = isEasternDaylightTime(year, month, day) ? 4 : 5;
    const utcDate = new Date(Date.UTC(year, month - 1, day, hours + offsetHours, minutes, 0));

    return utcDate.toISOString();
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
