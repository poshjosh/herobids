# Plan: Preset Review Gap Closure (Final — Authoritative)

**Status:** Ready for implementation
**Scope:** Close the real remaining gaps in the **active** preset-review pipeline for `capabilityMode = 'hybrid'` agents, surfaced by the 2026-07-29 staging evaluation.

> **This is the only plan an implementing agent should follow.** It supersedes `001-plan.md` and `002-plan-revised.md` in full. Where they conflict with this document, this document wins. Every claim below has been verified against the current codebase; file/line anchors are approximate and will drift as edits land — locate by symbol name, not line number.

## Companion Documents

- [002-platform-preset-assessment-and-transition/001-plan.md](../../07/18/002-platform-preset-assessment-and-transition/001-plan.md) — upstream feature architecture
- [003-plan-amendment-per-symbol-on-demand-assessment](../../07/18/002-platform-preset-assessment-and-transition/003-plan-amendment-per-symbol-on-demand-assessment.md) — per-symbol on-demand supersession
- [005-implementation-checklist-per-symbol-on-demand](../../07/18/002-platform-preset-assessment-and-transition/005-implementation-checklist-per-symbol-on-demand.md) — **this plan updates §7.0** (see Change 6)
- [001-plan.md](./001-plan.md), [002-plan-revised.md](./002-plan-revised.md) — **both superseded by this document**

---

## Current Code Truth (verified)

Do not re-diagnose these. They are confirmed facts about the code as it exists today.

1. **The active advice path already works end-to-end for delivery.**
   - `AssessmentReviewRunner` emits a `scanner` wake with `context.scannerKind = 'assessment_review'` — [assessment-review-runner.ts](../../../../apps/worker/src/market-intelligence/assessment-review-runner.ts) (`runReviewCheck`, wake payload construction).
   - The agent runtime detects `scannerKind === 'assessment_review'` and builds the prompt via `buildAssessmentReviewMessage` — [agent.ts](../../../../apps/worker/src/agent.ts) (`isAssessmentReviewWake` branch) and [assessment-review-message.ts](../../../../apps/worker/src/assessment-review-message.ts).
   - That message already instructs the agent to call `assess_strategy_preset`, then `change_strategy_preset`.
   - **Therefore the pipeline is NOT blocked by missing wake delivery.** Do **not** wire, revive, or emit `scannerKind = 'preset_review'`; `buildPresetReviewMessage` is deliberately deferred dead code and must stay that way.

2. **`assess_strategy_preset` and `change_strategy_preset` are registered tools but absent from every skill's `requiredTools`** — confirmed in [skills.ts](../../../../packages/domain/src/skills.ts) (`TRADING_SKILL.requiredTools`). The runtime enforces a hard gate that rejects any tool not in the active skill set — [agent.ts](../../../../apps/worker/src/agent.ts) (`if (!allowedTools().has(call.tool))`). **This is the single hard blocker that fully explains "0 tool calls" in the evaluation.**

3. **`resolveActivePreset` derives the preset from fields that do not exist in the schema.** Both copies fall back to `tech['type'] ?? intelligence['type'] ?? 'momentum'`. Neither `technical.type` nor `intelligence.type` is part of `UnifiedAgentConfigSchema`, so the effective result is always `'momentum'`. The logic is **duplicated in two places** in [index.ts](../../../../apps/worker/src/index.ts): the forced/manual review deps builder (near the comment "same logic as startReviewSchedulerForAgent") and inside `startReviewSchedulerForAgent()`.

4. **The per-agent review scheduler is started without a capability-mode gate.** `startReviewSchedulerForAgent(agent)` runs for any active agent — [index.ts](../../../../apps/worker/src/index.ts). Intelligence agents have no preset, so it produces `no_candidate`/`momentum` noise.

5. **`review_advice.consumed_at` means "wake delivered," not "agent acted."** `markAdviceConsumed` is called immediately after `emitAgentWake` — [assessment-review-runner.ts](../../../../apps/worker/src/market-intelligence/assessment-review-runner.ts). This semantic is correct and must be preserved; it just does not answer "did the agent then request an assessment?"

