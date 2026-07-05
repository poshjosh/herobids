# Agent Runtime Reliability

**Status:** Draft
**Created:** 2026-07-05
**Source:** Evaluation of agent session `8b94fa65` (thyper, 2026-07-03 to 2026-07-05)

## Background

A post-session evaluation of agent "thyper" uncovered five distinct platform bugs that caused
77,000+ `strategy.error` events, 4,615 false-positive reconciliation drift events, and 282
silent risk gate rejections over a two-day shadow session. The agent was effectively flying
blind for the duration. Each bug is independently fixable.

## Issues and Proposed Fixes

---

### Issue 1 — Bot strategy config-invalid loop (no circuit breaker)

**Observed:** Two bots emitted `strategy.error { code: "strategy.config_invalid", message: "Required" }`
on every tick (~5 s) for the full 2-day session, producing ~77,000 events and driving ~50 M
wasteful input tokens.

**Root cause:** The bot trading loop validates strategy config on every tick. When validation
fails it emits an event and continues to the next tick. There is no self-stop or error-rate
circuit breaker. A bot with a permanently broken config runs indefinitely.

**Proposed fix:**

Add a consecutive-error counter to the bot strategy execution loop, split by error code:

- `strategy.config_invalid` → halt after **1** consecutive failure. Config cannot heal itself;
  continuing even 10 ticks is pure token waste.
- `strategy.execution_error` (transient) → halt after **5** consecutive failures. Covers a
  brief venue outage (~25 s at 5 s/tick) without running indefinitely.

On halt:

1. Stop the bot automatically (`markBotStopped`).
2. Emit a single `strategy.fatal` journal event with the error detail and the threshold that
   was reached.
3. Notify the owning agent via an `instance.status` push with `reason: 'bot_halted_error_limit'`
   so the agent sees it on the next tick without needing to call `list_bots`.

**Config:** Both thresholds come from operator config (`agentRiskDefaults.botConfigInvalidHaltThreshold`
default 1, `agentRiskDefaults.botExecutionErrorHaltThreshold` default 5). Not hardcoded.

**Files likely touched:**
- `packages/engine/` — strategy execution loop
- `config/default.yaml` — new `agentRiskDefaults.botConfigInvalidHaltThreshold` and `agentRiskDefaults.botExecutionErrorHaltThreshold`
- `packages/domain/src/` — new `strategy.fatal` event type in journal schema (if needed)

---

### Issue 2 — Phantom drawdown gate (risk limits not transparent)

**Observed:** `get_risk_limits` returned `null` for drawdown while `submit_decision` was
simultaneously rejecting trades with `risk.max_drawdown_exceeded`. The agent spent multiple
ticks confused, eventually recording a "phantom drawdown confirmed" note in memory. 247
decisions were rejected over the final ~30 hours of the session.

**Root cause (confirmed):** Two compounding problems:

**2a — `get_risk_limits` cannot see live engine state.** The `EquityTracker` object that
computes `currentDrawdown` lives in the worker process's memory. The agent container runs in
a separate Docker container and its `get_risk_limits` tool has no access to that in-memory
state — so it returns `null` for drawdown. The engine and the tool are reading from completely
different sources.

**2b — `dailyLossLimit` is silently aliased to `maxDrawdown`, creating a semantic mismatch.**
In `apps/worker/src/agent-risk-limits.ts`:
```typescript
maxDrawdown: price(dailyLossLimit ?? '1000000000')
```
The engine enforces **peak-to-trough equity drawdown including unrealized P&L** from the
session high-water mark. `dailyLossLimit` means something different to an agent: a rolling
daily cap on realised losses. In the thyper session the agent had **+$26.38 in realised profit**
at the point of first rejection — it had no reason to think it was blocked. The actual trigger
was $44.54 of combined unrealized losses across 10+ open positions pulling equity $50.09 below
the $1,031.93 session peak.

**Data from thyper session:**
- Session peak equity: $1,031.93 (reached after profitable HYPE sells on day 1)
- First rejection: `2026-07-04T04:54:32` — drawdown = $50.097, limit = $50.00
- At that moment: realised equity ≈ $1,026.38 (+$26.38), unrealised ≈ −$44.54
- Total drawdown rejections: 247 (spanning the full second day)
- Drawdown range: $50.10 min → $109.04 max → $75.31 at session end
- The gate did allow position-reducing decisions through (`isRiskReducing = true`)

