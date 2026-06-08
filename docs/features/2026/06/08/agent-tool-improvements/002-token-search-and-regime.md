# 023 — Token Search & Market Regime

Add external market data infrastructure (token search + OHLCV candles), implement
two agent tools (`search_tokens`, `check_regime`), and add the `trading` skill's
market-awareness layer.

**Depends on:** 022 (stable `submit_decision` name, `trading` skill scaffold).
**Blocks:** 024 (backtesting needs OHLCV infrastructure built here).

---

## Background

Agents using `submit_decision` to trade Hyperliquid perpetuals know the instrument
IDs up front (BTC, SOL, ETH, etc.) — they don't need token discovery. But they
have no way to answer the question "is now a good time to trade?" without market
context.

Two tools address different problems:

| Tool | Problem solved |
|---|---|
| `search_tokens` | Finding a token address when the agent knows name/symbol but not the on-chain address (primarily for future Jupiter DEX trading) |
| `check_regime` | Gating trade decisions on market conditions — is the market trending or choppy? Strong uptrend or distribution? |

`check_regime` is immediately useful for perpetuals traders. `search_tokens` is
primarily an enabler for a future Jupiter direct-swap flow.

---

## External APIs

Both tools are powered by external APIs available on free tiers with no API key
required for the target use cases.

### DexScreener (token search)

- Endpoint: `GET https://api.dexscreener.com/latest/dex/search?q={query}`
- No auth required for basic search
- Rate limit: ~300 requests/min on free tier
- Returns: pools matching query, with token metadata, price, volume, liquidity
- Coverage: Solana, Base, Ethereum, BSC, and many more

### GeckoTerminal (OHLCV candles for regime)

- Endpoint: `GET https://api.geckoterminal.com/api/v2/networks/{network}/pools/{pool_address}/ohlcv/{timeframe}`
- No auth required
- Rate limit: 30 requests/min on free tier
- Timeframes: `minute`, `hour`, `day`
- Returns: OHLCV arrays suitable for indicator computation
- Coverage: Solana, Base/Ethereum, most major DEX pools

### Fallback for perpetuals (Hyperliquid instruments)

Hyperliquid instruments (BTC, SOL, ETH) don't have DEX pool addresses. For regime
checks on perp instruments:
- Use CoinGecko's `/simple/price` (already wired via `OracleMarkSource`) for spot
  price, but it doesn't provide candles.
- Use Binance public API for OHLCV: `GET https://api.binance.com/api/v3/klines?symbol={symbol}USDT&interval={interval}&limit={limit}` — no auth, ~1200 req/min.
- Default benchmark for regime checks: Binance BTC/USDT 1h candles (most liquid,
  best ADX signal for overall market regime).

---

## Architecture

### New package: `@herobids/market-data`

Create `packages/market-data/` as a zero-side-effect library.

```
packages/market-data/
  src/
    index.ts              # public exports
    dexscreener.ts        # DexScreener token search
    geckoterminal.ts      # GeckoTerminal OHLCV
    binance-candles.ts    # Binance public klines (for perp benchmarks)
    indicators.ts         # Pure functions: EMA, ADX, VWAP, market structure
    regime.ts             # evaluateRegime() — composes candles + indicators
    token-search.ts       # searchTokens() — DexScreener wrapper with filtering
    rate-limiter.ts       # Simple token-bucket rate limiter per provider
    types.ts              # PriceCandle, TokenInfo, RegimeResult interfaces
  package.json
  tsconfig.json
```

**Why a separate package and not a module in `packages/venues/`?**
- `venues/` is for venue adapters (execution, streaming). Market data discovery is
  read-only and crosses multiple external providers — different concern.
- Keeps `domain` ← `engine` ← `venues` dependency chain clean.
- `@herobids/market-data` depends only on `node:https` / `fetch` — zero workspace deps.

### Rate limiting

Each provider gets its own `TokenBucket` instance:

```ts
interface RateLimiterConfig {
  requestsPerMinute: number;
  burstCapacity?: number; // default = requestsPerMinute
}

class TokenBucketRateLimiter {
  async acquire(): Promise<void>   // waits if needed; throws after maxWaitMs
}
```