### Verified fact: where and when `strategyPreset` is persisted

- **Location:** `agents.unifiedConfig.metadata.strategyPreset` — a nested key inside the `unified_config` JSONB column. It is **not** a top-level `agents.metadata` column (that column does not exist — see [012-tool-context-wiring §"Do not invent agents.metadata.strategyPreset"](../../07/18/002-platform-preset-assessment-and-transition/012-tool-context-wiring.md); that warning is about the top-level column and does **not** apply to the nested `unifiedConfig.metadata` key used here).
- **Written by** `resolveAgentStrategyPreset` in [agents.ts](../../../../apps/api/src/routes/agents.ts), on agent create and on PATCH, **only when the request supplies `strategyPreset`.** The full block written is:
  ```ts
  metadata: {
    strategyPreset,                    // preset key, e.g. "momentum", "swing"
    strategyPresetName,                // display name
    strategyPresetStyle,               // "economy" | "standard" | "premium"  (the StyleKey)
    strategyPresetSource: 'agent-style',
    presetBehaviorVersion,             // mechanically-derived version
  }
  ```
- **Not written** for: pure intelligence agents, or hybrid agents created with a custom `technical` block but no `strategyPreset`. So the fallback **must** tolerate a missing `metadata.strategyPreset`.
- The 2026-07-29 eval agents were created via [create-eval-agents.sh](../../../../scripts/shell/run/create-eval-agents.sh) which passes `strategyPreset`, so `metadata.strategyPreset` **is** populated for them. This confirms the `'momentum'`-for-everyone symptom is the `resolveActivePreset` derivation bug, not missing metadata.

---

## Problem Statement

Hybrid agents received deterministic review advice but never converted it into preset-assessment tool calls (0 calls to `assess_strategy_preset` / `change_strategy_preset` over ~72h). The advice message is already delivered. The concrete, verified blockers are:

- **B1 (hard blocker):** the preset tools are not in any skill, so the runtime rejects them before the model's intent matters.
- **B2 (correctness):** review advice attributes the wrong active preset (`'momentum'`) because `resolveActivePreset` reads nonexistent schema fields.
- **B3 (noise/scope):** the scheduler runs for agents that cannot participate.
- **B4 (observability):** we cannot distinguish "advice delivered but ignored" from "advice delivered and acted on."

---

## Goals

1. Make the preset assessment/transition tools callable by trading agents via the existing `trading` skill.
2. Fix active-preset resolution so review advice uses the agent's real preset whenever derivable, via a single shared helper (no duplicated logic).
3. Gate **both** the automatic review scheduler **and** the user-triggered forced strategy-review path to `capabilityMode === 'hybrid'`, and make the cited design doc agree (Option 1: keep the gate, update the doc).
4. Add observability that distinguishes delivered advice from acted-on advice, without redefining `consumed_at`.
5. Add focused regression tests so the next evaluation cannot misread or regress the active path.

## Non-Goals

- Do **not** wire, emit, or re-activate `scannerKind = 'preset_review'`, and do not delete `buildPresetReviewMessage` (leave the deferred function untouched).
- Do **not** add a new wake source or change the wake model.
- Do **not** change the `assess_strategy_preset` request shape or the `change_strategy_preset` contract / transition modes.
- Do **not** promote `unifiedConfig.metadata` to a typed field of `UnifiedAgentConfigSchema` in this change; access it through a small, well-tested helper.
- Do **not** add preset validation or presets for intelligence agents.

---

## Root Causes

### Gap A — active preset fallback reads nonexistent fields
`resolveActivePreset` (two copies in [index.ts](../../../../apps/worker/src/index.ts)) derives `strategyType` from `tech.type ?? intelligence.type`, which are not in the schema, so it always yields `'momentum'`. This corrupts `review_advice.active_preset` and the deterministic peer comparison baseline.