**Proposed fix:**

**Fix 2a — Redis cache for live EquityTracker state.** After every decision (accepted or
rejected), the worker writes the actor's current equity snapshot to a Redis key:
```
equity:{actorId} → { startingCapital, realizedPnl, unrealizedPnl, peakEquity, currentDrawdown }
```
`get_risk_limits` reads from this key. The value is at most one decision stale — acceptable
for a tool call.

**Fix 2b — Split `dailyLossLimit` and `maxDrawdown` into separate fields.** Both limits already
have separate enforcement paths in the risk gate (`risk.daily_max_loss_exceeded` and
`risk.max_drawdown_exceeded`). The fix is to give each its own config field:

| Field | Semantics | Reset |
|---|---|---|
| `dailyLossLimit` | Max realised P&L loss in a rolling day | Daily at midnight |
| `maxDrawdown` | Max equity drop from session peak (includes unrealized P&L) | Never (high-water mark) |

In `agent-risk-limits.ts`, each field reads from the agent's own config, falling back to
`agentRiskDefaults.*` from operator config — no hardcoded fallback literals.

`get_risk_limits` response must include both values and their sources:
- `drawdown: { current, limit, source: "user_configured" | "operator_default" }`
- `dailyLoss: { current, limit, source: "user_configured" | "operator_default" }`

**Files likely touched:**
- `apps/worker/src/agent-risk-limits.ts` — split the two fields
- `apps/worker/src/tools/risk-limits.ts` — read equity from Redis, expose both limits
- `apps/worker/src/decision-intake.ts` (or wherever decisions are processed) — write equity snapshot to Redis after each decision
- `config/default.yaml` — add `agentRiskDefaults.maxDrawdown` default
- `packages/domain/src/` — update agent config schema to add `maxDrawdown` field

---

### Issue 3 — Shadow mode reconciliation false drift

**Observed:** 4,615 `reconciliation.drift_detected` events throughout the session, all with the
same pattern: "Local has long position but venue has no position." All flagged as `severity: "critical"`.
The positions in question were shadow-mode fills — intentionally never sent to the real venue.

**Root cause:** The reconciliation loop compares the system's local position state against the
real venue's reported positions. In shadow mode, local positions are synthetic (not sent to
venue), so divergence from real venue state is expected and correct. The reconciler is not
shadow-mode aware.

**Proposed fix:**

Two options — pick one:

**Option A (preferred):** Skip venue reconciliation entirely for actors in shadow (or paper)
execution mode. There is nothing to reconcile — the venue was never informed of these positions.

**Option B:** Mark shadow-mode fills/positions with a flag and filter them from the
reconciliation diff so they do not appear as drift. Real venue positions (if any) are still
checked.

**Files likely touched:**
- `apps/worker/src/` or `packages/engine/` — reconciliation loop
- Likely a simple guard: `if (executionMode !== 'live') return;`

**Note:** Paper mode should be treated the same way as shadow mode here.

---

### Issue 4 — `list_bots` empty despite bots existing

**Observed:** The agent repeatedly recorded "list_bots empty despite Managed Bots showing 2
running in context." The "Managed Bots" section in the prompt is populated by `instance.status`
push messages from the broker (reliable). The `list_bots` tool queries the agent container's
own DB connection (unreliable — conditional on `DATABASE_URL` being forwarded).

**Root cause:** Two compounding problems:

1. `DATABASE_URL` is forwarded to the agent container conditionally:
   ```typescript
   ...(process.env['DATABASE_URL'] ? [`DATABASE_URL=${process.env['DATABASE_URL']}`] : []),
   ```
   If the worker's env does not have `DATABASE_URL` at container-launch time, the agent loses
   direct DB access silently.

2. When `list_bots` returns `{ ok: true, bots: [...] }`, `runtime-composition.ts` fails to
   update the "Managed Bots" context section because it checks `Array.isArray(data)`, which
   is false for that response shape.

