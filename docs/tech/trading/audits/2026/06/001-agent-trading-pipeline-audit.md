# Agent Trading Pipeline Audit

- **Date:** 2026-06-18
- **Trigger:** Recurring silent-failure and venue-capability-gap bugs surfaced during normal development (most recently: `go_short` on swap venue producing decisions but no trade history).
- **Scope:** Full end-to-end trading path — agent prompt → tool call → decision intake → planner → executor → fill persistence — for all actor types (agent, bot) and all venue types (orderbook perpetuals, DEX/swap).
- **Output:** Prioritised findings with specific remediation tasks.

---

## Background

Three classes of defects have surfaced that share a root pattern: **a gap between what the agent believes it can do and what the system can actually execute**.

1. `go_short` on 1inch (swap, flat position) → decision persisted, zero fills, no feedback (fixed 2026-06-18, Bug 005).
2. Silent no-op paths in decision intake returned success when no trade occurred.
3. Agent prompt carries no explicit statement of which intents are valid for the configured venue type.

An audit is needed to systematically surface all remaining gaps rather than fixing them one bug at a time.

---

## Audit Scope

### In Scope

| Area | What to Audit |
|------|---------------|
| Agent system prompt | Venue capability information; intent restrictions; what the agent is and isn't told |
| `submit_decision` tool schema | Intent enum; description accuracy; venue-specific guidance |
| Planner | All intent × venue-type combinations; zero-order conditions; action labels |
| Decision intake pipeline | All early-return paths; guard ordering; silent-success conditions |
| Executor paths | Paper, shadow, live (orderbook), live (swap); fill semantics; failure paths |
| Risk gate | Checks present; gaps; venue-specific applicability |
| Agent feedback | Quality of rejection messages; sync reply accuracy; `decision_failures` recording |
| Context provided to agent | Position, price, venue type, risk limits — what reaches the agent at decision time |
| Test coverage | Unit and integration tests covering swap venue intents, zero-order paths, rejection paths |

### Out of Scope

- Reconciliation logic (separate concern)
- WebSocket stream stability
- Rate limiting (covered by its own guide)
- UI / API layer presentation of decisions

---

## Section 1 — Agent System Prompt & Venue Capability Awareness

### What to Examine

- `apps/worker/src/runtime-composition.ts` — `buildSystemPrompt()` and `formatTradingVenueLine()`
- The `PROVIDER_VENUE_DETAILS` map — what text is injected per venue
- Whether the prompt explicitly states which intents are valid vs. invalid for the venue
- Whether the prompt explains what `go_short` means on a swap venue (sell your holdings) vs. a perp venue (open a borrowed short)

### Known Gaps

1. **No intent restriction in prompt.** The agent is told its venue name and instrument format, but is never told that `go_short` from a flat position is a no-op on swap venues.
2. **No position-side context per venue type.** The agent is not told it cannot hold a short position on a DEX.
3. **`go_long` semantics differ silently.** On swap, `go_long` means "buy base tokens with quote". On perps, it means "open a leveraged long". The prompt does not distinguish these.
4. **Execution mode (paper/shadow/live) not exposed to agent.** The agent cannot calibrate its behaviour (e.g. aggression) based on mode.

### Audit Tasks

- [ ] **A1.1** — Read the full built system prompt for both a Hyperliquid agent and a 1inch/Jupiter agent. Diff the venue-specific sections. Document exactly what each agent knows about its trading constraints.
- [ ] **A1.2** — For each intent (`go_long`, `go_short`, `go_flat`, `increase`, `decrease`), determine whether the prompt gives the agent enough context to know when the intent is valid.
- [ ] **A1.3** — Determine where in `runtime-composition.ts` venue-type-specific guidance should be injected (e.g. a "Venue Constraints" block in the system prompt).
- [ ] **A1.4** — Draft the missing guidance text for each venue type and confirm it is concise enough not to bloat the prompt (token cost vs. clarity trade-off).

---

## Section 2 — `submit_decision` Tool Schema & Description

### What to Examine

- `apps/worker/src/tools/trading.ts` — `SubmitDecisionParamsSchema` and the tool description string
- The `intent` enum description — does it explain per-venue semantics?
- The `targetSize` field — is the unit (base tokens, USD notional, contracts) clear per venue?
- The `instrumentId` field description — venue-specific format guidance

### Known Gaps

1. **`intent` enum has no per-venue annotation.** All 5 intents are presented identically regardless of venue type.
2. **`targetSize` unit ambiguity.** On swap venues, target size is in base tokens. On perps it's in contracts or base units. The description does not clarify this per venue.
3. **No "valid intents for your venue" field.** The tool description doesn't tell the agent which intents are applicable to its current context.

### Audit Tasks

