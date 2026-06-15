# 2026-06-15-01 — Scout Over-Hold: Never Escalates With Open Positions

**Date:** 2026-06-15
**Severity:** Critical
**Files:** `apps/worker/src/scout-gating.ts`, `apps/worker/src/agent.ts`

## Summary

After a judge opened a BTC long position (tick 1), the scout held on all subsequent ticks (ticks 2–8) without escalating to close the position. Phase 3.6 of the agent trade test timed out at 600s with no `go_flat` decision ever submitted.

## Root Cause

`resolvePreScoutDecision` only force-escalated on tick 1 (first tick) and when the judge had scheduled a reminder. For all other ticks the scout LLM ran and could hold. The scout system prompt contained no instruction to escalate when open positions exist, so the LLM kept returning `{"disposition":"hold"}` each tick despite seeing an open long position via `list_positions`.

Additionally, `unrealizedPnl not available — mark prices are not cached in the agent process` was logged on every `list_positions` call, leaving the scout without P&L data to base an exit decision on.

## Observed Behaviour

```
[tick 2–8] scout.held — scout_hold (1–3 turns)
           Private stream disconnected / reconnected every ~30s
           Reconciliation drift: "Local has long position but venue has no position"
```

## Fix

Added `hasOpenPositions?: boolean` parameter to `resolvePreScoutDecision`. When `true`, the function returns a forced `escalate` decision with source `'forced_open_positions'` — skipping the scout LLM entirely. This ensures a trading agent always escalates to the judge while a position is open.

```ts
// scout-gating.ts
if (params.hasOpenPositions) {
  return {
    decision: { disposition: 'escalate', reason: 'open_positions_require_active_management' },
    source: 'forced_open_positions',
  };
}
```

`hasOpenPositions` was already computed in `agent.ts` before the `resolvePreScoutDecision` call; it was simply added to the call-site.

## Tests Added

`apps/worker/src/scout-gating.test.ts` — 3 new cases:
- forces escalation when `hasOpenPositions: true`
- runs scout when `hasOpenPositions: false`
- judge reminder takes priority over open positions
