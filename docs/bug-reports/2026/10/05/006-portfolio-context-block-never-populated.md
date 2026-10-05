# Bug 006 — Portfolio context block never populated from the agent's own reads

- **Status:** FIXED (code; not yet deployed)
- **Severity:** Medium
- **Date:** 2026-10-05
- **Summary:** The per-tick `Portfolio summary` block (exposure, P&L, available capital) always rendered "unavailable", even after the agent successfully called `get_account_summary`, which can make an agent believe its account data is still loading.

## Root Cause

- `state.metrics.portfolio` is only updated by `applyRuntimeMessage` from Redis inbound messages (`instance.tool.result`, `instance.context.snapshot`) in `apps/worker/src/runtime-composition.ts`.
- `InstanceEventPublisher.emitToolResult` has no production callers. Its last callers (brokered `list_bots` / `get_bot_status` / `get_analytics`) were removed in a8be2f99 (c4.9i). `get_account_summary` was never published this way; its handler (b20a3fc6) was only ever exercised by a unit test.
- The agent's own tool results were not fed back into composition state, and no platform-side per-tick account read fills it.

## Fix

Option 1 of the original report: `executeTool` (`apps/worker/src/agent.ts`) now passes every successful result to a new `applyOwnToolResult(state, tool, data)` in `runtime-composition.ts`. For `get_account_summary`, `list_positions` and `get_analytics` this reuses the existing `instance.tool.result` handlers (capital, open positions → exposure, realized P&L). All other tools and non-object data are ignored. Verified against Traderton's tool output: success data passes through `mapReadResultToToolResult` unchanged, with `capital`, `positions[]` and `realizedPnlUsd` in the shapes the handlers expect.

Side effect: each such read also adds one line to the "recent events" context (e.g. `Account summary: available capital $1000.00`), as the handlers always did for this message type.

## Files Changed

- `apps/worker/src/runtime-composition.ts`
- `apps/worker/src/agent.ts`
- `apps/worker/src/runtime-composition.test.ts`

## Verification

- New tests: the block fills from the agent's own `get_account_summary` / `get_analytics` / `list_positions` results; other tools and non-object data are ignored.
- `pnpm lint`, `pnpm build`, worker + domain suites (4150 passed) green.
- Not yet verified live: after rebuilding the agent image, the block should show capital on the tick after the agent's first `get_account_summary`.
