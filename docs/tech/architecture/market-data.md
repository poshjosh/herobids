# Market Data Architecture

## Purpose

This document is the current-state source of truth for how HeroBids fetches,
caches, rates, distributes, and degrades market data and related market
intelligence.

It replaces ad hoc feature notes as the durable description of the system. When
market-data providers, consumers, or source-selection rules change, update this
document alongside the code.

## Scope

In this repo, "market data" includes more than live prices.

It covers:

- public venue stream data used by trading actors
- venue intelligence such as funding, open interest, mark/oracle spread, and
  crowding ratios
- OHLCV candle data for regime checks
- token search, token discovery, and optional enrichment
- non-execution price lookup for valuation and monitoring
- background discovery snapshots published for the wider system

It does not include the actual order-execution quotes used to place live swap
trades. Those remain part of venue adapters and execution flows.

## Design Principles

1. Keep execution pricing separate from monitoring pricing.
   Live trade sizing and trade execution must use venue-native marks or the
   latest executable quote, not a generic price service.

2. Be asset-class aware.
   Perpetuals, CEX spot, and DEX tokens do not share the same best source.

3. Make freshness explicit.
   Provider results carry freshness metadata so callers can tell whether data is
   upstream, cached, or stale.

4. Prefer graceful degradation over silent blindness.
   Stale cached data is acceptable in some read paths; dead market-data tools or
   missing runtime data should be surfaced clearly.

5. Keep prompt-time context compact.
   Agents should receive summarized signals, not raw market-data dumps.

## Taxonomy

The shared market-data layer classifies provider traffic into request classes in
`packages/market-data/src/types.ts`:

| Class | Purpose |
|---|---|
| `execution-critical` | Reserved for the highest-priority market-data requests; present in the type system but not the primary class used by the current provider registry |
| `price-support` | Venue intelligence and price-adjacent lookups |
| `regime` | Candle-based trend and regime analysis |
| `discovery` | Token and pool discovery |
| `enrichment` | Optional paid-provider metadata enrichment |

This taxonomy matters because rate limiting, cache policy, and scheduling are
all defined in terms of these classes.

## Main Layers

### 1. Execution-native live data

Orderbook venues use worker-scoped WebSocket pooling for public market data.

- `packages/venues/src/stream-pool.ts`
  Owns one connection per venue and fans out ticker, orderbook, and trade
  events to many subscribers.
- `packages/engine/src/stream-market-data-feed.ts`
  Adapts pooled stream events into the feed consumed by trading executors.
- `apps/worker/src/trading-actor.ts`
  Injects `StreamMarketDataFeed` for shadow trading when a public stream is
  available.

If stream subscription fails, the feed degrades to polling and keeps attempting
to reconnect. This is an intentional fail-soft path, not an accident.

### 2. Registry-backed HTTP and cached provider data

The central integration surface is `packages/market-data/src/provider-registry.ts`.

The provider registry:

- constructs provider-specific clients from resolved operator config
- applies coordinated rate limiting
- applies cache policy and stale-while-revalidate behavior
- returns `ProviderResult<T>` values with freshness metadata

This is the main source for non-stream market data.

### 3. Derived market-data services

Higher-level services sit on top of raw providers:

- `packages/market-data/src/discovery.ts`
  Aggregates discovery vectors across multiple providers, merges, ranks, and
  fail-soft enriches.
- `packages/market-data/src/price-service.ts`
  Provides non-execution price lookup with explicit source priority.
- `packages/market-data/src/token-search.ts`
  Provides search and policy-filtered token selection.
- token-safety helpers in `packages/market-data/src/token-safety.ts`
  Evaluate candidates against liquidity, age, canonical-token, and other
  policy rules.

### 4. Background publication and runtime consumption

Two main consumers exist today:

- worker trading/runtime logic
- agent runtime tools and market-intelligence loops

The background coordinator in
`apps/worker/src/market-intelligence/coordinator.ts` periodically refreshes
discovery state and publishes snapshots into Redis. This makes market
intelligence available beyond the single request that fetched it.

## Current Provider Map

### Execution and stream data

