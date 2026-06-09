# 026 — Birdeye and CoinMarketCap Providers

Add Birdeye (Solana DEX analytics) and CoinMarketCap (cross-chain discovery +
enrichment) as opt-in market data providers. Both are already stubs in config
and types — this plan wires them end to end.

---

## Background

The following infrastructure already exists and does **not** need to change:

- `MarketDataConfig` has `birdeye` and `coinMarketCap` config blocks (`enabled`,
  `apiKey`, `baseUrl`, `requestsPerMinute`, `cacheTtlMs`) in both `types.ts` and
  `config/default.yaml`.
- `MarketDataProviderName` already includes `'birdeye'` and `'coinmarketcap'`.
- The `'enrichment'` request class already exists in `PROVIDER_REQUEST_CLASSES`.
- `discoverTokens()` in `discovery.ts` uses `Promise.allSettled` fan-out — partial
  provider failures are already silently skipped.
- `DiscoveredToken` is the shared currency for all discovery output.

What is missing: the HTTP client files, the wiring into `discovery.ts` and
`provider-registry.ts`, and the CMC enrichment pass.

---

## Scope

### In scope

- `packages/market-data/src/birdeye.ts` — new file
- `packages/market-data/src/coinmarketcap.ts` — new file
- `packages/market-data/src/types.ts` — extend `DiscoveredToken` and `DiscoveryConfig`
- `packages/market-data/src/discovery.ts` — wire in both providers + CMC enrichment pass
- `packages/market-data/src/provider-registry.ts` — add optional Birdeye and CMC entries
- `packages/market-data/src/index.ts` — export new symbols
- Unit tests for both new files and the updated `discovery.ts`

### Out of scope

- Birdeye OHLCV endpoint (`/defi/ohlcv`) — not needed until a Solana OHLCV fallback
  chain is built (future plan).
- Birdeye token overview (`/defi/token_overview`) — not needed until portfolio
  valuation is built.
- CMC security-detail endpoint — per-token GET, not batch-compatible, skip for now.
- Any changes to execution, strategy, or the worker tick loop.

---

## Constraints

### Birdeye returns HTTP 400 for rate limits, not 429

Birdeye signals both "token not indexed" and "rate quota exceeded" as HTTP 400,
not 429. Log 400 responses as `warn` (not `error`). Do not throw on 400.

### CMC enrichment is a second pass, not discovery fan-out

CMC's batch-query endpoint (`POST /v1/dex/tokens/batch-query`) enriches already-
discovered tokens. It must run *after* the fan-out merge, not in parallel with it.
One call per `discoverTokens()` invocation, capped to top-N tokens by liquidity.

### Both providers are opt-in (gated by `enabled` flag)

If `config.birdeye.enabled = false` (the default), zero Birdeye calls are made.
Same for CMC. The `discoverTokens()` function and the registry must never throw
when these configs are absent or disabled.

### Birdeye is Solana-only

Only include Birdeye discovery vectors when `'solana'` is in `config.networks`.

---

## Step 1 — Extend `DiscoveredToken` and `DiscoveryConfig` in `types.ts`

### `DiscoveredToken` changes

Add optional CMC enrichment fields and expand the `source` union:

```typescript
export interface DiscoveredToken {
  address: string;
  symbol: string;
  name: string;
  network: string;
  priceUsd: number;
  volume24hUsd: number;
  liquidityUsd: number;
  priceChange24hPct?: number;
  source: 'dexscreener' | 'geckoterminal' | 'birdeye' | 'coinmarketcap';
  discoveryVectors: string[];
  poolAddress?: string;
  poolCreatedAt?: string;
  // CMC enrichment — populated by enrichTokensViaCmc(), absent otherwise
  marketCapUsd?: number;
  fdvUsd?: number;
  holderCount?: number;
  cexListings?: string[];      // exchange names e.g. ['Binance', 'Coinbase']
  riskLevel?: string;          // 'low' | 'medium' | 'high' (CMC classification)
}
```

No changes to `MarketDataConfig` — it already has the right shape.

---

## Step 2 — Create `packages/market-data/src/birdeye.ts`

**Endpoint:** `GET /defi/token_trending`  
**Auth:** `X-API-KEY: {apiKey}` header, `x-chain: solana` header  
**Rate limit:** Free tier ~60 req/min; 400 = rate-limited or unsupported token

