# Decision 3: Provider Eligibility Source/Classification

**Decision:** 3 — Available source of candle-provider eligibility and whether existing provider responses are sufficient to classify unsupported instruments
**Status:** accepted
**Date:** 2026-07-16
**Owner:** Implementer agent (Phase 0 research)

## Question

What is the available source of candle-provider eligibility, and are existing provider responses sufficient to classify unsupported instruments without a new catalogue?

## Inspected Sources

### Candle fetcher (`packages/venues/src/candle-fetcher.ts`)

- `VenueCandleFetcher` adapts between the abstract `CandleFetcher` port and concrete providers
- For orderbook venues (Hyperliquid): routes to `fetchBinanceCandles(symbol, this.binanceCfg, ...)`
- The symbol is passed through without validation — any string goes to Binance
- GeckoTerminal path is only for swap venues; not relevant to scanner-gated
- **No eligibility check** before the fetch call

### Binance candles adapter (`packages/market-data/src/binance-candles.ts`)

- `resolveBinanceSymbol(instrument)` — the symbol resolution function:
  - Strips suffix patterns (`USDT`, `USD`, `PERP`) from the instrument
  - Looks up in `SYMBOL_MAP` (hard-coded 8 symbols: BTC, ETH, SOL, DOGE, AVAX, LINK, ARB, OP, SUI)
  - Falls back to `${base}USDT` for any unrecognized symbol
  - **No API call, no validation** — purely a string transform
  - Resolution is NOT proof of eligibility: `FOO` resolves to `FOOUSDT`, but Binance may not list `FOOUSDT`

- `fetchBinanceCandles(symbol, config, options)`:
  - Calls `config.rateLimiter.acquire()` (binance:regime limiter)
  - Constructs URL: `${baseUrl}/api/v3/klines?symbol=${binanceSymbol}&interval=${interval}&limit=${limit}`
  - Calls `fetchJson<BinanceKline[]>({ url, timeoutMs, fetchFn })`
  - Returns parsed candles or throws
  - **No error classification** — all errors propagate as generic fetch failures
  - No distinction between:
    - `400 Bad Request` (invalid symbol, e.g., `FOOUSDT` not listed)
    - `429 Too Many Requests` (rate limited — but this is handled by the coordinator rate limiter pre-flight)
    - `5xx` (transient Binance server error)
    - Network timeout
    - Empty `[]` response (valid symbol but no kline data, e.g., newly listed)

### Candle registry (`packages/market-data/src/candle-registry.ts`)

- `CANDLE_PROVIDERS` — static registry with a single provider: `binance`
- `CandleProviderDescriptor` interface: `id`, `resolveSymbol`, `symbolFormatHint`, `fetchCandles`
- The registry wraps `registry.binance.candles()` which goes through `loadWithCache` → `CoordinatedRateLimiter.acquire()` → `fetchBinanceCandles()`
- **No eligibility check** at the registry level — it delegates entirely to the underlying adapter

### Hyperliquid discovery (`apps/worker/src/index.ts`, lines 248–279)

- `discoverCandidates()`:
  - Calls `sharedMarketDataRegistry.hyperliquid.assetContexts()` — fetches ALL Hyperliquid perpetuals (~150+ assets)
  - Returns `{ symbol, instrumentId, volume24hUsd, priceChange24hPct }` for each asset
  - Applies `filters.symbols`, `filters.excludeSymbols`, `filters.minVolume24hUsd`
  - Discovery source is Hyperliquid — NOT Binance. No guarantee a discovered HL asset has a Binance spot listing.

### Provider error classification

- `packages/market-data/src/cache.ts` (`loadWithCache`): wraps the loader in try/catch, but propagates errors — no classification
- `packages/market-data/src/http.ts` (`fetchJson`): basic HTTP client with timeout, throws on non-2xx or parse failure
- `apps/worker/src/market-intelligence/provider-counters.ts`: records success/failure/rateLimitWait/rateLimitThrottle — but these are counters, not error classifiers for eligibility

### Binance API behavior (public knowledge)

- `GET /api/v3/klines?symbol=INVALID` → HTTP 400 with `{"code": -1121, "msg": "Invalid symbol."}`
- `GET /api/v3/klines?symbol=NEWCOINUSDT` (just listed, no trades yet) → HTTP 200 with `[]`
- `GET /api/v3/klines?symbol=BTCUSDT` → HTTP 200 with kline array
- Rate limit: HTTP 429 or HTTP 418 (IP ban)

## Decision

### Eligibility determined from Binance HTTP responses — no static catalogue

