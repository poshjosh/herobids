import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ForexFactoryCalendarAdapter,
  OhlcDevCalendarAdapter,
  CompositeEconomicCalendarProvider,
  type ForexFactoryAdapterConfig,
  type OhlcDevAdapterConfig,
  type CompositeEconomicCalendarConfig,
} from './economic-calendar.js';
import { RedisProviderResponseCache, type RedisCacheClient } from './redis-cache.js';
import type { RequestGate } from './types.js';
import type { EconomicEvent } from '@herobids/domain';

// ============================================================================
// Helpers
// ============================================================================

function createNoopRateLimiter(): RequestGate {
  return { acquire: vi.fn().mockResolvedValue(undefined) };
}

function createMockFetch(
  body: string,
  status = 200,
  contentType = 'text/html',
): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => {
      try {
        return JSON.parse(body);
      } catch {
        throw new Error('Invalid JSON');
      }
    },
  })) as unknown as typeof fetch;
}

function makeEvent(overrides: Partial<EconomicEvent> & { time: string; currency: string; event: string }): EconomicEvent {
  return {
    impact: 'medium',
    forecast: null,
    previous: null,
    sources: ['forex-factory'],
    ...overrides,
  };
}

function baseForexFactoryConfig(overrides: Partial<ForexFactoryAdapterConfig> = {}): ForexFactoryAdapterConfig {
  return {
    baseUrl: 'https://www.forexfactory.com',
    requestTimeoutMs: 10_000,
    requestsPerMinute: 60,
    userAgent: 'Mozilla/5.0',
    rateLimiter: createNoopRateLimiter(),
    ...overrides,
  };
}

function baseOhlcDevConfig(overrides: Partial<OhlcDevAdapterConfig> = {}): OhlcDevAdapterConfig {
  return {
    baseUrl: 'https://api.ohlc.dev',
    requestTimeoutMs: 10_000,
    requestsPerMinute: 60,
    rateLimiter: createNoopRateLimiter(),
    ...overrides,
  };
}

function baseCompositeConfig(overrides: Partial<CompositeEconomicCalendarConfig> = {}): CompositeEconomicCalendarConfig {
  return {
    daysForward: 7,
    minImpact: 'low',
    currencies: [],
    maxEvents: 50,
    dedupeWindowMinutes: 30,
    sourceOrder: ['forex-factory', 'ohlc-dev'],
    forexFactory: baseForexFactoryConfig(),
    ohlcDev: baseOhlcDevConfig(),
    ...overrides,
  };
}

function createMockRedisClient(): RedisCacheClient & { _store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    _store: store,
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string, ..._args: Array<string | number>) {
      store.set(key, value);
      return 'OK';
    },
    async del(key: string) {
      store.delete(key);
      return 1;
    },
  };
}

// ============================================================================
// Forex Factory HTML parsing
// ============================================================================