### Gap B — preset tools are not granted by any skill
The runtime only exposes tools in the resolved skill set; the hard gate rejects the rest. `assess_strategy_preset` / `change_strategy_preset` are in no skill, so a correctly-instructed agent still gets a silent rejection.

### Gap C — review scope is broader than the feature scope
Preset review is meaningful only for hybrid agents. Intelligence agents have no preset and should not run the automatic scheduler **or** be eligible for a user-triggered forced review. The cited normative doc (005 §7.0) currently says intelligence agents *do* get the tick — that contradiction must be resolved, not left dangling.

### Gap D — advice lifecycle observability is incomplete
`consumed_at` answers "delivered." The evaluation needs a second, separate signal: "did the agent then request an assessment for the same identity?"

---

## Proposed Changes

### Change 1 — Centralize and fix active-preset resolution

**Files:** new helper `apps/worker/src/market-intelligence/resolve-active-preset.ts`; call sites in [index.ts](../../../../apps/worker/src/index.ts) (forced/manual review deps builder and `startReviewSchedulerForAgent`).

**What:**
1. Extract a single exported async helper, e.g.:
   ```ts
   export async function resolveActivePresetState(
     db: Database,
     agent: { id: string; unifiedConfig: unknown },
   ): Promise<Result<ActivePresetState>>
   ```
   Both existing call sites must call this helper. Delete both inline copies so they cannot drift.
2. **Resolution order** inside the helper:
   1. **Authoritative binding** — `resolveAuthoritativeBinding(db, agent.id)` → `getPreset` + `applyPresetToAgent` (existing behavior, unchanged).
   2. **Unified-config metadata (NEW, replaces the broken `tech.type` path):** read `unifiedConfig.metadata.strategyPreset` (preset key) and `unifiedConfig.metadata.strategyPresetStyle` (StyleKey). If `strategyPreset` is a non-empty string and `getPreset(presetKey, styleTier)` resolves, run `applyPresetToAgent(presetKey, preset, styleTier, 'llm')` and return the real mapping (`presetKey`, `presetBehaviorVersion`, `scanInterval`, `signalBias`, `enabledIndicators`). For `behaviorVersion`, prefer `metadata.presetBehaviorVersion` when present, else the mapping's `presetBehaviorVersion`. Use `styleTier` from `metadata.strategyPresetStyle` when valid (`isStyleKey`), else `allowedPresets.styleTier`, else `'standard'`.
   3. **Last-resort safety fallback** — return `presetKey: 'momentum'` with a **loud `logger.warn`** including `agentId`, so hitting this path is visible in logs and observable in the next evaluation. Do **not** synthesize a preset from `tech.type` / `intelligence.type`; remove that logic entirely.
3. The helper must tolerate a completely absent `metadata` object (common for custom-technical hybrid agents) and fall straight through to step 3.

**Why:** eliminates the always-`'momentum'` bug, removes duplication, and makes fallback usage auditable.

### Change 2 — Add preset tools to the `trading` skill

**File:** [skills.ts](../../../../packages/domain/src/skills.ts), `TRADING_SKILL.requiredTools`.

**What:** append `'assess_strategy_preset'` and `'change_strategy_preset'` to the array.

**Why:** the active advice message already instructs the agent to use these tools; the runtime gate must make that instruction actionable. `trading` is already assigned to all trading agents, and the tools remain independently gated by `platformAssessment.enabled` and billing, so no adoption friction and no new opt-in surface.

### Change 3 — Gate review to hybrid agents (automatic scheduler + forced review)

Apply the same `capabilityMode === 'hybrid'` boundary everywhere preset review can be initiated. Key the gate **positively** off `capabilityMode === 'hybrid'` (the product boundary), never off `!== 'intelligence'`, so future capability modes are excluded by default.

**3a — Automatic scheduler.** **File:** [index.ts](../../../../apps/worker/src/index.ts), `startReviewSchedulerForAgent()`. At the top of the function, early-return unless hybrid:
```ts
if (agent?.unifiedConfig?.capabilityMode !== 'hybrid') return;
```