- [ ] **A2.1** — Read the full tool description as the agent sees it (including all field descriptions). Identify every place where venue-type context is missing or ambiguous.
- [ ] **A2.2** — For each gap, decide: fix in tool description, fix in system prompt, or fix in server-side pre-flight validation? (A description fix is cheapest; a server-side pre-flight catches errors programmatically.)
- [ ] **A2.3** — Evaluate adding a server-side pre-flight check in `AgentDecisionHandler` that rejects `go_short` on swap venues before hitting the planner, with a clear error code (e.g. `intent.not_supported_for_venue`). This surfaces the problem earlier and doesn't require the decision to be persisted first.

---

## Section 3 — Planner Correctness

### What to Examine

- `packages/engine/src/planner.ts` — full `switch (decision.intent)` block
- All intent × venue-type combinations
- Zero-order conditions: when are they legitimate (already at target) vs. problematic (intent not achievable)?
- Action label accuracy: does `action: 'close'` on a 0-order swap `go_short` describe reality?

### Known Gaps

1. **`action: 'close'` set even when 0 orders generated for `go_short` on swap.** The plan action misrepresents what happened (nothing was closed; position was already flat).
2. **`go_short` from an existing short on swap generates 0 orders with `action: 'close'`.** The agent asking to "increase its short" or "stay short" sends a `go_short` which has no effect. This is confusing.
3. **No distinction between "already at target" and "intent not achievable."** Both produce a zero-order plan. The intake now rejects all non-`go_flat` zero-order cases, which is slightly over-broad (e.g. `go_long` when already long at exact target size).

### Audit Tasks

- [ ] **A3.1** — Build a complete truth table: for every combination of `(intent, venueType, currentSide, currentSize vs targetSize)`, document what orders are generated and what `action` is set. Mark every row where 0 orders is legitimate vs. every row where it means "intent not achievable."
- [ ] **A3.2** — For each "not achievable" row, confirm the intake's `preExecutionRejection` path (added in Bug 005 fix) correctly catches it. For each "already at target" row, confirm the silent no-op path is correct.
- [ ] **A3.3** — Fix `action` label accuracy for zero-order swap `go_short` cases (it should not be `'close'` if nothing was closed).
- [ ] **A3.4** — Consider adding a `PlannerResult` wrapper that distinguishes `zeroBecauseAtTarget` from `zeroBecauseNotAchievable`, so the intake can handle them differently without a blanket non-`go_flat` check.

---

## Section 4 — Decision Intake Pipeline

### What to Examine

- `packages/engine/src/decision-intake.ts` — full `submitDecisionForExecution()` function
- Ordering of guards (hash check → persist decision → plan → zero-order check → swap safety → risk → execute)
- Early-return paths and what state is left in the DB after each one
- The new `preExecutionRejection` path for zero-order non-`go_flat` plans

### Known Gaps

1. **Decision is persisted (step 1) before the planner check (step 5).** A `go_short` on swap from flat persists a decision row then returns a rejection. The decision exists in the DB but has no plan. This is arguably correct (auditable), but the `decisions` table row has no status field to indicate it was rejected — callers infer this from `decision_failures`.
2. **The zero-order `preExecutionRejection` message is over-specific.** It references `go_short` even when triggered by other intents. The fix in Bug 005 conditionally applies the swap-specific message but the fallback is generic — both should be reviewed.
3. **`go_flat` from flat is the only intent whitelisted for silent no-op.** This may incorrectly reject `go_long` when already long at exact target size. No test currently covers this.
4. **Risk gate receives 0 as open position count for agents with no positions.** Verify this does not cause unexpected behaviour when `openPositionCount` is not provided.

### Audit Tasks

- [ ] **A4.1** — Trace every early-return path in `submitDecisionForExecution`. For each one, document: what DB state is left, what the return value contains, and whether the caller handles it correctly.
- [ ] **A4.2** — Add a `status` or `outcome` field to the `decisions` table (or a linked view/join) so callers can quickly determine whether a persisted decision resulted in a rejection, a no-op, or a trade — without querying `decision_failures`.
- [ ] **A4.3** — Test the "already at target" zero-order case for `go_long` and `go_short` on orderbook venues to confirm the new `preExecutionRejection` does not fire erroneously.
- [ ] **A4.4** — Review the guard ordering. Is there value in moving the zero-order check (currently step 5) to immediately after planning, before the risk gate? (Currently it is, but confirm no state is unnecessarily written before it.)

---

## Section 5 — Executor Paths

### What to Examine

- `packages/engine/src/paper-executor.ts`
- `packages/engine/src/shadow-executor.ts`
- `packages/engine/src/live-executor.ts` (orderbook)
- `packages/engine/src/swap-live-executor.ts` (swap/DEX)
- Fill semantics, price calculation, fee simulation, failure paths for each

