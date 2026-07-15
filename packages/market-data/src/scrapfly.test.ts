import { describe, it, expect, vi } from 'vitest';
import { createScrapflyFetch, type ScrapflyConfig } from './scrapfly.js';

// ============================================================================
// Helpers
// ============================================================================

function baseConfig(overrides: Partial<ScrapflyConfig> = {}): ScrapflyConfig {
  return {
    apiKey: 'test-key-123',
    baseUrl: 'https://api.scrapfly.io/scrape',
    asp: true,
    requestTimeoutMs: 60_000,
    ...overrides,
  };
}

/**
 * Spy fetch that captures the (url, init) passed to it and returns a canned
 * Response. This lets us assert on the exact URL Scrapfly's `createScrapflyFetch`
 * constructs.
 */
function createSpyFetch(
  responseInit: ResponseInit & { text?: string } = {},
): { fetchSpy: typeof fetch; getLastCall: () => { url: string; init: RequestInit } | null } {
  let lastUrl = '';
  let lastInit: RequestInit = {};

  const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
    lastUrl = url;
    lastInit = init ?? {};
    return new Response(responseInit.text ?? 'ok', {
      status: responseInit.status ?? 200,
      headers: responseInit.headers,
    });
  }) as unknown as typeof fetch;

  return {
    fetchSpy,
    getLastCall: () => (fetchSpy.mock.calls.length > 0 ? { url: lastUrl, init: lastInit } : null),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('createScrapflyFetch', () => {
  it('builds the expected Scrapfly proxy URL with all query params', async () => {
    const { fetchSpy, getLastCall } = createSpyFetch();
    const scrapflyFetch = createScrapflyFetch(baseConfig({ fetchFn: fetchSpy }));

    await scrapflyFetch('https://www.forexfactory.com/calendar?day=today');

    const lastCall = getLastCall();
    expect(lastCall).not.toBeNull();
    expect(fetchSpy).toHaveBeenCalledOnce();

    const proxyUrl = new URL(lastCall!.url);
    expect(proxyUrl.origin + proxyUrl.pathname).toBe('https://api.scrapfly.io/scrape');
    expect(proxyUrl.searchParams.get('url')).toBe('https://www.forexfactory.com/calendar?day=today');
    expect(proxyUrl.searchParams.get('key')).toBe('test-key-123');
    expect(proxyUrl.searchParams.get('asp')).toBe('true');
    expect(proxyUrl.searchParams.get('proxified_response')).toBe('true');
    expect(proxyUrl.searchParams.get('format')).toBe('raw');
  });

  it('handles URL object input', async () => {
    const { fetchSpy, getLastCall } = createSpyFetch();
    const scrapflyFetch = createScrapflyFetch(baseConfig({ fetchFn: fetchSpy }));

    await scrapflyFetch(new URL('https://example.com/page'));

    const proxyUrl = new URL(getLastCall()!.url);
    expect(proxyUrl.searchParams.get('url')).toBe('https://example.com/page');
  });

  it('handles Request object input', async () => {
    const { fetchSpy, getLastCall } = createSpyFetch();
    const scrapflyFetch = createScrapflyFetch(baseConfig({ fetchFn: fetchSpy }));

    await scrapflyFetch(new Request('https://example.com/data'));

    const proxyUrl = new URL(getLastCall()!.url);
    expect(proxyUrl.searchParams.get('url')).toBe('https://example.com/data');
  });

  it('does not forward incoming headers', async () => {
    const { fetchSpy, getLastCall } = createSpyFetch();
    const scrapflyFetch = createScrapflyFetch(baseConfig({ fetchFn: fetchSpy }));

    await scrapflyFetch('https://example.com', {
      headers: { 'User-Agent': 'custom-agent', 'X-Custom': 'value' },
    });

    const lastCall = getLastCall();
    // The init passed to the underlying fetch should have no headers property
    expect(lastCall!.init.headers).toBeUndefined();
  });

  it('propagates the AbortSignal from init through to the Scrapfly call', async () => {
    const { fetchSpy, getLastCall } = createSpyFetch();
    const scrapflyFetch = createScrapflyFetch(baseConfig({ fetchFn: fetchSpy }));
    const controller = new AbortController();

    await scrapflyFetch('https://example.com', { signal: controller.signal });

    const lastCall = getLastCall();
    expect(lastCall!.init.signal).toBe(controller.signal);
  });

  it('does not attach a signal when init has none', async () => {
    const { fetchSpy, getLastCall } = createSpyFetch();
    const scrapflyFetch = createScrapflyFetch(baseConfig({ fetchFn: fetchSpy }));

    await scrapflyFetch('https://example.com', {});

    const lastCall = getLastCall();
    expect(lastCall!.init.signal).toBeUndefined();
  });

  it('returns the Response unmodified (status and body pass through)', async () => {
    const { fetchSpy } = createSpyFetch({ status: 201, text: 'created' });
    const scrapflyFetch = createScrapflyFetch(baseConfig({ fetchFn: fetchSpy }));

    const response = await scrapflyFetch('https://example.com');

    expect(response.status).toBe(201);
    expect(await response.text()).toBe('created');
  });

  it('passes through non-2xx responses (proxified_response mode)', async () => {
    const { fetchSpy } = createSpyFetch({ status: 403, text: 'blocked' });
    const scrapflyFetch = createScrapflyFetch(baseConfig({ fetchFn: fetchSpy }));

    const response = await scrapflyFetch('https://example.com');

    expect(response.status).toBe(403);
    expect(await response.text()).toBe('blocked');
  });

  it('respects a custom baseUrl', async () => {
    const { fetchSpy, getLastCall } = createSpyFetch();
    const scrapflyFetch = createScrapflyFetch(
      baseConfig({ fetchFn: fetchSpy, baseUrl: 'https://custom-scrapfly.example.com/scrape' }),
    );

    await scrapflyFetch('https://example.com');

    const proxyUrl = new URL(getLastCall()!.url);
    expect(proxyUrl.origin + proxyUrl.pathname).toBe('https://custom-scrapfly.example.com/scrape');
  });

  it('passes asp=false as a query string "false"', async () => {
    const { fetchSpy, getLastCall } = createSpyFetch();
    const scrapflyFetch = createScrapflyFetch(baseConfig({ fetchFn: fetchSpy, asp: false }));

    await scrapflyFetch('https://example.com');

    const proxyUrl = new URL(getLastCall()!.url);
    expect(proxyUrl.searchParams.get('asp')).toBe('false');
  });

  it('defaults to GET method when init has no method', async () => {
    const { fetchSpy, getLastCall } = createSpyFetch();
    const scrapflyFetch = createScrapflyFetch(baseConfig({ fetchFn: fetchSpy }));

    await scrapflyFetch('https://example.com', {});

    expect(getLastCall()!.init.method).toBe('GET');
  });
});
