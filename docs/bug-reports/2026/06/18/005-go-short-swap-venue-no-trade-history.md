# Bug Report 005 — go_short on swap venue produces no trade history

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-18
- **Summary:** Agent submitting `go_short` decisions on a swap venue (1inch) from a flat position produced entries in "recent decisions" but nothing in "trade history". The agent received no feedback that its intent was not executed.

## Root Cause

`packages/engine/src/decision-intake.ts` — `submitDecisionForExecution` — at the `plan.orders.length === 0` early-return branch:

```ts
if (plan.orders.length === 0) {
  return { decision: resolvedDecision, riskRejected: false, position, executionFailed: false };
}
```

For swap venues (e.g. 1inch), the planner deliberately generates 0 orders for `go_short` when the position is flat or already short, because spot/DEX venues cannot open borrowed short positions. The planner comment correctly states:
> "Spot swap venues can reduce or close existing base holdings, but they cannot open or reverse into a borrowed short."

The intake returned a silent success for this path regardless of intent. The decision was persisted in step 1 (so it appeared in "recent decisions"), but no execution plan, orders, or fills were ever created — hence "trade history" remained empty.

The agent received a synthetic "accepted" acknowledgement with no orders and no fills, giving the false impression the decision was processed.

**Affected scenario:** Agent with `venueType: swap` submitting `go_short` (or any non-`go_flat` intent that generates 0 orders) from a flat position.

## Fix

Two changes to `packages/engine/src/decision-intake.ts`:

1. Added `'planner'` to `PreExecutionRejection.scope` union type.
2. In the `plan.orders.length === 0` branch, distinguished between two cases:
   - `go_flat` from flat → deliberate no-op, returns silent success (unchanged).
   - Any other intent → returns `preExecutionRejection` with `scope: 'planner'`, `code: 'no_orders_planned'`, and a descriptive message. For the specific `go_short` + swap case the message is: *"Swap venues cannot open short positions — go_short is only valid when closing an existing long position"*.

The existing `agent-decision-handler` already handles `preExecutionRejection` correctly: it emits `decision_rejected` back to the agent, records to `decision_failures`, and sends a `rejected` sync reply — so no changes were needed there.

## Files Changed

- `packages/engine/src/decision-intake.ts`

## Verification

- `pnpm lint` passes with no errors.
- All 14 `decision-intake.test.ts` tests pass.
- All 15 `planner.test.ts` tests pass.

With the fix deployed, the agent submitting `go_short` on a swap venue from flat will receive a `rejected` reply with a clear explanation, and the `decision_failures` table will record the rejection. Trade history correctly remains empty (no trade occurred), and the agent can act on the feedback.