```typescript
import type { DiscoveredToken, RequestGate } from './types.js';
import { fetchJson } from './http.js';

export interface BirdeyeConfig {
  baseUrl: string;
  apiKey: string;
  rateLimiter: RequestGate;
  timeoutMs: number;
  fetchFn?: typeof fetch;
}

interface BirdeyeTrendingItem {
  address?: string;
  symbol?: string;
  name?: string;
  price?: number;
  liquidity?: number;
  v24hUSD?: number;
  priceChange24hPercent?: number;
}

interface BirdeyeTrendingResponse {
  success?: boolean;
  data?: {
    items?: BirdeyeTrendingItem[];
  };
}

export async function fetchBirdeyeTrendingTokens(
  config: BirdeyeConfig,
  options?: { limit?: number },
): Promise<DiscoveredToken[]> {
  await config.rateLimiter.acquire();

  const limit = options?.limit ?? 20;
  const url = `${config.baseUrl}/defi/token_trending?sort_by=rank&sort_type=asc&limit=${limit}`;

  let response: BirdeyeTrendingResponse;
  try {
    response = await fetchJson<BirdeyeTrendingResponse>({
      url,
      timeoutMs: config.timeoutMs,
      headers: {
        'X-API-KEY': config.apiKey,
        'x-chain': 'solana',
        'Accept': 'application/json',
      },
      fetchFn: config.fetchFn,
    });
  } catch (err: unknown) {
    // Birdeye returns 400 for rate-limit exceeded AND unsupported tokens.
    // Treat as warn, not error — caller should skip gracefully.
    const status = err instanceof Error && 'status' in err
      ? (err as { status?: number }).status
      : undefined;
    const level = status === 400 ? 'warn' : 'error';
    // fetchJson throws; log message only, do not rethrow
    void level; // logging wired in caller via Promise.allSettled
    throw err;
  }

  if (!response.success || !response.data?.items) return [];

  return response.data.items.map((item): DiscoveredToken => ({
    address: item.address ?? '',
    symbol: item.symbol ?? '',
    name: item.name ?? '',
    network: 'solana',
    priceUsd: item.price ?? 0,
    liquidityUsd: item.liquidity ?? 0,
    volume24hUsd: item.v24hUSD ?? 0,
    priceChange24hPct: item.priceChange24hPercent,
    source: 'birdeye',
    discoveryVectors: ['birdeye:trending'],
  })).filter((t) => t.address !== '');
}
```

**Key note on error handling:** `fetchJson` already throws on non-2xx. Callers in
`discovery.ts` use `Promise.allSettled`, so the rejection is caught automatically
and does not abort other vectors. No extra try/catch needed in the function body —
but the 400-as-warn distinction should be noted in a comment so future readers
don't "fix" it.

---

## Step 3 — Create `packages/market-data/src/coinmarketcap.ts`

Three exported functions: two discovery, one enrichment.

### 3a. Chain ID mapping

```typescript
// CMC numeric platform IDs — from /v1/dex/platform/list
const CHAIN_TO_CMC_PLATFORM_ID: Record<string, string> = {
  solana: '16',
  base:   '25',
};

// CMC platform name strings — used by batch-query endpoint (different from IDs above)
const CHAIN_TO_CMC_PLATFORM_NAME: Record<string, string> = {
  solana: 'solana',
  base:   'base',
};
```

### 3b. Config and response types

```typescript
export interface CoinMarketCapConfig {
  baseUrl: string;
  apiKey: string;
  rateLimiter: RequestGate;
  enrichmentRateLimiter: RequestGate;  // separate 'enrichment' class limiter
  timeoutMs: number;
  batchSize?: number;   // max tokens per enrichment call, default 20
  fetchFn?: typeof fetch;
}
```