Config values (operator-controlled via `config/default.yaml`):

```yaml
marketData:
  dexscreener:
    baseUrl: "https://api.dexscreener.com"
    requestsPerMinute: 60        # conservative (free tier allows ~300)
  geckoterminal:
    baseUrl: "https://api.geckoterminal.com"
    requestsPerMinute: 20        # conservative (free tier allows 30)
  binance:
    baseUrl: "https://api.binance.com"
    requestsPerMinute: 200       # conservative (free tier allows 1200)
  timeoutMs: 5000
```

These go in `AppConfigSchema` (Zod) in `apps/worker/src/config.ts`.

---

## Core logic

### `indicators.ts` — pure functions, no I/O

```ts
interface PriceCandle {
  timestamp: string;   // ISO 8601
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function ema(candles: PriceCandle[], period: number): number[]
function adx(candles: PriceCandle[], period?: number): number     // last value
function vwap(candles: PriceCandle[]): number                      // rolling VWAP
function detectMarketStructure(candles: PriceCandle[]): 'higherHighs' | 'lowerHighs' | 'mixed'
```

All functions operate on arrays of `PriceCandle`. No external calls. Tested in isolation.

### `regime.ts` — composition

```ts
interface RegimeParams {
  benchmarkSymbol?: string;        // default: 'BTC' (maps to Binance BTCUSDT)
  emaFast?: number;                // default: 20
  emaSlow?: number;                // default: 50
  emaTrend?: number;               // default: 200
  adxMin?: number;                 // default: 20
  emaAlignment?: 'bullish' | 'bearish' | 'any';  // default: 'any'
  marketStructure?: 'higherHighs' | 'lowerHighs' | 'any'; // default: 'any'
  priceAboveVwap?: boolean;        // default: false
  disableWhenChoppy?: boolean;     // default: false
}

interface RegimeResult {
  pass: boolean;
  reasons: string[];              // human-readable, shown to agent
  details: {
    benchmarkSymbol: string;
    currentPrice: number;
    emaFast: number;
    emaSlow: number;
    emaTrend: number;
    emaAlignment: 'bullish' | 'bearish';
    adxValue: number;
    choppy: boolean;
    vwap: number;
    priceAboveVwap: boolean;
    marketStructure: 'higherHighs' | 'lowerHighs' | 'mixed';
  };
}

async function evaluateRegime(
  params: RegimeParams,
  candleFetcher: (symbol: string) => Promise<PriceCandle[]>,
): Promise<RegimeResult>
```

`evaluateRegime` is injected with a `candleFetcher` so it remains testable without
live API calls.

### `token-search.ts`

```ts
interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  network: string;         // 'solana', 'base', 'ethereum', etc.
  priceUsd: number;
  volume24hUsd: number;
  liquidityUsd: number;
  priceChange24hPct: number;
  dexId: string;           // e.g. 'raydium', 'orca', 'uniswap-v3'
}

async function searchTokens(
  query: string,
  options?: { network?: string; minLiquidityUsd?: number; limit?: number },
): Promise<TokenInfo[]>
```

Filtering applied after DexScreener response:
- Sort by liquidity descending
- Optionally filter by network
- Filter out results where `liquidityUsd < minLiquidityUsd` (default: $10k)
- Return top `limit` (default: 10)

---

## Agent tools (in `apps/worker/src/agent.ts`)

Both are **direct in-process tools** — no broker. Execute, return result, add to history.

### `search_tokens`

```ts
case 'search_tokens': {
  const { query, network, minLiquidityUsd } = call.args;
  const results = await searchTokens(query, { network, minLiquidityUsd });
  addToHistory('user', JSON.stringify({ ok: true, tokens: results }));
  break;
}
```

Rate-limited by the `dexscreener` `TokenBucketRateLimiter`. On rate-limit breach:
return `{ ok: false, error: 'rate_limit', note: 'Try again in a moment.' }`.

### `check_regime`

