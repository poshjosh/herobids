# Agent Data Contract by Venue

Define exactly what data agents receive per venue/asset-class, what gets injected into tick context vs. fetched lazily via tools, and what is critical for short bias, regime awareness, and execution quality.

---

## Background

Agents trade across multiple asset classes (perps, CEX spot, DEX memecoins). Each venue provides different data at different costs and freshness levels. The agent should not need to know these details — it should receive a normalized, venue-aware data bundle in its tick context.

This document defines the data contract between the platform and the agent runtime, per venue type.

---

## Scope

### In scope

- Per-venue data catalog (what's available, how fresh, how to get it)
- Classification: context-injected vs. tool-fetched
- Freshness and staleness rules
- Fallback behavior when data is unavailable

### Out of scope

- Implementation details of data fetching (see market-data-provider-strategy.md)
- Rate-limit coordination (see market-data-rate-limit-testing.md)
- Prompt formatting (see agent-context-and-progress.md)

---

## 1. Venue Classification

| Venue Type | Examples | Primary Use |
|---|---|---|
| **Orderbook / Perps** | Hyperliquid, Bybit | Leveraged directional trading, funding arb |
| **DEX Swap** | Jupiter (Solana), 1inch (Base) | Spot token trading, memecoin plays |
| **Data-only** | Binance, DexScreener, GeckoTerminal | Market data, discovery, regime checks |

---

## 2. Perps Venue Data Contract (Hyperliquid / Bybit)

### Context-injected (every tick, pre-computed)

| Data Point | Source | Freshness | Why |
|---|---|---|---|
| Current positions | Private WS stream | Real-time | Agent must always know its exposure |
| Unrealized P&L | Computed from position + mark price | Real-time | Risk awareness |
| Mark price / last price | Public WS ticker | <1s | Current market level |
| Funding rate (current + predicted) | REST: `metaAndAssetCtxs` | <5 min | Long/short cost signal |
| Open interest | REST: same endpoint | <5 min | Crowding signal |
| 24h volume | WS ticker or REST | <5 min | Activity level |
| Orderbook imbalance (bid/ask ratio) | Public WS orderbook | <5s | Short-term pressure |
| Recent fills (own) | Private WS | Real-time | Execution confirmation |

### Tool-fetched (on demand, agent calls tool)

| Data Point | Tool | Source | Why lazy |
|---|---|---|---|
| Historical candles (OHLCV) | `check_regime` / future `get_candles` | Binance REST | Large payload, not needed every tick |
| Liquidation events | Future `get_liquidations` | Bybit REST | Supplementary signal |
| Full orderbook depth | Future `get_orderbook` | WS snapshot | Rarely needed for decisions |
| Instrument metadata (tick size, lot size) | Future `get_instrument_info` | Venue REST | Static, fetched once |

### Not available (would require new provider)

| Data Point | Would need | Priority |
|---|---|---|
| Whale wallet tracking | On-chain indexer | Low |
| Social sentiment | Twitter/Telegram API | Low |
| News events | News API | Low |

---

## 3. DEX Swap Venue Data Contract (Jupiter / 1inch)

### Context-injected (every tick, if agent has DEX bindings)

| Data Point | Source | Freshness | Why |
|---|---|---|---|
| Current positions (token holdings) | Swap venue adapter `fetchBalances` | <30s | Agent must know what it holds |
| Portfolio value (USD) | Token prices × balances | <30s | Capital awareness |
| Watched token prices | DexScreener / GeckoTerminal | <60s | Monitor active interests |

### Tool-fetched (on demand)

| Data Point | Tool | Source | Why lazy |
|---|---|---|---|
| Token search | `search_tokens` | DexScreener | Exploration, agent-initiated |
| Discovery (trending) | Future `discover_tokens` | DexScreener + GeckoTerminal | Periodic scan, not every tick |
| Token OHLCV | Future `get_token_candles` | GeckoTerminal | Analysis, not needed every tick |
| Token overview (liquidity, volume, age) | Future `get_token_info` | DexScreener | Due diligence before entry |
| Token safety check | Future `check_token_safety` | Multiple sources | Before committing capital |
| Swap quote | Implicit in `submit_decision` | Jupiter/1inch | Happens at execution time |

### Context-injected only when enrichment providers are available

| Data Point | Source | Condition |
|---|---|---|
| Market cap, FDV | CMC | CMC configured |
| Holder count, distribution | CMC / Birdeye | Provider configured |
| Risk level | CMC | CMC configured |
| CEX listings | CMC | CMC configured |

---

## 4. Data-Only Provider Contract (Binance / DexScreener / GeckoTerminal)

These providers do not execute trades but supply data consumed by context assembly and agent tools.

| Provider | Data Type | Delivery Mode | Rate Budget |
|---|---|---|---|
| **Binance** | OHLCV candles (1h, 4h, 1d) | Tool-fetched via `check_regime` | 1200 req/min (generous) |
| **DexScreener** | Token search, discovery, pair info | Tool-fetched via `search_tokens` / `discover_tokens` | 60 req/min |
| **GeckoTerminal** | OHLCV per pool, trending pools, new pools | Tool-fetched / context-injected discovery | 10–30 req/min |
| **Birdeye** | Solana token analytics, trending | Tool-fetched / enrichment | Paid tier dependent |
| **CMC** | Cross-chain enrichment (mcap, holders, risk) | Context-injected enrichment | 10K calls/mo (free) |

---

## 5. Freshness Rules

| Category | Max Staleness | On Stale |
|---|---|---|
| Position data | 0 (real-time) | Flag `[STALE]` in context, warn agent |
| Execution prices | 5s | Use last known, note in context |
| Funding rates | 5 min | Acceptable (updates hourly on-chain) |
| Open interest | 5 min | Acceptable |
| Regime indicators | 2 min | Re-compute from cached candles |
| Discovery tokens | 10 min | Acceptable; agent can force-refresh via tool |
| Enrichment data (CMC) | 1 hour | Acceptable (slow-moving data) |

---

## 6. Fallback Behavior

When a data source is unavailable:

| Data Point | Fallback | Agent sees |
|---|---|---|
| Funding rate | Omit from context | `Funding rate: unavailable` |
| Open interest | Omit from context | `Open interest: unavailable` |
| Token price (DEX) | Try alternate provider → use last known | Price with `[stale Xs]` annotation |
| Discovery | Return empty | `No trending tokens available` |
| Regime check | Skip gate, allow LLM call | Regime section omitted |
| Positions | CRITICAL — if unavailable, skip tick | Agent told "position data unavailable, skipping tick" |

---

## 7. Data Contract Versioning

The data contract is versioned via `schemaVersion` in the runtime descriptor. If new data points are added:
- They are optional (missing = not available, not an error).
- Agents written for v1 still work when v2 adds fields.
- Breaking removals require a schema version bump and migration period.

---

## Dependencies

- `apps/worker/src/runtime-composition.ts` — context assembly
- `@herobids/market-data` — provider implementations
- Venue adapters — REST endpoints for funding, OI
- `market-data-provider-strategy.md` — which providers are active
- `agent-context-and-progress.md` — how data is formatted in the prompt
