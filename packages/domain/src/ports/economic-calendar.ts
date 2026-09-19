import type { DomainError, Result } from '../result.js';

export interface EconomicEvent {
  /** ISO-8601 datetime string (UTC) */
  time: string;
  /** Currency code (USD, EUR, GBP, etc.) */
  currency: string;
  /** Event name */
  event: string;
  /** Impact level */
  impact: 'high' | 'medium' | 'low';
  /** Forecast value (null if none) */
  forecast: string | null;
  /** Previous value (null if none) */
  previous: string | null;
  /** Source ids that contributed to this normalized event */
  sources: string[];
}

export interface EconomicCalendarResult {
  events: EconomicEvent[];
  /** ISO-8601 datetime when the merged result was produced */
  fetchedAt: string;
  /** Source identifiers used to produce this merged result */
  sources: string[];
}

export interface EconomicCalendarError extends DomainError {
  code: string;
}

export interface EconomicCalendarProvider {
  getUpcomingEvents(options?: {
    daysForward?: number;
    currencies?: string[];
    minImpact?: 'high' | 'medium' | 'low';
    maxEvents?: number;
    /**
     * When true, never fetch from source — only serve cached data or empty
     * events. Aligns the port with the copied concrete
     * (`CompositeEconomicCalendarProvider`), which already implements this: the
     * per-tick boundary read passes `{ cacheOnly: true }` so it never blocks on
     * a network call. The background acquisition loop omits it (full fetch,
     * warms the cache).
     */
    cacheOnly?: boolean;
  }): Promise<Result<EconomicCalendarResult, EconomicCalendarError>>;
}