| Source | Data | Main consumers | Notes |
|---|---|---|---|
| Hyperliquid public/private streams | ticker, orderbook, trades, fills, positions | trading actors, reconciler, runtime state | execution-native venue path |
| Bybit public/private streams | ticker, orderbook, trades, fills, positions | trading actors, reconciler, runtime state | execution-native venue path |
| Jupiter swap quotes | executable swap pricing | execution only | intentionally outside shared market-data registry |
| 1inch swap quotes | executable swap pricing | execution only | intentionally outside shared market-data registry |

### Registry-backed providers

| Provider | Current use | Implemented surface |
|---|---|---|
| Binance | regime candles | candle fetch via `fetchBinanceCandles()` |
| DexScreener | token search, oracle price support, discovery | search, trending/boosts/profiles discovery vectors; boost-to-pool enrichment pipeline (fills real liquidity for tokens surfaced via paid promotion endpoints) |
| GeckoTerminal | DEX candles and discovery | candles, trending pools, top pools, new pools |
| Hyperliquid REST | perp intelligence | funding, annualized funding, open interest, mark/mid/oracle price, mark-oracle spread, 24h volume, 24h price change |
| Bybit REST | crowding signal | long/short ratio |
| CoinMarketCap | optional discovery and enrichment | trending, new listings, enrichment, only when enabled |
| Birdeye | optional Solana-only discovery, overview, and OHLCV | token trending, token overview, OHLCV candles, only when enabled; HTTP 400 treated as warn-and-skip (Birdeye returns 400 for both rate limits and unsupported tokens) |
| CoinGecko | reference oracle mark fallback | separate `OracleMarkSource`, not part of the shared registry |

## Source-of-Truth Rules

### Live execution and shadow fill heuristics

Use venue-native market data first.

- Orderbook/perps flows should read from live stream or venue polling paths.
- Swap execution should use the latest executable quote from the venue adapter.
- The shared price service must not become the source of truth for trade entry
  or exit.

### Non-execution price lookup

`packages/market-data/src/price-service.ts` defines the current policy.

For `hyperliquid`:

1. Hyperliquid execution mark from asset contexts
2. DexScreener oracle-style price fallback
3. local last-known cached price within TTL

For other chains/networks:

1. DexScreener price lookup
2. local last-known cached price within TTL

This service is intended for valuation, watch/monitor style checks, and
discovery-adjacent pricing, not live execution.

### Discovery

Discovery is intentionally multi-provider.

`packages/market-data/src/discovery.ts` currently fans out to:

- DexScreener trending
- DexScreener latest boosts
- DexScreener latest token profiles
- GeckoTerminal trending pools per network
- GeckoTerminal top pools per network
- GeckoTerminal new pools per network
- CoinMarketCap trending and new listings when enabled
- Birdeye trending when enabled and when `solana` is in the network list

Results are merged by `network:address`, ranked by liquidity or market-cap-like
proxy, then a DexScreener boost-enrichment pass fills real on-chain liquidity for
zero-liquidity boost/profile tokens before the threshold filter runs. After
filtering and ranking, CoinMarketCap enrichment optionally adds market-cap and
CEX-listing metadata. Birdeye 400s (rate limits / unsupported tokens) are caught
and discarded by `Promise.allSettled` — they do not block other providers.

## Configuration Flow

Market-data behavior is operator config, not user or instance config.

The resolved `appConfig.marketData` object is:

1. loaded in the worker process
2. serialized into `MARKET_DATA_CONFIG_JSON` in
   `apps/worker/src/index.ts`
3. parsed in the agent runtime in `apps/worker/src/agent.ts`
4. used to build the provider registry and price service inside the runtime

This follows the repo rule that structured operator policy lives in config and
is transported as resolved runtime payload, not reassembled from ad hoc env
reads.

## Caching, Rate Limiting, and Freshness

### Shared rate budgets

The provider registry uses coordinated rate limiting so one noisy caller does
not consume the entire budget for a provider.

Notable current behavior:

- DexScreener search and discovery share one combined provider budget, with
  reservation for `price-support` traffic.
- GeckoTerminal candle and discovery paths share one combined provider budget,
  with reservation for `regime` traffic.
- Hyperliquid and Bybit intelligence use their own rate-limited budgets.
- Birdeye uses a single `discovery`-class budget for all endpoints (trending,
  overview, OHLCV) — Birdeye has a global API-wide rate limit.

### Cache semantics

