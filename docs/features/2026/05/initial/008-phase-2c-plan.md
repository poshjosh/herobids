# Phase 2c: Streams + Second Venue + Unified Validation

**Goal:** Public market-data stream infrastructure (shared WebSocket pool), second venue type (swap adapter), swap valuation policy, and unified lifecycle validation proving the architecture generalizes across venue types.

**Parent:** [006-phase-2-plan.md](006-phase-2-plan.md) §5, §7, §9

**Depends on:** [007-phase-2b-plan.md](007-phase-2b-plan.md) — shadow executor, private streams, and crash recovery must be in place. The shadow executor's polling-based market data feed gets upgraded to use the stream pool built here.

---

## 1. Public Market-Data Streams (§5)

Shadow mode and reconciliation both depend on live market data. Per §10.3, public streams are shared via a connection pool. This batch delivers the real `subscribePublic` implementation (stubbed in Phase 2a) and the shared stream infrastructure.

### Stream pool

- [ ] `PublicStreamPool` class in `packages/venues/src/stream-pool.ts`
- [ ] One WebSocket connection per venue per worker — fan-out to all interested actors
- [ ] Keyed by venue (not by trading instance) — pure optimization, no privacy concern
- [ ] Uses `ws` library directly against venue-specific WS endpoints

### Stream types

- [ ] Ticker (last price, bid/ask) — needed for shadow executor market-order fills
- [ ] Orderbook depth (top N levels) — needed for accurate bid/ask in shadow mode
- [ ] Trade prints — needed for shadow limit-order heuristic fill detection

### Actor subscription model

- [ ] Actors subscribe on start: `pool.subscribe(venue, symbols, handlers)`
- [ ] Actors unsubscribe on stop: `subscription.unsubscribe()`
- [ ] Pool opens connection on first subscriber, closes on last unsubscribe (lazy lifecycle)

### Reliability

- [ ] Reconnection handling (exponential backoff with jitter, re-subscribe on disconnect)
- [ ] Graceful shutdown: close all venue connections when worker stops
- [ ] Connection health monitoring: emit metric/log on disconnect, track consecutive failures

### Shadow executor upgrade

- [ ] Replace Phase 2b's polling-based `MarketDataFeed` implementation with a stream-pool-backed implementation
- [ ] Shadow executor receives real-time tickers and trade prints from the pool
- [ ] Implement real `subscribePublic` on `HyperliquidAdapter` (replaces the stub from Phase 2a)
- [ ] No changes to `ShadowExecutor` itself — only the injected `MarketDataFeed` dependency swaps

---

## 2. Second Venue Type — Swap Adapter (§7)

Add a swap venue adapter proving the architecture handles both orderbook and swap venue types.

### Adapter implementation

- [ ] Swap adapter implementing expanded `SwapVenuePort` (including `fetchBalance`, `fetchRecentTransactions`)
- [ ] `quote(SwapQuoteParams) → execute(SwapQuote)` lifecycle
- [ ] Unified execution lifecycle: swap fast-paths through `submitted → filled` (no resting/partial states)
- [ ] Same `Fill` record shape, journal entries, position model as orderbook venue

### Venue choice

**Jupiter (Solana)** via `@jup-ag/api` — real DEX aggregator proving the crypto swap path.

The parent plan (006-phase-2-plan.md §7) requires a chain-specific adapter. A mock/test double is insufficient to satisfy the parent's exit criteria ("second venue type produces same observability shape as orderbook venue" against real market conditions). The test suite will additionally include a deterministic test double for CI (no network dependency in unit tests), but the deliverable is a real Jupiter adapter.

### Plan/routing layer

- [ ] Planner handles venue-type dispatch (orderbook vs swap)
- [ ] Orderbook: planner produces orders with side/type/quantity/price
- [ ] Swap: planner produces swap params with input/output asset + amount
- [ ] Decision → Plan mapping accounts for venue type differences

### Reconciliation for swap venue

