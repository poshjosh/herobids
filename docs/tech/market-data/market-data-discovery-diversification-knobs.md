# MARKET DATA DISCOVERY DIVERSIFICATION KNOBS

Here are all the knobs that control discovery diversification, from the operator level down:

---

## Quick reference: what to change for what effect

| Goal | Change | Notes |
|---|---|---|
| See more tokens per run | Raise `marketData.discovery.maxResults` from 50 | Capped at 100 by tool schema |
| See more *different* tokens over time | Keep `antistalenessCooldownHours` at 4+ | This is the real diversity driver |
| Expand the raw candidate pool | Set `geckoTerminalExtraPages: 1` | Costs 4 GT API calls/run — verify rate-limit budget first |
| Add Birdeye Solana trending tokens | Set `marketData.birdeye.enabled: true` | Requires a Birdeye API key; Solana-only |
| Admit smaller/riskier tokens | Lower `tokenSafety.defaults.minLiquidityUsd` | Also affects `search_tokens` |
| Discovery to update faster | Lower GT/DS discovery `cacheTtlMs` | Increases API call rate — stay within rate limits |
| Broader chain coverage | Add chains to `marketIntelligence.networks` | Provider coverage varies by chain |

---

## Operator config — default.yaml

### `marketData.discovery.*` (new, from the just-implemented diversity plan)

| Knob | Default | Effect |
|---|---|---|
| `discovery.maxResults` | `50` | Ceiling on tokens returned per discovery run. The agent's `discover_tokens` tool can request 1–100 per call; this is the default when the agent doesn't specify. |
| `discovery.geckoTerminalExtraPages` | `0` | Set to `1` to fetch page 2 of GeckoTerminal trending + top pools. Adds ~35 unique Solana/Base tokens per run at the cost of 4 extra API calls. |
| `discovery.antistalenessCooldownHours` | `4` | Tokens surfaced in the last N hours are pushed to the back of the list. `0` disables the Redis anti-staleness filter entirely. |
| `discovery.antistalenessTokenTtlHours` | `24` | How long a seen address is tracked in Redis before pruning. Longer = more aggressive deprioritization over time. |

### `marketData.dexscreener.discovery` and `marketData.geckoterminal.discovery`

| Knob | Default | Effect |
|---|---|---|
| `dexscreener.discovery.cacheTtlMs` | `300000` (5 min) | How long discovery results are cached. Lower = fresher data, more API calls consumed. |
| `geckoterminal.discovery.cacheTtlMs` | `300000` (5 min) | Same for GeckoTerminal. |
| `geckoterminal.discovery.requestsPerMinute` | `10` | Rate ceiling on GT discovery calls. If `geckoTerminalExtraPages: 1` is set, you're at exactly this limit. Raising it requires a paid GT plan. |
| `dexscreener.discovery.requestsPerMinute` | `30` | Rate ceiling on DS discovery calls. Plenty of headroom. |

### `marketData.birdeye.*` (Solana-only, opt-in)

Birdeye is an optional paid provider for Solana trending tokens, token overview, and OHLCV candles.

| Knob | Default | Effect |
|---|---|---|
| `birdeye.enabled` | `false` | When `true`, Birdeye trending is included in the discovery fan-out (Solana only). Requires a valid `apiKey`. |
| `birdeye.apiKey` | `""` | Birdeye API key. If `enabled` is `true` and this is empty, the worker fails to start with a clear error. |
| `birdeye.requestsPerMinute` | operator-defined | Rate ceiling shared across all Birdeye endpoints (trending, overview, OHLCV). Birdeye has a single global API-wide limit. |
| `birdeye.cacheTtlMs` | operator-defined | TTL for overview and OHLCV cache entries. Also floors the aggregate discovery cache TTL (preventing overly aggressive refresh). |

### DexScreener boost enrichment (always-on)

The DexScreener boost/profile endpoints (`boosts/top`, `boosts/latest`, `profiles/latest`) now feed into a boost-enrichment pipeline that fills real on-chain liquidity for tokens surfaced via paid promotion. This is always-on with no config flag — the three DS discovery calls already always fire; enrichment simply makes them useful. See `packages/market-data/src/dexscreener.ts` → `enrichDexScreenerBoostTokens`.

### `marketData.tokenSafety.*`

| Knob | Default | Effect |
|---|---|---|
| `tokenSafety.defaults.minLiquidityUsd` | `10000` | Minimum liquidity to pass `passesDiscoveryThreshold`. Lower = more speculative tokens admitted to discovery. |
| `tokenSafety.defaults.minVolume24hUsd` | `25000` | Minimum 24h volume. Not applied at discovery time (that's the `minLiquidityUsd` filter), but applies at token search time. |
| `tokenSafety.defaults.preferCanonical` | `true` | Known tokens (SOL, USDC, WETH) are boosted when multiple addresses match the same symbol. Narrows the pool toward vetted addresses. |

### `marketIntelligence.*`

| Knob | Default | Effect |
|---|---|---|
| `marketIntelligence.discoveryPollMs` | `30000` | How often the coordinator fetches fresh discovery data. At 30s with a 5-minute cache TTL, most cycles hit the cache. Lower = fresher data but more rate-limit consumption. |
| `marketIntelligence.networks` | `["solana", "base"]` | Which chains to scan. Removing one halves the candidate pool. |
| `marketIntelligence.families.discoveryDeltas.enabled` | `true` | When on, the monitor wakes agents when new tokens appear in discovery. |

---

## Agent-level (per-call) — `discover_tokens` tool parameters

| Parameter | Constraints | Effect |
|---|---|---|
| `network` | e.g. `"solana"` | Filter discovery to a single chain. Narrows the pool; the anti-staleness filter is scoped per-network so this doesn't affect diversity across agents using different networks. |
| `limit` | `1–100` | Overrides `discovery.maxResults` for this call. |
| `minLiquidityUsd` | positive number | Overrides the token-safety default for this call. Set lower to admit more speculative tokens. |