**Root cause detail (confirmed):** The broker path (`agent-message-broker.ts`) passes a raw
array as `emitToolResult.data`, while the direct tool path (`tools/bots.ts`) returns
`{ ok: true, bots: [] }`. `runtime-composition.ts` checks `Array.isArray(data)` — matching
only the broker shape. On the typical agent-container path (direct DB access), the data is
an object so the check is always false and the "Managed Bots" section is never updated.

**Proposed fix:**

**4a — Hard-require `DATABASE_URL` in agent containers:** Change the conditional pass-through
in `docker-agent-manager.ts` to fail-fast (or log a prominent warning) if `DATABASE_URL` is
absent when the worker starts, since it's required for correct agent tool behaviour.

**4b — Standardise both `list_bots` paths to `{ ok, bots: [] }` shape, then fix the
`runtime-composition.ts` handler once:**

1. In `agent-message-broker.ts`, change the broker's `emitToolResult` call to wrap the
   array in the same envelope the direct tool uses:
   ```typescript
   // Before
   data: bots.map(...),
   // After
   data: { ok: true, bots: bots.map(...) },
   ```
2. In `runtime-composition.ts`, update the `list_bots` handler to read `data.bots`
   unconditionally — no dual-shape fallback needed:
   ```typescript
   if (tool === 'list_bots' && Array.isArray(data?.bots)) {
     state.metrics.managedBots = data.bots.map(...);
   }
   ```

Patching `runtime-composition.ts` to accept both shapes is explicitly avoided — that would
preserve the inconsistency as a silent contract for every future consumer.

**Files likely touched:**
- `apps/worker/src/agents/agent-message-broker.ts` — fix emitToolResult data shape
- `apps/worker/src/agents/docker-agent-manager.ts` — hard-require DATABASE_URL
- `apps/worker/src/runtime-composition.ts` — read data.bots unconditionally

---

### Issue 5 — `submit_decision` times out in shadow mode (instead of failing fast)

**Observed:** The agent attempted 6 direct `submit_decision` calls during one tick, all timed
out. The agent spent the entire tick waiting and then re-attempted in later ticks.

**Root cause:** In shadow mode, `submit_decision` is routed through the normal execution path
but the path hangs or takes excessively long. It should either execute the full simulated path
(shadow fill) or return an immediate structured error.

**Proposed fix:**

Determine whether shadow mode `submit_decision` is intended to produce fills or not:

- If it **should** produce fills (shadow simulation): fix the routing so it completes promptly
  instead of hanging. The session data shows fills DO exist from `submit_decision`, so this
  is the correct path — the timeouts appear to be intermittent, not systemic.
- If some ticks time out and others succeed, the likely cause is a flaky dependency in the
  shadow execution path (e.g., venue adapter, mark price lookup). Add a timeout guard and
  return `{ ok: false, reason: "execution_timeout" }` instead of hanging.

**Files likely touched:**
- `packages/engine/` — shadow execution path
- `apps/worker/src/` — decision intake / submission

---

### Issue 6 — Evaluator misattributes bot tool failures as agent tool failures

**Observed:** The evaluation report's `tool_usage` finding reads "73.9% of journal events are
tool failures (77,242 out of 104,547)". But these are `strategy.error` events emitted by bots
(`actorType: "bot"`), not the agent's own tool calls.

**Root cause:** The `tool_usage` analyzer counts all events of type `strategy.error` in the
session journal regardless of `actorType`. It does not distinguish between agent tool failures
and bot strategy errors.

**Proposed fix:**

Split the tool usage analysis by `actorType`:
- Agent tool failures: events where `actorType === "agent"` and event type is a tool-related failure
- Bot strategy errors: events where `actorType === "bot"` and event type is `strategy.error`

The `core.high_tool_failure_rate` finding should only fire based on agent tool failure rate,
not bot strategy error rate. Add a separate finding (e.g., `core.high_bot_error_rate`) for
runaway bot error loops, which is the more serious signal here.

**Files likely touched:**
- Evaluation analyzer (agent evidence / scoring logic)

---

## Implementation Phases

The issues are independent and can be tackled in any order. Suggested priority:

