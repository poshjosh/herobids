# 006 — Wake signal tick skipped by context_hash gate — reminder not delivered

**Status:** FIXED  
**Severity:** High  
**Date:** 2026-06-12  
**Summary:** When an agent received a wake signal (e.g. from a scheduled reminder), the tick triggered by that wake was silently skipped by the `context_hash` gate because the trading context had not changed. The LLM was never dispatched and the user was not notified.

---

## Root Cause

`shouldSkipTick` in `apps/worker/src/tick-gates.ts` has a `context_hash` gate that returns `skip: true` when the decision context hash (position side, price bucket, PnL bucket, regime pass) matches the previous tick's hash. This gate exists to avoid redundant LLM calls when nothing material has changed.

However, the gate had no awareness of wake signals. When `pa-1` (`0649fb56...`) received an `agent.market.wake` message (from the reminder coordinator at 08:21:01 UTC), the agent runtime correctly triggered an early tick. At the call site in `agent.ts`, `hasWakeRequest` was extracted from incoming messages and logged, but it was **never passed into `shouldSkipTick`**. The `TickGateState` interface had no `hasWakeSignal` field.

Because the PA agent has no open positions and the market context hadn't changed since tick 1, the context hash was identical to the previous tick's hash. `shouldSkipTick` returned `skip: true, reason: 'context_unchanged'` and the tick was aborted before LLM dispatch. The `send_message` tool was never called and the user received no notification.

**Evidence from container logs (agent `0649fb56...`):**
```
{"tickCount":3,"msg":"Processing market wake signal"}
{"tickCount":3,"reason":"context_unchanged","gate":"context_hash","msg":"Skipping agent tick before LLM dispatch"}
```

**Redis stream evidence:** `agent:outbound:0649fb56...` contained the `agent.market.wake` entry at `1781252461933-0` (08:21:01.921 UTC). The agent inbound stream contained only `agent.runtime.heartbeat` messages — no `send_message` or other tool-call evidence.

---

## Fix

Three-file change:

### `apps/worker/src/tick-gates.ts`
1. Added `hasWakeSignal?: boolean` field to `TickGateState`.
2. Added `&& !state.hasWakeSignal` guard to **both** `context_hash` gate checks (the `hasOpenPositions` branch and the flat/regime branch). A tick that carries a wake signal always proceeds to LLM dispatch regardless of context hash identity.

### `apps/worker/src/agent.ts`
3. Passed `hasWakeSignal: hasWakeRequest` into the `shouldSkipTick` call at the existing call site (line ~1273). `hasWakeRequest` was already computed — it just wasn't threaded through.

### `apps/worker/src/tick-gates.test.ts`
4. Added two new test cases:
   - `'does not skip when hasWakeSignal is true even if context hash matches (flat position)'`
   - `'does not skip when hasWakeSignal is true even if context hash matches (open position)'`

---

## Files Changed

- `apps/worker/src/tick-gates.ts`
- `apps/worker/src/agent.ts`
- `apps/worker/src/tick-gates.test.ts`

---

## Verification

- No TypeScript errors in affected files.
- New tests assert `skip: false` when `hasWakeSignal: true` and the context hash matches — covering both the open-position and flat-position code paths in `shouldSkipTick`.
- Existing `'skips when decision context is unchanged before the forced tenth tick'` test continues to pass unmodified (no regression — it does not set `hasWakeSignal`).

---

## Notes

- The `session` gate (trading hours) and `regime` gate are **not** bypassed by wake signals. Only the `context_hash` gate is affected. A wake-driven tick on a PA/task agent (which has no regime gate or session gate configured) will always reach LLM dispatch.
- The `hasWakeSignal` flag is only `true` for the single tick that actually processes the wake message. Subsequent normal ticks revert to standard gate behavior.
