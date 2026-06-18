# Discovery Diversity Plan

**Date:** 2026-06-17
**Status:** Draft

## Problem

Agents converge on the same ~20 tokens — and more importantly, the same tokens day after day. Two root causes:

1. **Artificial ceiling**: `discoverTokens` hardcodes `maxResults ?? 20`. There is no operator config key. Even though GeckoTerminal provides enough raw data for ~50 unique quality tokens per run, all but the top 20 are silently discarded.

2. **No staleness tracking**: Discovery returns the highest-liquidity tokens from the current provider response. High-liquidity tokens dominate "trending" for days. Every agent, every tick, sees the same narrow pool. There is no mechanism to push recently-surfaced tokens to the back of the queue and surface fresh ones.

The aitradingbot predecessor hit exactly this failure mode (May 2026 evals: 13+ agent instances, 4+ days, 5 recurring tokens). Their fix: anti-staleness Redis tracking + GeckoTerminal pagination past page 1.

## What Is NOT in scope

- DexScreener token enrichment (turning boost/profile addresses into liquidity-bearing tokens requires a new `GET /tokens/v1/{chainId}/{addresses}` call — a separate plan)
- Birdeye integration (separate plan already in backlog)
- CMC enablement (operational config change, not a code change)

## Available raw data before the 20-cap

| Source | Calls per run | Raw entries | After dedup + $10k filter |
|---|---|---|---|
| GeckoTerminal trending p1 × 2 networks | 2 | ~20 | ~15 |
| GeckoTerminal top pools p1 × 2 networks | 2 | ~40 | ~25 |
| GeckoTerminal new pools × 2 networks | 2 | ~40 | ~20 |
| DexScreener boosts/trending/profiles | 3 | ~60 | **0** (liquidityUsd=0, filtered) |
| **Total (current)** | **9** | **~160** | **~60** |
| GeckoTerminal trending p2 × 2 networks (new) | +2 | +~40 | +~15 |
| GeckoTerminal top pools p2 × 2 networks (new) | +2 | +~40 | +~20 |
| **Total (after plan)** | **13** | **~240** | **~95** |

The realistic unique pool after pagination is ~80–95 quality tokens. The anti-staleness filter then rotates which subset the agent sees.

## Phase 1 — `discovery.maxResults` operator config key

**Goal:** Remove the hardcoded 20. Let the operator set the ceiling. Raise the `discover_tokens` tool schema max to match.

### Files

| File | Change |
|---|---|
| `config/default.yaml` | Add `marketData.discovery.maxResults: 50` |
| `packages/market-data/src/types.ts` | Add `discovery?: { maxResults?: number }` to `MarketDataConfig` |
| `packages/market-data/src/discovery.ts` | Accept `maxResults` from `DiscoveryConfig` (already present); no change needed |
| `packages/market-data/src/provider-registry.ts` | Pass `config.discovery?.maxResults` as the default when `discoveryOptions?.maxResults` is not set; update the cache key |
| `apps/worker/src/tools/market-data.ts` | Raise `DiscoverTokensParamsSchema` limit max from `50` to `100` |

### Detail

**`config/default.yaml`** — add under `marketData`:
```yaml
marketData:
  discovery:
    maxResults: 50          # Maximum tokens returned per discovery run (agent can override down to 1, up to 100)
```

**`MarketDataConfig`** (`types.ts`) — add optional field:
```typescript
discovery?: {
  maxResults?: number;
};
```

