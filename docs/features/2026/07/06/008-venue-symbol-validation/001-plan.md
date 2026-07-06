# 001 — Venue Symbol Validation at Decision Intake

**Status:** pending  
**Created:** 2026-06-17  
**Scope:** Prevent agents from trading symbols that don't exist on their bound venue.

## Problem

Shadow/paper mode agents can submit decisions for any symbol string (e.g. "DOGE", "HYPE"). The `ShadowExecutor` simulates fills using oracle prices (CoinGecko) without ever contacting the venue. This creates phantom positions locally that crash reconciliation on restart because the real venue doesn't recognize those symbols.

Live mode agents are protected by the venue itself — Hyperliquid rejects unknown symbols with `venue.exchange_error`. But shadow/paper mode has no such protection.

## Solution Outline

Add a fast, in-memory instrument cache populated from venue APIs. Validate every incoming decision's `instrumentId` against this cache before it reaches the executor. Reject unknown symbols with a clear `instrument_unknown` rejection code.

## Design Decisions

### D1: In-memory cache vs. DB (`instruments` table)

**Decision:** In-memory cache (per-worker `Map<venue, Set<symbol>>`) with periodic refresh.

**Rationale:**
- The `instruments` table exists but requires `type`, `base`, `quote`, `tick_size`, `lot_size` — overkill for a yes/no membership check.
- Symbol validation is a hot path (every decision). DB round-trip per check adds latency.
- The cache is small (Hyperliquid has ~150 perps; Jupiter maybe thousands of tokens but still <1MB).
- Redis secondary cache for worker-restart survivability is optional (Phase 2).

### D2: Where to fetch symbols from

| Venue | Source | Method |
|-------|--------|--------|
| Hyperliquid | ccxt `exchange.loadMarkets()` | Already available internally; expose via adapter |
| Bybit | ccxt `exchange.loadMarkets()` | Same pattern |
| Jupiter | Jupiter token list API | `https://token.jup.ag/strict` |
| 1inch | 1inch token list per chain | `https://api.1inch.dev/token/v1.2/{chainId}/search` |

**Decision:** Add `fetchAvailableSymbols(): Promise<Result<string[], VenueError>>` to `OrderbookVenuePort` (for orderbook venues). For swap venues, add to `SwapVenuePort`. Each adapter implements it using the appropriate source.

### D3: Where to validate

**Decision:** In `AgentIntakeResolver.getIntakeDeps()` and `AgentTradingActor.getIntakeDeps()` — the two chokepoints where `DecisionIntakeDeps` is built.

These are the only paths through which agent decisions reach `submitDecisionForExecution()`. Both already return `IntakeResult` which supports the `{ rejected: true, code, message }` shape — we add `code: 'instrument_unknown'`.

### D4: Cache refresh strategy

- **On worker startup:** Fetch all symbols for all configured venues. Worker won't accept decisions until cache is warm (fail-closed).
- **Periodic refresh:** Every 60 minutes via `setInterval`. New Perp listings and token additions are infrequent.
- **On cache miss:** Optionally trigger an immediate venue fetch and retry the decision once (Phase 2 optimization).

### D5: Symbol format normalization

Different venues use different symbol formats. We need to normalize both the cache key and the incoming `instrumentId`:

| Venue | Cache format | Agent's instrumentId | Normalization |
|-------|-------------|---------------------|---------------|
| Hyperliquid | `BTC` | `BTC`, `BTC-PERP`, `BTC/USD:USD` | Strip suffixes, uppercase |
| Bybit | `BTCUSDT` | `BTC-USDT`, `BTC/USDT:USDT` | Strip separators, uppercase |
| Jupiter | Mint address (`So111...`) | Same | No normalization (exact match) |
| 1inch | Token address (`0x...`) | Same | No normalization (exact match) |

**Decision:** Each venue adapter provides a `normalizeSymbol(raw: string): string` helper. The cache stores normalized symbols. Incoming `instrumentId` is normalized before lookup.

## Implementation Plan

### Step 1: Extend venue ports (`packages/domain`) — **DONE**

Add to `OrderbookVenuePort`:
```typescript
/** Fetch all tradeable symbols on this venue. Used for decision intake validation. */
fetchAvailableSymbols?(): Promise<Result<string[], VenueError>>;
```

Add to `SwapVenuePort`:
```typescript
/** Fetch all tradeable token symbols/addresses on this venue. */
fetchAvailableSymbols?(): Promise<Result<string[], SwapVenueError>>;
```

