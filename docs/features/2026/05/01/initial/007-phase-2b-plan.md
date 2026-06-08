# Phase 2b: Shadow Executor + Crash Recovery

**Goal:** Shadow execution mode (validate strategy decisions against real market conditions without capital risk) and the full crash-recovery contract (venue-state confirmation + private streams before resuming trading).

**Parent:** [006-phase-2-plan.md](006-phase-2-plan.md) §2, §3, §6

**Depends on:** [006-phase-2a-plan.md](006-phase-2a-plan.md) — expanded venue ports, reconciliation module, and reconciliation persistence must be in place.

---

## 1. Shadow Executor (§6)

Real quotes from venue, simulated fills. Validates strategy decisions against real market conditions without capital risk. Per §14.1, Phase 2 shadow does **not** model queue position or pessimistic fills — those are deferred to Phase 3+.

### Implementation

- [ ] `ShadowExecutor` class in `packages/engine/src/shadow-executor.ts` implementing `Executor` interface
- [ ] Accepts a market-data source (ticker/orderbook/trade stream) as a dependency
- [ ] **Market orders (orderbook):** Immediate fill at best bid/ask from live ticker. No latency modeling.
- [ ] **Limit orders (orderbook):** Heuristic fill — fill if trade stream shows a print at or through the limit price. No queue-position simulation.
- [ ] **Swaps:** Fill at the quoted output amount from a real `quote()` call (no execution).
- [ ] Produces the same `Fill` records, journal entries, and position updates as paper/live
- [ ] Configuration: `execution.mode: 'shadow'` in trading instance config

### Shadow market-data dependency

- [ ] Shadow executor requires live price data to determine fill prices
- [ ] Minimal dependency: a `MarketDataFeed` interface with `getTicker(symbol)` and `onTrade(symbol, handler)`
- [ ] For Phase 2b: implement via polling (`fetchTicker` on the venue port at a configurable interval)
- [ ] Full streaming implementation (WebSocket fan-out) delivered in [Phase 2c](008-phase-2c-plan.md) §1, which upgrades this polling feed to the public stream pool

**Deviation from parent plan:** The parent (006-phase-2-plan.md §6) specifies that shadow uses the public stream pool (§5). This batch introduces polling as an intermediate step because the public stream pool does not yet exist — it is built in Phase 2c. The `MarketDataFeed` interface is designed so the shadow executor is unaware of the backing implementation; the upgrade in 2c is a swap of the injected dependency, not a rewrite.

### Documented limitations

- [ ] Shadow answers "did the strategy make reasonable decisions?" — not "would limit orders have filled at this exact price?"
- [ ] No queue-position simulation for resting limit orders (Phase 3+)
- [ ] No pessimistic fill modeling — partial fills, latency, adverse selection (Phase 3+)
- [ ] No detailed book capture for replay (Phase 3+)

---

## 2. Crash Recovery — Venue-State Reconciliation on Restart (§2)

Complete the §3.5 rehydration contract. Currently: DB-state reconciliation (incomplete plans, position rebuild). Missing: venue-state confirmation before resuming.

- [ ] On actor start (after DB rehydration): query venue for current positions/orders via expanded port methods
- [ ] Compare venue state to local DB state using `reconcile()` function (from Phase 2a)
- [ ] Emit reconciliation event to both `reconciliation_events` and `journal_events`
- [ ] If drift detected: block scan loop, log discrepancy, apply correction if within threshold
- [ ] **Invariant enforced:** No trading until venue-state reconciliation pass confirms local == venue (or drift is within acceptable threshold)
- [ ] Incomplete execution plans: query venue for actual order/fill status (not just mark-as-failed)
  - Upgrade existing `reconcileIncompletePlans()` in `TradingActor` to query venue when in live/shadow mode
  - Paper mode retains current behavior (mark as failed)

---

## 3. Crash Recovery — Private Stream Re-establishment (§3)

This batch delivers the real `subscribePrivate` implementation (stubbed in Phase 2a). Public streams (`subscribePublic`) are delivered in [Phase 2c](008-phase-2c-plan.md) §1.

- [ ] On actor start: open authenticated WebSocket to venue account (from `venue_accounts` record)
- [ ] Subscribe to private fill/order streams for real-time state updates
- [ ] Use `ws` library directly (not ccxt pro) — architecturally pure, self-contained per adapter
- [ ] Implement real `subscribePrivate` on `HyperliquidAdapter` (replaces the stub from Phase 2a)
- [ ] Handle reconnection (exponential backoff with jitter, re-subscribe on disconnect)
- [ ] Configurable max reconnection attempts before giving up and stopping the actor
- [ ] Graceful shutdown: close WebSocket on actor stop
- [ ] On fill/order events from stream: update local state + emit journal entries

### Integration with TradingActor

- [ ] Actor lifecycle: `start()` → rehydrate → venue-state reconciliation → open private stream → begin scan loop
- [ ] If private stream disconnects during operation: pause scan loop, attempt reconnect, resume on success
- [ ] If reconnection fails after max attempts: stop actor, mark instance as `crashed`

---

## 4. Executor Selection

- [ ] `TradingActor` selects executor based on `execution.mode` config:
  - `'paper'` → `PaperExecutor` (existing)
  - `'shadow'` → `ShadowExecutor` (new)
  - `'live'` → `LiveExecutor` (future — not in scope)
- [ ] Executor selection happens at actor construction time (not per-tick)

---

## Exit Criteria (Batch 2b)

- [ ] `ShadowExecutor` produces fills from live ticker data (market orders fill at bid/ask)
- [ ] Shadow mode limit-order heuristic: fill recorded when trade stream shows a print through the price
- [ ] Worker crash recovery: venue-state reconciliation confirms local == venue before resuming
- [ ] Incomplete plans in live/shadow mode: venue queried for actual order status
- [ ] Private stream opens on actor start, reconnects on disconnect with exponential backoff
- [ ] Actor lifecycle enforces: no trading until reconciliation + stream ready
- [ ] All existing tests pass (`pnpm test`)

---

## Configuration additions

```yaml
# config/default.yaml (additions)
streams:
  private:
    reconnectBaseMs: 1000          # initial backoff for reconnection
    reconnectMaxMs: 30000          # max backoff cap
    maxReconnectAttempts: 10       # give up after N failures
```

```typescript
// packages/domain/src/config/schema.ts (additions)
export const StreamConfigSchema = z.object({
  private: z.object({
    reconnectBaseMs: z.number().min(100).default(1_000),
    reconnectMaxMs: z.number().min(1000).default(30_000),
    maxReconnectAttempts: z.number().min(1).default(10),
  }),
});
```