**`provider-registry.ts`** — in the `discover` loader call, the current registry passes `maxResults: discoveryOptions?.maxResults` (which is `undefined` when the agent doesn't specify a limit, causing `discoverTokens` to default to 20). Change to:
```typescript
maxResults: discoveryOptions?.maxResults ?? config.discovery?.maxResults ?? 20,
```

And update the cache key similarly so that the config-level default is included:
```typescript
cacheKey: `discovery:${networks.join(',')}:${maxResults}:${minLiquidityUsd}`,
```

**`market-data.ts` tool** — raise schema max:
```typescript
limit: z.number().int().positive().max(100).optional()
```

### Dependencies
None.

---

## Phase 2 — GeckoTerminal page 2 support

**Goal:** Fetch page 2 of GeckoTerminal trending and top-pools endpoints, expanding the raw pool by ~35–40 additional unique tokens per run.

### How GeckoTerminal pagination works

GeckoTerminal pool endpoints accept a `?page=N` query parameter. Page 1 returns pools 1–20, page 2 returns pools 21–40 (approximately — actual count depends on the network). The API is free-tier at ~10 req/min.

### Rate-limit impact

Current: 6 GT discovery calls (3 endpoints × 2 networks). Adding page 2 for trending and top-pools adds 4 more calls (2 endpoints × 2 networks × 1 additional page) = 10 GT discovery calls total.

At the current `geckoterminal.discovery.requestsPerMinute: 10` budget, 10 calls per discovery cycle is the exact limit. This is acceptable for the default 5-minute discovery cache TTL (calls are amortized). But it means the discovery cache TTL should not be reduced below 2 minutes without also raising the GT budget.

This feature should be **off by default** (no config key means page 2 is not fetched) and opt-in via `marketData.discovery.geckoTerminalExtraPages: 1`. This avoids surprising operators who are at the free-tier boundary.

### Files

| File | Change |
|---|---|
| `packages/market-data/src/geckoterminal.ts` | Accept optional `page` param in `fetchGeckoTerminalTrendingPools` and `fetchGeckoTerminalTopPools`; append `?page={page}` to the URL when page > 1 |
| `packages/market-data/src/discovery.ts` | When `config.extraGeckoTerminalPages` is set, fan out additional trending and top-pools calls for pages 2..N per network; update `DiscoveryConfig` interface |
| `packages/market-data/src/types.ts` | Add `geckoTerminalExtraPages?: number` to the `discovery` block in `MarketDataConfig` |
| `config/default.yaml` | Add `marketData.discovery.geckoTerminalExtraPages: 0` (explicit zero = off) |

### Detail

**`geckoterminal.ts`** — the `fetchPools` helper already builds the URL from a `path` string. Add an optional `page` param to `fetchGeckoTerminalTrendingPools` and `fetchGeckoTerminalTopPools`:

```typescript
export async function fetchGeckoTerminalTrendingPools(
  network: string,
  config: GeckoTerminalConfig,
  page = 1,
): Promise<DiscoveredToken[]> {
  const pageParam = page > 1 ? `?page=${page}` : '';
  return fetchPools(
    network,
    `/api/v2/networks/${encodeURIComponent(network)}/trending_pools${pageParam}`,
    page > 1 ? `trending_pools_p${page}` : 'trending_pools',
    config,
  );
}
```

Same change for `fetchGeckoTerminalTopPools`.

**`discovery.ts`** — add `extraGeckoTerminalPages?: number` to `DiscoveryConfig`. In `discoverTokens`, expand the fan-out:

```typescript
const extraPages = config.extraGeckoTerminalPages ?? 0;
const pageNumbers = [1, ...Array.from({ length: extraPages }, (_, i) => i + 2)];

// Replace the existing per-network GT calls with:
...networks.flatMap((network) => [
  ...pageNumbers.map((page) => fetchGeckoTerminalTrendingPools(network, config.geckoterminal, page)),
  ...pageNumbers.map((page) => fetchGeckoTerminalTopPools(network, config.geckoterminal, page)),
  fetchGeckoTerminalNewPools(network, config.geckoterminal),
]),
```

**`provider-registry.ts`** — pass `config.discovery?.geckoTerminalExtraPages` through to `discoverTokens`.

**`config/default.yaml`**:
```yaml
marketData:
  discovery:
    maxResults: 50
    geckoTerminalExtraPages: 0    # Set to 1 to fetch page 2 of GT trending + top pools (~35 extra tokens, 4 extra req/run)
```

### Dependencies
Phase 1 (config shape for `discovery` block in `MarketDataConfig`).

---

## Phase 3 — Anti-staleness Redis filter

**Goal:** Track which token addresses have been surfaced recently. On each discovery run, return fresh tokens first. If all candidates are recently seen, still return them (graceful degradation) — just deprioritized.

### Design decisions (informed by aitradingbot)

| Decision | Choice | Rationale |
|---|---|---|
| Scope | Global (single shared Redis key) | Simpler; forces system-wide diversity; same as aitradingbot |
| Key type | Redis sorted set: `market-data:discovery:seen:{network}` | Score = surfacing timestamp ms; enables efficient range queries |
| Key per network | Yes | Solana and Base have distinct token universes; mixing would unfairly penalize a Solana token that appeared in a Solana-only run |
| Graceful Redis failure | Skip anti-staleness, return full sorted list unchanged | Anti-staleness is a diversity hint, not a correctness requirement |
| Cooldown default | 4 hours | Matches aitradingbot default |
| TTL for pruning | 24 hours | Entries older than 24h are pruned; keeps the set bounded |
| When to apply | After merge + filter, before the `maxResults` slice | Reorders candidates; does not reduce them |
| Enabled flag | `marketData.discovery.antistalenessCooldownHours: 4` | Zero or absent = disabled (no Redis calls, no overhead) |

### New interface and implementations

**`packages/market-data/src/discovery-seen-tracker.ts`** (new file):

```typescript
export interface DiscoverySeenClient {
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]>;
  zremrangebyscore(key: string, min: number | string, max: number | string): Promise<unknown>;
}

export interface DiscoverySeenTracker {
  applyAntiStaleness(
    tokens: DiscoveredToken[],
    cooldownMs: number,
  ): Promise<DiscoveredToken[]>;
  markSeen(tokens: DiscoveredToken[]): Promise<void>;
}

export class NoopDiscoverySeenTracker implements DiscoverySeenTracker {
  async applyAntiStaleness(tokens: DiscoveredToken[]): Promise<DiscoveredToken[]> {
    return tokens;
  }
  async markSeen(): Promise<void> {}
}

export class RedisDiscoverySeenTracker implements DiscoverySeenTracker {
  constructor(private readonly redis: DiscoverySeenClient, private readonly ttlMs: number) {}
  // ...implementation...
}
```

The `RedisDiscoverySeenTracker.applyAntiStaleness`:
1. Group tokens by network.
2. For each network, call `zrangebyscore(key, now - cooldownMs, now)` to get recently-seen addresses.
3. Partition tokens into `fresh` (not in the seen set) and `stale` (in the seen set).
4. Return `[...fresh, ...stale]`.

The `RedisDiscoverySeenTracker.markSeen`:
1. For each token, `zadd(key, Date.now(), token.address)`.
2. Prune old entries: `zremrangebyscore(key, '-inf', Date.now() - ttlMs)`.
3. Both operations run concurrently per network.

**Error handling**: All Redis operations are wrapped in try/catch. Any failure returns the original token array unchanged and logs a warning.

### Integration point

Anti-staleness is applied inside `discoverTokens()`, after the merge+filter+sort pipeline and before the `maxResults` slice:

```typescript
// After: .sort(...)
// Before: .slice(0, maxResults)

const reordered = config.seenTracker
  ? await config.seenTracker.applyAntiStaleness(merged, cooldownMs)
  : merged;

const final = reordered.slice(0, maxResults);

if (config.seenTracker) {
  await config.seenTracker.markSeen(final);
}

return final;
```

`seenTracker` is added to `DiscoveryConfig` as an optional field (not serializable config — it's a runtime dependency like `rateLimiter`).

### Wiring in the registry

`ProviderRegistryOptions` gets a new optional field:
```typescript
discoverySeenClient?: DiscoverySeenClient;
```

In `createProviderRegistry`, when `options.discoverySeenClient` is present and `config.discovery?.antistalenessCooldownHours > 0`, create a `RedisDiscoverySeenTracker` and pass it to the `discoverTokens` call via `DiscoveryConfig.seenTracker`.

The worker passes `redisClient` for rate-limiting already. The same ioredis `Redis` instance satisfies `DiscoverySeenClient` — it has `zadd`, `zrangebyscore`, and `zremrangebyscore` as native methods. The worker adds `discoverySeenClient: redis` alongside `redisClient: redis` when calling `createProviderRegistry`.

### Config additions

```yaml
marketData:
  discovery:
    maxResults: 50
    geckoTerminalExtraPages: 0
    antistalenessCooldownHours: 4    # Hours before a token can re-appear at top of discovery. 0 = disabled.
    antistalenessTokenTtlHours: 24   # How long to track a seen address before pruning it
```

And in `MarketDataConfig` (`types.ts`):
```typescript
discovery?: {
  maxResults?: number;
  geckoTerminalExtraPages?: number;
  antistalenessCooldownHours?: number;
  antistalenessTokenTtlHours?: number;
};
```

### Files

| File | Change |
|---|---|
| `packages/market-data/src/discovery-seen-tracker.ts` | New file — `DiscoverySeenClient` interface, `NoopDiscoverySeenTracker`, `RedisDiscoverySeenTracker` |
| `packages/market-data/src/discovery.ts` | Add `seenTracker?: DiscoverySeenTracker` to `DiscoveryConfig`; apply anti-staleness between sort and slice; call `markSeen` after slicing |
| `packages/market-data/src/types.ts` | Add `antistalenessCooldownHours` and `antistalenessTokenTtlHours` to `MarketDataConfig.discovery` |
| `packages/market-data/src/provider-registry.ts` | Add `discoverySeenClient?: DiscoverySeenClient` to `ProviderRegistryOptions`; construct `RedisDiscoverySeenTracker` when client + cooldown config present |
| `packages/market-data/src/index.ts` | Export `DiscoverySeenClient`, `DiscoverySeenTracker`, `NoopDiscoverySeenTracker` |
| `config/default.yaml` | Add `antistalenessCooldownHours: 4` and `antistalenessTokenTtlHours: 24` under `marketData.discovery` |
| `apps/worker/src/index.ts` | Pass `discoverySeenClient: redisClient` to `createProviderRegistry` options |
| `apps/worker/src/agent.ts` | Same — pass `discoverySeenClient: redis` |

### Dependencies
Phase 1 (config shape). Phase 2 is independent of Phase 3.

---

## Phase 4 — Tests

### Phase 1 tests
- `provider-registry.test.ts`: registry uses `config.discovery.maxResults` as the default when `discoveryOptions.maxResults` is absent
- `provider-registry.test.ts`: registry uses `discoveryOptions.maxResults` when explicitly provided (overrides config)
- No changes needed to `discovery.test.ts` — `maxResults` is already tested there

### Phase 2 tests
- `geckoterminal.test.ts`: `fetchGeckoTerminalTrendingPools(network, config, 2)` appends `?page=2` and uses vector `trending_pools_p2`
- `discovery.test.ts`: with `extraGeckoTerminalPages: 1`, discovery fan-out includes p2 trending and top-pools calls

### Phase 3 tests
- `discovery-seen-tracker.test.ts` (new):
  - `NoopDiscoverySeenTracker` returns tokens unchanged
  - `RedisDiscoverySeenTracker.applyAntiStaleness`: fresh tokens appear before stale tokens
  - `RedisDiscoverySeenTracker.applyAntiStaleness`: if all tokens are stale, they are still returned (graceful degradation)
  - `RedisDiscoverySeenTracker.applyAntiStaleness`: Redis failure returns original list unchanged
  - `RedisDiscoverySeenTracker.markSeen`: ZADD is called for each token; prune is called per network
- `discovery.test.ts`:
  - With a `seenTracker` stub, anti-staleness is applied before the maxResults slice
  - Without a `seenTracker`, result is unchanged
- `provider-registry.test.ts`:
  - With `discoverySeenClient` + `antistalenessCooldownHours > 0`, a `RedisDiscoverySeenTracker` is created and passed through
  - With no `discoverySeenClient`, a `NoopDiscoverySeenTracker` is used

---

## Complete file change summary

| File | Phase | Change type |
|---|---|---|
| `config/default.yaml` | 1, 2, 3 | Add `marketData.discovery` block |
| `packages/market-data/src/types.ts` | 1, 3 | Add `discovery` optional block to `MarketDataConfig` |
| `packages/market-data/src/provider-registry.ts` | 1, 3 | Use config default for `maxResults`; add `discoverySeenClient` option |
| `apps/worker/src/tools/market-data.ts` | 1 | Raise `discover_tokens` limit schema max to 100 |
| `packages/market-data/src/geckoterminal.ts` | 2 | Add `page` param to trending and top-pools fetchers |
| `packages/market-data/src/discovery.ts` | 2, 3 | Fan out page 2+; wire anti-staleness between sort and slice |
| `packages/market-data/src/discovery-seen-tracker.ts` | 3 | New file |
| `packages/market-data/src/index.ts` | 3 | Export new tracker types |
| `apps/worker/src/index.ts` | 3 | Pass `discoverySeenClient` |
| `apps/worker/src/agent.ts` | 3 | Pass `discoverySeenClient` |
| `packages/market-data/src/geckoterminal.test.ts` | 4 | Page param and vector name tests |
| `packages/market-data/src/discovery-seen-tracker.test.ts` | 4 | New test file |
| `packages/market-data/src/discovery.test.ts` | 4 | Anti-staleness and pagination tests |
| `packages/market-data/src/provider-registry.test.ts` | 4 | Config default maxResults; tracker wiring |

---

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| GeckoTerminal free-tier 10 req/min exceeded when `geckoTerminalExtraPages: 1` | Feature is off by default (`geckoTerminalExtraPages: 0`). Config comment documents the rate-limit cost. |
| Anti-staleness Redis set grows unbounded | `zremrangebyscore` prune runs on every `markSeen` call; entries older than `antistalenessTokenTtlHours` are removed. |
| Redis unavailability breaks discovery | All Redis anti-staleness operations are try/catch fail-soft. If Redis is down, discovery returns the normal sorted list unchanged. |
| Same token seen on Solana and Base independently | Seen sets are keyed per network (`market-data:discovery:seen:solana`, `market-data:discovery:seen:base`). No cross-network interference. |
| Anti-staleness cooldown prevents agent from trading a genuinely good opportunity again | Agent can override with `minLiquidityUsd` filter or network filter to bypass the discovery layer and use `search_tokens` directly. Anti-staleness only reorders candidates — it never blocks a token from appearing, it just pushes it to the back of the list. |

---

## Exit criteria

- `discover_tokens` with no explicit limit returns `config.marketData.discovery.maxResults` tokens (default 50) instead of 20.
- `discover_tokens` with `limit: 100` works.
- With `geckoTerminalExtraPages: 1` configured, discovery makes page-2 calls and the raw candidate pool is ~35–40 tokens larger.
- With `antistalenessCooldownHours: 4` configured and a Redis client available, tokens surfaced in the last 4 hours appear after fresher tokens in the discovery output.
- When Redis is unavailable, discovery completes normally and returns the standard sorted list.
- `pnpm lint` passes.
- `pnpm test` passes with new unit tests covering all phases.

---

## Implementation order

Phases are independent except Phase 2 depends on Phase 1 for the shared `discovery` config block in `MarketDataConfig`, and Phase 3 similarly depends on Phase 1. The recommended order is 1 → 2 → 3 → 4 (tests written alongside each phase).