**3b — Forced-review API trigger.** **File:** [agent-platform-assessment-reviews.ts](../../../../apps/api/src/routes/agent-platform-assessment-reviews.ts), `POST /agents/:id/platform-assessment/reviews`. Alongside the existing operator-gate / opt-in / active / running-session checks, reject non-hybrid agents before creating the run and enqueuing the job:
```ts
if (unifiedConfig['capabilityMode'] !== 'hybrid') {
  return reply.status(403).send({
    error: 'capability_mode_unsupported',
    message: 'Strategy review is only available for hybrid agents',
  });
}
```

**3c — Forced-review eligibility endpoint.** **Same file**, `GET /agents/:id/platform-assessment/reviews/eligibility`. Push a matching reason so the UI shows the control as ineligible:
```ts
if (unifiedConfig['capabilityMode'] !== 'hybrid') {
  reasons.push('Strategy review is only available for hybrid agents');
}
```

**3d — Forced-review worker defense-in-depth.** **File:** [manual-review-runtime.ts](../../../../apps/worker/src/manual-review-runtime.ts) via the `ManualReviewRunnerFactory` constructed in [index.ts](../../../../apps/worker/src/index.ts) (the manual/forced deps builder that already loads the agent). If a job somehow reaches the worker for a non-hybrid agent (stale enqueue, race), have the factory return a typed `err` with code `review.capability_mode_unsupported`; the job handler already maps a factory failure to `markManualReviewFailed`, so the run terminates cleanly instead of executing against a non-existent preset.

**Why:** matches the feature boundary at every entry point; stops intelligence agents from generating `no_candidate`/`momentum` scheduler noise and misleading `review_advice`, and prevents a user from forcing a meaningless review on an agent that has no preset. The API checks are the primary guard (fast user feedback); 3d is a safety net.

### Change 4 — Add "advice acted on" observability (without touching `consumed_at`)

**Files:** [review-advice.ts](../../../../packages/db/src/schema/review-advice.ts) (schema + generated migration); [assessment-request-service.ts](../../../../apps/worker/src/market-intelligence/assessment-request-service.ts) (the DB-backed service that owns the request flow and resolves canonical identity).

**What:**
1. Add a nullable timestamp column `assessment_requested_at` (`timestamp with time zone`) plus an index `idx_review_advice_assessment_requested_at`. Keep `consumed_at` exactly as-is. Generate the migration with `pnpm --filter @herobids/db run db:generate` and verify a new SQL file lands under `packages/db/drizzle/` (do not hand-edit snapshots).
2. In `AssessmentRequestService.requestAssessment` (the per-instrument entry that `requestBatchAssessment` fans into), **after** canonical identity is resolved and a real request attempt enters the flow — regardless of outcome (`cache_hit`, `cooldown`, `billing-blocked`, `completed`) — mark matching advice rows: set `assessment_requested_at = now()` where:
   - `agent_id = agentId`, and
   - canonical identity matches (`instrument_kind`, `venue_family`, `style_tier`, and either `symbol` for orderbook/perp or `network + address` for swap/dex), and
   - `outcome = 'advised'`, and
   - `expires_at > now()`, and
   - `assessment_requested_at IS NULL`.
   Recommended additional filter: `consumed_at IS NOT NULL` (only advised rows are ever consumed, so this asserts "delivered then acted on"). This correlation works for both orderbook/perp and swap/dex because it runs after canonicalization.

**Correlation rule (critical):** Do **not** correlate via `assessmentArtifactId` — that value does not exist until after the assessment request succeeds, so it can never be the key that links an *incoming* request back to prior advice. Correlate on `agentId` + canonical identity, as above.

**Why:** gives the evaluation a clean way to separate delivered-but-ignored advice from delivered-and-acted-on advice, while preserving the existing, correct meaning of `consumed_at`.

### Change 5 — Regression tests around the actual active path

**Files:** worker tests under `apps/worker/src/**`, domain test for skills.

