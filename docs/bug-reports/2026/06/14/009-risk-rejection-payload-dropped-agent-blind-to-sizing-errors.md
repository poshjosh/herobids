# 009 — Agent Blind to Risk Rejection: Guardrail Payload Dropped, Sizing Loop Never Breaks

- **Status:** OPEN
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

## Root Cause (two distinct defects)

### Defect 1 — `instance.guardrail.triggered` has no handler in `applyRuntimeMessage`

**File:** `apps/worker/src/runtime-composition.ts`

When a risk rejection occurs, `AgentDecisionHandler` calls `emitGuardrailTriggered` with a rich payload:

```json
{
  "scope": "risk_gate",
  "code": "risk.rejected",
  "message": "Decision rejected by risk gate",
  "decisionId": "..."
}
```

This is published as an `instance.guardrail.triggered` message to the agent's outbound Redis stream. On the next tick, `applyRuntimeMessage` processes the message but **has no `if` branch for this type**. It falls through to the final catch-all:

```ts
const summary = `Platform message: ${type}`;
pushRecentEvent(state, type, summary);
return summary;
```

The entire payload — including `code`, `message`, and `decisionId` — is discarded. The LLM's **Recent Events** context block shows only:

```
<timestamp>: Platform message: instance.guardrail.triggered
```

No error code, no notional, no actionable information.

### Defect 2 — The actual rejection reason (`risk.max_position_size_pct_exceeded`) is never surfaced at all

The underlying risk error (from `checkRisk` in `packages/engine/src/decision-intake.ts`) contains the precise rejection detail:

```
"Resulting position notional 6745 exceeds 100% of equity (1000)"
```

But `emitGuardrailTriggered` in `agent-decision-handler.ts` is called with a hardcoded generic message:

```ts
await this.eventPublisher.emitGuardrailTriggered(effectiveBotId, {
  scope: 'risk_gate',
  code: 'risk.rejected',          // generic — not the specific error code
  message: 'Decision rejected by risk gate',  // not the engine's message
  decisionId: payload.decisionId,
});
```

The specific risk error (`riskResult.error.code` and `riskResult.error.message`) from the engine is **never forwarded** to the agent.

### Defect 3 — `emitDecisionAccepted` fires before risk check

`AgentDecisionHandler` emits `decision.accepted` as soon as context hash and pre-execution checks pass — **before** the risk gate has run. If the risk gate then rejects, the agent sees an acceptance immediately followed by a mystery `Platform message: instance.guardrail.triggered`. This is misleading: the agent believes its decision was accepted, making it harder to reason about why nothing executes.

### Contributing factor — Agent sizing in token quantity, not USD notional

The agent's prompt does not instruct it to compute `qty = target_usd / price`. It submits round token counts (100 SOL, 5 ETH, 0.5 BTC), producing notionals of $6,745, $8,313, and $32,003 against a $1,000 capital limit. This is a prompt/configuration problem that the bug above makes invisible and self-reinforcing.

---

## Proposed Fix

### Fix 1 — Add `instance.guardrail.triggered` handler in `applyRuntimeMessage`

In `apps/worker/src/runtime-composition.ts`, add a branch that extracts and surfaces the rejection payload:

```ts
if (type === 'instance.guardrail.triggered') {
  const code = typeof payload['code'] === 'string' ? payload['code'] : 'unknown';
  const message = typeof payload['message'] === 'string' ? payload['message'] : 'Guardrail triggered';
  const summary = `Guardrail: ${code} — ${message}`;
  pushRecentEvent(state, type, summary);
  return summary;
}
```

This ensures the LLM sees, in its Recent Events block:

```
<timestamp>: Guardrail: risk.max_position_size_pct_exceeded — Resulting position notional 6745 exceeds 100% of equity (1000)
```

### Fix 2 — Forward the engine's specific risk error in `agent-decision-handler.ts`

In `AgentDecisionHandler.handleDecisionSubmit`, replace the hardcoded generic message with the actual error from the engine result. `submitDecisionForExecution` returns `riskRejected: true` but does not currently expose the error detail on the result object. The `DecisionIntakeResult` type should be extended with an optional `riskError` field, and `agent-decision-handler.ts` should use it:

```ts
if (result.riskRejected) {
  await this.eventPublisher.emitGuardrailTriggered(effectiveBotId, {
    scope: 'risk_gate',
    code: result.riskError?.code ?? 'risk.rejected',
    message: result.riskError?.message ?? 'Decision rejected by risk gate',
    decisionId: payload.decisionId,
    details: result.riskError?.context,
  });
}
```

### Fix 3 — Move `emitDecisionAccepted` after the risk check (or rename it)

`decision.accepted` should mean "accepted for execution and passed all gates", not "accepted for intake processing". Either:
- Move `emitDecisionAccepted` to after the risk gate passes (inside the `else if (result.executionResult)` branch), or
- Rename the pre-risk emission to `decision.received` / `decision.intake_ok` so the agent is not misled.

### Fix 4 — Prompt update (separate from code fix)

The agent's prompt should explicitly state:
- The capital available (e.g. "$1,000")
- That `targetSize` is in tokens, not USD
- That the agent must compute `qty = desired_usd_notional / current_mark_price` before calling `submit_decision`

---

## Files to Change

| File | Change |
|---|---|
| `apps/worker/src/runtime-composition.ts` | Add `instance.guardrail.triggered` handler in `applyRuntimeMessage` |
| `packages/engine/src/decision-intake.ts` | Expose `riskError` on `DecisionIntakeResult` |
| `apps/worker/src/agents/agent-decision-handler.ts` | Forward `riskError` fields to `emitGuardrailTriggered`; move `emitDecisionAccepted` |

---

## Verification

After fix:
- `Recent Events` block in the LLM context should show the specific rejection code and notional message.
- A new agent with the same prompt and $1,000 capital, if given sizing guidance, should stop producing risk rejections and start producing fills.
- Integration test: add a case to `agent-decision-handler.test.ts` asserting that when `riskRejected: true` is returned, `emitGuardrailTriggered` is called with the specific `code` and `message` from the engine.
