# 007 — Market Data Discovery and Venue Intelligence

Concrete implementation plan for adding market data sources, discovery endpoints, venue intelligence (funding, OI, liquidations), and corresponding agent tools.

This is the "trading data" implementation counterpart to 001 (LLM cost reduction).

---

## Background

`market-data-provider-strategy.md` defines **what** to add and **why**.
`agent-data-contract-by-venue.md` defines **what data the agent sees**.
This document defines **how to build it** — endpoints, data models, agent tools, rate budgets, and wiring into context assembly.

---

## Scope

### In scope

- Hyperliquid REST: funding rates + open interest
- Bybit REST: liquidation data
- DexScreener: trending, boosts, profiles discovery endpoints
- GeckoTerminal: trending pools, top pools, new pools
- New agent tools: `discover_tokens`, `get_funding_rates`, `get_market_overview`
- Integration into tick context assembly
- Birdeye adapter (implemented June 2026 — see `docs/features/2026/06/27/005-birdeye-provider/001-plan.md`)

### Out of scope

- Execution logic changes (venues already work)
- Rate-limit testing methodology (covered by 006)
- Agent prompt formatting (covered by 004)

---

## Part A — Venue Intelligence (Free, from existing venues)

### A1. Hyperliquid Funding Rates + Open Interest

**Endpoint:** `POST https://api.hyperliquid.xyz/info`

**Request body:**
```json
{"type": "metaAndAssetCtxs"}
```

**Response (relevant fields):**
```json
[
  {
    "universe": [
      { "name": "BTC", "szDecimals": 5 },
      { "name": "ETH", "szDecimals": 4 }
    ]
  },
  [
    {
      "funding": "0.0000125",
      "openInterest": "1234.5",
      "prevDayPx": "67000.0",
      "dayNtlVlm": "500000000.0",
      "markPx": "67500.0",
      "midPx": "67499.5",
      "oraclePx": "67480.0"
    }
  ]
]
```

**Data extracted per asset:**
- `funding` — current hourly funding rate (annualize × 8760 for display)
- `openInterest` — total OI in coins
- `markPx`, `oraclePx` — mark vs oracle spread (basis signal)
- `dayNtlVlm` — 24h notional volume
- `prevDayPx` — for computing 24h price change

**Implementation location:** `packages/market-data/src/hyperliquid-info.ts` (new file)

```typescript
export interface HyperliquidAssetContext {
  name: string;
  funding: string;
  openInterest: string;
  markPx: string;
  oraclePx: string;
  dayNtlVlm: string;
  prevDayPx: string;
}

export interface HyperliquidInfoConfig {
  baseUrl: string;           // https://api.hyperliquid.xyz
  rateLimiter: TokenBucketRateLimiter;
  timeoutMs: number;
}

export async function fetchHyperliquidAssetContexts(
  config: HyperliquidInfoConfig,
): Promise<HyperliquidAssetContext[]>;
```

**Rate budget:** Conservative 10 req/s estimate. One call returns ALL assets. Call once per tick (every 15 min) — effectively zero rate pressure.

**Export from `@herobids/market-data` index.**

---

### A2. Bybit Liquidation Data

**Endpoint:** `GET https://api.bybit.com/v5/market/recent-trade?category=linear&symbol=BTCUSDT&limit=50`

Bybit trade prints include a `side` field. Liquidation trades are identifiable by the `isLiquidation` or specific `tickDirection` patterns in the v5 API. Alternatively, use the dedicated endpoint:

**Endpoint:** `GET https://api.bybit.com/v5/market/account-ratio?category=linear&symbol=BTCUSDT&period=1h&limit=10`

This gives long/short account ratio which is a proxy for liquidation pressure.

**Data extracted:**
- Long/short ratio over time
- Direction of recent liquidation flow

**Implementation location:** `packages/market-data/src/bybit-info.ts` (new file)

```typescript
export interface BybitLongShortRatio {
  symbol: string;
  buyRatio: string;
  sellRatio: string;
  timestamp: string;
}

export interface BybitInfoConfig {
  baseUrl: string;           // https://api.bybit.com
  rateLimiter: TokenBucketRateLimiter;
  timeoutMs: number;
}

export async function fetchBybitLongShortRatio(
  symbol: string,
  config: BybitInfoConfig,
): Promise<BybitLongShortRatio[]>;
```

**Rate budget:** 120 req/min for Bybit linear endpoints. One call per symbol per tick — negligible.

---

### A3. Context Assembly Integration

Both A1 and A2 data feed into the `trading-context` block in `runtime-composition.ts`.

Add a new context provider:

```typescript
{
  id: 'venue-intelligence',
  costTier: 'cheap',
  requiredFamilies: ['trading'],
  build: (state) => {
    // Format funding rates, OI, long/short ratio for instruments
    // the agent is actively trading
  },
}
```

This provider is called before the LLM call and injects pre-computed venue data so the agent doesn't waste tool calls fetching it.

---

## Part B — DEX Discovery (Free tier)