(Two limiters — one for `'discovery'` class, one for `'enrichment'` class — so
enrichment calls don't consume the discovery rate budget.)

### 3c. `fetchCmcTrendingTokens(network, config)`

```
POST /v1/dex/tokens/trending/list
Body: { platformIds: "16", pageSize: 20 }
Header: X-CMC_PRO_API_KEY: {apiKey}
```

Maps `CmcLeaderboardItem` (abbreviated field names: `addr`, `sym`, `n`, `p`,
`liqUsd`, `v24h`, `ch24h`, `lchAt`) to `DiscoveredToken` with
`source: 'coinmarketcap'` and `discoveryVectors: ['cmc:trending']`.

Returns `[]` when the network is not in `CHAIN_TO_CMC_PLATFORM_ID` (e.g.
unsupported chain) rather than throwing.

### 3d. `fetchCmcNewTokens(network, config)`

```
POST /v1/dex/new/list
Body: { platformIds: "16", pageSize: 20 }
```

Same mapping, `discoveryVectors: ['cmc:new']`.

### 3e. `enrichTokensViaCmc(tokens, network, config)`

```
POST /v1/dex/tokens/batch-query
Body: { platform: "solana", addresses: ["addr1", "addr2", ...] }
```

Response is a bare `CmcBatchQueryItem[]` with fields: `addr`, `mcap`, `fdv`,
`hld` (holder count), `cexs` (array of `{ n: string }`), `rl` (risk level).

Logic:
1. Skip entirely if `tokens.length === 0` or network not in map.
2. Take top `batchSize` tokens by `liquidityUsd` (to cap at one call).
3. POST batch-query, build enrichment map keyed by `addr.toLowerCase()`.
4. Return the full input `tokens` array with enrichment fields merged in where
   an address match exists. Tokens without a match are returned unchanged.

```typescript
export async function enrichTokensViaCmc(
  tokens: DiscoveredToken[],
  network: string,
  config: CoinMarketCapConfig,
): Promise<DiscoveredToken[]>
```

---

## Step 4 — Update `discovery.ts`

### Extend `DiscoveryConfig`

```typescript
export interface DiscoveryConfig {
  dexscreener: DexScreenerConfig;
  geckoterminal: GeckoTerminalConfig;
  networks: string[];
  maxResults?: number;
  minLiquidityUsd?: number;
  birdeye?: BirdeyeConfig;          // optional; absent = disabled
  coinMarketCap?: CoinMarketCapConfig;  // optional; absent = disabled
}
```

### Update `discoverTokens()`

**Fan-out phase** — add conditionally to the `Promise.allSettled` call array:

```typescript
// Birdeye: only on solana, only if config provided
...(config.birdeye && networks.includes('solana')
  ? [fetchBirdeyeTrendingTokens(config.birdeye)]
  : []),

// CMC: per-network, only if config provided
...(config.coinMarketCap
  ? networks.flatMap((network) => [
      fetchCmcTrendingTokens(network, config.coinMarketCap!),
      fetchCmcNewTokens(network, config.coinMarketCap!),
    ])
  : []),
```

**Enrichment phase** — after the existing merge + filter + sort, before return:

```typescript
// CMC enrichment: one batch-query call per network, after merge
if (config.coinMarketCap) {
  for (const network of networks) {
    const networkTokens = merged.filter((t) => t.network === network);
    if (networkTokens.length === 0) continue;
    const enriched = await enrichTokensViaCmc(networkTokens, network, config.coinMarketCap);
    // splice enriched back in (replace by address match)
    const enrichedMap = new Map(enriched.map((t) => [t.address, t]));
    merged = merged.map((t) => enrichedMap.get(t.address) ?? t);
  }
}
return merged;
```

The enrichment pass is sequential per network (not parallel) to stay within the
CMC rate budget and keep the enrichment call count predictable.

---

## Step 5 — Update `provider-registry.ts`

### Extend `ProviderRegistry` interface

```typescript
export interface ProviderRegistry {
  // ... existing fields ...
  birdeye?: {
    trending(options?: { limit?: number }): ReturnType<typeof loadWithCache<DiscoveredToken[]>>;
  };
  coinmarketcap?: {
    trending(network: string): ReturnType<typeof loadWithCache<DiscoveredToken[]>>;
    newTokens(network: string): ReturnType<typeof loadWithCache<DiscoveredToken[]>>;
  };
  discovery: { /* unchanged */ };
}
```

Both are optional (`?`) — callers must guard before use.

### Wire in `createProviderRegistry()`

When `config.birdeye.enabled`:
- Create a `CoordinatedRateLimiter` with `requestClass: 'discovery'` using
  `config.birdeye.requestsPerMinute`.
- Build a `BirdeyeConfig`.
- Populate `registry.birdeye`.

When `config.coinMarketCap.enabled`:
- Create two limiters: one for `'discovery'`, one for `'enrichment'`.
- Build a `CoinMarketCapConfig` (pass both limiters).
- Populate `registry.coinmarketcap`.

Pass both configs into the `discovery.discover()` loader:

```typescript
discovery: {
  discover: (discoveryOptions) => loadWithCache({
    // ...
    loader: () => discoverTokens({
      dexscreener: dexscreenerDiscoveryConfig,
      geckoterminal: geckoDiscoveryConfig,
      networks: discoveryOptions?.networks ?? ['solana', 'base'],
      maxResults: discoveryOptions?.maxResults,
      minLiquidityUsd: discoveryOptions?.minLiquidityUsd,
      birdeye: config.birdeye.enabled ? birdeyeDiscoveryConfig : undefined,
      coinMarketCap: config.coinMarketCap.enabled ? cmcConfig : undefined,
    }),
  }),
},
```

The `discovery.discover()` cache TTL should use the minimum across all enabled
providers (already the pattern in the existing implementation — extend to include
`config.birdeye.cacheTtlMs` and `config.coinMarketCap.cacheTtlMs` when enabled).

---

## Step 6 — Update `index.ts`

Export all new public symbols:

```typescript
export {
  fetchBirdeyeTrendingTokens,
  type BirdeyeConfig,
} from './birdeye.js';

export {
  fetchCmcTrendingTokens,
  fetchCmcNewTokens,
  enrichTokensViaCmc,
  type CoinMarketCapConfig,
} from './coinmarketcap.js';
```

---

## Step 7 — Config validation

In the operator config resolution (wherever `MarketDataConfig` is validated at
startup), add:

- If `birdeye.enabled = true` and `birdeye.apiKey` is empty → throw at startup.
- If `coinMarketCap.enabled = true` and `coinMarketCap.apiKey` is empty → throw at startup.

This ensures fail-fast behaviour rather than silent 401s at runtime.

Locate the existing config validation and add alongside similar credential checks
already present for other providers.

---

## Step 8 — Tests

### `birdeye.test.ts`

- `fetchBirdeyeTrendingTokens` maps items correctly to `DiscoveredToken`.
- Empty `data.items` returns `[]` without throwing.
- Tokens with no `address` are filtered out.
- HTTP 400 response causes the function to throw (so `Promise.allSettled` catches
  it as rejected — tests that no silent swallowing occurs).

### `coinmarketcap.test.ts`

- `fetchCmcTrendingTokens` maps `CmcLeaderboardItem` fields (`addr`, `sym`, `n`,
  `p`, `liqUsd`, `v24h`, `ch24h`) correctly.
- `fetchCmcTrendingTokens` returns `[]` for unsupported networks without throwing.
- `enrichTokensViaCmc` merges enrichment fields onto matching tokens.
- `enrichTokensViaCmc` returns original tokens unchanged when no address match.
- `enrichTokensViaCmc` caps to `batchSize` tokens (passes top-N by liquidity).
- `enrichTokensViaCmc` returns input unchanged when `tokens` is empty.

### `discovery.test.ts` additions

- `discoverTokens` with Birdeye config only calls Birdeye for `'solana'` network.
- `discoverTokens` with CMC config runs enrichment pass after merge.
- `discoverTokens` with both configs disabled (absent) behaves identically to
  existing tests.
- Birdeye rejection does not abort the overall `discoverTokens` result.
- CMC enrichment failure (rejected promise) is caught and returns the un-enriched
  merged list rather than throwing.

### `provider-registry.test.ts` additions

- Registry built with `birdeye.enabled = false` has `registry.birdeye === undefined`.
- Registry built with `birdeye.enabled = true` has `registry.birdeye` populated.
- Same for `coinmarketcap`.

---

## File Summary

| File | Action |
|---|---|
| `packages/market-data/src/types.ts` | Extend `DiscoveredToken` (source union + enrichment fields) |
| `packages/market-data/src/birdeye.ts` | **Create** |
| `packages/market-data/src/coinmarketcap.ts` | **Create** |
| `packages/market-data/src/discovery.ts` | Extend `DiscoveryConfig`, wire fan-out + enrichment pass |
| `packages/market-data/src/provider-registry.ts` | Add optional Birdeye/CMC registry entries |
| `packages/market-data/src/index.ts` | Export new symbols |
| `packages/market-data/src/birdeye.test.ts` | **Create** |
| `packages/market-data/src/coinmarketcap.test.ts` | **Create** |
| `packages/market-data/src/discovery.test.ts` | Extend with new provider coverage |
| `packages/market-data/src/provider-registry.test.ts` | Extend with enabled/disabled cases |
| Config validation (locate exact file) | Add startup assertions for `apiKey` when `enabled` |

No schema migrations. No new dependencies. No changes to `config/default.yaml`
(stubs already present with `enabled: false`).

---

## Effort Estimate

| Area | Effort |
|---|---|
| `birdeye.ts` + test | ~0.5 day |
| `coinmarketcap.ts` + test | ~1 day |
| `discovery.ts` wiring + enrichment pass | ~0.5 day |
| `provider-registry.ts` wiring | ~0.5 day |
| Config validation + index exports | ~0.25 day |
| **Total** | **~2.75 days** |
