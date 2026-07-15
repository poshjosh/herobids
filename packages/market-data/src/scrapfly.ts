/**
 * Scrapfly proxy fetch helper.
 *
 * Wraps `fetch()` to route requests through Scrapfly's Scrape API
 * (https://scrapfly.io), which proxies the request through rotating
 * (residential-capable) IPs and its Anti-Scraping Protection (ASP) feature
 * to solve Cloudflare JS challenges.
 *
 * Intended for scraping targets that block cloud/datacenter IP ranges
 * (e.g. Forex Factory behind Cloudflare). Other scrapers can opt in by
 * injecting this as a `fetchFn`.
 *
 * ## Response mode
 *
 * `proxified_response=true` so Scrapfly responds with the **target's** raw
 * body, status code, and headers — no JSON envelope to unwrap. This keeps
 * `fetchText()` (`http.ts`) working unmodified.
 *
 * **Important nuance:** with `proxified_response=true`, a non-2xx HTTP status
 * on the response can mean *either* that the target genuinely returned that
 * status *or* that Scrapfly itself rejected the request (bad API key, quota
 * exceeded, concurrency limit). `fetchText()` surfaces both as `HttpError`
 * today, which is acceptable given the "no fallback, let it fail" decision
 * for this integration. `X-Scrapfly-Reject-Code` and
 * `X-Scrapfly-Reject-Description` headers are available on the response for
 * future debugging if needed.
 *
 * ## Header handling
 *
 * We deliberately drop incoming `init.headers` entirely. Scrapfly's docs
 * recommend using its own smart-default fingerprinting (User-Agent + OS +
 * browser brand are coordinated for ASP to work correctly); forwarding a
 * custom `User-Agent` header disables that coordination.
 */

export interface ScrapflyConfig {
  /** Scrapfly API key (resolved from `process.env['SCRAPFLY_API_KEY']` — never a schema field). */
  apiKey: string;
  /** Base URL of the Scrapfly Scrape API endpoint. */
  baseUrl: string;
  /** Enable Anti-Scraping Protection (Cloudflare JS challenge bypass). */
  asp: boolean;
  /** Timeout for the entire Scrapfly round trip (including ASP retries/browser rendering). */
  requestTimeoutMs: number;
  /** Test injection for the underlying `fetch` implementation. Defaults to global `fetch`. */
  fetchFn?: typeof fetch;
}

/**
 * Create a `fetch`-shaped function that routes every request through Scrapfly's
 * Scrape API with `proxified_response=true` (raw target response passthrough).
 *
 * The returned function conforms to `typeof fetch` so it can be dropped in as
 * a `fetchFn` wherever a config accepts an injectable fetch implementation
 * (e.g. `ForexFactoryAdapterConfig.fetchFn`).
 */
export function createScrapflyFetch(config: ScrapflyConfig): typeof fetch {
  const rawFetch = config.fetchFn ?? fetch;
  return async (input, init) => {
    const targetUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    const proxyUrl = new URL(config.baseUrl);
    proxyUrl.searchParams.set('url', targetUrl);
    proxyUrl.searchParams.set('key', config.apiKey);
    proxyUrl.searchParams.set('asp', String(config.asp));
    proxyUrl.searchParams.set('proxified_response', 'true');
    proxyUrl.searchParams.set('format', 'raw');

    // Deliberately do NOT forward `init.headers` — see module-level doc on
    // why a custom User-Agent breaks Scrapfly's ASP fingerprinting.
    return rawFetch(proxyUrl, {
      method: init?.method ?? 'GET',
      signal: init?.signal ?? undefined,
    });
  };
}
