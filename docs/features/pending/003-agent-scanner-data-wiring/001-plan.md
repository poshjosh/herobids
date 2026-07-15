# Implementation Plan — Agent Scanner Data Wiring

**Goal:** Hybrid/scanner_gated agents receive pre-scored signals and trade across all 4 supported venues.

**Prerequisite:** `docs/features/2026/07/15/002-technical-data-for-agents/001-plan.md` (short-term Hyperliquid wiring).

---

## Part A — Bybit Discovery (`packages/market-data/`)

### A1: Implement `fetchBybitTickers`

New file: `packages/market-data/src/bybit-tickers.ts`

Wrap Bybit's `/v5/market/tickers?category=linear` endpoint:

```typescript
export async function fetchBybitTickers(config: BybitTickersConfig): Promise<BybitTicker[]>
```

Return type: `{ symbol: string; lastPrice: number | null; volume24hUsd: number | null; priceChange24hPct: number | null; high24h: number | null; low24h: number | null }[]`

Follow the same pattern as `fetchHyperliquidAssetContexts`:
- Accept `RequestGate` rate limiter
- Use `fetchJson` from `http.js`
- Parse the `result.list` array from Bybit's response
- Map to typed ticker objects

### A2: Add to provider registry

In `packages/market-data/src/provider-registry.ts`:
- Add `BybitTickersConfig` to config types
- Add `tickers()` method to `registry.bybit` interface
- Wire `loadWithCache` with config-driven TTL and cache key `bybit:tickers:linear`
- Export `fetchBybitTickers` and types from `packages/market-data/src/index.ts`

### A3: Config schema

Add to `config/default.yaml` under `marketData.bybit`:
```yaml
tickersPath: "/v5/market/tickers"
category: "linear"
```

Add optional fields to `BybitInfoConfig`. Default `tickersPath` to `/v5/market/tickers`.

### A4: Tests

- Mock Bybit tickers endpoint, verify parsing of volume/price fields
- Verify `null` handling for missing fields
- Verify rate limiter integration
- Verify cache key and TTL

---

## Part B — Scanner Wiring (`apps/worker/src/index.ts`)

### B1: Implement venue-agnostic `discoverCandidates`

```typescript
const discoverCandidates = async (filters: FilterConfig): Promise<DiscoveredInstrument[]> => {
  if (!sharedMarketDataRegistry) return [];

  if (filters.venueType === 'orderbook') {
    return discoverOrderbookCandidates(filters);
  }
  return discoverSwapCandidates(filters);
};
```

#### `discoverOrderbookCandidates`

| Venue | Source | Mapping |
|-------|--------|---------|
| `hyperliquid` | `registry.hyperliquid.assetContexts()` | `asset` → `symbol`, `asset-PERP` → `instrumentId` |
| `bybit` | `registry.bybit.tickers()` | `symbol` → `symbol` and `instrumentId` |
| other | Return `[]` with warning log |

Apply `filters.minVolume24hUsd`, `filters.symbols`, `filters.excludeSymbols`.

#### `discoverSwapCandidates`

Use `registry.discovery.discover()` with `filters.networks` (default: `['solana', 'base']`). Also use `registry.geckoterminal.trendingPools()` and `registry.geckoterminal.topPools()` for additional candidates. Deduplicate by pool address.

Map to `DiscoveredInstrument`:
- `symbol` ← token symbol from discovery
- `instrumentId` ← pool address (used as instrument identifier for swaps)
- `volume24hUsd`, `liquidityUsd`, `priceChange24hPct` ← from discovery data

Apply `filters.minVolume24hUsd`, `filters.minLiquidityUsd`, `filters.symbols`, `filters.excludeSymbols`.

### B2: Implement `fetchCandles` (reuse `VenueCandleFetcher`)

```typescript
const agentCandleFetcher = sharedMarketDataRegistry
  ? new VenueCandleFetcher(
      sharedMarketDataRegistry.configs.binance,
      { config: sharedMarketDataRegistry.configs.geckoterminal, network: 'solana' },
      'orderbook', // default; overridden per-symbol by VenueCandleFetcher based on symbol format
    )
  : undefined;

const fetchCandles = agentCandleFetcher
  ? (symbol: string, interval: string, limit: number) =>
      agentCandleFetcher.fetchCandles(symbol, interval, limit)
  : undefined;
```

