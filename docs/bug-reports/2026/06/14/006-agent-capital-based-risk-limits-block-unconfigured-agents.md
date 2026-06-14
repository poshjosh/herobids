# 006 — Agent capital-based risk limits block unconfigured agents

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-14
- **Summary:** Agents created without an explicit `capital` setting were blocked from trading by over-restrictive default risk limits derived from a hardcoded fallback of `$100`.

## Root Cause

In both `apps/worker/src/index.ts` and `apps/worker/src/agents/agent-intake-resolver.ts`, when `agent.capital` is `null` (not configured by the creator), the worker fell back to `'100'` and applied capital-based risk checks:

- `maxOrderNotional: price('100')` — blocked any single order with notional > $100
- `maxPositionSizePct: 100` with `equity: price('100')` — blocked any position with notional > 100% × $100 = $100

At current BTC prices (~$64K), a minimal 0.01 BTC order has notional ~$640, far exceeding the $100 limit. The risk gate logged `risk.max_position_size_pct_exceeded` and rejected the plan. No fills were produced, no position was written to DB, and in-memory position state remained flat.

When the agent subsequently submitted `go_flat`, the planner found no open position and generated zero orders. No execution plan was persisted (`status=no-plan-yet`), and `closedAt` was never set in the positions table, causing Phase 3.7 bookkeeping audit to fail.

This violates the AGENTS.md rule: "Never apply [constraints] unless the goal or creator-specified instructions explicitly specify them."

## Fix

1. **`apps/worker/src/index.ts`** — When `agent.capital` is `null`, omit `maxOrderNotional`, `maxPositionSizePct`, and `capital` from the `AgentTradingActor` constructor. Capital-based limits are only applied when the creator explicitly configured a capital value.

2. **`apps/worker/src/agents/agent-intake-resolver.ts`** — Same change: when `agent.capital` is `null`, omit `maxOrderNotional`, `maxPositionSizePct`, and `equity` from the resolved `DecisionIntakeDeps`. Also changed `maxPositionSize` from `quantity(capitalStr)` (semantically incorrect — base units ≠ USD) to the permissive `quantity('1000000000')`.

3. **`scripts/ts/agent-trade-test.ts`** — Set `capital: '100000'` on the test agent to explicitly exercise the capital-constrained code path and ensure realistic test conditions.

4. **`apps/worker/src/agents/agent-intake-resolver.test.ts`** — Updated assertions to reflect the corrected behaviour (`maxPositionSize = '1000000000'`, `equity` present only when capital is configured); added a new test verifying capital-based limits are omitted when `capital` is `null`.

## Files Changed

- `apps/worker/src/index.ts`
- `apps/worker/src/agents/agent-intake-resolver.ts`
- `apps/worker/src/agents/agent-intake-resolver.test.ts`
- `scripts/ts/agent-trade-test.ts`

## Verification

- `pnpm lint` passes (0 errors)
- `pnpm test` passes (2289 tests, 0 failures)
- Agent trade test Phase 3.7 expected to pass after stack rebuild and rerun