describe('ForexFactoryCalendarAdapter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Set date to Jan 1, 2026 so all Jul 2026 events are in the future
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('parses a realistic calendar table and extracts event fields', async () => {
    const fixtureHtml = `
      <html><body>
      <table class="calendar__table">
        <tr class="calendar__row" data-eventid="123">
          <td class="calendar__date">Wed<br>Jul 9</td>
          <td class="calendar__time">2:00pm</td>
          <td class="calendar__currency">USD</td>
          <td class="calendar__event">
            <span>FOMC Statement</span>
          </td>
          <td class="calendar__impact">
            <span class="calendar__impact-icon calendar__impact-icon--red" title="High Impact Expected"></span>
          </td>
          <td class="calendar__forecast">TBA</td>
          <td class="calendar__previous">5.50%</td>
        </tr>
        <tr class="calendar__row" data-eventid="124">
          <td class="calendar__date">Thu<br>Jul 10</td>
          <td class="calendar__time">8:30am</td>
          <td class="calendar__currency">EUR</td>
          <td class="calendar__event">
            <span>CPI m/m</span>
          </td>
          <td class="calendar__impact">
            <span class="calendar__impact-icon calendar__impact-icon--ora" title="Medium Impact Expected"></span>
          </td>
          <td class="calendar__forecast">0.2%</td>
          <td class="calendar__previous">0.1%</td>
        </tr>
      </table>
      </body></html>
    `;

    const adapter = new ForexFactoryCalendarAdapter(
      baseForexFactoryConfig({ fetchFn: createMockFetch(fixtureHtml) }),
    );

    const result = await adapter.getUpcomingEvents({ daysForward: 365 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok result');

    const events = result.data.events;
    expect(events).toHaveLength(2);

    // Event 1: FOMC Statement, high impact, USD, Jul 9 2:00pm ET = 18:00 UTC (EST, Jan → offset 5)
    const fomc = events.find((e) => e.event === 'FOMC Statement');
    expect(fomc).toBeDefined();
    expect(fomc!.currency).toBe('USD');
    expect(fomc!.impact).toBe('high');
    expect(fomc!.previous).toBe('5.50%');
    expect(fomc!.forecast).toBe('TBA');
    // July 9 = EDT (UTC-4), so 2:00pm ET = 18:00 UTC
    expect(fomc!.time).toContain('2026-07-09T18:00:00');

    // Event 2: CPI m/m, medium impact, EUR, Jul 10 8:30am ET = 12:30 UTC (EDT)
    const cpi = events.find((e) => e.event === 'CPI m/m');
    expect(cpi).toBeDefined();
    expect(cpi!.currency).toBe('EUR');
    expect(cpi!.impact).toBe('medium');
    expect(cpi!.forecast).toBe('0.2%');
    expect(cpi!.previous).toBe('0.1%');
    expect(cpi!.time).toContain('2026-07-10T12:30:00');
  });

  it('parses impact from orange/yellow class names', async () => {
    const fixtureHtml = `
      <html><body>
      <table class="calendar__table">
        <tr class="calendar__row">
          <td class="calendar__date">Wed<br>Jul 9</td>
          <td class="calendar__time">9:00am</td>
          <td class="calendar__currency">GBP</td>
          <td class="calendar__event"><span>Manufacturing PMI</span></td>
          <td class="calendar__impact">
            <span class="icon icon--ff-impact-yel"></span>
          </td>
          <td class="calendar__forecast">52.0</td>
          <td class="calendar__previous">51.5</td>
        </tr>
      </table>
      </body></html>
    `;

    const adapter = new ForexFactoryCalendarAdapter(
      baseForexFactoryConfig({ fetchFn: createMockFetch(fixtureHtml) }),
    );

    const result = await adapter.getUpcomingEvents({ daysForward: 365 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok result');

    expect(result.data.events).toHaveLength(1);
    expect(result.data.events[0]!.impact).toBe('low');
  });

  it('skips rows with missing required fields', async () => {
    const fixtureHtml = `
      <html><body>
      <table class="calendar__table">
        <tr class="calendar__row">
          <td class="calendar__date"></td>
          <td class="calendar__time">2:00pm</td>
          <td class="calendar__currency">USD</td>
          <td class="calendar__event"><span>Event</span></td>
          <td class="calendar__impact"></td>
          <td class="calendar__forecast"></td>
          <td class="calendar__previous"></td>
        </tr>
        <tr class="calendar__row">
          <td class="calendar__date">Wed<br>Jul 9</td>
          <td class="calendar__time">2:00pm</td>
          <td class="calendar__currency">invalid-currency</td>
          <td class="calendar__event"><span>Event</span></td>
          <td class="calendar__impact"></td>
          <td class="calendar__forecast"></td>
          <td class="calendar__previous"></td>
        </tr>
      </table>
      </body></html>
    `;

    const adapter = new ForexFactoryCalendarAdapter(
      baseForexFactoryConfig({ fetchFn: createMockFetch(fixtureHtml) }),
    );

    const result = await adapter.getUpcomingEvents({ daysForward: 365 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok result');

    expect(result.data.events).toHaveLength(0);
  });

  it('returns empty array for HTML without calendar table', async () => {
    const adapter = new ForexFactoryCalendarAdapter(
      baseForexFactoryConfig({ fetchFn: createMockFetch('<html><body>No table here</body></html>') }),
    );

    const result = await adapter.getUpcomingEvents({ daysForward: 365 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok result');
    expect(result.data.events).toHaveLength(0);
  });

  it('returns error when fetch fails', async () => {
    const adapter = new ForexFactoryCalendarAdapter(
      baseForexFactoryConfig({
        fetchFn: createMockFetch('', 500),
      }),
    );

    const result = await adapter.getUpcomingEvents();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error result');
    expect(result.error.code).toBe('economic-calendar.fetch_failed');
  });

  it('filters by currency', async () => {
    const fixtureHtml = `
      <html><body>
      <table class="calendar__table">
        <tr class="calendar__row">
          <td class="calendar__date">Wed<br>Jul 9</td>
          <td class="calendar__time">2:00pm</td>
          <td class="calendar__currency">USD</td>
          <td class="calendar__event"><span>FOMC</span></td>
          <td class="calendar__impact"></td>
          <td class="calendar__forecast"></td>
          <td class="calendar__previous"></td>
        </tr>
        <tr class="calendar__row">
          <td class="calendar__date">Wed<br>Jul 9</td>
          <td class="calendar__time">3:00pm</td>
          <td class="calendar__currency">EUR</td>
          <td class="calendar__event"><span>ECB</span></td>
          <td class="calendar__impact"></td>
          <td class="calendar__forecast"></td>
          <td class="calendar__previous"></td>
        </tr>
      </table>
      </body></html>
    `;

    const adapter = new ForexFactoryCalendarAdapter(
      baseForexFactoryConfig({ fetchFn: createMockFetch(fixtureHtml) }),
    );

    const result = await adapter.getUpcomingEvents({ currencies: ['USD'], daysForward: 365 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok result');

    expect(result.data.events).toHaveLength(1);
    expect(result.data.events[0]!.currency).toBe('USD');
  });
});

// ============================================================================
// OHLC.dev JSON normalization
// ============================================================================

describe('OhlcDevCalendarAdapter', () => {
  const FUTURE_TS = Math.floor(Date.now() / 1000) + 86400; // tomorrow
  const FUTURE_TS2 = FUTURE_TS + 3600; // +1 hour

  it('normalizes Unix timestamps, impact labels, and currency codes', async () => {
    const mockBody = JSON.stringify([
      {
        timestamp: FUTURE_TS,
        currency: 'usd',
        title: 'Fed Interest Rate Decision',
        impact: 'high-impact',
        forecast: '5.50%',
        previous: '5.25%',
      },
      {
        timestamp: FUTURE_TS2,
        currency: 'eur',
        title: 'ECB Press Conference',
        impact: 'moderate',
        forecast: null,
        previous: null,
      },
    ]);

    const adapter = new OhlcDevCalendarAdapter(
      baseOhlcDevConfig({
        fetchFn: createMockFetch(mockBody, 200, 'application/json'),
      }),
    );

    const result = await adapter.getUpcomingEvents({ daysForward: 365 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok result');

    const events = result.data.events;
    expect(events).toHaveLength(2);

    // Event 1
    const fed = events.find((e) => e.event === 'Fed Interest Rate Decision');
    expect(fed).toBeDefined();
    expect(fed!.currency).toBe('USD');
    expect(fed!.impact).toBe('high');
    expect(fed!.forecast).toBe('5.50%');
    expect(fed!.previous).toBe('5.25%');
    // Timestamp should be ISO-8601
    expect(fed!.time).toBe(new Date(FUTURE_TS * 1000).toISOString());

    // Event 2
    const ecb = events.find((e) => e.event === 'ECB Press Conference');
    expect(ecb).toBeDefined();
    expect(ecb!.currency).toBe('EUR');
    expect(ecb!.impact).toBe('medium');
    expect(ecb!.forecast).toBeNull();
    expect(ecb!.previous).toBeNull();
  });

  it('handles array-shaped response', async () => {
    const mockBody = JSON.stringify([
      { timestamp: FUTURE_TS, currency: 'gbp', title: 'GDP m/m', impact: 'low' },
    ]);

    const adapter = new OhlcDevCalendarAdapter(
      baseOhlcDevConfig({
        fetchFn: createMockFetch(mockBody, 200, 'application/json'),
      }),
    );

    const result = await adapter.getUpcomingEvents({ daysForward: 365 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok result');
    expect(result.data.events).toHaveLength(1);
    expect(result.data.events[0]!.currency).toBe('GBP');
  });

  it('handles { events: [...] } response shape', async () => {
    const mockBody = JSON.stringify({
      events: [
        { timestamp: FUTURE_TS, currency: 'jpy', title: 'BOJ Minutes', impact: 'medium' },
      ],
    });

    const adapter = new OhlcDevCalendarAdapter(
      baseOhlcDevConfig({
        fetchFn: createMockFetch(mockBody, 200, 'application/json'),
      }),
    );

    const result = await adapter.getUpcomingEvents({ daysForward: 365 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok result');
    expect(result.data.events).toHaveLength(1);
    expect(result.data.events[0]!.currency).toBe('JPY');
  });

  it('handles { data: [...] } response shape', async () => {
    const mockBody = JSON.stringify({
      data: [
        { timestamp: FUTURE_TS, currency: 'cad', title: 'CPI y/y', impact: 'high' },
      ],
    });

    const adapter = new OhlcDevCalendarAdapter(
      baseOhlcDevConfig({
        fetchFn: createMockFetch(mockBody, 200, 'application/json'),
      }),
    );

    const result = await adapter.getUpcomingEvents({ daysForward: 365 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok result');
    expect(result.data.events).toHaveLength(1);
    expect(result.data.events[0]!.currency).toBe('CAD');
  });

  it('defaults unrecognized impact to low', async () => {
    const mockBody = JSON.stringify([
      { timestamp: FUTURE_TS, currency: 'usd', title: 'Unknown Event', impact: 'super-duper' },
    ]);

    const adapter = new OhlcDevCalendarAdapter(
      baseOhlcDevConfig({
        fetchFn: createMockFetch(mockBody, 200, 'application/json'),
      }),
    );

    const result = await adapter.getUpcomingEvents({ daysForward: 365 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok result');
    expect(result.data.events[0]!.impact).toBe('low');
  });

  it('returns error when fetch fails', async () => {
    const adapter = new OhlcDevCalendarAdapter(
      baseOhlcDevConfig({
        fetchFn: createMockFetch('', 500, 'application/json'),
      }),
    );

    const result = await adapter.getUpcomingEvents();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error result');
    expect(result.error.code).toBe('economic-calendar.fetch_failed');
  });
});

// ============================================================================
// Composite merge/dedupe
// ============================================================================

describe('CompositeEconomicCalendarProvider — merge & dedupe', () => {
  beforeEach(() => {
    // Set to Jan 1, 2026 so Jul 2026 events are in the future
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('merges two events with same currency and time within dedupe window', async () => {
    // Jul 8, 2026 5:20pm EDT = 21:20 UTC (isEasternDaylightTime uses event date, Jul = EDT = UTC-4)
    const utcMs = Date.UTC(2026, 6, 8, 21, 20, 0);
    const sharedTs = Math.floor(utcMs / 1000);

    const ffHtml = `
      <html><body>
      <table class="calendar__table">
        <tr class="calendar__row">
          <td class="calendar__date">Tue<br>Jul 8</td>
          <td class="calendar__time">5:20pm</td>
          <td class="calendar__currency">USD</td>
          <td class="calendar__event"><span>FOMC Statement</span></td>
          <td class="calendar__impact">
            <span class="calendar__impact-icon calendar__impact-icon--red"></span>
          </td>
          <td class="calendar__forecast">TBA</td>
          <td class="calendar__previous">5.50%</td>
        </tr>
      </table>
      </body></html>
    `;

    const ohlcJson = JSON.stringify([
      {
        timestamp: sharedTs,
        currency: 'usd',
        title: 'FOMC Statement (Different Title)',
        impact: 'medium',
        forecast: '5.25%',
        previous: null,
      },
    ]);

    const config = baseCompositeConfig({
      dedupeWindowMinutes: 30,
      sourceOrder: ['forex-factory', 'ohlc-dev'],
    });
    config.forexFactory.fetchFn = createMockFetch(ffHtml);
    config.ohlcDev.fetchFn = createMockFetch(ohlcJson, 200, 'application/json');

    const provider = new CompositeEconomicCalendarProvider(config);
    const result = await provider.getUpcomingEvents({ daysForward: 365 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok result');

    // Should be deduplicated to 1 event
    expect(result.data.events).toHaveLength(1);

    const merged = result.data.events[0]!;
    // FF title wins (higher sourceOrder priority)
    expect(merged.event).toBe('FOMC Statement');
    // FF impact wins (higher sourceOrder priority)
    expect(merged.impact).toBe('high');
    // FF previous wins for non-null, FF forecast is non-null so OHLC forecast not adopted
    expect(merged.previous).toBe('5.50%');
    expect(merged.forecast).toBe('TBA');
    // Sources should include both
    expect(merged.sources.sort()).toEqual(['forex-factory', 'ohlc-dev']);
  });

  it('does not merge events with different currencies', async () => {
    const ts = Math.floor(Date.now() / 1000) + 86400; // tomorrow
    const ohlcJson = JSON.stringify([
      { timestamp: ts, currency: 'usd', title: 'FOMC', impact: 'high' },
      { timestamp: ts, currency: 'eur', title: 'ECB', impact: 'high' },
    ]);

    const config = baseCompositeConfig();
    config.forexFactory.fetchFn = createMockFetch('<html><body>No table</body></html>');
    config.ohlcDev.fetchFn = createMockFetch(ohlcJson, 200, 'application/json');

    const provider = new CompositeEconomicCalendarProvider(config);
    const result = await provider.getUpcomingEvents({ daysForward: 365 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok result');
    expect(result.data.events).toHaveLength(2);
    expect(result.data.events.map((e) => e.currency).sort()).toEqual(['EUR', 'USD']);
  });

  it('does not merge events outside dedupe window', async () => {
    const ts = Math.floor(Date.now() / 1000) + 86400; // tomorrow
    const ohlcJson = JSON.stringify([
      { timestamp: ts, currency: 'usd', title: 'Event A', impact: 'high' },
      // 3 hours later — well outside a 30-minute dedupe window
      { timestamp: ts + 3 * 3600, currency: 'usd', title: 'Event B', impact: 'high' },
    ]);

    const config = baseCompositeConfig({ dedupeWindowMinutes: 30 });
    config.forexFactory.fetchFn = createMockFetch('<html><body>No table</body></html>');
    config.ohlcDev.fetchFn = createMockFetch(ohlcJson, 200, 'application/json');

    const provider = new CompositeEconomicCalendarProvider(config);
    const result = await provider.getUpcomingEvents({ daysForward: 365 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok result');
    expect(result.data.events).toHaveLength(2);
  });

  it('conflict preference: Forex Factory title and impact win over OHLC.dev', async () => {
    // Jul 10, 2026 10:00am EDT = 14:00 UTC (EDT = UTC-4)
    const eventUtcMs = Date.UTC(2026, 6, 10, 14, 0, 0);
    const eventTs = Math.floor(eventUtcMs / 1000);

    const ffHtml = `
      <html><body>
      <table class="calendar__table">
        <tr class="calendar__row">
          <td class="calendar__date">Thu<br>Jul 10</td>
          <td class="calendar__time">10:00am</td>
          <td class="calendar__currency">USD</td>
          <td class="calendar__event"><span>CPI m/m (FF)</span></td>
          <td class="calendar__impact">
            <span class="calendar__impact-icon calendar__impact-icon--red"></span>
          </td>
          <td class="calendar__forecast">0.2%</td>
          <td class="calendar__previous">0.3%</td>
        </tr>
      </table>
      </body></html>
    `;

    const ohlcJson = JSON.stringify([
      {
        timestamp: eventTs,
        currency: 'usd',
        title: 'CPI m/m (OHLC)',
        impact: 'low',
        forecast: null,
        previous: null,
      },
    ]);

    const config = baseCompositeConfig({
      dedupeWindowMinutes: 5,
      sourceOrder: ['forex-factory', 'ohlc-dev'],
    });
    config.forexFactory.fetchFn = createMockFetch(ffHtml);
    config.ohlcDev.fetchFn = createMockFetch(ohlcJson, 200, 'application/json');

    const provider = new CompositeEconomicCalendarProvider(config);
    const result = await provider.getUpcomingEvents({ daysForward: 365 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok result');

    expect(result.data.events).toHaveLength(1);
    const merged = result.data.events[0]!;
    // FF title should win
    expect(merged.event).toBe('CPI m/m (FF)');
    // FF impact should win
    expect(merged.impact).toBe('high');
  });
});

// ============================================================================
// Composite failure modes
// ============================================================================

describe('CompositeEconomicCalendarProvider — failure modes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns events from surviving source when one source fails (OHLC fails)', async () => {
    const ffHtml = `
      <html><body>
      <table class="calendar__table">
        <tr class="calendar__row">
          <td class="calendar__date">Wed<br>Jul 9</td>
          <td class="calendar__time">2:00pm</td>
          <td class="calendar__currency">USD</td>
          <td class="calendar__event"><span>FOMC</span></td>
          <td class="calendar__impact"></td>
          <td class="calendar__forecast"></td>
          <td class="calendar__previous"></td>
        </tr>
      </table>
      </body></html>
    `;

    const config = baseCompositeConfig();
    config.forexFactory.fetchFn = createMockFetch(ffHtml);
    config.ohlcDev.fetchFn = createMockFetch('', 500, 'application/json');

    const provider = new CompositeEconomicCalendarProvider(config);
    const result = await provider.getUpcomingEvents({ daysForward: 365 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok result');
    expect(result.data.events).toHaveLength(1);
    expect(result.data.events[0]!.event).toBe('FOMC');
    expect(result.data.sources).toEqual(['forex-factory']);
  });

  it('returns events from surviving source when one source fails (FF fails)', async () => {
    const ts = Math.floor(Date.now() / 1000) + 86400; // tomorrow
    const ohlcJson = JSON.stringify([
      { timestamp: ts, currency: 'eur', title: 'ECB', impact: 'high' },
    ]);

    const config = baseCompositeConfig();
    config.forexFactory.fetchFn = createMockFetch('', 500);
    config.ohlcDev.fetchFn = createMockFetch(ohlcJson, 200, 'application/json');

    const provider = new CompositeEconomicCalendarProvider(config);
    const result = await provider.getUpcomingEvents({ daysForward: 365 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok result');
    expect(result.data.events).toHaveLength(1);
    expect(result.data.events[0]!.event).toBe('ECB');
    expect(result.data.sources).toEqual(['ohlc-dev']);
  });

  it('returns error when both sources fail', async () => {
    const config = baseCompositeConfig();
    config.forexFactory.fetchFn = createMockFetch('', 500);
    config.ohlcDev.fetchFn = createMockFetch('', 500, 'application/json');

    const provider = new CompositeEconomicCalendarProvider(config);
    const result = await provider.getUpcomingEvents({ daysForward: 365 });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected error result');
    expect(result.error.code).toBe('economic-calendar.all_sources_failed');
  });

  it('returns events from surviving source when one source throws (not just error result)', async () => {
    const ffHtml = `
      <html><body>
      <table class="calendar__table">
        <tr class="calendar__row">
          <td class="calendar__date">Wed<br>Jul 9</td>
          <td class="calendar__time">2:00pm</td>
          <td class="calendar__currency">USD</td>
          <td class="calendar__event"><span>FOMC</span></td>
          <td class="calendar__impact"></td>
          <td class="calendar__forecast"></td>
          <td class="calendar__previous"></td>
        </tr>
      </table>
      </body></html>
    `;

    const config = baseCompositeConfig();
    config.forexFactory.fetchFn = createMockFetch(ffHtml);
    config.ohlcDev.fetchFn = (async () => {
      throw new Error('Network failure');
    }) as unknown as typeof fetch;

    const provider = new CompositeEconomicCalendarProvider(config);
    const result = await provider.getUpcomingEvents({ daysForward: 365 });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected ok result');
    expect(result.data.sources).toEqual(['forex-factory']);
  });
});

// ============================================================================
// Redis cache behavior
// ============================================================================

describe('RedisProviderResponseCache', () => {
  let redis: RedisCacheClient & { _store: Map<string, string> };
  let cache: RedisProviderResponseCache;

  beforeEach(() => {
    redis = createMockRedisClient();
    cache = new RedisProviderResponseCache(redis, 'test:');
  });

  it('cache miss returns undefined', async () => {
    const result = await cache.get('nonexistent');
    expect(result).toBeUndefined();
  });

  it('cache hit (fresh) returns cached value with isStale=false', async () => {
    const now = Date.now();
    await cache.set('key1', { hello: 'world' }, { ttlMs: 60_000, staleWhileRevalidateMs: 30_000 }, now);

    const result = await cache.get('key1', now + 10_000);
    expect(result).toBeDefined();
    expect(result!.value).toEqual({ hello: 'world' });
    expect(result!.isStale).toBe(false);
  });

  it('cache hit (stale) returns stale value with isStale=true', async () => {
    const now = Date.now();
    await cache.set('key2', { foo: 'bar' }, { ttlMs: 60_000, staleWhileRevalidateMs: 30_000 }, now);

    const result = await cache.get('key2', now + 70_000); // Past TTL but within stale window
    expect(result).toBeDefined();
    expect(result!.value).toEqual({ foo: 'bar' });
    expect(result!.isStale).toBe(true);
  });

  it('cache fully expired (beyond staleAt) returns undefined', async () => {
    const now = Date.now();
    await cache.set('key3', { baz: 'qux' }, { ttlMs: 60_000, staleWhileRevalidateMs: 30_000 }, now);

    const result = await cache.get('key3', now + 100_000); // Past staleAt
    expect(result).toBeUndefined();
    // Should also be evicted from store
    expect(redis._store.has('test:key3')).toBe(false);
  });

  it('set stores value with correct TTL', async () => {
    const now = Date.now();
    await cache.set('key4', { a: 1 }, { ttlMs: 120_000, staleWhileRevalidateMs: 60_000 }, now);

    const raw = redis._store.get('test:key4');
    expect(raw).toBeDefined();

    const parsed = JSON.parse(raw!);
    expect(parsed.value).toEqual({ a: 1 });
    expect(parsed.storedAt).toBe(now);
    expect(parsed.expiresAt).toBe(now + 120_000);
    expect(parsed.staleAt).toBe(now + 180_000);
  });

  it('Redis error on get returns undefined (graceful degradation)', async () => {
    const brokenRedis: RedisCacheClient = {
      get: async () => { throw new Error('Connection lost'); },
      set: async () => 'OK',
      del: async () => 1,
    };
    const brokenCache = new RedisProviderResponseCache(brokenRedis, 'test:');

    const result = await brokenCache.get('anything');
    expect(result).toBeUndefined();
  });

  it('Redis error on set does not throw (graceful degradation)', async () => {
    const brokenRedis: RedisCacheClient = {
      get: async () => null,
      set: async () => { throw new Error('Connection lost'); },
      del: async () => 1,
    };
    const brokenCache = new RedisProviderResponseCache(brokenRedis, 'test:');

    await expect(
      brokenCache.set('key', { x: 1 }, { ttlMs: 60_000 }),
    ).resolves.toBeUndefined();
  });

  it('delete removes the key', async () => {
    await cache.set('key5', { val: 1 }, { ttlMs: 60_000 });
    expect(redis._store.has('test:key5')).toBe(true);

    await cache.delete('key5');
    expect(redis._store.has('test:key5')).toBe(false);
  });

  it('get with zero TTL returns undefined if expired immediately', async () => {
    const now = Date.now();
    await cache.set('key6', { val: 1 }, { ttlMs: 0, staleWhileRevalidateMs: 0 }, now);

    const result = await cache.get('key6', now + 1);
    expect(result).toBeUndefined();
  });
});

// ============================================================================
// Composite with Redis cache
// ============================================================================

describe('CompositeEconomicCalendarProvider — cache integration', () => {
  let redis: RedisCacheClient & { _store: Map<string, string> };
  let cache: RedisProviderResponseCache;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    redis = createMockRedisClient();
    cache = new RedisProviderResponseCache(redis, 'test:');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves from cache on second call (fresh hit)', async () => {
    const ts = Math.floor(Date.now() / 1000) + 86400; // tomorrow
    const ohlcJson = JSON.stringify([
      { timestamp: ts, currency: 'usd', title: 'FOMC', impact: 'high' },
    ]);

    const config = baseCompositeConfig({
      cache,
      cacheTtlMs: 300_000,
    });
    config.forexFactory.fetchFn = createMockFetch('<html><body>No table</body></html>');
    config.ohlcDev.fetchFn = createMockFetch(ohlcJson, 200, 'application/json');

    const provider = new CompositeEconomicCalendarProvider(config);

    // First call — should fetch
    const result1 = await provider.getUpcomingEvents({ daysForward: 365 });
    expect(result1.ok).toBe(true);

    // Second call — should hit cache (no extra fetch needed)
    const result2 = await provider.getUpcomingEvents({ daysForward: 365 });
    expect(result2.ok).toBe(true);
    if (!result2.ok) throw new Error('Expected ok result');
    expect(result2.data.events).toHaveLength(1);
    expect(result2.data.events[0]!.event).toBe('FOMC');
  });
});