| Phase | Issues | Rationale |
|-------|--------|-----------|
| 1 | Issue 1 (bot circuit breaker) | Highest impact — eliminates 77k error floods |
| 1 | Issue 3 (shadow reconciliation) | Simple guard, low risk, eliminates 4.6k false events |
| 2 | Issue 2 (risk limit transparency) | Requires engine coordination; high agent UX value |
| 2 | Issue 4 (list_bots / DATABASE_URL) | Low-risk fixes, two small changes |
| 3 | Issue 5 (submit_decision timeout) | Low-risk guard; add now rather than investigate first |
| 3 | Issue 6 (evaluator attribution) | Evaluator-only change, no runtime impact |

---

## Open Questions

### Q1 — What is the correct bot error threshold (N) for Issue 1? ✅ RESOLVED

**Answer:** Split by error code — do not use a single threshold:
- `strategy.config_invalid` → halt after **1** failure. Config cannot self-heal; any further
  ticks are guaranteed waste.
- `strategy.execution_error` → halt after **5** consecutive failures. Covers a ~25 s venue
  outage at the default 5 s tick rate.

Both values come from `agentRiskDefaults.*` in operator config. See Issue 1 fix above.

### Q2 — Should halted bots be auto-restartable by the agent? ✅ RESOLVED

**Answer:** Yes. AGENTS.md grants agents full lifecycle authority over their own bots — the
circuit breaker stops the bot, the agent decides whether to fix config and retry. No user
confirmation required.

One invariant: the error counter resets only on a **successful tick**, not on restart. If the
agent restarts a bot without fixing the config, the circuit breaker fires again immediately.
This prevents trivial restart loops from burning tokens without requiring any additional gate.

### Q3 — Issue 3: should shadow reconciliation be disabled entirely or scoped? ✅ RESOLVED

**Answer:** Option A (skip entirely). A shadow agent by definition does not send orders to
the venue, so there is nothing to reconcile. Option B adds flag-propagation complexity for a
scenario that does not currently exist. If a future use case requires partial reconciliation
for shadow actors, Option B can be added then.

### Q4 — Issue 2: what is the actual source of the phantom drawdown? ✅ RESOLVED

**Answer:** The drawdown is `peak − (startingCapital + realizedPnl + unrealizedPnl)` computed
in `EquityTracker.currentDrawdown()`, which lives in the worker process memory. It is a
**peak-to-trough equity drawdown including live unrealized P&L**, not a daily realised loss.

The first rejection occurred when the agent had +$26.38 in realized profit but $44.54 of
combined unrealized losses across 10+ open positions. `dailyLossLimit = $50` is aliased
directly to `maxDrawdown`, so the $50 limit was breached despite the agent being profitable
on a realised basis.

The fix requires two changes (see Issue 2 proposed fix above): Redis caching of the live
EquityTracker state, and splitting `dailyLossLimit` / `maxDrawdown` into distinct fields.

### Q5 — Issue 5: are shadow submit_decision timeouts systemic or intermittent? ✅ RESOLVED

**Answer:** Add the timeout guard now without prior investigation. The guard is low-risk
regardless of root cause, and it converts a silent hang into a structured
`{ ok: false, reason: "execution_timeout" }` response. That structured response makes the
root cause easier to diagnose when it next appears — the agent logs it, the journal captures
it, and the evaluator can count it. Investigating without the guard means the next session
repeats the same wasted tick.

### Q6 — Scope of Issue 4b: is the `Array.isArray` check a deliberate contract? ✅ RESOLVED

**Answer:** The raw-array broker shape is an inconsistency, not a deliberate contract. The
direct tool (`tools/bots.ts`) returns `{ ok, bots: [] }` — the structured shape used
throughout the tool response chain. The broker's `emitToolResult.data: bots[]` is the anomaly.

Fix: standardise the broker to emit `{ ok: true, bots: [] }` (one-line change), then update
`runtime-composition.ts` to read `data.bots` unconditionally. Do not patch the composition
layer to accept both shapes — see Issue 4 fix above.

---

## Non-Goals

- Do not change the agent's strategy logic or trading decisions.
- Do not add new risk limits or alter existing user-configured limits.
- Do not change how shadow fills are simulated — only whether reconciliation runs against them.
- Do not change the evaluator's overall scoring model — only the tool failure attribution.
