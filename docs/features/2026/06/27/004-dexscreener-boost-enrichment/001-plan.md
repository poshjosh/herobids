# DexScreener Boost Enrichment Plan

**Date:** 2026-06-19
**Status:** Done

## Problem

`discoverTokens` fires three DexScreener calls every discovery cycle:

| Call | Vector tag | Liquidity returned |
|---|---|---|
| `GET /token-boosts/top/v1` | `boosts_top` | None — boost metadata only |
| `GET /token-boosts/latest/v1` | `boosts_latest` | None — boost metadata only |
| `GET /token-profiles/latest/v1` | `profiles_latest` | None — profile metadata only |

All three return `liquidityUsd = 0`. `passesDiscoveryThreshold` requires `liquidityUsd >= minLiquidityUsd` (default $10k). Every token from these three calls is silently filtered before the final slice. The calls consume rate-limit budget and return nothing.

These endpoints surface a real signal — **tokens that teams have paid to promote**. This is independent of organic liquidity: a token can have high promotional spend (active marketing, funded team) and be entirely absent from GeckoTerminal trending. Enriching boost/profile addresses with a single follow-up call per network turns three wasted calls into a useful discovery vector.

## Endpoint

`GET /tokens/v1/{chainId}/{tokenAddresses}`

- Accepts multiple comma-separated token addresses per request
- Returns a `{ pairs: DexScreenerPair[] }` response — the same `DexScreenerPair` shape already used by `fetchDexScreenerSearch`
- Includes: `baseToken.{address,symbol,name}`, `priceUsd`, `volume.h24`, `liquidity.usd`, `priceChange.h24`, `dexId`, `chainId`
- A single token address can match multiple pairs (e.g. TOKEN/USDC and TOKEN/USDT); response includes all of them
- **Batch size limit: not documented by DexScreener.** The implementation should use a conservative default of 30 addresses per request. This must be verified empirically before or during implementation — if the API returns an error or truncates results beyond a certain count, the batch constant should be lowered accordingly.

Rate limit: 300 requests/minute (same as other DexScreener endpoints). The enrichment adds at most 1–2 calls per discovery cycle (see rate-limit budget section below).

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Opt-in vs always-on | Always-on, no config flag | The three DS discovery calls already always fire; enrichment simply makes them useful. Adding a flag for enrichment that can be disabled independently of the calls themselves would be confusing. |
| Network filtering before enrichment | Yes — filter to `config.networks` | DexScreener boosts/profiles return tokens from all chains (ETH, BSC, etc.). Without filtering, a high-liquidity ETH token could enter a Solana/Base discovery result. Only enrich tokens whose `chainId` is in the configured network list. |
| Token selection when multiple pairs returned | Highest-liquidity pair wins | A token has one authoritative liquidity figure for discovery purposes. Pick the pair with the largest `liquidity.usd` as the representative entry. |
| Enrichment placement in the pipeline | After `mergeDiscoveredTokens`, before `passesDiscoveryThreshold` | Enrichment must run before the threshold filter so enriched tokens can enter the pool. This mirrors where boost tokens currently fail. |
| Fail-soft | Yes — on any error, return original (unenriched) tokens | Same pattern as CMC enrichment (`enrichByNetworkSlice`). An enrichment failure must not abort a discovery run that succeeded for GeckoTerminal and other providers. |
| Batch size | 30 addresses per request (conservative default) | The DexScreener docs do not document a maximum for `/tokens/v1/{chainId}/{addresses}`. 30 is used as a safe starting point and must be verified empirically. If the API handles more, the constant can be raised to reduce calls. |
| `volume24hUsd` field on raw boost items | Overwrite with enriched value | The raw `mapDiscoveryItemToToken` sets `volume24hUsd = item.amount ?? item.totalAmount ?? 0` — this is the **boost spend amount**, not the trading volume. After enrichment, this must be replaced with the actual `volume.h24` from the pair response. |
| Tokens not indexed by DexScreener | Still filtered | If a boost address returns no pairs (very new token, unlisted), `liquidityUsd` stays 0 and `passesDiscoveryThreshold` still rejects it. No special handling needed. |

## Rate-limit budget

Current DexScreener discovery budget: 30 req/min, burst 15.

| Call type | Count per discovery cycle | Running total |
|---|---|---|
| `boosts/top`, `boosts/latest`, `profiles/latest` | 3 | 3 |
| Enrichment batches (solana, ≤30 addresses each) | 1 | 4 |
| Enrichment batches (base, ≤30 addresses each) | 1 | 5 |