Both are optional (`?`) — venues that don't implement them get no symbol validation (existing behavior preserved).

### Step 2: Implement in venue adapters (`packages/venues`) — **PENDING**

**Hyperliquid** (`hyperliquid.ts`):
```typescript
async fetchAvailableSymbols(): Promise<Result<string[], VenueError>> {
  return this.withRateLimit(async () => {
    const markets = await this.exchange.loadMarkets();
    const symbols = Object.keys(markets);  // ccxt returns Record<symbol, Market>
    return ok(symbols);
  });
}
```

**1inch** (`one-inch.ts`): Fetch from `https://api.1inch.dev/token/v1.2/{chainId}/search` — returns token list.

**Jupiter** (`jupiter.ts`): Fetch from `https://token.jup.ag/strict` — returns token list.

### Step 3: Create instrument cache (`apps/worker/src/`) — **PENDING**

New file: `venue-instrument-cache.ts`

```typescript
class VenueInstrumentCache {
  private cache = new Map<string, Set<string>>();  // venue → Set<normalized symbols>
  private ready = false;

  async warmup(venueAdapters: Map<string, { fetchSymbols: () => Promise<string[]> }>): Promise<void>;
  hasSymbol(venue: string, symbol: string): boolean;
  isReady(): boolean;
  startPeriodicRefresh(intervalMs: number): void;
}
```

### Step 4: Add validation to decision intake — **PENDING**

**`AgentIntakeResolver.getIntakeDeps()`** (`agent-intake-resolver.ts`):
```typescript
if (!instrumentCache.hasSymbol(binding.venue, instrumentId)) {
  return {
    rejected: true,
    code: 'instrument_unknown',
    message: `'${instrumentId}' is not a recognized instrument on ${binding.venue}`,
    retryable: false,
  };
}
```

**`AgentTradingActor.getIntakeDeps()`** (`agent-trading-actor.ts`):
Same check, using `this.deps.venue` and the shared instrument cache.

### Step 5: Wire up in worker (`apps/worker/src/index.ts`) — **PENDING**

- Instantiate `VenueInstrumentCache` at worker startup
- Call `warmup()` during initialization — block agent decision processing until ready
- Start periodic refresh (every 60 minutes)
- Inject into `AgentIntakeResolver` and `AgentTradingActor` constructors

### Step 6: Populate instruments table (optional, Phase 2) — **PENDING**

Use the cache data to `INSERT … ON CONFLICT DO NOTHING` into the `instruments` table for operator visibility and future use cases (UI instrument picker, etc.).

## Edge Cases

1. **New venue listing between refreshes:** The 60-minute refresh window means a newly listed symbol won't be tradeable for up to an hour. Acceptable — listings are rare events.

2. **Venue API down during warmup:** Worker fails to start (fail-closed). Better than silently allowing unvalidated trades. Add a configurable `allowUnvalidatedTrades` escape hatch for emergencies.

3. **Swap venues with massive token lists:** Jupiter's strict list is ~2,000 tokens. A `Set<string>` of that size is negligible. No paging needed.

4. **Agent uses ticker while venue uses address:** The normalization step (D5) handles this. If a symbol can't be normalized to match any cache entry, it's rejected.

5. **Paper mode + no venue adapter wired:** `AgentIntakeResolver` handles paper mode for agents without a running actor. We inject the instrument cache there too — it validates against the binding's venue even in paper mode.

## Non-Goals

- Real-time symbol addition/removal (60-min refresh is sufficient)
- UI instrument picker (uses instruments table, Phase 2)
- Cross-venue symbol mapping (e.g., "BTC on Hyperliquid" vs "WBTC on Jupiter")

## Effort Estimate

| Step | Effort |
|------|--------|
| 1. Extend venue ports | Small (interface change, optional method) |
| 2. Implement adapters | Small–Medium (3 adapters, each ~20 lines) |
| 3. Instrument cache | Medium (new class, ~80 lines) |
| 4. Add validation to intake | Small (two guard clauses, ~10 lines each) |
| 5. Wire up in worker | Small (dependency injection) |
| 6. Populate instruments table | Small (optional, deferred) |
| **Total** | **~3–4 hours** |

## Dependencies

- None (self-contained feature)
- No DB migration needed (instruments table already exists)
- No breaking API changes (optional port methods)
