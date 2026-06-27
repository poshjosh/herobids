# Plan: Exit Policy — Scale-Out and Trail Remainder

**Status:** Proposed — not yet implemented  
**Date:** 2026-06-27  
**Prior art:** `aitradingbot/src/config/presets/*.ts` (preset structure only — never activated)

---

## Summary

Add a configurable exit policy to the strategy system that supports:
- **Scale-out:** Close a fraction of a position at predefined R-multiples (e.g.,
  "close 50% at 2R, let the rest run").
- **Trail remainder:** After the first scale-out, move the stop-loss to
  breakeven and trail it behind price for the remaining position.

This gives mechanical and hybrid strategies more sophisticated position
management than the current "all-in, all-out" model.

---

## Motivation

### Current State

Today, every position opened by a bot follows a binary exit path:
- Hit `takeProfitPct` → close 100%
- Hit `stopLossPct` → close 100%
- Signal lost → close 100%

There is no way to express "take partial profits and let the winner run." This
is a well-known weakness of rule-based systems and a key reason traders prefer
discretionary exits.

### Reference Implementation

The aitradingbot preset structure defines `exitPolicy` on every preset but
**never activates it**:

```typescript
// Every aitradingbot preset:
exitPolicy: { scaleOut: null, trailRemainder: false }
```

The field exists as a capability placeholder — the structure was designed, the
preset files allocate it, but no engine ever reads it. This plan proposes
making it real in Herobids.

---

## Architecture Impact

This feature touches four layers:

| Layer | Component | Change |
|---|---|---|
| **Domain** | `Decision` type | Add optional `closeFraction` field (0–1) to express partial closes |
| **Domain** | `MechanicalParamsSchema` | Add `exitPolicy` sub-schema |
| **Engine** | `MechanicalStrategy` | After entry, track R-multiple and emit partial-close decisions |
| **Worker** | `TradingActor` tick loop | Handle partial-close decisions: reduce position size, update stop |
| **Worker** | Position tracker | Track entry price, current stop, and R-multiple for open positions |

### Why This Is High-Effort

Unlike VWAP or price-action (which are pure scoring additions to an existing
function), exit policy requires **stateful position tracking across ticks**.
The current `MechanicalStrategy` is stateless — it evaluates each tick
independently and returns a decision. Exit policy requires the strategy to
remember "I opened at $100, I'm now at 1.5R, when I hit 2R I need to close 50%."

This statefulness creates ripple effects:
- `Decision` must carry partial-close intent
- `TradingActor` must understand partial closes
- Position tracker must handle fractional position sizes
- Stop-loss becomes dynamic (breakeven after first scale-out, then trailing)

---

## Design

### Phase 1 — Schema (`MechanicalParamsSchema`)

```typescript
export const ExitPolicySchema = z.object({
  // Scale-out plan: ordered list of R-multiple targets.
  // At each target, close `closeFraction` of the REMAINING position.
  // Example: [{ atR: 2, closeFraction: 0.5 }] = close 50% at 2R.
  scaleOut: z.array(z.object({
    atR: z.number().positive(),           // R-multiple target (e.g. 2 = 2R)
    closeFraction: z.number().min(0).max(1), // Fraction of remaining position to close
  })).max(3).nullable().default(null),     // Max 3 scale-out levels

  // After FIRST scale-out executes, move stop to breakeven and trail.
  trailRemainder: z.boolean().default(false),

  // Trail distance in R-multiples (only active after first scale-out).
  // e.g. 1.5 = maintain stop 1.5R behind current price.
  // If omitted, defaults to the original stopLossPct converted to R.
  trailDistanceR: z.number().positive().optional(),
}).default({});

// Add to MechanicalParamsSchema:
export const MechanicalParamsSchema = z.object({
  // ... existing fields ...
  exitPolicy: ExitPolicySchema,
});
```

### Phase 2 — Decision Model

Add optional partial-close metadata to `Decision`:

