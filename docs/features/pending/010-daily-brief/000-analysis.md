# ANALYSIS

## Background

We have 2 things implemented:

- Economic calendar
- Strategy preset review

---

We would like to publish daily crypto trading info like:

- Economic calendar
- Trending instruments
- Market regime
- Recommended strategy preset for current market regime

---

The crypto trading info will be used in:

- A newsletter page which we should create in our public pages in apps/web/src/features/public-pages/content/

- By the proposed chat UI for creating agents to reduce the complexity by asking the user if the AI should suggest the best fitting defaults 

---

What do you think? For example how feasible? Any caveats?

## Feasibility: **Highly Feasible** ✅

The core data infrastructure for **all four** pieces already exists and is running in production. You're mostly wiring together things that are already built:

| Daily Info | Existing Infrastructure | Maturity |
|---|---|---|
| **Economic Calendar** | `EconomicCalendarProvider` → Forex Factory via Scrapfly → Redis cache → injected into agent context as `macroEvents` | ✅ Working |
| **Trending Instruments** | Multi-provider discovery pipeline (DexScreener, GeckoTerminal, CoinMarketCap, Birdeye) → Redis snapshots at `market-intel:discovery:latest` | ✅ Working |
| **Market Regime** | `evaluateRegime()` (EMA alignment, ADX, VWAP, structure) → evaluated every 60s by `MarketDataCoordinator` → Redis at `market-intel:regime:{symbol}` | ✅ Working |
| **Strategy Preset Recommendation** | `assess_strategy_preset` tool + `AssessmentReviewRunner` + presets in `config/strategy-presets/*.yaml` | ⚠️ Core exists, tool access being fixed (see `001-preset-review-gap-closure`) |

---

## What You'd Need to Build

### 1. A Daily Digest API Endpoint
A new endpoint (e.g., `GET /market-data/daily-digest` or `GET /public/daily-brief`) that aggregates from Redis:

```
EconomicCalendarProvider.getUpcomingEvents()  → economic events
market-intel:discovery:latest                 → trending tokens (top N by volume/liquidity)
market-intel:regime:BTC                       → regime details (ADX, EMA alignment, choppy flag)
```

The regime → preset mapping could be heuristic at first (no LLM cost):
- **Bullish trend + ADX > 25 + not choppy** → `momentum` or `momentum-position`
- **Choppy / ADX < 20** → `range` or `swing`
- **Bearish alignment** → `contrarian`

### 2. A Newsletter Page in Public Pages
Add to contentRegistry.ts and create a dynamic component (not just markdown). The public pages framework already supports this pattern — PublicPage.tsx renders `MarkdownPage`, but you could add a `DailyBriefPage` component for a new `newsletter` section:

```
apps/web/src/features/public-pages/
  content/
    en/
      newsletter/          ← new
        daily-brief.md     ← static intro text
  DailyBriefPage.tsx        ← new dynamic component
```

### 3. Chat UI Suggestion
When the chat UI asks "Should the AI suggest the best fitting defaults?", call the same digest endpoint and present the recommendation. This is essentially the same data source as #3.

---

## Caveats ⚠️

### 1. Economic Calendar Is Forex-Focused, Not Crypto-Native
The current `ForexFactoryCalendarAdapter` scrapes traditional economic events (FOMC, NFP, CPI, etc.). It does **not** cover crypto-specific events like token unlocks, protocol upgrades, governance votes, or on-chain metrics. For a crypto trading newsletter, this is a gap. You'd either need to:
- Add a second calendar source (e.g., CoinMarketCap's calendar API, which you already have API access to)
- Or clearly label the section as "Macro Economic Calendar"

### 2. Trending Instruments Are Point-in-Time
Discovery snapshots refresh every 30s and represent "what's trending right now." For a daily newsletter, you'd want either:
- A **24h aggregated view** (top gainers, top volume over the day) — this doesn't exist yet
- Or to snapshot the discovery data to Postgres at publish time so it's stable

The `DiscoveredToken` type already has `volume24hUsd`, `priceChange24hPct`, and `liquidityUsd` — so sorting by these metrics is straightforward.

### 3. Regime → Preset Mapping Is Heuristic, Not Proven
The current `assess_strategy_preset` tool uses LLM reasoning per-agent. A generic daily recommendation without an LLM is a heuristic mapping. There's no backtest data (yet) proving that "bullish regime → momentum preset" actually outperforms other presets in that regime. You'd want to:
- Start with a simple heuristic
- Log what was recommended vs. what agents actually used
- Eventually run backtests to validate the mapping

### 4. Regime Is Single-Symbol (BTC)
`evaluateRegime()` evaluates one benchmark at a time (defaults to BTC). For a broader market picture, you might want to also evaluate ETH and SOL regimes. The coordinator already supports `benchmarkSymbols: ['BTC']` — this is just a config change to `['BTC', 'ETH', 'SOL']`.

### 5. Redis TTL vs. Newsletter Persistence
The discovery and regime snapshots in Redis have TTLs (e.g., `discoveryMaxAgeMs` = 10 min). If the worker is down, the Redis keys expire and the newsletter page shows nothing. For a newsletter, consider:
- Having the API persist a daily snapshot to Postgres (a simple `daily_briefs` table)
- Or accepting that the page shows "data temporarily unavailable" when the worker is down

### 6. Public API Authentication
The admin market-data endpoints are admin-only. A public newsletter page needs either:
- A new **unauthenticated** public endpoint (if the data isn't sensitive)
- Or a server-side fetch with a service token

Since this is marketing/content data (not user-specific), an unauthenticated endpoint is appropriate.

### 7. Multi-Venue Complexity
Trending tokens on Solana DEX (Jupiter) look very different from trending perps on Hyperliquid. The discovery system already tags tokens by `network`. You'd want to present them in separate sections or with clear venue labels in the newsletter.

### 8. LLM Cost for "Recommended Preset"
If you use the LLM-based `assess_strategy_preset` path for the daily recommendation (rather than a heuristic), that adds ongoing token costs. The current cost estimate is ~$0.08–$0.15 per tick for an agent. A once-daily assessment would be negligible, but worth tracking.

---

## Recommended Approach

**Phase 1 — Quick win (1-2 days):**
1. Add `GET /api/public/daily-brief` — unauthenticated, reads from Redis
2. Create a simple heuristic `regime → preset` mapping function
3. Add a `DailyBriefPage` component in public pages
4. Wire the preset default into the create agent form

**Phase 2 — Polish:**
5. Add CoinMarketCap calendar as a second economic calendar source for crypto events
6. Snapshot daily brief to Postgres for persistence
7. Add ETH/SOL regime evaluation
8. Use the daily brief data in the chat UI flow

**Phase 3 — Validate:**
9. Log recommended-vs-actual preset performance
10. Backtest regime→preset mapping
11. Consider LLM-generated commentary for the newsletter

---

The foundation is remarkably solid — this is much more of an integration/UX project than a greenfield build. Most of the hard data engineering is done.