A static symbol catalogue (mapping Hyperliquid perpetuals to Binance spot pairs) would need constant maintenance as both exchanges list/delist assets. It would also be an unnecessary dependency. Instead, we classify eligibility from the actual HTTP response and kline data returned by Binance.

**Four-way classification of `fetchBinanceCandles` outcomes:**

| Outcome | Binance HTTP Status | Response Body | Classification | Scanner Action |
|---|---|---|---|---|
| **Supported, data available** | 200 | Non-empty `PriceCandle[]` | `eligible_fetched` | Proceed to scoring |
| **Supported, no data yet** | 200 | Empty `[]` | `eligible_empty` | Skip symbol (new listing, no price history) |
| **Unsupported symbol** | 400 | `{"code": -1121, "msg": "Invalid symbol."}` | `unsupported` | Skip symbol permanently (cache the unsupported status per scan) |
| **Transient failure** | 5xx, timeout, network error | N/A | `transient_failure` | Retry or skip (record as transient, do not cache as unsupported) |
| **Rate limited** | 429 / 418 | N/A | `rate_limited` | Already handled by `CoordinatedRateLimiter` pre-flight; if it occurs despite the limiter, treat as transient |

### Implementation approach: error classification wrapper in `fetchCandles`

The cleanest place to add eligibility classification is in the `fetchCandles` wrapper function in `apps/worker/src/index.ts` (lines 291–296), since it's injected into the `AgentTradingActor` and is the single point where scanner candle fetches flow through.

Current wrapper:
```typescript
const fetchCandles = agentCandleFetcher
  ? async (symbol: string, interval: string, limit: number) => {
      return agentCandleFetcher.fetchCandles(symbol, interval, limit);
    }
  : undefined;
```

Enhanced wrapper with classification:
```typescript
type CandleFetchOutcome =
  | { status: 'eligible_fetched'; candles: PriceCandle[] }
  | { status: 'eligible_empty'; symbol: string }
  | { status: 'unsupported'; symbol: string; resolvedSymbol: string }
  | { status: 'transient_failure'; symbol: string; error: string };

const fetchCandles = agentCandleFetcher
  ? async (symbol: string, interval: string, limit: number): Promise<PriceCandle[]> => {
      try {
        const candles = await agentCandleFetcher.fetchCandles(symbol, interval, limit);
        // Binance returns [] for valid but empty symbols (new listings).
        // This is distinguishable from unsupported — the symbol exists but has no klines.
        return candles;
      } catch (err) {
        // Classify the error for structured scan outcome recording.
        // The caller (runTechnicalPhase) records the classification in its result.
        throw err; // Re-throw — classification metadata is captured by the scan loop
      }
    }
  : undefined;
```

However, to keep the interface simple (matching the existing `fetchCandles: (symbol, interval, limit) => Promise<PriceCandle[]>` signature), we classify errors at the call site in `technical-phase.ts` rather than changing the function signature. The existing `technical-phase.ts` already catches per-symbol fetch errors:

```typescript
// technical-phase.ts lines 145-156
batch.map(async (symbol) => {
  try {
    const candles = await deps.fetchCandles(symbol, config.candles.interval, config.candles.limit);
    candlesBySymbol.set(symbol, candles);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`candle_fetch_failed(${symbol}): ${msg}`);
  }
}),
```