```typescript
// In packages/domain/src/... (Decision type)
export interface Decision {
  id: DecisionId;
  intent: 'go_long' | 'go_short' | 'go_flat';
  size: string;                    // Total size for go_long/go_short
  closeFraction?: number;          // 0–1 for partial go_flat (exit policy)
  exitPolicyState?: {
    entryPrice: number;            // Price at which position was opened
    currentStop: number;           // Current stop-loss price
    scaleOutLevel: number;         // Index of next scale-out target (0 = first)
    isTrailing: boolean;           // Whether stop is in trailing mode
  };
  metadata?: Record<string, unknown>;
}
```

`closeFraction` is the key addition. When `intent === 'go_flat'` and
`closeFraction === 0.5`, the trading actor closes 50% of the position instead
of 100%.

`exitPolicyState` is carried on `go_long`/`go_short` decisions to initialize
the position tracker with the entry conditions. It is irrelevant on `go_flat`.

### Phase 3 — MechanicalStrategy Statefulness

The strategy must become stateful for exit policy to work. Two options:

#### Option A: Strategy-internal state (self-contained)

```typescript
export class MechanicalStrategy implements Strategy {
  // Per-symbol state map: symbol → exit policy state
  private exitState = new Map<string, {
    entryPrice: number;
    scaleOutLevel: number;
    isTrailing: boolean;
    currentStop: number;
  }>();

  async evaluate(snapshot, rawConfig): Promise<Result<Decision | null, StrategyError>> {
    // ... existing scoring ...

    const exitState = this.exitState.get(snapshot.symbol);

    if (exitState) {
      // Calculate current R-multiple
      const currentR = (snapshot.price - exitState.entryPrice) / (exitState.entryPrice * stopLossPct / 100);

      // Check scale-out targets
      const nextTarget = params.exitPolicy.scaleOut?.[exitState.scaleOutLevel];
      if (nextTarget && currentR >= nextTarget.atR) {
        // Emit partial close
        exitState.scaleOutLevel++;
        if (params.exitPolicy.trailRemainder) {
          exitState.isTrailing = true;
          exitState.currentStop = exitState.entryPrice; // Move to breakeven
        }
        return ok(makePartialCloseDecision(..., nextTarget.closeFraction, exitState));
      }

      // Trail stop if active
      if (exitState.isTrailing) {
        const trailDistance = exitState.entryPrice * stopLossPct * trailDistanceR / 100;
        const newStop = snapshot.price - trailDistance;
        if (newStop > exitState.currentStop) {
          exitState.currentStop = newStop;
        }
        // Check if stop hit
        if (snapshot.price <= exitState.currentStop) {
          this.exitState.delete(snapshot.symbol);
          return ok(makeDecision(..., 'go_flat', '0', { reason: 'trailing_stop' }));
        }
      }
    }

    // ... existing entry/exit logic ...
  }
}
```

**Pros:** Self-contained — no changes to `TradingActor` or position tracker.  
**Cons:** Strategy holds state — breaks the stateless design principle
(Decision 9 in `000-contemplations.md`). State lost on restart. Two sources
of truth (strategy state vs position tracker state).

#### Option B: Actor-managed state (recommended)

Keep `MechanicalStrategy` stateless. Move exit-policy state into the
`TradingActor` tick loop:

1. `MechanicalStrategy.evaluate()` returns a `Decision` with enriched
   `exitPolicyState` metadata on entry signals.
2. `TradingActor.tick()` stores this state in the position tracker (or actor
   memory).
3. On each tick, before calling `strategy.evaluate()`, the actor checks:
   - Is there an open position with exit policy active?
   - Has the current R-multiple crossed the next scale-out target?
   - Should the trailing stop be updated?
4. If yes, the actor emits the partial close directly — the strategy is not
   involved in exit-policy execution.

**Pros:** Keeps strategy stateless. Single source of truth (position tracker).
Survives restart (state in Postgres).  
**Cons:** More components to change. Exit policy logic lives in the actor, not
the strategy — less self-contained.

**Recommendation:** Option B. The strategy should produce entry signals with
exit policy intent. The actor should execute exit policy mechanically — it's
execution infrastructure, not strategy logic.

### Phase 4 — TradingActor Changes