5 calls per discovery cycle against a 30/min budget, with a 5-minute cache TTL: well within limits. Even if the discovery cache is invalidated frequently, there is no rate-limit risk.

## Pipeline change (before vs after)

**Before:**
```
Promise.allSettled([DS boosts/top, DS boosts/latest, DS profiles/latest, GT calls...])
→ mergeDiscoveredTokens
→ .filter(passesDiscoveryThreshold)   ← all DS boost tokens fail here (liquidityUsd=0)
→ .sort()
→ anti-staleness
→ .slice(0, maxResults)
→ CMC enrichment (post-slice)
```

**After:**
```
Promise.allSettled([DS boosts/top, DS boosts/latest, DS profiles/latest, GT calls...])
→ mergeDiscoveredTokens
→ enrichDexScreenerBoostTokens(merged, networks, config)   ← NEW: fills liquidityUsd for DS source tokens
→ .filter(passesDiscoveryThreshold)   ← DS tokens now pass if they have real liquidity
→ .sort()
→ anti-staleness
→ .slice(0, maxResults)
→ CMC enrichment (post-slice)
```

## Step-by-step implementation

### Step 1 — `fetchDexScreenerTokensByAddress` in `dexscreener.ts`

New exported function:

```typescript
export async function fetchDexScreenerTokensByAddress(
  chainId: string,
  addresses: string[],
  config: DexScreenerConfig,
): Promise<DiscoveredToken[]>
```

**Behaviour:**
1. If `addresses` is empty, return `[]` immediately.
2. Split `addresses` into chunks of 30.
3. For each chunk, acquire the rate limiter and call:
   ```
   GET {baseUrl}/tokens/v1/{chainId}/{chunk.join(',')}
   ```
4. Parse the `DexScreenerResponse` (same `{ pairs?: DexScreenerPair[] }` shape used by `fetchDexScreenerSearch`).
5. Group pairs by `pair.baseToken?.address?.toLowerCase()`.
6. For each token address, pick the pair with the highest `liquidity.usd` as the representative pair.
7. Map using an extended version of `mapPairToTokenInfo` that returns `DiscoveredToken` (with `source: 'dexscreener'` and `discoveryVectors: []`). The caller in `enrichDexScreenerBoostTokens` will merge discovery vectors from the original entry.
8. Chunks are fetched sequentially (not `Promise.all`) to respect the rate limiter.

Note: this function does not set `discoveryVectors` — that is preserved from the original boost/profile token during the merge in step 2.

### Step 2 — `enrichDexScreenerBoostTokens` in `dexscreener.ts`

New exported function that follows the same pattern as `enrichByNetworkSlice` in `discovery.ts`:

```typescript
export async function enrichDexScreenerBoostTokens(
  tokens: DiscoveredToken[],
  networks: string[],
  config: DexScreenerConfig,
): Promise<DiscoveredToken[]>
```

**Behaviour:**
1. Identify tokens to enrich: `source === 'dexscreener'` AND `liquidityUsd === 0` AND `token.network` is in `networks`.
2. If none, return `tokens` unchanged.
3. Group by `token.network`.
4. For each network group, call `fetchDexScreenerTokensByAddress(network, addresses, config)`.
5. Build an enriched-by-key map: `network:address → enriched DiscoveredToken`.
6. Return `tokens.map(token => merge(token, enrichedMap.get(tokenKey(token))))` where merge:
   - Overwrites: `priceUsd`, `volume24hUsd`, `liquidityUsd`, `priceChange24hPct`, `symbol` (if enriched symbol is non-empty), `name` (if enriched name is non-empty)
   - Preserves: `source`, `discoveryVectors`, `address`, `network`
   - Tokens not found in the enriched map are returned unchanged
7. The entire function is wrapped in try/catch — any error returns `tokens` unchanged and logs a warning.

### Step 3 — Wire into `discovery.ts`

Import `enrichDexScreenerBoostTokens` from `dexscreener.ts`.

In `discoverTokens`, insert the enrichment call between `mergeDiscoveredTokens` and the `passesDiscoveryThreshold` filter:

```typescript
const merged = mergeDiscoveredTokens(fulfilled);

// Enrich DexScreener boost/profile tokens that have no liquidity yet.
// This runs before the threshold filter so enriched tokens can enter the pool.
const enrichedMerge = await enrichDexScreenerBoostTokens(merged, networks, config.dexscreener);

const filtered = enrichedMerge
  .filter((token) => passesDiscoveryThreshold(token, minLiquidityUsd))
  .sort(...);
```

No changes to `DiscoveryConfig` — the enrichment is unconditional, driven by the presence of `source === 'dexscreener'` tokens with zero liquidity.

### Step 4 — Tests

**`packages/market-data/src/dexscreener.test.ts`** (extend existing file):

- `fetchDexScreenerTokensByAddress`: returns `[]` for empty addresses
- `fetchDexScreenerTokensByAddress`: maps the highest-liquidity pair for each token address
- `fetchDexScreenerTokensByAddress`: when a token has no pairs in the response, it is absent from the result
- `fetchDexScreenerTokensByAddress`: batches >30 addresses into sequential requests of ≤30
- `enrichDexScreenerBoostTokens`: overwrites `liquidityUsd`, `volume24hUsd`, `priceUsd` on `source=dexscreener` tokens with `liquidityUsd=0`
- `enrichDexScreenerBoostTokens`: preserves `discoveryVectors` and `source` from original token
- `enrichDexScreenerBoostTokens`: overwrites `volume24hUsd` with the real trading volume (not the original boost spend amount)
- `enrichDexScreenerBoostTokens`: skips tokens whose `network` is not in the configured networks list
- `enrichDexScreenerBoostTokens`: skips tokens that already have `liquidityUsd > 0`
- `enrichDexScreenerBoostTokens`: returns original tokens unchanged when the fetch throws

**`packages/market-data/src/discovery.test.ts`** (extend existing file):

- DexScreener boost tokens with real on-chain liquidity (after mock enrichment) appear in discovery results
- DexScreener boost tokens with no DexScreener pair (enrichment returns nothing) remain filtered by `passesDiscoveryThreshold`
- DexScreener boost tokens from non-configured networks (e.g. `ethereum` when `networks: ['solana']`) do not appear in results

## Complete file change summary

| File | Change type | What changes |
|---|---|---|
| `packages/market-data/src/dexscreener.ts` | Extend | Add `fetchDexScreenerTokensByAddress` and `enrichDexScreenerBoostTokens` |
| `packages/market-data/src/discovery.ts` | Extend | Insert `enrichDexScreenerBoostTokens` call between merge and filter |
| `packages/market-data/src/index.ts` | Extend | Export `enrichDexScreenerBoostTokens` and `fetchDexScreenerTokensByAddress` |
| `packages/market-data/src/dexscreener.test.ts` | Extend | Tests for new functions |
| `packages/market-data/src/discovery.test.ts` | Extend | Tests for enrichment integration in the pipeline |

No config changes. No changes to `types.ts`, `provider-registry.ts`, or any app-level code.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Boost tokens from non-configured chains (ETH, BSC) pollute the Solana/Base result set | `enrichDexScreenerBoostTokens` filters to `config.networks` before enrichment. Non-matching tokens are skipped entirely. |
| `volume24hUsd` on raw boost items reflects boost spend, not trading volume | Enrichment explicitly overwrites `volume24hUsd` with `pair.volume.h24` from the API response. |
| DexScreener 429 during enrichment slows or breaks discovery | Enrichment is fail-soft (try/catch returns original tokens). Rate budget is 30/min; 5 total calls per cycle is far within limits. |
| Token with only a low-liquidity pair passes threshold unexpectedly | Same threshold applies to enriched DS tokens as to GT tokens: `liquidityUsd >= minLiquidityUsd` (default $10k). A token with a $500 pool still fails. |
| Enrichment adds latency to each discovery run | Sequential batching adds ~1–2 HTTP round-trips (~200–500ms each). Discovery is cached for 5 minutes. One-time overhead per cache miss is acceptable. |

## Exit criteria

- DexScreener boost and profile tokens that have a real on-chain pool with liquidity ≥ `minLiquidityUsd` appear in discovery results.
- The `volume24hUsd` field on enriched DexScreener tokens reflects trading volume, not boost spend amount.
- DexScreener tokens from networks not in `config.networks` are not enriched and do not appear in results.
- A DexScreener enrichment failure does not abort the discovery run.
- `pnpm lint` passes.
- `pnpm test` passes with new unit tests covering all cases above.