### Known Gaps

1. **Paper executor does not simulate swap-specific fill semantics.** On a real swap, you get a quoted price that may differ from mark; slippage applies per swap size. Paper executor applies generic slippage without swap-routing awareness.
2. **Shadow executor fetches real quotes but does not execute.** This means shadow fills use real market prices, but the fill is synthetic — there's no venue-level confirmation that the swap would have succeeded (e.g. token blacklisted, liquidity fragmented at execution time).
3. **Swap live executor atomic-fill semantics vs. orderbook async-fill semantics.** The position tracker and reconciler are designed around async fills. Confirm swap fills (which are synchronous/atomic) flow correctly through the same reconciler without double-counting.
4. **Error path on swap execution failure (e.g. slippage exceeded, quote expired).** What state is left? Is the plan marked failed? Is the position left unchanged?

### Audit Tasks

- [ ] **A5.1** — Read `swap-live-executor.ts` fully. Trace a failed swap execution (expired quote, slippage exceeded) through to plan/order/fill state in DB. Confirm no partial state is left inconsistent.
- [ ] **A5.2** — Audit paper executor slippage model for swap venues. Does it apply a swap-appropriate slippage (e.g. price impact from AMM curve) or a generic fixed-bps model?
- [ ] **A5.3** — Confirm shadow executor result flows correctly into fill accounting and position update. Does a shadow `go_short` on swap (which would sell existing holdings) produce a correct position after?
- [ ] **A5.4** — Confirm the reconciler does not attempt to poll for fills on swap orders that are already atomically filled at submission time.

---

## Section 6 — Risk Gate

### What to Examine

- `packages/engine/src/risk-gate.ts` — `checkRisk()` function and all limit checks
- `RiskLimits` interface — what fields exist, what defaults apply
- Which checks are venue-type-aware vs. universal

### Known Gaps

1. **No venue-type-specific checks in risk gate.** All checks are numeric (size, notional, drawdown). No check prevents an invalid intent for a venue type — that's handled by the planner/intake.
2. **`maxOpenPositions` check uses `action === 'open_long' || 'open_short'`.** On swap venues, a `go_long` from flat has `action: 'open_long'`. A `go_short` from long has `action: 'close'` (or `'reverse'` on orderbook). Confirm the action label is correct for swap venues so the position count gate fires appropriately.
3. **`maxDrawdown` is checked against `currentDrawdown`.** Clarify how `currentDrawdown` is computed for swap venues where P&L tracking is based on token flows, not a simple entry/mark delta.
4. **Daily loss limit uses `dailyLossTracker`.** Verify swap fills feed into `dailyLossTracker` correctly (via `applyFillAccounting`).

### Audit Tasks

- [ ] **A6.1** — For each risk check, confirm the input values (position size, notional, drawdown, daily loss) are computed correctly for swap venues vs. orderbook venues.
- [ ] **A6.2** — Trace a swap `go_long` from flat through `checkRisk`. Confirm `openPositionCount` increments and the `open_long` action triggers the max-positions check.
- [ ] **A6.3** — Verify `dailyLossTracker` receives fills from swap executor (paper, shadow, live). Check `rehydrateDailyLoss` in `AgentTradingActor` uses swap fills correctly.

---

## Section 7 — Agent Feedback Quality

### What to Examine

- Sync reply sent back to agent after each decision outcome
- `decision_failures` recording (code, message, retryable flag)
- Events published by `InstanceEventPublisher` (plan status, execution result, rejection events)
- What the agent's `submit_decision` tool surfaces in its return value

### Known Gaps