### B1. DexScreener Discovery

**Endpoints to add:**

| Endpoint | URL | Returns |
|---|---|---|
| Trending (boosts top) | `GET /token-boosts/top/v1` | Top boosted tokens |
| Trending (boosts latest) | `GET /token-boosts/latest/v1` | Latest boosted tokens |
| Profiles (latest) | `GET /token-profiles/latest/v1` | Latest token profiles |

**Implementation location:** `packages/market-data/src/dexscreener.ts` (extend existing file)

```typescript
export interface DexScreenerDiscoveryConfig extends DexScreenerConfig {
  // Inherits baseUrl, rateLimiter, timeoutMs
}

export async function fetchDexScreenerTrending(
  config: DexScreenerDiscoveryConfig,
): Promise<TokenInfo[]>;

export async function fetchDexScreenerBoostsLatest(
  config: DexScreenerDiscoveryConfig,
): Promise<TokenInfo[]>;

export async function fetchDexScreenerProfilesLatest(
  config: DexScreenerDiscoveryConfig,
): Promise<TokenInfo[]>;
```

**Rate budget:** 60 req/min shared across all DexScreener calls. Discovery calls should use a priority budget (e.g., max 30 req/min for discovery, leaving 30 for search/price).

**Deduplication:** Merge results by `network:address`, keep highest-liquidity entry.

---

### B2. GeckoTerminal Discovery

**Endpoints to add:**

| Endpoint | URL | Returns |
|---|---|---|
| Trending pools | `GET /api/v2/networks/{network}/trending_pools` | Top trending pools by activity |
| Top pools | `GET /api/v2/networks/{network}/pools?sort=h24_volume_usd_desc` | Highest volume pools |
| New pools | `GET /api/v2/networks/{network}/new_pools` | Recently created pools |

**Implementation location:** `packages/market-data/src/geckoterminal.ts` (extend existing file)

```typescript
export interface GeckoTerminalDiscoveryConfig extends GeckoTerminalConfig {
  // Inherits baseUrl, rateLimiter, timeoutMs
}

export interface DiscoveredPool {
  poolAddress: string;
  network: string;
  baseToken: { address: string; symbol: string; name: string };
  quoteToken: { address: string; symbol: string; name: string };
  priceUsd: number;
  volume24hUsd: number;
  liquidityUsd: number;
  poolCreatedAt?: string;
}

export async function fetchGeckoTerminalTrendingPools(
  network: string,
  config: GeckoTerminalDiscoveryConfig,
): Promise<DiscoveredPool[]>;

export async function fetchGeckoTerminalTopPools(
  network: string,
  config: GeckoTerminalDiscoveryConfig,
): Promise<DiscoveredPool[]>;

export async function fetchGeckoTerminalNewPools(
  network: string,
  config: GeckoTerminalDiscoveryConfig,
): Promise<DiscoveredPool[]>;
```

**Networks to support:** `solana`, `base` (match execution venue coverage).

**Rate budget:** 10–30 req/min. Discovery calls should be capped at 50% of budget (5–15 req/min), leaving the rest for OHLCV.

---

### B3. Unified Discovery Aggregator

Combine DexScreener and GeckoTerminal results into a single normalized list.

**Implementation location:** `packages/market-data/src/discovery.ts` (new file)

```typescript
export interface DiscoveryConfig {
  dexscreener: DexScreenerDiscoveryConfig;
  geckoterminal: GeckoTerminalDiscoveryConfig;
  networks: string[];           // e.g. ['solana', 'base']
  maxResults: number;           // default 20
  minLiquidityUsd: number;      // default 10000
}

export interface DiscoveredToken {
  address: string;
  symbol: string;
  name: string;
  network: string;
  priceUsd: number;
  volume24hUsd: number;
  liquidityUsd: number;
  priceChange24hPct?: number;
  source: 'dexscreener' | 'geckoterminal';
  discoveryVector: string;      // e.g. 'trending', 'boosts_top', 'new_pools'
  poolAddress?: string;
  poolCreatedAt?: string;
}

/**
 * Fetch from all configured discovery vectors, merge, deduplicate,
 * filter by minLiquidity, sort by volume, return top N.
 */
export async function discoverTokens(
  config: DiscoveryConfig,
): Promise<DiscoveredToken[]>;
```

**Deduplication:** By `network:address`. If same token found in multiple vectors, keep the entry with highest liquidity and note all vectors in metadata.

