# Bug Report 001 — `check_watches` boundary poll storm + `removeTriggered` schema coercion

- **Status:** FIXED
- **Severity:** Medium
- **Date:** 2026-09-23
- **Environment:** development; local docker compose cross-stack (herobids + traderton)
- **Discovered by:** agent evaluation 2026-09-23 (`.ignore/eval/2026/09/23/REPORT.md`)

## Summary

Two defects in the `check_watches` path introduced by the B3 extraction
(`git show f370f9fc` — "re-enable watch-threshold wakes via boundary
check_watches"):

1. **Poll storm.** The market monitor (`apps/worker/src/market-intelligence/monitor.ts`)
   calls the Traderton boundary `check_watches` **once per active agent per 5s
   evaluation loop**, regardless of whether the agent has any watches. Over the
   evaluation period this produced **~55,935 `boundary_invocations`** (~48/min) to
   evaluate **2 never-triggered watches**. `boundary_invocations` is dominated by
   `check_watches` (55,935) vs `submit_decision` (17).

2. **Coercion failure.** The agent LLM emits `removeTriggered` as a *string*
   (`"false"`), but the Zod schema (`apps/worker/src/tools/watch.ts:170`) declares
   `z.boolean()`. Zod rejects it, logging "Tool parameter validation failed …
   removeTriggered: Expected boolean, received string". Observed 3× in `tintel`'s
   log. Every other LLM-emitted numeric tool arg in the codebase already uses
   `z.coerce.*` — booleans are the gap.

## Root Cause

**Poll storm.** The B3 migration moved watch *evaluation authority* to Traderton,
so the herobids monitor can no longer know whether an agent has any watches
without calling the boundary. `getSubscribedAgentIds('watch_threshold')` returns
*all active agents* (watch presence is not a filter), and `evaluateWatches` then
calls `evaluateAgentWatches(agentId)` — a full `check_watches` boundary
round-trip with a DB owner-id lookup — for every one of them, every loop. With
`evaluationIntervalMs: 5000` and 4 active agents, that is a constant ~48
boundary calls/minute with zero triggers.

**Coercion failure.** `resolveWatchSummaryDigest` / LLM arg emission sends the
boolean as `"false"`. The tool schema uses `z.boolean()` where the convention
(analytics.ts, bots.ts, market-data.ts, code.ts, find-instrument.ts) is
`z.coerce.*` for LLM-emitted values.

## Fix (implemented 2026-09-23)

1. **Skip the boundary call when the agent has no watches.** The Traderton
   `check_watches` tool now always reports `totalWatches` (0 when the agent has
   no watches, previously omitted on the empty path). The monitor reads this and
   backs off watchless agents via a **Redis-backed** marker
   (`market-monitor:watchless:{agentId}`, TTL 60s) — the same lease-surviving
   pattern as the rate-limit/dedupe keys, so a leader-election handoff can't
   reset it. `undefined` (older boundary / unknown count) means "do NOT back off"
   (avoid starving watchful agents). Agents with watches are never backed off.

2. **Coerce `removeTriggered`** in both the herobids and traderton
   `CheckWatchesParamsSchema` via `z.preprocess` (string `"true"`/`"false"` →
   boolean), mirroring the existing `z.coerce.*` convention for LLM-emitted args.

### Files Changed

- `herobids/apps/worker/src/market-intelligence/monitor.ts` — watchless Redis-backed backoff (`markWatchless`/`clearWatchless`/`isWatchlessBackedOff`), consumed in `evaluateWatches`
- `herobids/apps/worker/src/index.ts` — `evaluateAgentWatches` forwards `totalWatches`
- `herobids/apps/worker/src/tools/watch.ts` — coerce `removeTriggered`
- `herobids/apps/worker/src/market-intelligence/monitor.test.ts` — 3 backoff tests + port `totalWatches` passthrough
- `traderton/packages/worker/src/tools/watch.ts` — coerce `removeTriggered`; empty path returns `totalWatches: 0`
- `traderton/packages/worker/src/tools/watch.test.ts` — 2 tests (coercion + `totalWatches: 0`)

## Verification

- herobids: `tsc --noEmit -p apps/worker` clean; monitor suite 67/67, watch suite 11/11.
- traderton: `tsc --noEmit -p packages/worker` clean; watch suite 70/70.
- Expected live effect: `boundary_invocations` `check_watches` rate drops to ~0 for watchless agents; watchful agents still evaluated every cycle; no `removeTriggered … Expected boolean` warning.

## Related

- `git show f370f9fc` (B3-monitor re-enable)
- `apps/worker/src/market-intelligence/monitor.ts` `evaluateWatches`
- traderton `packages/worker/src/tools/watch.ts` `checkWatchesTool` + `refreshWatchSummaryCache`