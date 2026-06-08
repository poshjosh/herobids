# Phase 2a: Foundations (Port Expansion + Reconciliation Core)

**Goal:** Expand venue ports with the methods Phase 2 features depend on; build the reconciliation module and persistence. This batch has no external runtime dependencies (no WebSocket connections, no swap chain) — it is purely structural.

**Parent:** [006-phase-2-plan.md](006-phase-2-plan.md) §1, §4, §8

---

## 1. Venue Port Expansion (§8)

Sections §1–§4 (reconciliation, crash recovery) require venue capabilities beyond the current `OrderbookVenuePort` and `SwapVenuePort` surfaces. These must be added before the features that depend on them.

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

### Hyperliquid adapter implementation

- [ ] Implement `fetchOpenOrders` — via `ccxt.fetchOpenOrders()`
- [ ] Implement `fetchRecentFills` — via `ccxt.fetchMyTrades()`
- [ ] Stub `subscribePrivate` — return `err({ code: 'venue.not_implemented' })` (real WS implementation in [Phase 2b](007-phase-2b-plan.md) §3)
- [ ] Stub `subscribePublic` — return `err({ code: 'venue.not_implemented' })` (real WS implementation in [Phase 2c](008-phase-2c-plan.md) §1)

**Note on subscription phasing:** The port signatures for `subscribePrivate` and `subscribePublic` are defined here so downstream code can type-check against them. The real WebSocket implementations are delivered in separate batches because they have distinct runtime dependencies:
- Private streams (authenticated, per-actor) → Phase 2b
- Public streams (shared pool, fan-out) → Phase 2c

---

## 2. Reconciliation Module (§1)

Build `packages/engine/src/reconciliation/` — periodic venue-state comparison that detects and resolves drift. This is a **direct implementation** (not a plugin interface — per §21.2, plugin interfaces exist only for venues and strategies).

### Core reconcile function

- [ ] `reconcile(localState, venueState)` — pure comparison function
  - Accepts local positions, balances, recent fills, open orders
  - Accepts venue positions, balances, recent fills, open orders
  - Returns a `ReconciliationResult`: `{ status: 'match' | 'drift_detected', diffs: Diff[] }`
- [ ] Diff types: `position_mismatch`, `balance_mismatch`, `unknown_fill`, `orphaned_order`

### Periodic reconciler loop

- [ ] `Reconciler` class with configurable interval (default 30s for orderbook venues)
- [ ] Fetches venue state via expanded port methods (§1 above)
- [ ] Compares against local sources:
  - **Positions:** `positions` table (open positions for this instance)
  - **Balances:** `balance_snapshots` table (latest snapshot for this venue account)
  - **Recent fills:** `fills` table (fills since last reconciliation cursor)
  - **Open orders:** `orders` table (orders in non-terminal state for this instance)
- [ ] Drift handling: log + emit journal event for Phase 2a; auto-correct deferred to backlog
- [ ] Reconciliation for swap venues: confirm on-chain balance matches expected post-swap state (deferred to Phase 2c for real implementation)

---

## 3. Reconciliation Persistence (§1 + §9.2)

The design doc (§9.2) specifies a dedicated `reconciliation_events` table alongside the journal. Both must be written.

### Database schema

- [ ] Add `reconciliation_events` table: `id`, `trading_instance_id`, `venue_account_id`, `result` (match | drift_detected | repaired), `local_state` (jsonb), `venue_state` (jsonb), `diff` (jsonb), `created_at`
- [ ] Add `last_reconciled_at` column to `venue_accounts` table
- [ ] Generate migration via `drizzle-kit generate`

### Repository

- [ ] `ReconciliationEventRepository`: `insert(event)`, `getByInstance(instanceId, opts)`, `getByVenueAccount(venueAccountId, opts)`
- [ ] Each reconciliation pass writes to both `reconciliation_events` (structured, queryable) and `journal_events` (audit log)

### API endpoint

- [ ] `GET /instances/:id/reconciliation-events` — query recent reconciliation results (pagination, time range filter)

---

## 4. Reconciliation Cursor (§4)

- [ ] Store `last_reconciled_at` on `venue_accounts` after each successful reconciliation pass
- [ ] On actor start: read cursor, run immediate reconciliation from that point forward
- [ ] Ensures no gap in reconciliation coverage between worker death and recovery

---

## Exit Criteria (Batch 2a)

- [ ] `OrderbookVenuePort` and `SwapVenuePort` have expanded method signatures
- [ ] `HyperliquidAdapter` implements `fetchOpenOrders` and `fetchRecentFills` (real calls via ccxt)
- [ ] `reconcile()` pure function detects injected drift in unit tests
- [ ] `Reconciler` loop runs periodically and writes to `reconciliation_events` + `journal_events`
- [ ] `last_reconciled_at` cursor persisted and read on startup
- [ ] API endpoint returns reconciliation history
- [ ] All existing tests pass (`pnpm test`)

---

## Configuration additions

```yaml
# config/default.yaml (additions)
reconciliation:
  intervalMs: 30000          # reconciliation loop interval
  driftAlertOnly: true       # true = log+alert only; false = auto-correct (future)
```

```typescript
// packages/domain/src/config/schema.ts (additions)
export const ReconciliationConfigSchema = z.object({
  intervalMs: z.number().min(5000).default(30_000),
  driftAlertOnly: z.boolean().default(true),
});
```