`VenueCandleFetcher` auto-detects pool addresses (length > 20 chars) and routes them to GeckoTerminal. Standard symbols route to Binance. No venue-specific branching needed at the wiring level.

### B3: Extract `technicalConfig` and wire all three

In the `AgentTradingActor` constructor call, add:

```typescript
const technicalConfig = (agent?.unifiedConfig?.technical as TechnicalConfig | undefined) ?? undefined;

actor = new AgentTradingActor({
  // ... existing deps unchanged ...
  technicalConfig,
  discoverCandidates,
  fetchCandles,
});
```

### B4: Imports

Add to `index.ts` imports:
```typescript
import type { TechnicalConfig, PriceCandle } from '@herobids/domain';
import type { DiscoveredInstrument, FilterConfig } from './technical-phase.js';
```

`VenueCandleFetcher` already imported (line 21).

---

## Part C — Tests

### C1: `fetchBybitTickers` unit tests

File: `packages/market-data/src/bybit-tickers.test.ts`
- Successful parse of real Bybit response shape
- Null/undefined handling for optional fields
- Rate limiter acquire called
- Empty response handling
- HTTP error handling

### C2: `discoverCandidates` integration tests

File: `apps/worker/src/index.test.ts` (or new `scanner-wiring.test.ts`)
- Orderbook path: Hyperliquid `assetContexts` called, results mapped correctly
- Orderbook path: Bybit `tickers` called, results mapped correctly
- Swap path: discovery pipeline called, results mapped correctly
- Filter application: minVolume, symbols whitelist, excludeSymbols blacklist
- Graceful degradation when registry is undefined

### C3: Existing tests must still pass

- `agent-trading-actor.test.ts` — scanner enrichment tests (mock `discoverCandidates`/`fetchCandles`)
- `technical-phase.test.ts` — phase orchestration tests
- `hybrid-agent-evaluator.test.ts` — evaluator routing tests
- `pnpm lint` — no new type errors

---

## Part D — Config

### D1: Bybit tickers config in `default.yaml`

```yaml
marketData:
  bybit:
    tickersPath: "/v5/market/tickers"
    tickersCategory: "linear"
    tickers:
      requestsPerMinute: 30
      burstCapacity: 10
      maxWaitMs: 5000
      cacheTtlMs: 60000
```

### D2: Discovery config (already exists, verify)

Existing `marketData.discovery.maxResults` and `marketIntelligence.networks: [solana, base]` are sufficient for swap venue discovery.

---

## Verification

| Check | How |
|-------|-----|
| Worker starts without errors | `docker logs herobids-worker-1` |
| Scanner loop starts for hybrid agents | Log: "Technical scan loop started" with intervalMs |
| Hyperliquid signals discovered | Log with venue="hyperliquid", signalCount > 0 |
| Bybit signals discovered | Log with venue="bybit", signalCount > 0 |
| Swap signals discovered | Log with venueType="swap", signalCount > 0 |
| Scanner wake emitted to agent | Agent log: "routing to single-shot evaluator (scanner wake)" |
| Agent makes decisions | Agent log: hybrid evaluator JSON decisions |
| Decisions in DB | `SELECT COUNT(*) FROM decisions WHERE actor_type='agent' AND actor_id != '81d62e72...'` |
| `pnpm lint` passes | No new type errors |
| `pnpm test` passes | All existing tests + new tests green |

---

## Checklist

### Part A — Bybit Discovery
- [ ] A1: Implement `fetchBybitTickers` in `packages/market-data/src/bybit-tickers.ts`
- [ ] A2: Add `tickers()` to provider registry interface and wiring
- [ ] A3: Add config schema fields to `BybitInfoConfig`
- [ ] A4: Add config to `default.yaml`
- [ ] A5: Unit tests for `fetchBybitTickers`

### Part B — Scanner Wiring
- [ ] B1: Implement venue-agnostic `discoverCandidates` in `index.ts`
- [ ] B2: Implement `fetchCandles` wrapping `VenueCandleFetcher`
- [ ] B3: Extract `technicalConfig` and pass all three to `AgentTradingActor`
- [ ] B4: Add required imports

### Part C — Tests
- [ ] C1: Integration tests for `discoverCandidates` per venue
- [ ] C2: Verify existing tests still pass

### Part D — Config
- [ ] D1: Bybit tickers config in `default.yaml`