Provider responses go through `loadWithCache()` and return freshness metadata.

Current patterns:

- discovery and intelligence paths commonly allow stale-while-revalidate
- CoinMarketCap and Birdeye are opt-in and fail-soft; enabled-without-API-key is a loud startup error caught by both Zod schema validation and a safety-net throw in the provider registry
- Binance candles currently use an effective TTL of `0`, so the registry treats
  them as uncached per request

### Freshness model

Each provider result includes:

- whether it came from upstream or cache
- when it was fetched
- how old it is
- TTL and expiry info
- whether it is considered stale

Callers should preserve this distinction rather than flattening everything into
an undifferentiated price or token list.

## Runtime Consumers

### Trading actors

`apps/worker/src/trading-actor.ts` uses:

- `StreamMarketDataFeed` for orderbook venues when the stream pool is present
- polling fallback when the stream path is unavailable or unsupported
- `OracleMarkSource` for reference marking and P&L/risk valuation support

### Agent runtime

`apps/worker/src/agent.ts` builds:

- a `ProviderRegistry` when `MARKET_DATA_CONFIG_JSON` is present
- a `PriceService` on top of that registry
- market-data tools only when the registry is available

If market-data config is absent or invalid, market-data tools are explicitly
disabled rather than half-configured.

### Background coordinator

`apps/worker/src/market-intelligence/coordinator.ts` is leader-elected and owns
shared discovery refresh.

It currently:

- refreshes aggregated discovery snapshots on an interval
- publishes the latest global snapshot and per-network slices into Redis
- marks existing discovery state stale when refresh fails
- keeps metadata such as capture time, next poll time, and basic source health

This turns provider fetches into shared platform state instead of forcing every
consumer to rediscover the same tokens independently.

## Failure and Degradation Model

HeroBids does not treat all market-data failures the same.

### Stream failure

When a live stream fails:

- the feed falls back to polling when possible
- reconnect attempts continue in the background
- the goal is to keep the actor trading with degraded fidelity rather than go
  fully blind immediately

### Provider failure

When a registry-backed provider fails:

- stale cached data may still be served when the policy allows it
- multi-provider discovery continues when only some providers fail
- optional enrichment must not block base discovery results
- Birdeye HTTP 400 responses (rate limits, unsupported tokens) are caught by the Birdeye client and treated as empty results — other providers proceed unaffected

### Coordinator failure

When a discovery refresh fails:

- the coordinator preserves the last snapshot when present
- marks the snapshot stale
- records source health as degraded in the published state

### Config failure

When market-data config is missing or unparsable in agent runtime:

- market-data tools are disabled
- the system logs the problem loudly
- it does not guess defaults from unrelated config

## Boundaries

The following boundaries are intentional and should remain explicit.

### Shared market-data layer vs. venue execution adapters

The shared market-data layer owns reusable fetches, discovery, enrichment,
regime, and non-execution price lookup.

Venue adapters still own:

- live order entry and cancellation
- private account streams
- swap quotes used for executable routing

### Price service vs. oracle mark source

These are related but distinct.

- `createPriceService()` is for non-execution lookup inside the market-data
  package.
- `OracleMarkSource` in `packages/venues/src/oracle-mark-source.ts` is the
  reference-mark fallback used by worker-side trading and marking flows.

### Feature notes vs. architecture docs

Feature-era documents may discuss vendor comparisons or proposed rollouts.
This document should stay focused on current architecture, present behavior,
and explicit system boundaries.

## Known Gaps

These are current gaps or areas to watch, not hidden assumptions.

1. Birdeye is present in config/types but not wired into the provider registry.
2. `execution-critical` exists as a request class but is not yet the dominant
   path in the current registry wiring.
3. Market-data observability is stronger in code paths than in operator-facing
   dashboards; there is not yet a dedicated UI for provider freshness, budget
   pressure, or source health.
4. The repo has both registry-backed price lookup and worker-side oracle marks;
   future changes should preserve the distinction instead of merging them into a
   single catch-all abstraction.

## Update Checklist

When changing market-data behavior, update this document if any of the following
change:

- a new provider is added or an existing one is removed
- source-priority rules change
- a new runtime consumer is introduced
- cache or rate-limit policy changes materially
- stale/fallback behavior changes
- a currently planned provider such as Birdeye becomes real