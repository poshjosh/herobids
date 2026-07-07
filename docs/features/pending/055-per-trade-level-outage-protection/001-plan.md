# Per-Trade Level Outage Protection

**Created:** 2026-07-07
**Status:** pending
**Depends on:** [Per-Trade Stop-Loss and Take-Profit](../../2026/07/06/010-per-trade-stoploss-takeprofit/001-plan.md)

## Problem

The [per-trade stop-loss/take-profit feature](../../2026/07/06/010-per-trade-stoploss-takeprofit/001-plan.md) protects open positions via an in-process periodic monitor loop. That loop is started when the agent actor starts, and cleared when the actor stops. This creates a protection gap:

| Scenario | Protected? | Why |
|---|---|---|
| LLM budget exhausted (loop stops, worker alive) | ✓ | Monitor timer keeps firing |
| Agent paused via API (actor stays alive) | ✓ | Monitor timer keeps firing |
| Agent stopped via API | ✗ | Actor stops, monitor cleared |
| Worker process crashes | ✗ | No process to run the timer |
| Worker restarts after crash | ✓ | Levels rehydrated from `positions.stop_loss/take_profit`, monitor resumes |

The goal stated in the original plan — protection "even if the agent becomes incapacitated (crash, LLM budget exhausted, paused, stopped)" — is not met for the **stopped** and **crash** cases.

## What We Aim For

Per-trade stop-loss and take-profit levels should fire even when the worker process is completely dead or the agent actor has been explicitly stopped. A position set with `stopLoss=90000` at entry should be exited at that level regardless of the operator's infrastructure state.

## Options

### Option A — Tighten documentation (no code, done)

Accept the current in-process limitation and update the plan goal text to accurately reflect the protection scope. Already applied — see the "Known limitation" note in [001-plan.md](../../2026/07/06/010-per-trade-stoploss-takeprofit/001-plan.md).

**Pros:** Zero complexity. Accurate expectations.  
**Cons:** Positions are unprotected during outages. The "incapacitated agent" protection claim is weakened.

---

### Option B — Venue-native stop orders

When per-trade levels are set on a decision, place real conditional trigger orders at the venue alongside the market order. The venue's matching engine fires the exit independently of whether the worker is running.

- **Hyperliquid** — supports trigger orders natively (`tpsl` order type)
- **Jupiter / dex** — no native stops; requires an on-chain keeper or a sentinel service

On `submit_decision` with levels:
1. Execute the entry order as today
2. After a successful fill, place a trigger order (stop-limit or stop-market) at the specified level
3. Store the venue order ID alongside the position row (`positions.stopOrderId`)
4. On level update (agent submits new levels): cancel + replace the trigger order
5. On position close: cancel the trigger order if still open

**Pros:** True crash-proof protection. Zero dependency on worker uptime.  
**Cons:** High complexity. Requires per-venue implementation (Hyperliquid, Jupiter, Bybit each differ). Must handle partial fills, order rejection, and stale order cleanup. Jupiter has no native support. Increases fee surface (additional order).

---

### Option C — Separate always-on monitor service (recommended)

Extract the per-trade level check into a dedicated worker loop that runs outside the agent actor lifecycle. On every tick it:
1. Queries all open positions with non-null `stop_loss` or `take_profit` (already stored on `positions` table since migration 0035)
2. Fetches current mark prices from the venue or Redis price cache
3. Submits a `go_flat` decision if any level is breached

This loop runs even when individual agents are stopped. It is only unavailable during a full worker crash — same as today — but positions are not unprotected just because an agent was explicitly stopped.

**Key properties:**
- No venue integration required
- Survives agent stop/restart (decoupled from actor lifecycle)
- Reasonably bounded complexity: one interval query, price lookup, decision submission
- Uses existing infrastructure: `positions` table, existing `go_flat` intake path, Redis price cache
- Natural home: `apps/worker/src/` as a top-level service, started alongside the stream pool

**Pros:** Significantly stronger protection than today. Moderate complexity. No venue coupling.  
**Cons:** A full worker crash still creates a gap (until restart). Does not eliminate the need for venue-native orders if true zero-downtime protection is required.

---

## Recommendation

**Implement Option C now; implement Option B later.**

Option C closes the most common gap (agent explicitly stopped, no active LLM budget, maintenance restarts) with contained scope. It fits naturally into the existing architecture: the positions table already carries `stop_loss`/`take_profit`, mark prices are available via the stream pool and Redis, and the `go_flat` decision path is already battle-tested.

Option B (venue-native) is the correct long-term solution for true zero-downtime guarantees, but its complexity is proportional to the number of supported venues and should be tackled as a separate feature when the venue integration layer is mature enough to absorb it.

## Implementation Sketch (Option C)

### New: `PositionLevelGuard` service (`apps/worker/src/position-level-guard.ts`)

```ts
export class PositionLevelGuard {
  private interval?: ReturnType<typeof setInterval>;

  constructor(private readonly deps: {
    positionRepo: PositionRepository;
    markSource: MarkPriceSource;       // existing venue ticker / Redis cache abstraction
    publishGoFlat: (agentId: string, venueAccountId: string, instrumentId: string, metadata: Record<string, unknown>) => Promise<void>;
    intervalMs: number;
    logger: Logger;
  }) {}

  start(): void {
    this.interval = setInterval(() => void this.tick(), this.deps.intervalMs);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
  }

  private async tick(): Promise<void> {
    const positions = await this.deps.positionRepo.getOpenWithExitLevels(); // new query
    for (const pos of positions) {
      const mark = await this.deps.markSource.getPrice(pos.instrumentId, pos.venueAccountId);
      if (!mark) continue;
      const triggered = checkTrigger(pos, mark);  // reuses checkPerTradeLevels logic
      if (triggered) {
        await this.deps.publishGoFlat(pos.actorId, pos.venueAccountId, pos.instrumentId, {
          trigger: triggered,
          source: 'position_level_guard',
        });
      }
    }
  }
}
```

### DB change

Add a query `PositionRepository.getOpenWithExitLevels()` that returns all open positions where `stop_loss IS NOT NULL OR take_profit IS NOT NULL`.

### Lifecycle

Started in `apps/worker/src/index.ts` alongside the stream pool. Stopped in the graceful shutdown handler. The actor-level per-trade monitor remains for low-latency checks during active agent sessions; the `PositionLevelGuard` provides the backstop when actors are inactive.

### Deduplication

Both the actor monitor and the guard may fire concurrently for an active agent. The existing `exitingInstruments` set in `AgentTradingActor` prevents double execution for the actor path. The guard submits via the normal decision intake path, which handles idempotency at the risk gate level.