**Add/adjust coverage for:**
- active-preset resolution: prefers authoritative binding, then `metadata.strategyPreset` (+ `strategyPresetStyle`), then the loud `'momentum'` fallback; and tolerates absent `metadata`.
- both scheduler entry points (forced/manual deps builder and `startReviewSchedulerForAgent`) use the same `resolveActivePresetState` helper.
- `TRADING_SKILL.requiredTools` contains `assess_strategy_preset` and `change_strategy_preset`.
- `startReviewSchedulerForAgent` returns early for a non-hybrid (intelligence) agent and starts for a hybrid agent.
- forced-review API: the `POST` trigger returns `403 capability_mode_unsupported` for a non-hybrid agent and proceeds (past the capability gate) for a hybrid agent; the eligibility endpoint reports `canTrigger: false` with the capability-mode reason for a non-hybrid agent and omits it for a hybrid agent.
- forced-review worker: the runner factory returns `review.capability_mode_unsupported` for a non-hybrid agent (defense-in-depth).
- `assessment_review` wake routing remains active and the rendered message still points at `assess_strategy_preset` (guards against accidental regression to `preset_review`).
- `assessment_requested_at` is set only after a real assessment request is correlated to delivered advice, and matches for both a symbol identity and a network+address identity; `consumed_at` semantics are unchanged.

### Change 6 — Update the cited design doc (Option 1: keep the gate, update the doc)

**File:** [005-implementation-checklist-per-symbol-on-demand.md](../../07/18/002-platform-preset-assessment-and-transition/005-implementation-checklist-per-symbol-on-demand.md), §7.0 normative trigger table.

**What:** remove `intelligence` from the normative "gets an `assessment_review` tick" table (or mark it explicitly deferred/out-of-scope), so the doc matches Change 3. Add a one-line note stating the rationale: intelligence agents have no strategy preset, so preset review does not apply to them; the scheduler now gates on `capabilityMode === 'hybrid'`.

**Why:** prevents a future reader from "fixing" the gate back. Code and normative doc must agree.

---

## Implementation Order

| Step | Change | Depends on | Risk | Status |
|------|--------|-----------|------|--------|
| 1 | Change 2 — add preset tools to `trading` skill | none | Low (additive to a static list) | DONE |
| 2 | Change 3 — gate scheduler + forced-review path to hybrid | none | Low | DONE |
| 3 | Change 6 — update 005 §7.0 | Change 3 | Low (doc only) | DONE |
| 4 | Change 1 — centralize + fix active-preset resolution | none | Medium | DONE |
| 5 | Change 5 (part) — tests for Changes 1–3 | 1,2,4 | Low | IN PROGRESS |
| 6 | Change 4 — `assessment_requested_at` column + correlation | 4 | Medium (migration + service change) | PENDING |
| 7 | Change 5 (part) — tests for Change 4 | 6 | Medium | PENDING |

Steps 1–4 are independent and parallelizable. Lock the active path with tests (Step 5) before the observability change (Step 6).

---

## Verification

### Code-level
- [ ] `resolveActivePresetState` exists as one exported helper; both former inline copies are deleted and now call it.
- [ ] The helper no longer references `technical.type` / `intelligence.type`; the safety fallback logs a loud `warn` with `agentId`.
- [ ] `TRADING_SKILL.requiredTools` includes `assess_strategy_preset` and `change_strategy_preset`.
- [ ] `startReviewSchedulerForAgent()` early-returns unless `capabilityMode === 'hybrid'`.
- [ ] The forced-review `POST` trigger and eligibility endpoints, and the manual-review runner factory, all gate on `capabilityMode === 'hybrid'`.
- [ ] `buildPresetReviewMessage` is untouched and still unused; `assessment_review` remains the active wake kind.
- [ ] New migration file exists under `packages/db/drizzle/` adding `assessment_requested_at` + its index; `consumed_at` unchanged.
- [ ] 005 §7.0 no longer lists `intelligence` as receiving the tick.

