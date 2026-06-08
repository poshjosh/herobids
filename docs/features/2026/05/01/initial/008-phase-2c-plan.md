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
- [ ] ~~Reconciliation compares local mark against venue-reported value~~ — **deferred**: balance snapshots span multiple assets without a single canonical mark; position-level marks are recorded via `positionRepo.upsert({ markSource })` but reconciliation-side comparison requires venue-reported mark values that swap/perp venues don't expose uniformly. See Backlog.

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

## Implementation Decisions (2026-05-25)

The contemplation pass against the current codebase resolved several tensions between the plan's literal text and the architecture already in place.

### Resolved decisions

- `HyperliquidAdapter.subscribePublic()` remains a thin stub in `packages/venues/src/hyperliquid.ts`.
  - The worker-scoped `PublicStreamPool` in `packages/venues/src/stream-pool.ts` is the real public-stream implementation.
  - Do **not** inject the pool into the adapter in this batch; that would blur ownership between account-scoped venue adapters and worker-scoped shared infrastructure.
- Swap reconciliation stays balance-based in `packages/engine/src/reconciliation/venue-state-loaders.ts`.
  - Do **not** call `fetchRecentTransactions()` for canonical reconciliation in this batch.
  - BUG-011 established that mapping wallet transactions to fill-like records causes false unknown-fill diffs in shadow mode.
- The §4 unified lifecycle test remains required for Phase 2c exit criteria, but it should be implemented by the `Tester`/`UnitTester` workflow, not by the `Implementer` agent.

### Remaining open design dependency

- Swap orders should carry explicit swap execution parameters, but the codebase does not yet define where canonical swap asset IDs come from.
  - Current shadow execution derives assets from `plan.symbol` in `packages/engine/src/shadow-executor.ts`.
  - `SwapVenuePort` and `JupiterSwapAdapter` expect exact asset identifiers (`inputAsset`, `outputAsset`), not display symbols.
  - Before implementing swap params, extend trading-instance config with canonical swap asset IDs and thread them into planner dependencies.

---

## Concrete Execution Plan (remaining Phase 2c work)

### 1. Persist balance snapshots during reconciliation

**What to change**

- Modify `packages/db/src/repositories.ts`
  - Add `BalanceSnapshotRepository.insertSnapshot()`.
  - Accept `venueAccountId`, `venue`, serialized balances, optional `markSource`, and `snapshotAt`.
- Modify `apps/worker/src/trading-actor.ts`
  - Update `startReconciler()` -> `persistResult()` to write a balance snapshot from `venueState.balances` after a successful reconciliation pass.
  - Keep `loadLocalState()` reading from the latest persisted snapshot.

**Dependencies**

- None. This is the cleanest missing persistence gap and should go first.

**Risk / open question**

- `balance_snapshots.mark_source` is a single string while the snapshot contains multiple assets.
- For this batch, do not block snapshot writes on richer provenance modeling. Persist the snapshot and leave `markSource` null unless an account-level source is unambiguous.

### 2. Use reference marks in the risk gate without making the gate stateful

**What to change**

- Modify `packages/engine/src/risk-gate.ts`
  - Extend `RiskSnapshot` (or equivalent risk input) with `referenceMark?: Price`.
  - Use the reference mark for notional-based checks (`maxOrderNotional`, `maxPositionSizePct`) when present.
  - Keep `checkRisk()` pure; do not inject `MarkSource` into the engine layer.
- Modify `apps/worker/src/trading-actor.ts`
  - In `tick()`, fetch the mark before the risk check and pass the value into `checkRisk()`.
  - Continue using execution-time prices/quotes for the executor itself.

**Dependencies**

- Independent of step 1.

**Risk / open question**

- Decide fail-closed behavior when notional limits are configured but `referenceMark` is unavailable.
  - Preferred behavior: reject when a configured notional check cannot be evaluated safely.

### 3. Add explicit swap planning params backed by canonical asset IDs

**What to change**

- Modify `packages/domain/src/config/schema.ts`
  - Extend `TradingInstanceConfigSchema` with swap-specific asset identifiers (for example, a `swapAssets` block carrying canonical base/quote or input/output IDs).
- Modify `apps/worker/src/index.ts`
  - Parse the new swap config fields and pass them into `TradingActorDeps`.
