# NOTES

The aim is to guide purely intelligence based agents (agents with no scanner filter) to trade based on various methodologies.

- Each methodology could be served as a playbook skill
- We could also have a trading-playbook-selector skill
- Playbooks can pair with any preset. An agent could use the price-action methodology with the momentum-day strategy preset
- We could prefer seeding the already running system with skills in a generic way rather than explicitly adding the skills as part of the code. For example, after the app is launched, we run a script to upload all the skills in a specified folder.

---

## Evaluation of possible methodologies against the current codebase:

| # | Methodology | Verdict | What's Missing |
|---|------------|---------|----------------|
| 1 | `ict-swing` | ❌ Cannot | No candle/OHLCV tool for the agent. Can't draw Fibonacci or detect swing highs/lows. `check_regime` gives EMA values but the agent can't calculate OTE zones (62–79% Fib) without price range data. |
| 2 | `price-action` | ❌ Cannot | No candle data — agent can't detect pin bars, engulfing, doji, or structure breaks. `check_regime` returns `marketStructure` but only as `higherHighs`/`lowerHighs`/`mixed` — not raw swing points the agent can reason over. |
| 3 | `order-flow` | ❌ Cannot | No order book depth, no tick data, no tape. The venues we integrate with (Hyperliquid, Jupiter) don't expose raw order flow. `execute_code` can't help — the data simply isn't in the system. |
| 4 | `contrarian` | ⚠️ Partial | `check_regime` gives ADX (overextension proxy). Agent can track price extremes in memory. But no RSI, no Bollinger Bands, no standard deviation tool — so divergence/band-touch detection is guesswork. |
| 5 | `breakout-momentum` | ⚠️ Partial | `check_regime` gives structure and volume data exists in `get_market_overview`. Agent can track price levels in memory for break/retest logic. But no formal support/resistance computation tool. |
| 6 | `range-fade` | ⚠️ Partial | `check_regime` returns `choppy` (ADX < threshold) — the agent knows it's in a range. But no oscillator tools (RSI, stochastics) to identify overbought/oversold within the range. |
| 7 | `vwap-mean-reversion` | ⚠️ Partial | `check_regime` returns VWAP value and `priceAboveVwap` flag. Agent can trade mean-reversion toward VWAP. But no VWAP standard deviation bands (1σ, 2σ) — agent only knows above/below, not how extended. |
| 8 | `funding-rate-arbitrage` | ✅ **Can** | All data exists: `get_funding_rates` (funding %), `get_price` (spot + perp), `submit_decision`. Agent can compute basis, size positions, and execute. Fully self-contained. |
| 9 | `news-catalyst` | ⚠️ Partial | `search_web` + `browse_url` + `read_document` allow web research. But no structured news sentiment API. The `SentimentProvider` port exists but has **no implementation** (confirmed dead code in AGENTS.md). Agent is doing manual web scraping for sentiment. |
| 10 | `volume-profile` | ❌ Cannot | No volume-at-price data anywhere in the system. `get_market_overview` returns total 24h volume only. No POC, no value area, no volume nodes. |
| 11 | `market-structure` | ✅ **Can** | `check_regime` returns `marketStructure` (higherHighs/lowerHighs/mixed), EMA alignment, ADX trend strength. This is exactly what structure-based trading needs. Fully covered. |
| 12 | `liquidity-grab` | ❌ Cannot | No order book depth. No liquidation level data. No stop-cluster detection. Hyperliquid doesn't expose this via our adapter. |
| 13 | `trend-following` | ✅ **Can** | `check_regime` returns EMA stacking (fast > slow > trend), ADX, structure. Agent can confirm trend + `get_price` for entry timing + `submit_decision`. The core loop is fully covered. |
| 14 | `gap-fill` | ❌ Cannot | No candle/session close data. Can't detect gaps between daily/weekly closes and opens. |
| 15 | `opening-range` | ❌ Cannot | No intraday session demarcation. No opening range high/low data. |

---

**Summary:** 3 can, 5 partial, 7 cannot.

The single biggest gap: **the agent has no `get_candles` / `get_ohlc` tool.** `check_regime` fetches candles internally but only exposes a summary — not the raw series. Without candle data, any methodology that needs price history beyond the last price (Fibonacci, swing points, pattern detection, gaps, bands, volume profile) is dead on arrival.

## Selecting Methodologies

Some methodologies are not atomic concepts. For example, ICT swing is a branded composite of three simpler ones:

| ICT Swing concept | Maps to |
|---|---|
| Daily bias + EMA stacking + ADX trend confirmation | `trend-following` (#13) |
| Swing high/low breaks, structure shifts | `market-structure` (#11) |
| Fibonacci OTE retracement zones | A Fib computation sub-skill, not a standalone methodology |

| # | Methodology | Distinct? |
|---|------------|-----------|
| 1 | `trend-following` | ✅ Atomic — EMA/ADX alignment |
| 2 | `market-structure` | ✅ Atomic — HH/HL, breaks, ranges |
| 3 | `contrarian` | ✅ Atomic — mean reversion, fade extremes |
| 4 | `breakout-momentum` | ✅ Atomic — level breaks + volume |
| 5 | `vwap-mean-reversion` | ✅ Atomic — VWAP-centric, distinct from generic contrarian |
| 6 | `funding-rate-arbitrage` | ✅ Atomic — different asset class (basis), not directional |
| 7 | `news-catalyst` | ✅ Atomic — event-driven, not technical |
| 8 | `range-fade` | ⚠️ Overlaps with market-structure (range = no trend) + contrarian (fade extremes). Could merge. |
| — | `ict-swing` | ❌ Removed — = trend-following + market-structure + Fib entry rules |
| — | `price-action` | ❌ Removed — = market-structure + candle patterns (which we can't support anyway) |
| — | `order-flow` | ❌ Removed — unsupported, and crypto venues don't expose the data |
| — | `volume-profile` | ❌ Removed — unsupported data |
| — | `liquidity-grab` | ❌ Removed — unsupported data |
| — | `gap-fill` | ❌ Removed — unsupported data |
| — | `opening-range` | ❌ Removed — unsupported data |