**Anti-staleness:** Optional — track recently-seen tokens in memory (or Redis if shared). Deprioritize tokens seen in the last 4 hours. (Port pattern from aitradingbot's `mdc:discovery:seen`.)

---

## Part C — Agent Tools

### C1. `discover_tokens` tool

```typescript
tool name: discover_tokens
args: {
  network?: string          // 'solana' | 'base' | omit for all
  minLiquidityUsd?: number  // default 10000
  limit?: number            // default 10, max 20
}
returns: {
  ok: boolean
  tokens: DiscoveredToken[]
  note?: string
}
```

**Implementation:** In `apps/worker/src/agent.ts` tool dispatch. Calls `discoverTokens()` from `@herobids/market-data`.

**Rate limiting:** Shares DexScreener + GeckoTerminal rate budget. If rate-limited, returns `{ ok: false, error: 'rate_limit', note: 'Try again next tick.' }`.

---

### C2. `get_funding_rates` tool

```typescript
tool name: get_funding_rates
args: {
  symbols?: string[]        // e.g. ['BTC', 'ETH', 'SOL']. Omit for top 10 by OI.
}
returns: {
  ok: boolean
  assets: Array<{
    symbol: string
    fundingRate: string         // hourly rate as decimal
    fundingAnnualized: string   // annualized %
    openInterest: string        // in coins
    markPrice: string
    oraclePrice: string
    volume24h: string           // notional USD
  }>
}
```

**Implementation:** Calls `fetchHyperliquidAssetContexts()`. Filters to requested symbols or top 10 by OI.

---

### C3. `get_market_overview` tool

```typescript
tool name: get_market_overview
args: {
  venue?: string            // 'hyperliquid' | 'bybit'. Default: hyperliquid.
  symbols?: string[]        // specific symbols. Default: top 5 by volume.
}
returns: {
  ok: boolean
  overview: Array<{
    symbol: string
    price: string
    change24hPct: string
    volume24h: string
    fundingRate?: string
    openInterest?: string
    longShortRatio?: string
  }>
}
```

**Implementation:** Combines Hyperliquid asset contexts + Bybit long/short ratio into a unified view.

---

## Part D — Skill Registration

New tools need to be added to the skill definitions in `@herobids/domain`:

- `discover_tokens` → belongs in a new `market-research` skill or the existing `trading` skill
- `get_funding_rates` → belongs in `trading` skill
- `get_market_overview` → belongs in `trading` skill

Update `TRADING_SKILL.requiredTools` to include the new tools.

---

## Part E — Birdeye (Implemented June 2026)

**Implementation location:** `packages/market-data/src/birdeye.ts` (new file)

```typescript
export interface BirdeyeConfig {
  baseUrl: string;           // https://public-api.birdeye.so
  apiKey: string;
  rateLimiter: TokenBucketRateLimiter;
  timeoutMs: number;
}

export async function fetchBirdeyeTrending(config: BirdeyeConfig): Promise<TokenInfo[]>;
export async function fetchBirdeyeTokenOverview(address: string, config: BirdeyeConfig): Promise<TokenInfo | null>;
export async function fetchBirdeyeOhlcv(address: string, config: BirdeyeConfig, options?: { interval?: string; limit?: number }): Promise<PriceCandle[]>;
```

**Status:** Implemented June 2026. See `docs/features/2026/06/27/005-birdeye-provider/001-plan.md` for the implementation plan.

---

## Part F — Configuration

Add to `config/default.yaml`:

```yaml
marketData:
  hyperliquid:
    infoUrl: "https://api.hyperliquid.xyz"
    rateLimit:
      requestsPerMinute: 600
    timeoutMs: 5000
  bybit:
    infoUrl: "https://api.bybit.com"
    rateLimit:
      requestsPerMinute: 120
    timeoutMs: 5000
  dexscreener:
    baseUrl: "https://api.dexscreener.com"
    rateLimit:
      requestsPerMinute: 60
      discoveryBudgetPct: 50
    timeoutMs: 5000
  geckoterminal:
    baseUrl: "https://api.geckoterminal.com"
    rateLimit:
      requestsPerMinute: 30
      discoveryBudgetPct: 50
    timeoutMs: 5000
  discovery:
    networks: ["solana", "base"]
    minLiquidityUsd: 10000
    maxResults: 20
    antistalenessCooldownHours: 4
  birdeye:
    enabled: false
    baseUrl: "https://public-api.birdeye.so"
    # apiKey: set via BIRDEYE_API_KEY env var
    rateLimit:
      requestsPerMinute: 100
    timeoutMs: 5000
```

---

## Implementation Order

1. **A1** — Hyperliquid funding + OI (single fetch, immediate value)
2. **A3** — Wire into tick context (agent sees funding/OI without tool calls)
3. **C2** — `get_funding_rates` tool (agent can also fetch on demand)
4. **B1** — DexScreener discovery endpoints
5. **B2** — GeckoTerminal discovery endpoints
6. **B3** — Unified discovery aggregator
7. **C1** — `discover_tokens` tool
8. **A2** — Bybit long/short ratio
9. **C3** — `get_market_overview` tool
10. **D** — Skill registration updates
11. **F** — Configuration schema
12. **E** — Birdeye ✅ (implemented June 2026)

---

## Dependencies

- `@herobids/market-data` — all new fetch functions live here
- `apps/worker/src/agent.ts` — tool dispatch
- `apps/worker/src/runtime-composition.ts` — context injection
- `@herobids/domain` — skill definitions, tool schemas
- `config/default.yaml` — new config section
