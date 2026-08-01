# Agent Scanner Data Wiring — Problem & Solution

**Status:** Pending  
**Created:** 2026-07-15  
**Depends on:** `docs/features/2026/07/15/002-technical-data-for-agents/001-plan.md` (short-term fix)

## Statement of Problem

Hybrid/scanner_gated agents never make trading decisions. The entire scanner pipeline — orchestration (`technical-phase.ts`), signal scoring (`@herobids/strategy`), wake emission, hybrid evaluator, single-shot LLM prompt — is built and tested. But two critical data-input functions were never implemented or wired in production:

1. **`discoverCandidates(filters)`** — find instruments to scan
2. **`fetchCandles(symbol, interval, limit)`** — fetch OHLCV data for indicator computation

Both exist as TypeScript interfaces in `AgentTradingActorDeps`. Both are mocked in tests. Neither has a production implementation. The `AgentTradingActor` constructor in `index.ts` never receives them. `startTechnicalScanLoop()` silently returns. Six of eight staging agents sit idle.

## Target Solution

A venue-agnostic scanner that works across all 4 supported venues:

| Venue | Type | Discovery source | Candle source |
|-------|------|-----------------|---------------|
| Hyperliquid | orderbook | `providerRegistry.hyperliquid.assetContexts()` | `VenueCandleFetcher` → Binance |
| Bybit | orderbook | `fetchBybitTickers()` (NEW — `/v5/market/tickers?category=linear`) | `VenueCandleFetcher` → Binance |
| Jupiter | swap | `providerRegistry.discovery.discover()` + `geckoterminal.*` | `VenueCandleFetcher` → GeckoTerminal |
| 1inch | swap | `providerRegistry.discovery.discover()` (Base network) + `geckoterminal.*` | `VenueCandleFetcher` → GeckoTerminal |

The scanner uses the same indicator model (RSI, MACD, volume profile, support/resistance) across all venue types. DEX tokens are scanned successfully — this was proven in the aitradingbot codebase which used identical indicators on DexScreener/GeckoTerminal OHLCV data.

### New infrastructure required

- **`fetchBybitTickers`** in `packages/market-data/` — wraps Bybit's `/v5/market/tickers?category=linear`, returns ticker data (symbol, volume24h, priceChange24h, lastPrice) mapped to `DiscoveredInstrument`. Added to `providerRegistry.bybit`.

### What reuses existing infrastructure

- `VenueCandleFetcher` — already routes orderbook→Binance, swap→GeckoTerminal
- `providerRegistry.hyperliquid.assetContexts()` — already cached every 30s
- `providerRegistry.discovery.discover()` — existing DEX discovery pipeline (Solana + Base)
- `runTechnicalPhase()` — fully built orchestration
- `scanCandidates()` / `scoreCandidate()` — fully built in `@herobids/strategy`
- Wake infrastructure, hybrid evaluator, single-shot prompt — all built

### What does NOT change

- No schema changes, no DB migrations, no new dependencies
- No changes to `agent.ts`, `hybrid-agent-evaluator.ts`, `runtime-composition.ts`
- Intelligence-mode agents (tsonnet) completely unaffected

## Q&A

See [Q&A](./Q-and-A.md) for detailed questions and answers covering:
- Why agents don't trade (root cause investigation)
- Venue scope decisions (all 4 venues)
- Data source decisions (venue-native discovery, shared candle fetcher)
- 1inch inclusion rationale
- Binance-as-proxy for Hyperliquid candles

See also [Q&A 2](./Q-and-A-2.md)