The enhancement is to **classify the error message** to distinguish unsupported from transient:
- If the error message contains `"Invalid symbol"` or HTTP 400 → classify as `unsupported`
- If the error message is a timeout or network error → classify as `transient_failure`
- If the error message contains `"Rate limit exceeded"` → classify as `rate_limited` (shouldn't happen due to limiter, but defensive)

### Distinguishing unsupported from transient failure

The key concern is: an unsupported symbol must NOT trigger retries, and a transient failure must NOT permanently blacklist a valid symbol.

**Decision criteria embedded in the error handling:**
1. `fetchJson` throws on HTTP 400 — the Binance error response body contains `"Invalid symbol."` — parse or string-match this
2. `fetchJson` throws on HTTP 5xx — classify as transient
3. `fetchJson` throws on timeout — classify as transient
4. Empty `[]` is NOT an error — it's a successful response, just with no data. Already handled by the existing code (candles are stored as empty array, candidate is skipped during scoring since there are no candles to score)

**Caching unsupported status per scan:**
Since the same symbol could appear across multiple scan agents, and Binance's symbol list doesn't change mid-scan, we cache the `unsupported` classification for the duration of a single scan. In `technical-phase.ts`, before batching, we can resolve each symbol and skip already-known-unsupported ones. This avoids redundant 400 responses for unsupported symbols.

### No static catalogue needed — but a small known-good list is valuable for testing

For test determinism and smoke verification, a small set of known-supported symbols should be maintained:
- `BTC`, `ETH`, `SOL` — always on Binance spot
- This is already effectively in `SYMBOL_MAP`

For production, the HTTP-response classification approach is sufficient because:
- Binance's error response for invalid symbols is deterministic (HTTP 400, code -1121)
- The cost of one 400 response per unsupported symbol per scan is negligible
- A static catalogue would need maintenance and risk becoming stale

### How to distinguish from rate-limit rejection

The `CoordinatedRateLimiter.acquire()` call happens BEFORE the HTTP request. If the limiter denies the request (bucket empty + wait exceeds maxWaitMs), it throws `"Rate limit exceeded"` — this is caught at the `fetchCandles` level before any HTTP call is made. This is distinct from a Binance 429 response (which shouldn't occur if the limiter is working correctly).

## Rejected Alternatives

- **Alternative: Pre-fetch a static Binance symbol catalogue (exchangeInfo endpoint) at worker startup**
  - Rejected: Adds a startup dependency on Binance API availability. The exchangeInfo response is large (~1MB) and would need caching. Adds complexity for a problem that HTTP response classification solves well enough.

- **Alternative: Use `resolveBinanceSymbol` + API ping to check eligibility before each scan**
  - Rejected: Adds an extra API call per candidate. Doubles the request volume. The eligibility check itself can fail transiently, adding another layer of uncertainty.

- **Alternative: Only scan symbols in `SYMBOL_MAP` (the 8 hard-coded majors)**
  - Rejected: Too restrictive. A user may want to scan mid-cap Hyperliquid perps (e.g., TIA, SEI, INJ) that also have Binance spot listings. The static map covers only the most liquid majors. The whole point of Hyperliquid discovery is breadth.

- **Alternative: Add a comprehensive `Hyperliquid→Binance` symbol catalogue as a config file**
  - Rejected: Maintenance burden. Both exchanges add/delist symbols regularly. The HTTP response classification approach is self-maintaining — if Binance lists a symbol, it returns data; if it delists, it returns 400.

## Implementation Consequences

- `fetchBinanceCandles` (or `fetchJson` wrapper) needs error classification: parse HTTP status and response body to distinguish "Invalid symbol" (400/-1121) from transient errors
- `technical-phase.ts` candle fetch loop enhanced to record per-symbol eligibility outcomes in `TechnicalPhaseResult` (new fields: `unsupportedSymbols: string[]`, `transientFailures: string[]`)
- Per-scan unsupported cache: a `Set<string>` of symbols that returned 400 during this scan, so batch processing skips them
- Test symbols: `BTC` (supported), `NO_SUCH_COIN_12345` (unsupported), timeout simulation (transient)
- Empty response `[]` must NOT be treated as an error — it's `eligible_empty`

## Required Validation

- **Unit test**: `fetchBinanceCandles` with invalid symbol → HTTP 400 → classified as unsupported
- **Unit test**: `fetchBinanceCandles` with network timeout → classified as transient failure
- **Unit test**: `fetchBinanceCandles` with valid symbol returning `[]` → successful, empty candles
- **Unit test**: `resolveBinanceSymbol('BTC')` → `'BTCUSDT'` (from map)
- **Unit test**: `resolveBinanceSymbol('FOO')` → `'FOOUSDT'` (fallback)
- **Integration test**: scan with known-supported symbol → candles fetched
- **Integration test**: scan with known-unsupported symbol → `unsupported` outcome, no retry
- **Integration test**: scan with mixed (some supported, some unsupported) → distinct outcomes

## Residual Risk or Follow-Up

- **Binance error format change**: If Binance changes the error response format for invalid symbols (e.g., different HTTP code or JSON structure), the classification logic will break. Mitigation: defensive matching (check for both `-1121` code AND `"Invalid symbol"` substring in the message).
- **Partial listings**: A Hyperliquid perp may exist with no corresponding Binance spot pair. The discovery-to-candle path inherently has a mismatch (HL perps → Binance spot). The Phase 3 live-provider smoke will quantify how many discovered HL assets have valid Binance spot pairs. This may inform a future decision to switch to a Hyperliquid-native candle provider.
- **Empty kline ambiguity**: `[]` could mean "symbol exists but no trades in this interval" vs. "symbol was just listed with no history." These are indistinguishable from the API response alone but have the same operational meaning for the scanner: no usable data. Both are `eligible_empty`.
