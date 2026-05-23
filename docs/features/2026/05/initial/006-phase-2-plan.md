# Phase 2: Reconciliation + Shadow + Second Venue

**Goal:** Validate reconciliation, shadow execution, and multi-venue generalization. Completes the crash-safety contract from §3.5 and proves the architecture handles both venue types. Live rollout remains Phase 4.

**Scope note:** 003-design-decisions.md §10.1 labels agents as "Phase 2" and the summary table (§21) repeats this. However, the §20 build-phase roadmap defines Phase 2 as "Reconciliation + Shadow + Second Venue" with no agent work. This plan follows the §20 roadmap. Agents (container-isolated AI actors) are deferred to a separate phase after reconciliation and shadow mode are proven. The §10.1/§21 labels should be read as "after Phase 1" rather than "part of this plan."

**Reference:** [003-design-decisions.md §Phase 2](003-design-decisions.md), [003-design-decisions.md §3.5](003-design-decisions.md), [003-design-decisions.md §5](003-design-decisions.md), [003-design-decisions.md §8.4](003-design-decisions.md), [003-design-decisions.md §10.3](003-design-decisions.md), [003-design-decisions.md §14.1](003-design-decisions.md)

---

## 1. Reconciliation Module

Build `packages/engine/src/reconciliation/` — periodic venue-state comparison that detects and resolves drift. This is a **direct implementation** (not a plugin interface — per §21.2, plugin interfaces exist only for venues and strategies).

- [ ] `reconcile(localState, venueState)` function in `packages/engine/src/reconciliation/`
- [ ] Periodic reconciler loop (configurable interval, default 30–60s for orderbook venues)
- [ ] Fetch venue state: positions, balances, recent fills, open orders via venue port
- [ ] Compare against local sources:
  - **Positions:** `positions` table (open positions for this instance)
  - **Balances:** `balance_snapshots` table (latest snapshot for this venue account)
  - **Recent fills:** `fills` table (fills since last reconciliation cursor)
  - **Open orders:** `orders` table (orders in non-terminal state for this instance)
- [ ] Drift handling: log + alert for Phase 2; auto-correct within configured thresholds deferred to later
- [ ] Reconciliation for swap venues: confirm on-chain balance matches expected post-swap state

### Reconciliation persistence

The design doc (§9.2) specifies a dedicated `reconciliation_events` table alongside the journal. Both must be written.

- [ ] Add `reconciliation_events` table (migration): id, trading_instance_id, venue_account_id, result (match/drift_detected/repaired), local_state (jsonb), venue_state (jsonb), diff (jsonb), created_at
- [ ] `ReconciliationEventRepository`: insert, query by instance/time range
- [ ] Each reconciliation pass writes to both `reconciliation_events` (structured, queryable) and `journal_events` (audit log)
- [ ] API endpoint: GET /instances/:id/reconciliation-events (query recent results)

## 2. Crash Recovery — Venue-State Reconciliation on Restart

Complete the §3.5 rehydration contract. Currently: DB-state reconciliation (incomplete plans, position rebuild). Missing: venue-state confirmation before resuming.

- [ ] On actor start (after DB rehydration): query venue for current positions/orders
- [ ] Compare venue state to local DB state; emit reconciliation event
- [ ] If drift detected: block scan loop, log discrepancy, apply correction if within threshold
- [ ] **Invariant enforced:** No trading until venue-state reconciliation pass confirms local == venue
- [ ] Incomplete execution plans: query venue for actual order/fill status (not just mark-as-failed)

## 3. Crash Recovery — Private Stream Re-establishment

- [ ] On actor start: open authenticated WebSocket to venue account (from `venue_accounts` record)
- [ ] Subscribe to private fill/order streams for real-time state updates
- [ ] Handle reconnection (exponential backoff, re-subscribe on disconnect)
- [ ] Graceful shutdown: close WebSocket on actor stop

## 4. Crash Recovery — Reconciliation Cursor

- [ ] Add `last_reconciled_at` column to `venue_accounts` table (migration)
- [ ] Store cursor after each successful reconciliation pass
- [ ] On actor start: read cursor, run immediate reconciliation from that point forward
- [ ] Ensures no gap in reconciliation coverage between worker death and recovery

## 5. Public Market-Data Streams

Shadow mode and reconciliation both depend on live market data. Per §10.3, public streams are shared via a connection pool.

- [ ] Public stream connection pool: one WebSocket per venue per worker, fan-out to interested actors
- [ ] Keyed by venue (not by trading instance) — pure optimization, no privacy concern
- [ ] Streams: ticker, orderbook depth, trade prints (needed for shadow limit-order heuristic)
- [ ] Reconnection handling (exponential backoff, re-subscribe on disconnect)
- [ ] Graceful shutdown: close all venue connections when worker stops
- [ ] Actors subscribe/unsubscribe on start/stop

## 6. Shadow Executor

Real quotes from venue, simulated fills. Validates strategy decisions against real market conditions without capital risk. Per §14.1, Phase 2 shadow does **not** model queue position or pessimistic fills — those are deferred to Phase 3+.

