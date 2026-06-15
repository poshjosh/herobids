# 009 — Agent Blind to Risk Rejection: Guardrail Payload Dropped, Sizing Loop Never Breaks

- **Status:** FIXED
- **Severity:** High
- **Date:** 2026-06-14
- **Affected agent:** `fea02b41-4427-41b6-b7a6-eedb4467d3a0` (trader-1, shadow mode)
- **Summary:** Every `submit_decision` call from this agent is rejected by the risk gate (`risk.max_position_size_pct_exceeded`), yet the agent has produced zero fills and zero positions across 20+ decision attempts spanning ~1.5 hours. The agent never adapts its sizing because the rejection reason is silently dropped before reaching the LLM context.

---

## Observed Symptoms

- UI Trade History shows "No trade history yet" despite continuous `go_long` / `go_short` activity in the activity feed.
- Database: `decisions` table has 20 rows, `fills` = 0, `positions` = 0.
- All 20 journal events of type `risk.rejected`; all 20 execution plans have `status = 'failed'`.
- Agent submits the same oversized batches (BTC + ETH + SOL simultaneously) every ~10 minutes without any change in sizing.

---

## Root Cause

This issue was caused by three separate code-path problems plus one prompt-level contributing factor:

1. `instance.guardrail.triggered` fell through the generic catch-all in `applyRuntimeMessage`, so the Recent Events block only showed `Platform message: instance.guardrail.triggered`.
2. `AgentDecisionHandler` emitted a generic guardrail payload instead of forwarding the engine's specific `riskError.code` and `riskError.message`.
3. `decision.accepted` was emitted before the risk gate completed, which made later guardrail rejections look contradictory.
4. The agent prompt did not tell the model that `targetSize` is token quantity rather than USD notional, so it repeatedly proposed oversized positions.

The first three defects are fixed in code. The prompt-sizing guidance remains a separate follow-up.

---

## Resolution

### Shipped code fix

The runtime now preserves and surfaces guardrail payload detail in Recent Events. A risk rejection is rendered as:

```text
<timestamp>: Guardrail: risk.max_position_size_pct_exceeded — Resulting position notional 6745 exceeds 100% of equity (1000)
```

The surrounding intake path also now behaves consistently with that message:

- `AgentDecisionHandler` forwards the engine's specific risk error fields when emitting `instance.guardrail.triggered`.
- `decision.accepted` is emitted only after the decision passes the risk gate.

### Remaining follow-up

The agent prompt still needs explicit sizing guidance. It should state:

- The capital available (for example `$1,000`)
- That `targetSize` is in tokens, not USD
- That the agent must compute `qty = desired_usd_notional / current_mark_price` before calling `submit_decision`

That prompt/configuration work is separate from this code fix.

---

## Files Changed

| File | Change |
|---|---|
| `apps/worker/src/runtime-composition.ts` | Surface `instance.guardrail.triggered` code and message in Recent Events |
| `apps/worker/src/runtime-composition.test.ts` | Add coverage for guardrail summary rendering |
| `apps/worker/src/agents/agent-decision-handler.ts` | Forward specific `riskError` fields and emit `decision.accepted` only after risk passes |
| `packages/engine/src/decision-intake.ts` | Carry `riskError` on `DecisionIntakeResult` |

---

## Verification Status

- The Recent Events formatter now includes the specific risk code and message.
- A focused unit test covers `instance.guardrail.triggered` summary rendering.
- End-to-end sizing adaptation still depends on the separate prompt update described above.
