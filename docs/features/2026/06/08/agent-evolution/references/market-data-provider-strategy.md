## Provider Map: aitradingbot vs. herobids

### Market Data Providers

| Provider | Free Tier | Capabilities | aitradingbot | herobids | Notes |
|---|---|---|---|---|---|
| **DexScreener** | Yes (60 req/min) | Discovery, token search, OHLCV (via pool), overview/price | ✅ Full (trending, boosts, profiles, search) | ✅ Partial (search only) | herobids uses it for `search_tokens` tool; aitradingbot has deep discovery vectors |
| **GeckoTerminal** | Yes (10–30 req/min) | Discovery (trending, top, new pools), OHLCV, token overview/price | ✅ Full (trending/top/new, OHLCV, overview) | ✅ Partial (OHLCV only) | herobids only fetches candles by pool address — no discovery |
| **Binance** | Yes (1200 req/min) | OHLCV candles, ticker prices | ✅ OHLCV + symbol mapping | ✅ OHLCV (regime checks) | Both use it for reliable candle data on major pairs. No auth needed |
| **Birdeye** | Paid ($49+/mo) | Discovery (trending), OHLCV, token overview/price | ✅ Full (Solana only) | ❌ Not implemented | Solana DEX analytics. Requires API key. Good OHLCV fallback |
| **CoinMarketCap** | Paid (free tier 10K calls/mo) | Discovery (trending/new), enrichment (market cap, FDV, holders, CEX listings, risk) | ✅ Full (enrichment + discovery) | ❌ Not implemented | Enrichment data (holders, risk score) is valuable for agent context |
| **Coinbase** | Yes (no auth) | OHLCV candles | ✅ OHLCV fallback | ❌ Not implemented | Redundant — Binance covers the same symbols better |
| **Jupiter Price** | Yes (no auth, 600 req/min) | Token price via swap quote (Solana) | ✅ Primary price source | ❌ (quotes happen via JupiterSwapAdapter) | In herobids, swap quotes implicitly give prices during execution |

### Execution Venues (Orderbook / Perps)

| Venue | Free Tier | Capabilities | aitradingbot | herobids | Notes |
|---|---|---|---|---|---|
| **Hyperliquid** | Yes (perps) | Submit/amend/cancel orders, positions, balances, WebSocket streams (ticker, orderbook, trades, fills, positions) | ❌ Not used | ✅ Full (orderbook + private/public streams) | Primary CEX venue. Free to trade (no subscription). Provides real-time data via WS |
| **Bybit** | Yes (perps) | Submit/amend/cancel orders, positions, balances, WebSocket streams | ❌ Not used | ✅ Full (orderbook + private/public streams) | Second CEX venue. Also free via API |

### Execution Venues (DEX Swaps)

| Venue | Free Tier | Capabilities | aitradingbot | herobids | Notes |
|---|---|---|---|---|---|
| **Jupiter** (Solana) | Yes | Swap quotes, execute swaps | ✅ Execution | ✅ Swap venue adapter | Same in both |
| **1inch** (Base/EVM) | Free API key required | Swap quotes, execute swaps | ✅ Execution | ✅ Swap venue adapter | Same in both |

### Data Available from Execution Venues (Free, via WebSocket — herobids only)

| Data Type | Hyperliquid | Bybit | Cost |
|---|---|---|---|
| Real-time tickers (last/bid/ask) | ✅ Public WS | ✅ Public WS | **$0** |
| Orderbook depth | ✅ Public WS | ✅ Public WS | **$0** |
| Trade prints | ✅ Public WS | ✅ Public WS | **$0** |
| Positions (live updates) | ✅ Private WS | ✅ Private WS | **$0** |
| Fill notifications | ✅ Private WS | ✅ Private WS | **$0** |
| Funding rates | Available via REST (not implemented) | Available via REST (not implemented) | **$0** |
| Open interest | Available via REST (not implemented) | Available via REST (not implemented) | **$0** |

---

## What herobids is Missing vs. aitradingbot

| Gap | Impact on Agent | Effort |
|---|---|---|
| DexScreener discovery vectors (trending, boosts, profiles) | Agent can't find new tokens without explicit search query | Low — add fetch functions to `@herobids/market-data` |
| GeckoTerminal discovery (trending/top/new pools) | Same as above | Low |
| Funding rate fetch (Hyperliquid/Bybit REST) | Agent lacks key short-vs-long signal | Low — single endpoint, free |
| Open interest fetch (Hyperliquid/Bybit REST) | Agent can't see crowding signals | Low — single endpoint, free |

---

## Implementation Plan

Agents trade perps, CEX spot, and DEX memecoins. The data strategy must be **asset-class aware**, not perps-only.

---

### Layer 1 — Core Free Execution + Market Data (keep as-is)

| Provider | Role | Cost | Status |
|---|---|---|---|
| **Hyperliquid** | Perps execution, real-time WS (ticker, orderbook, trades, positions, fills) | $0 | ✅ Implemented |
| **Bybit** | Perps execution, real-time WS (same) | $0 | ✅ Implemented |
| **Binance** | OHLCV candles for regime checks, major-pair indicators | $0 | ✅ Implemented |
| **Jupiter** | Solana DEX swap execution + implicit price quotes | $0 | ✅ Implemented |
| **1inch** | Base/EVM DEX swap execution | $0 (free key) | ✅ Implemented |