- [ ] `ShadowExecutor` implementing executor interface
- [ ] Uses live market data from public stream pool (§5 above)
- [ ] **Market orders (orderbook):** Immediate fill at best bid/ask from live orderbook snapshot. No latency modeling.
- [ ] **Limit orders (orderbook):** Heuristic fill — fill if venue trade stream shows a print at or through the limit price. No queue-position simulation.
- [ ] **Swaps:** Fill at the quoted output amount from a real `quote()` call.
- [ ] Produces the same `Fill` records, journal entries, and position updates as paper/live
- [ ] Configuration: `execution.mode: 'shadow'` in trading instance config
- [ ] Document limitation: shadow answers "did the strategy make reasonable decisions?" — not "would limit orders have filled at this exact price?"

**Explicitly deferred (Phase 3+):**
- Queue-position simulation for resting limit orders
- Pessimistic fill modeling (partial fills, latency, adverse selection)
- Detailed book capture for replay

## 7. Second Venue Type (Swap)

Add a swap venue adapter (e.g. Jupiter/Solana) proving the architecture handles both orderbook and swap venue types.

- [ ] Implement `SwapVenuePort` adapter (chain-specific: Jupiter, Uniswap, or similar)
- [ ] `quote(SwapQuoteRequest) → execute(SwapQuote)` interface
- [ ] Unified execution lifecycle: swap fast-paths through `submitted → filled`
- [ ] Same `Fill` record shape, journal entries, position model as orderbook venue
- [ ] Plan/routing layer handles venue-type dispatch (orderbook vs swap)
- [ ] Reconciliation for swap venue: on-chain balance confirmation

### Swap valuation policy (§8.4)

Swap P&L, risk checks, and reconciliation require a canonical mark that is not the volatile executable quote.

- [ ] Mark source: last fill price for positions with recent fills; reference oracle price (CoinGecko/Coinbase spot) for stale positions
- [ ] Marking source configured per instrument, recorded on each `balance_snapshot` and `position` record
- [ ] Risk gate uses reference mark (stable, auditable); execution uses executable quote (size-accurate, transient)
- [ ] Paper/shadow/live use the same marking source — no mode-specific P&L divergence
- [ ] Reconciliation compares local mark against venue-reported value

## 8. Venue Port Expansion

Sections 1–4 (reconciliation, crash recovery) and 5–6 (streams, shadow) require venue capabilities beyond the current `OrderbookVenuePort` and `SwapVenuePort` surfaces. These must be added before the features that depend on them.

### OrderbookVenuePort additions

- [ ] `fetchOpenOrders(): Promise<Result<Order[], VenueError>>` — needed for reconciliation (compare local open orders vs venue)
- [ ] `fetchRecentFills(since?: Date): Promise<Result<Fill[], VenueError>>` — needed for reconciliation (detect unrecorded fills)
- [ ] `subscribePrivate(handlers): Promise<Result<Subscription, VenueError>>` — authenticated WS for fills/orders/positions
- [ ] `subscribePublic(symbols, handlers): Promise<Result<Subscription, VenueError>>` — shared ticker/orderbook/trade stream

### SwapVenuePort additions

- [ ] `fetchBalance(token): Promise<Result<TokenBalance, VenueError>>` — on-chain balance check for reconciliation
- [ ] `fetchRecentTransactions(since?: Date): Promise<Result<Transaction[], VenueError>>` — detect unrecorded swaps

### Subscription type

- [ ] `Subscription` handle with `unsubscribe()` and connection-state events
- [ ] Reconnection is the caller's responsibility (actors manage their own lifecycle)

## 9. Unified Lifecycle Validation

- [ ] Integration test: same strategy runs on both venue types
- [ ] Verify: both produce identical journal event shapes, position records, fill records
- [ ] Verify: reconciliation works for both venue types
- [ ] Verify: shadow mode works for both venue types

---

## Exit Criteria

- [ ] Reconciliation module detects injected drift (test: mutate local state, confirm detection)
- [ ] Shadow mode validates strategy decisions against real market conditions (heuristic fills, no real capital)
- [ ] Worker crash recovery: venue-state reconciliation confirms local == venue before resuming
- [ ] Second venue type (swap) produces same observability shape as orderbook venue
- [ ] Swap positions have canonical mark source recorded and used for P&L/risk
- [ ] Unified lifecycle validated across both venue types

---

## Backlog (Phase 2 scope — deferred but near-term)

Items from the design doc that should be addressed during or immediately after Phase 2:

- [ ] Auto-correction thresholds for reconciliation drift (configurable per venue)
- [ ] WebSocket keepalive and health monitoring for private streams
- [ ] Strategy cold-start: fetch enough candle history to recompute indicators on rehydration
- [ ] Queue-position simulation for resting limit orders (Phase 3+ per §14.1)
- [ ] Pessimistic fill modeling — partial fills, latency, adverse selection (Phase 3+)
- [ ] Detailed book capture for replay (Phase 3+)