```ts
case 'check_regime': {
  const params = call.args as RegimeParams;
  const result = await evaluateRegime(params, binanceCandleFetcher);
  addToHistory('user', JSON.stringify({ ok: true, ...result }));
  break;
}
```

Rate-limited by the `binance` `TokenBucketRateLimiter`. Timeout from `marketData.timeoutMs`.

---

## Skill updates

### Update `trading` skill (from 022)

Add `search_tokens` and `check_regime` to `requiredTools`.

Updated instructions:

```
You have access to direct trading tools.
- Use `submit_decision` to submit a trade intent for a specific instrument.
- Use `check_regime` to assess whether market conditions are favorable before trading.
  BTC is the default benchmark; other symbols can be specified.
- Use `list_positions` to check current open positions.
- Use `search_tokens` to find a token by name or symbol when you need its on-chain address.
  This is primarily used when preparing Jupiter DEX trades.
```

---

## Config additions

`config/default.yaml`:
```yaml
marketData:
  dexscreener:
    baseUrl: "https://api.dexscreener.com"
    requestsPerMinute: 60
  geckoterminal:
    baseUrl: "https://api.geckoterminal.com"
    requestsPerMinute: 20
  binance:
    baseUrl: "https://api.binance.com"
    requestsPerMinute: 200
  timeoutMs: 5000
```

`AppConfigSchema` in `apps/worker/src/config.ts`: add `marketData` section (optional,
with defaults — worker starts without it and tools return a "market data not configured"
error).

---

## Files changed

| File | Change |
|---|---|
| `packages/market-data/` | New package — all source files, package.json, tsconfig.json |
| `pnpm-workspace.yaml` | Register `packages/market-data` |
| `tsconfig.json` (root) | Add `packages/market-data` to `references` |
| `apps/worker/package.json` | Add `@herobids/market-data` dependency |
| `apps/worker/src/agent.ts` | Add `search_tokens` and `check_regime` tool cases |
| `apps/worker/src/config.ts` | Add `marketData` config section + schema |
| `config/default.yaml` | Add `marketData` block |
| `packages/domain/src/skills.ts` | Update `trading` skill `requiredTools` and instructions |

---

## Testing

- Unit: `ema()`, `adx()`, `vwap()` with synthetic candle arrays — verify against
  known values (cross-check with TA-Lib reference outputs).
- Unit: `evaluateRegime()` with injected mock `candleFetcher` — test each
  pass/fail condition branch.
- Unit: `searchTokens()` with mocked DexScreener HTTP response — verify filtering
  and ordering.
- Unit: rate limiter — verify it blocks after burst capacity exhausted.
- Integration (manual/dev): call `check_regime` with real Binance API in dev environment.

---

## Rate limit operational notes

DexScreener and GeckoTerminal are unauthenticated free-tier APIs. The operator config
`requestsPerMinute` values are intentionally conservative to avoid 429s. Document in
`docs/lessons/rate-limiting-guide.md` (append section: "External Market Data").

If multiple agents run concurrently in the same worker process, the rate limiters are
**per-process** (in-memory singleton). If multiple worker instances run in parallel
(horizontal scaling), shared rate limiting would need Redis — out of scope here.
Note this constraint in the implementation.

---

## Open questions

1. For `check_regime` on Hyperliquid perp instruments (BTC, SOL), should we default
   to Binance spot candles (BTCUSDT) as the underlying data source? This is the most
   liquid and reliable data source for those benchmarks. Document the mapping.
2. `search_tokens` is most useful for Jupiter DEX swaps, which currently have no
   direct-submit path in herobids. Should this tool be gated on a future
   `dex-trading` skill, or included in `trading` now? Recommendation: include in
   `trading` now — it's read-only and cheap (no risk), and gives agents vocabulary
   for planning even before DEX trading is implemented.
3. GeckoTerminal covers Solana pools well but coverage for newer or low-liquidity
   tokens can be sparse. If candle fetch returns insufficient data for ADX (needs
   ~40+ candles), `check_regime` should return `{ pass: false, reasons: ['insufficient_data'] }`
   rather than throw.