1. **Rejection message for `no_orders_planned` does not suggest what the agent should do instead.** A good rejection message for a swap venue should say "use `go_long` to buy base tokens, or `go_flat` to sell existing holdings."
2. **`retryable: false` on `no_orders_planned`.** This is correct (retrying won't help unless position changes), but the agent should be told *when* the intent would become valid (i.e. "after you hold a long position").
3. **No structured "valid intents" field in the rejection.** The agent receives a free-text message. A structured field listing valid intents at this moment would let the agent adapt without parsing text.
4. **`decision_failures` `failureCode` namespace is flat.** `no_orders_planned` could be more specific: `planner.swap.go_short_from_flat` etc.

### Audit Tasks

- [ ] **A7.1** — Review the full set of rejection messages an agent can receive from `submit_decision`. For each, assess: Is the message actionable? Does it tell the agent what to do next?
- [ ] **A7.2** — Add a `validIntentsNow` field to the sync reply rejection payload for `no_orders_planned`, listing which intents would produce orders given the current position.
- [ ] **A7.3** — Review `failureCode` naming for all rejection paths. Standardise to `scope.category.detail` format (e.g. `planner.swap.short_from_flat`).

---

## Section 8 — Context Provided to Agent at Decision Time

### What to Examine

- `AgentTradingActor.getDecisionContext()` — what is in `DecisionContext`
- What the agent's system prompt tells it about its current position and venue
- Whether the agent can see its effective risk limits

### Known Gaps

1. **`DecisionContext` does not include venue type.** The agent must infer its venue from the instrument ID format. A `venueType: 'swap' | 'orderbook'` field would make this explicit and enable correct decision logic.
2. **`DecisionContext` does not include valid intents.** The agent must know the semantics of its venue to understand which intents are applicable.
3. **Risk limits are not visible to the agent.** The agent cannot calibrate position size to stay within `maxPositionSize` or `maxOrderNotional` because it doesn't know these limits. It learns about them only when the risk gate fires.
4. **Execution mode (paper/shadow/live) not in context.** The agent cannot adjust aggression or sizing based on whether capital is real.
5. **`strategyParams` is empty in current implementation.** This field exists in `DecisionContext` but is never populated.

### Audit Tasks

- [ ] **A8.1** — Add `venueType` and `validIntents` to `DecisionContext` (or the agent's system prompt block). Decide whether these are best as context fields or as static prompt text.
- [ ] **A8.2** — Add effective risk limits (at minimum `maxPositionSize`, `maxOrderNotional`, `dailyLossLimit`) to the context the agent sees. This prevents trial-and-error risk gate rejections.
- [ ] **A8.3** — Expose `executionMode` to the agent, so it can calibrate behaviour (e.g. size down in shadow mode, full aggression in live).
- [ ] **A8.4** — Decide what to put in `strategyParams` — or remove the field if it has no planned use.

---

## Section 9 — Test Coverage Gaps

### What to Examine

- `packages/engine/src/decision-intake.test.ts` — existing coverage
- `packages/engine/src/planner.test.ts` — existing coverage
- `apps/worker/src/__tests__/integration/agent-native-decision.integration.test.ts` — agent-level coverage

### Known Gaps

1. **No test for `go_short` on swap venue from flat** → `preExecutionRejection` with `scope: 'planner'`. This is the exact bug that was just fixed.
2. **No test for `go_long` / `go_short` on orderbook already at exact target size** → confirm silent no-op (NOT a rejection) is correct or incorrect per A3 findings.
3. **No test for the full planner truth table.** Individual intent cases exist but not a systematic matrix.
4. **No integration test for swap executor failure paths** (expired quote, slippage rejection).
5. **No test confirming `decision_failures` is populated** for `no_orders_planned` rejections.

### Audit Tasks

- [ ] **A9.1** — Add unit test: `go_short` on swap from flat → `preExecutionRejection` (`scope: 'planner'`, `code: 'no_orders_planned'`).
- [ ] **A9.2** — Add unit tests for "already at target" zero-order cases for orderbook `go_long` and `go_short`. Determine and assert the correct outcome (silent no-op vs. rejection).
- [ ] **A9.3** — Add planner tests for every row in the truth table from A3.1 that is not already covered.
- [ ] **A9.4** — Add an integration test covering the `decision_failures` insert for `no_orders_planned`.
- [ ] **A9.5** — Add swap executor failure path tests (simulated slippage exceeded, quote expired).

---

## Prioritisation

| Priority | Tasks | Rationale |
|----------|-------|-----------|
| **HIGH** | A1.3, A1.4, A2.3, A8.1, A8.2 | Agent is currently trading with incomplete venue capability knowledge — it will keep submitting invalid intents |
| **HIGH** | A9.1, A9.3 | The Bug 005 fix has no regression test; the planner truth table is not systematically covered |
| **MEDIUM** | A3.1, A3.3, A3.4, A4.1, A4.3 | Planner action labels are misleading; zero-order classification needs precision |
| **MEDIUM** | A5.1, A5.3, A5.4 | Swap executor failure paths and reconciler interaction are untested |
| **MEDIUM** | A7.1, A7.2, A7.3 | Agent feedback is functional but not actionable enough for self-correction |
| **LOW** | A4.2, A4.4, A6.1–A6.3, A8.3, A8.4, A9.4, A9.5 | Important for completeness but not blocking correct agent behaviour |

---

## Audit Execution Order

1. **Read phase** — complete all examination tasks (read files, build truth tables) before writing any code.
2. **Findings phase** — for each section, write findings as a list of observations with file + line references.
3. **Fix phase** — implement HIGH priority fixes first, each with a corresponding bug report and test.
4. **Verification** — run `pnpm lint`, `pnpm test`, and the agent trade test after each batch of fixes.
5. **Sign-off** — re-run the agent against a swap venue in shadow mode; confirm `go_short` is rejected with a useful message and the agent self-corrects to `go_long` or `go_flat`.
