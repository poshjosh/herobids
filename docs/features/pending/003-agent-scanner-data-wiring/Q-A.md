# Q&A — Agent Scanner Data Wiring

## Investigation

### Q1: Why don't hybrid/scanner_gated agents trade?

The scanner pipeline has 5 layers. Layers 2–5 are fully built and tested. Layer 1 — the data input functions — was never implemented:

| Layer | Component | Status |
|-------|-----------|--------|
| 5 | Hybrid evaluator (single-shot LLM prompt) | ✅ Built |
| 4 | Wake gating (scanner_gated suppression) | ✅ Built |
| 3 | Signal scoring (`scanCandidates`, `scoreCandidate`) | ✅ Built |
| 2 | Technical phase orchestration (`runTechnicalPhase`) | ✅ Built |
| **1** | **Data inputs (`discoverCandidates`, `fetchCandles`)** | **❌ Missing** |
| 0 | Config schema (`TechnicalConfigSchema`) | ✅ Built |

`discoverCandidates` and `fetchCandles` are declared as optional deps in `AgentTradingActorDeps` but never assigned in `index.ts`. `startTechnicalScanLoop()` silently returns because both are `undefined`. No scanner signals are ever produced, so scanner_gated agents wait forever.

Evidence from staging (2026-07-15):
- Worker logs: 0 occurrences of "scan", "scanner", "Technical scan" in 24h
- Agent logs: *"Hybrid agent: timer tick without wake signal — skipping LLM dispatch"* repeating every 30 min
- DB: 0 decisions from any hybrid agent (only tsonnet in intelligence mode made 12)
- Redis: `agent:scanner_gated:*` flags exist, wake prefs exist, but zero wake signal events

### Q2: Which venues does the scanner need to support?

All 4 venues currently supported by the platform:

| Venue | Type | Live-gated (`allowedVenues`) |
|-------|------|------------------------------|
| Hyperliquid | orderbook | ✅ |
| Bybit | orderbook | ✅ |
| Jupiter | swap | ✅ |
| 1inch | swap | ✅ |

All 4 have full adapter support in `VenueAdapterFactory` and can execute trades.

### Q3: Can the indicator model (RSI, MACD, etc.) work on swap/DEX venues?

Yes. The aitradingbot codebase (`/Users/chinomso.ikwuagwu/dev_ai/aitradingbot/src/strategy/`) used identical indicators (RSI, MACD, volume profile, support/resistance) on DEX tokens. It discovered candidates from DexScreener/GeckoTerminal, fetched OHLCV from the same sources, and scored them with the same math. The indicator model is venue-agnostic — it only needs OHLCV arrays.

### Q4: How does the scanner discover candidates per venue?

| Venue | Discovery method | Returns |
|-------|-----------------|---------|
| Hyperliquid | `providerRegistry.hyperliquid.assetContexts()` | Symbol, volume24hUsd, priceChange24hPct, OI, markPrice |
| Bybit | `fetchBybitTickers()` (NEW) — wraps `/v5/market/tickers?category=linear` | Symbol, volume24hUsd, priceChange24hPct, lastPrice |
| Jupiter | `providerRegistry.discovery.discover()` + `geckoterminal.trendingPools/topPools/newPools` | Pool address, symbol, volume24hUsd, liquidityUsd, priceUsd |
| 1inch | Same as Jupiter — discovery pipeline on Base network | Same fields |

For orderbook venues: discovery returns all perps filtered by volume/price criteria. For swap venues: discovery returns trending/new tokens from DEX aggregators.

### Q5: How does the scanner fetch candles per venue?

All venues use a single shared `VenueCandleFetcher` instance:

| Venue type | Candle source | How |
|------------|--------------|-----|
| orderbook (Hyperliquid, Bybit) | Binance spot | `VenueCandleFetcher` auto-routes by venue type |
| swap (Jupiter, 1inch) | GeckoTerminal pool candles | `VenueCandleFetcher` auto-routes by venue type |

Hyperliquid perps use Binance spot as proxy (no public kline endpoint). Bybit has `/v5/market/kline` but Binance is used for consistency. If venue-native accuracy becomes needed, Birdeye or Bybit klines can be added later without changing the scanner interface.

### Q6: Why include 1inch if it has no instrument list?

1inch is a universal aggregator — any ERC-20 token on Base is tradeable. There's no fixed symbol list. But the scanner doesn't need one. It discovers candidates from the DEX discovery pipeline (DexScreener/GeckoTerminal on Base), not from venue symbol lists. The discovery pipeline already runs for the `base` network. The instrument cache skipping 1inch is about symbol validation at decision intake, not about scanner discovery — those are different concerns.

### Q7: What new infrastructure needs to be built?

Only one new function: **`fetchBybitTickers`** in `packages/market-data/`.

Bybit's `/v5/market/tickers?category=linear` returns all linear perpetual tickers. This maps directly to the `DiscoveredInstrument` shape the scanner expects. The function will be added to `providerRegistry.bybit` alongside the existing `longShortRatio`. It follows the same pattern as `fetchHyperliquidAssetContexts`.

### Q8: What existing infrastructure is reused?

- `VenueCandleFetcher` — candle routing (already used by bots)
- `providerRegistry.hyperliquid.assetContexts()` — Hyperliquid discovery (already cached)
- `providerRegistry.discovery.discover()` — DEX discovery (already running)
- `providerRegistry.geckoterminal.*` — pool data (already running)
- `runTechnicalPhase()` — full scanner orchestration (already built)
- `scanCandidates()` / `scoreCandidate()` — indicator engine (already built in `@herobids/strategy`)
- Wake infrastructure, hybrid evaluator, single-shot prompt — all built

### Q9: Does this affect intelligence-mode agents?

No. Intelligence-mode agents (like tsonnet) have `isHybridMode: false`. The scanner loop runs but wake signals are only emitted when `isHybridMode && signals.length > 0`. Intelligence agents use the full scout/judge LLM loop and are completely orthogonal to the scanner.

### Q10: What about `tmomentum-d`?

This agent is configured as `hybrid`/`scanner_gated` but has NULL `technical` config in `unified_config`. `startTechnicalScanLoop()` checks `if (!technicalConfig) return` — so it would still not scan even after wiring. It needs either a technical config or a mode switch to `intelligence`.

### Q11: What's the relationship to the short-term plan?

The short-term plan (`docs/features/2026/07/15/002-technical-data-for-agents/001-plan.md`) wires Hyperliquid-only discovery and Binance candles into `index.ts` — a minimal fix to get staging agents trading. This plan builds on it by adding multi-venue support, Bybit discovery, and swap venue coverage for a production-ready feature.