- Modify `apps/worker/src/trading-actor.ts`
  - Extend `PlannerDeps` passed into `planDecision()` so swap planners receive canonical asset IDs.
- Modify `packages/engine/src/planner.ts`
  - Extend `PlannedOrder` with explicit swap params, preferably as a discriminated union or a dedicated `swapParams` field.
  - Emit swap params for `venueType === 'swap'` instead of relying on downstream symbol parsing.
- Modify `packages/engine/src/shadow-executor.ts`
  - Consume `planned.swapParams` directly.
  - Remove or reduce `resolveSwapAssets()` fallback logic once planner-supplied params are available.

**Dependencies**

- Depends on deciding and encoding the swap asset ID source in instance config.
- Should happen after step 2 so risk and persistence gaps are closed before the larger type-threading change.

**Risk / open question**

- Current tests and sample data use symbols like `SOL/USDC`, while Jupiter expects mint addresses.
- Do not hide this mismatch behind ad hoc parsing in the executor. Solve it at the config/planning boundary.

### 4. Leave public-stream ownership and swap reconciliation semantics unchanged

**What to change**

- No production code changes required for:
  - `packages/venues/src/hyperliquid.ts` -> `subscribePublic()` ownership
  - `packages/engine/src/reconciliation/venue-state-loaders.ts` -> transaction-free swap reconciliation

**Dependencies**

- None.

**Risk / open question**

- Future consumers may still want a public-stream abstraction at the venue interface level.
- If that becomes necessary, solve it with a separate public-stream capability abstraction rather than by coupling the adapter to the worker pool.

### 5. Validate unified lifecycle behavior in the testing workflow

**What to change**

- Extend existing worker-level integration-style coverage in `apps/worker/src/trading-actor.test.ts` or add an adjacent dedicated worker integration test file.
- Verify the same strategy path across orderbook and swap venues:
  - journal event taxonomy
  - fill record shape
  - position record shape
  - reconciliation persistence
  - shadow-mode execution path

**Dependencies**

- Depends on steps 1 through 3.
- Assigned to `Tester`/`UnitTester`, not `Implementer`.

**Risk / open question**

- This repo has no frontend, so no visual verification is required.
- Keep network dependencies mocked/deterministic for CI; the real Jupiter adapter remains the product deliverable, not the test transport.

---

## Test Strategy For Remaining Work

### Unit tests

- `packages/engine/src/risk-gate.test.ts`
  - Add cases proving risk notional checks use `referenceMark` instead of `order.price`.
  - Add fail-closed coverage when a configured notional check cannot be evaluated.
- `packages/engine/src/planner.test.ts`
  - Add swap-specific planner coverage asserting emitted `swapParams` shape.
- `packages/engine/src/shadow-executor.test.ts`
  - Add coverage that swap execution consumes planner-supplied swap params instead of deriving assets from the symbol string.
- `packages/db/src/repositories.ts`
  - Cover `BalanceSnapshotRepository.insertSnapshot()` at the repository level if the repo already has persistence tests nearby; otherwise cover via worker integration tests.

### Integration-style tests

- `apps/worker/src/trading-actor.test.ts`
  - Add assertions that reconciliation persists balance snapshots.
  - Add assertions that the actor passes reference marks into risk evaluation.
  - Add/extend the cross-venue lifecycle scenario required by §4.

### Visual verification

- None. This repository has no browser/UI surface.


## Backlog (deferred from Phase 2 scope)

Items acknowledged but explicitly deferred beyond Phase 2c:

- [ ] Auto-correction thresholds for reconciliation drift (configurable per venue)
- [ ] WebSocket keepalive and health monitoring for private streams (basic reconnect exists; advanced monitoring deferred)
- [ ] Strategy cold-start: fetch enough candle history to recompute indicators on rehydration
- [ ] Queue-position simulation for resting limit orders (Phase 3+ per §14.1)
- [ ] Pessimistic fill modeling — partial fills, latency, adverse selection (Phase 3+)
- [ ] Detailed book capture for replay (Phase 3+)
- [ ] Reconciliation-side mark comparison: compare local mark against venue-reported value during reconciliation passes. Deferred because balance snapshots span multiple assets (no single mark) and venues don't uniformly expose a comparable mark price for reconciliation. Position-level mark source is already recorded on `upsert()`.