### Behavior-level
- [ ] For a hybrid agent created with a `strategyPreset`, `review_advice.active_preset` matches the authoritative preset (binding first, else `metadata.strategyPreset`), not `'momentum'`.
- [ ] Hybrid agents with `platformAssessment.enabled: true` and the `trading` skill can call `assess_strategy_preset` with no tool rejection.
- [ ] Intelligence agents accumulate no new review-scheduler activity or `review_advice` rows, and cannot trigger a forced review (API returns `403`; eligibility reports not-triggerable).
- [ ] Delivered advice still sets `consumed_at`; acted-on advice additionally sets `assessment_requested_at`.
- [ ] Evaluation queries can now distinguish delivered-but-ignored from delivered-and-acted-on advice.

### Commands
- Run the targeted worker/domain tests covering assessment-review routing, review-scheduler gating, skills membership, active-preset resolution, and the new advice lifecycle.
- Run `pnpm lint` (must pass).

---

## Residual Risk / Out-of-Scope Follow-Up

Changes 1–4 remove every **verified** blocker (tool visibility, wrong preset attribution, scope noise, observability). They do **not** guarantee agents will choose to call `assess_strategy_preset`. If, after this lands, agents still do not call it, the next investigation moves **up** to prompt/runtime behavior — not back down into wake transport:
- prompt framing quality of `buildAssessmentReviewMessage`,
- billing/cooldown discouraging tool use,
- agent preference for ordinary trading actions over assessment actions,
- insufficient reasoning-loop instrumentation.

The single most probable cure for the observed "0 calls" is Change 2 (tool visibility), since the hard gate currently rejects the tools outright.

---

## Open Questions (resolved)

1. **Prefer `metadata.strategyPreset` or the `style` column in the fallback?**
   **Resolved:** prefer `metadata.strategyPreset` (+ `metadata.strategyPresetStyle`). `style` is a tier, not a preset. Authoritative binding still wins over both.

2. **Make `unifiedConfig.metadata` a typed schema field?**
   **Resolved:** not in this change. Access via the helper only.

3. **Also gate the user-triggered forced strategy-review path?**
   **Resolved:** yes. Apply the `capabilityMode === 'hybrid'` gate at the forced-review API trigger and eligibility endpoints, with worker-side defense-in-depth in the runner factory (Change 3b–3d). Intelligence agents have no preset, so a forced review is as meaningless for them as an automatic one. The forced path also benefits from Change 1's shared helper.

4. **Record acted-on for any assessment request, or only successful ones?**
   **Resolved:** record after canonical-identity resolution and a real request attempt enters the service, even on `cache_hit`, cooldown-blocked, or billing-blocked outcomes. The question is whether the agent acted on the advice, not whether a fresh artifact was produced.

---

## Outstanding Issues

### [Step 1 — Change 2] Add preset tools to `trading` skill
- **LOW:** `TRADING_SKILL.instructions` does not mention `assess_strategy_preset` or `change_strategy_preset`. This is intentional — these tools are not part of general trading workflow; they're invoked only via `assessment_review` wake messages. No action required.
### [Step 2 — Change 3] Gate scheduler + forced-review path to hybrid
- **MEDIUM:** Error code `review.capability_mode_unsupported` from factory (3d) gets swallowed and mapped to generic `review.runner_factory_failed` in `ManualReviewRuntime` handler. Pre-existing pattern, not introduced by this change.
- **MEDIUM:** POST gate (3b) runs unnecessary DB queries (agentRuntimeSessions, hasActiveManualReviewRun) for non-hybrid agents before rejecting. Minor optimization, not blocking.
- **LOW:** `review-scheduler-lifecycle-wiring.test.ts` doesn't mirror the new `capabilityMode` gate. Tests to be added in Change 5.
- **LOW:** Minor style redundancy in 3a where `unifiedConfig` is re-extracted right after the gate.

### [Step 3 — Change 6] Update 005 §7.0
- **MEDIUM:** Locked decision D2 in §2 ("all agent types") now in tension with §7.0 which explicitly removes intelligence. Should be updated to say "all applicable (hybrid) agent types."
- **LOW:** Introductory sentence in §7.0 says "every opted-in agent type" — could be tightened to "every applicable agent type."