```typescript
// In TradingActor.tick():
async tick(): Promise<void> {
  // 1. Check exit policy state BEFORE strategy evaluation
  const exitAction = this.checkExitPolicy();
  if (exitAction) {
    await this.executePartialClose(exitAction);
    return; // Don't evaluate strategy this tick — we're mid-scale-out
  }

  // 2. Evaluate strategy (existing flow)
  const snapshot = await this.buildSnapshot();
  const decision = await this.strategy.evaluate(snapshot, this.config);

  // 3. On entry: capture exit policy state
  if (decision.intent === 'go_long' && decision.exitPolicyState) {
    this.positionTracker.setExitPolicy(symbol, decision.exitPolicyState);
  }

  // 4. Execute (existing flow)
  await this.executeDecision(decision);
}
```

### Phase 5 — Position Tracker Schema

Add exit-policy columns to the positions table (or in-memory state):

```typescript
interface PositionExitPolicyState {
  entryPrice: number;        // Price at entry
  stopLossPct: number;       // Original stop-loss %
  currentStop: number;       // Current stop price (updates with trail)
  scaleOutLevel: number;      // Index: 0 = first target not yet hit
  isTrailing: boolean;        // True after first scale-out
  trailDistanceR: number;     // Trail distance in R-multiples
}
```

---

## Implementation Phases

| Phase | Scope | Effort |
|---|---|---|
| **Phase 1** | Schema: `ExitPolicySchema` + `MechanicalParamsSchema` extension | ~30 min |
| **Phase 2** | Decision model: `closeFraction` + `exitPolicyState` fields | ~1 hour |
| **Phase 3** | `TradingActor` exit-policy check + partial-close execution | ~1 day |
| **Phase 4** | Position tracker exit-policy state (in-memory or DB column) | ~2–3 hours |
| **Phase 5** | Stop-loss trailing logic (breakeven → trail) | ~2–3 hours |
| **Phase 6** | Unit tests: partial close, trail update, full exit, edge cases | ~3–4 hours |
| **Phase 7** | Preset defaults: wire exitPolicy into strategy presets | ~30 min |
| **Total** | | ~2–3 days |

---

## Risks & Edge Cases

| Risk | Mitigation |
|---|---|
| **State drift**: Position tracker state diverges from actual exchange position | Reconciliation loop (already exists) must reconcile partial closes. If exchange shows 50% of expected size, either the partial close failed or the tracker is wrong — log and alert. |
| **Restart safety**: Exit-policy state lost on worker restart | Store `exitPolicyState` in the positions DB row. Reload on startup. |
| **Gap risk**: Price gaps through a scale-out level without touching it | Scale-out only triggers when price is **at or beyond** the target (`>=`), not at exactly the target. Gaps are handled naturally. |
| **Multiple scale-outs in one tick**: Price moves through two levels between checks | Process ALL triggered scale-outs in order (close 50% at 2R, then 50% of remainder at 3R, etc.). |
| **Fee erosion**: Frequent partial closes amplify fee impact | Document that scale-out works best on venues with low fees (Hyperliquid) and warn for swap venues. |
| **Trail-stop whipsaw**: Trail too tight → stopped out prematurely | Default `trailDistanceR` to 2× ATR or a sensible fraction of the original stop. Don't default to 0.5R. |

---

## Definition of Done

- [ ] `ExitPolicySchema` defined and exported from `packages/domain/src/config/schema.ts`
- [ ] `Decision` type extended with `closeFraction` and `exitPolicyState`
- [ ] `TradingActor` handles partial-close decisions (reduces position, doesn't close fully)
- [ ] `TradingActor` executes scale-out logic (R-multiple → partial close)
- [ ] `TradingActor` executes trailing stop after first scale-out
- [ ] Position tracker persists exit-policy state across ticks/restarts
- [ ] Strategy presets default to `exitPolicy: { scaleOut: null, trailRemainder: false }` (opt-in)
- [ ] Unit tests for: single scale-out, multi scale-out, trail activation, trail stop hit, gap-through, restart recovery
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes

---

## References

- `aitradingbot/src/config/presets/index.ts` — `PresetDefinition.exitPolicy` type definition
- `aitradingbot/src/config/presets/swing.ts` — example: `exitPolicy: { scaleOut: null, trailRemainder: false }`
- `packages/strategy/src/mechanical-strategy.ts` — current stateless strategy
- `docs/features/2026/06/16/003-rich-strategy-parity/000-contemplations.md#decision-9` — statelessness decision