**Action:** No changes needed. These remain the backbone.

---

### Layer 2 — Free Data Extraction from Existing Venues (add now)

Data already available at $0 from the venues we connect to, but not yet surfaced:

| Data to add | Source | Cost | Why it matters |
|---|---|---|---|
| **Funding rates** | Hyperliquid REST: `POST /info` with `{"type": "metaAndAssetCtxs"}` | $0 | Short-vs-long signal. Negative funding = shorts crowded = long opportunity |
| **Open interest** | Same Hyperliquid response includes OI per asset | $0 | Position crowding / sentiment |
| **24h volume + price change** | Hyperliquid/Bybit REST or already in WS ticker | $0 | Replaces what CMC/Birdeye gives for perp assets |
| **Liquidation data** | Bybit REST: `/v5/market/recent-trade?category=linear&limit=100` (trade type includes liq) | $0 | Shows where leveraged positions are breaking |

**Action:** Implement these as new functions in `@herobids/market-data` or the venue adapters. Pre-compute and inject into agent tick context.

---

### Layer 3 — Free DEX Discovery (add now)

| Provider | What to add | Cost | Why |
|---|---|---|---|
| **DexScreener** | Discovery endpoints: trending tokens, boosts (top/latest), token profiles (latest/recent) | $0 (60 req/min) | Agents need to find new DEX token opportunities without explicit search queries |
| **GeckoTerminal** | Discovery endpoints: trending pools, top pools (by volume), new pools | $0 (10–30 req/min) | Second discovery source. Multi-chain coverage (Solana + Base + others). Also provides OHLCV per pool |

**Action:** Port the discovery vector pattern from aitradingbot into `@herobids/market-data`. Expose as agent tools (`discover_tokens`) and/or pre-compute into tick context.

---

### Layer 4 — Paid Providers (add)

Priority order if paying for one or two:

#### Priority 1: Birdeye

| | |
|---|---|
| **Cost** | $49+/mo |
| **Covers** | Solana DEX: trending tokens, OHLCV, token overview/price, holder distribution |
| **Why first** | Strongest Solana DEX analytics. Complements free DexScreener/GeckoTerminal with deeper token-level data (holder count, distribution, wallet activity). Critical for memecoin screening on Solana. |
| **When to add** | When agents actively trade Solana DEX memecoins and the free discovery sources prove insufficient for quality filtering. |

#### Priority 2: CoinMarketCap

| | |
|---|---|
| **Cost** | Free tier 10K calls/mo; paid $79+/mo for more |
| **Covers** | Cross-chain enrichment: market cap, FDV, holder count, CEX listing names, risk level, categories, trending/new tokens |
| **Why second** | Broadest cross-asset enrichment. Helps agents assess token quality regardless of chain. Risk level and CEX listing data are hard to get elsewhere. |
| **When to add** | When agents need quality-gating metadata (risk score, holder concentration, CEX presence) to avoid scams and rug pulls on DEX tokens. Start with free tier (10K calls/mo may suffice for enrichment-only use). |

#### Not recommended to pay for

| Provider | Reason to skip |
|---|---|
| **Coinbase** | Binance is strictly better — more symbols, higher rate limits, same free tier |
| **DexScreener paid** | Free tier (60 req/min) is adequate for discovery. Paid tier only needed at very high agent concurrency |
| **GeckoTerminal paid** (CoinGecko Pro) | Free tier sufficient for discovery + OHLCV. Paid tier adds rate-limit headroom but not new capabilities |
| **Hyperliquid / Bybit / Binance paid** | These are free to use. No paid tier needed for data or execution |

---

### Layer 5 — Optional / Future

| Provider | What it adds | When to consider |
|---|---|---|
| **Jupiter Price API** | Explicit price lookups separate from swap execution | If agents need Solana token prices outside of swap flow (e.g. portfolio valuation, watchlists) |
| **Coinbase** | OHLCV fallback | Only if Binance becomes unreliable or rate-limited at scale |
| **On-chain data** (Helius, Shyft, etc.) | Wallet tracking, token holder snapshots, transaction history | When agents need on-chain intelligence beyond what Birdeye provides |

---

### Summary

| Layer | Providers | Cost | Status |
|---|---|---|---|
| Core execution + data | Hyperliquid, Bybit, Binance, Jupiter, 1inch | $0 | ✅ Keep |
| Free venue extraction | Funding, OI, liquidations, volume (from HL/Bybit) | $0 | 🔨 Add now |
| Free DEX discovery | DexScreener discovery, GeckoTerminal discovery | $0 | 🔨 Add now |
| Paid priority 1 | Birdeye (Solana DEX depth) | $49/mo | 📋 Add |
| Paid priority 2 | CoinMarketCap (cross-chain enrichment) | Free–$79/mo | 📋 Add (start on free tier) |
| Skip | Coinbase, paid DexScreener, paid GeckoTerminal | — | ❌ Not needed |

**Cost posture:** 5 free providers + 1–2 low-tier paid (Birdeye + CMC free tier) + LLM provider. Total non-LLM data cost: $49–$128/mo max.