- [ ] On-chain (or venue-reported) balance confirmation
- [ ] Compare local position/balance state against `fetchBalance()` result
- [ ] Detect unrecorded swaps via `fetchRecentTransactions()`

---

## 3. Swap Valuation Policy (§8.4)

Swap P&L, risk checks, and reconciliation require a canonical mark that is not the volatile executable quote.

- [ ] Mark source: last fill price for positions with recent fills; reference oracle price (e.g. CoinGecko/Coinbase spot) for stale positions
- [ ] Marking source configured per instrument, recorded on each `balance_snapshot` and `position` record
- [ ] Risk gate uses reference mark (stable, auditable); execution uses executable quote (size-accurate, transient)
- [ ] Paper/shadow/live use the same marking source — no mode-specific P&L divergence
- [ ] Reconciliation compares local mark against venue-reported value

### Mark source interface

- [ ] `MarkSource` port: `fetchMark(instrument): Promise<Result<Price, MarkError>>`
- [ ] Implementations: `LastFillMarkSource` (from fills table), `OracleMarkSource` (external API)
- [ ] Selection logic: use last fill if recent (< configurable staleness threshold); fall back to oracle

---

## 4. Unified Lifecycle Validation (§9)

- [ ] Integration test: same strategy runs on both venue types (orderbook + swap)
- [ ] Verify: both produce identical journal event shapes (same `type` field taxonomy)
- [ ] Verify: both produce position records with same schema (side, size, entryPrice, realizedPnl)
- [ ] Verify: both produce fill records with same schema
- [ ] Verify: reconciliation works for both venue types (drift detection, event persistence)
- [ ] Verify: shadow mode works for both venue types (heuristic fills from market data)

---

## Exit Criteria (Batch 2c)

- [ ] Public stream pool connects to venue WS, fans out tickers/trades to subscribed actors
- [ ] Shadow executor uses stream pool for real-time fill heuristics (replaces polling)
- [ ] Second venue type (swap) produces same observability shape as orderbook venue
- [ ] Swap positions have canonical mark source recorded and used for P&L/risk
- [ ] Reconciliation detects drift for both orderbook and swap venues
- [ ] Unified lifecycle validated: integration test passes with both venue types
- [ ] All existing tests pass (`pnpm test`)

---

## Configuration additions

```yaml
# config/default.yaml (additions)
streams:
  public:
    reconnectBaseMs: 1000
    reconnectMaxMs: 30000
    maxReconnectAttempts: 20
    depthLevels: 5             # orderbook depth levels to track

venues:
  jupiter:                     # example swap venue (TBD)
    baseUrl: https://quote-api.jup.ag/v6
    timeoutMs: 15000

marking:
  stalenessThresholdMs: 300000   # 5 min — use oracle if last fill older than this
  oracleBaseUrl: https://api.coingecko.com/api/v3
```

```typescript
// packages/domain/src/config/schema.ts (additions)
export const PublicStreamConfigSchema = z.object({
  reconnectBaseMs: z.number().min(100).default(1_000),
  reconnectMaxMs: z.number().min(1000).default(30_000),
  maxReconnectAttempts: z.number().min(1).default(20),
  depthLevels: z.number().min(1).max(50).default(5),
});

export const MarkingConfigSchema = z.object({
  stalenessThresholdMs: z.number().min(10_000).default(300_000),
  oracleBaseUrl: z.string().url().optional(),
});
```

---

## Backlog (deferred from Phase 2 scope)

Items acknowledged but explicitly deferred beyond Phase 2c:

- [ ] Auto-correction thresholds for reconciliation drift (configurable per venue)
- [ ] WebSocket keepalive and health monitoring for private streams (basic reconnect exists; advanced monitoring deferred)
- [ ] Strategy cold-start: fetch enough candle history to recompute indicators on rehydration
- [ ] Queue-position simulation for resting limit orders (Phase 3+ per §14.1)
- [ ] Pessimistic fill modeling — partial fills, latency, adverse selection (Phase 3+)
- [ ] Detailed book capture for replay (Phase 3+)
