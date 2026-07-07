# 010 — LLM Cost Reduction Follow-on Plan

**Status:** Draft  
**Created:** 2026-07-07  
**Depends on:** `docs/features/2026/07/07/003-session-circuit-breaker-and-non-wakeable-events/001-plan.md`  
**Source inputs:**
- `docs/features/pending/010-llm-cost-reduction/000-recommendations.md`
- `docs/best-practices/agent-runtime.md`
- current worker/runtime code paths
- chat review on 2026-07-07

## Purpose

This plan covers the **remaining** LLM cost-reduction work after the session circuit breaker and non-wakeable event work in `003`.

It is intentionally a **follow-on hardening plan**, not a runtime redesign.

## What Already Exists

The codebase already has several important controls in place.

### 1. Tick gating is already partially implemented

- `shouldSkipTick()` already skips scheduled ticks when the derived `contextHash` is unchanged and there is no wake signal.
- wake-triggered ticks already bypass that gate.
- the gate already preserves a periodic forced evaluation via `FORCE_FULL_EVALUATION_EVERY_TICK = 10`.
- hybrid agents already have a stricter no-wake guard: timer ticks do not reach the LLM at all unless a wake signal is present.

### 2. Prompt reduction is already implemented

- `buildIncrementalContext()` already emits diffs instead of the full prompt on many ticks.
- this reduces prompt size, but it is **not** an admission gate; it does not decide whether the LLM should be called.

### 3. Invalid bot config handling is already partly implemented

- direct API bot creation validates with `BotConfigSchema.safeParse(...)` before write.
- agent broker `create` validates stamped config before write.
- agent broker `adjust_config` validates the merged config before write.
- worker bot startup also validates config before actor startup.
- trading actors already auto-halt on `strategy.config_invalid` after the configured threshold, which defaults to `1`.

### 4. `maxBots` enforcement is already partly implemented

- agent broker `create` checks `countRunningBotsByCreator('agent', agent.id)` against `agent.maxBots`.
- plan-level bot limits are also enforced separately.

## Observed Gaps

The remaining waste is not caused by a total lack of controls. It comes from controls that are **real but incomplete**.

### Gap A — The tick gate fingerprint is narrower than the prompt-driving state

The current tick gate hash is computed from position side, price bucket, PnL bucket, regime pass, and multi-instrument snapshots.

However, the judge/scout prompt can also materially depend on runtime state that is **not currently part of the gate**, including:

- active watch summary / watch status mix
- queued wake signal context
- other prompt-driving state loaded after the gate decision

That means the current gate is best described as a **partial unchanged-context gate**, not a complete one.

### Gap B — The unchanged-context gate is only a tick-admission gate

Today the main worker loop has a skip gate before the LLM path, but there is not yet one explicit, shared **LLM admission policy** that says:

> scheduled tick + no wake + no material state change = no LLM call

across all relevant runtime paths.

We should preserve the existing gate, not replace it, and make it more complete.

### Gap C — Invalid configs are validated, but restart/start retries are not yet fully hardened

Current state is much better than the recommendation text originally assumed:

- invalid configs are rejected on create and adjust
- invalid configs fail fast at startup
- runtime `strategy.config_invalid` already self-halts bots

The remaining gap is narrower:

- a persisted invalid config can still be pushed through a start attempt before failing
- start/restart semantics should treat config-invalid startup as a terminal, non-retriable state until config changes
- the agent should see a clear reason, without needing to reason repeatedly about the same broken bot

### Gap D — `maxBots` is enforced, but not robustly enough for cost control

Current enforcement is real, but limited:

- enforced on agent broker `create`
- not clearly enforced on every `start` path
- not atomic against concurrent create/start requests

This matters because cost-control here is about preventing excess actors from creating drift, reconnect churn, and extra wake pressure.

## Goals

1. Complete the existing tick gate into a more faithful unchanged-context admission gate without replacing the scheduler, scout/judge flow, or wake model.
2. Close the remaining invalid-bot-config retry surfaces.
3. Turn `maxBots` into a robust budget guard across create/start concurrency.

## Non-Goals

- Do **not** duplicate the session circuit breaker work from `003`.
- Do **not** rewrite scout/judge orchestration.
- Do **not** replace prompt diffing with a new prompt system.
- Do **not** introduce prompt-micro-optimization work as the primary lever.

## Design

## Part A — Complete the Existing Tick Gate Instead of Replacing It

### Why

The current gate is already the correct control point. The problem is that the fingerprint is narrower than the real prompt-driving state, and some non-actionable runtime churn can still invalidate it.

### Approach

Keep `shouldSkipTick()` and `previousContextHash`, but expand the gate input into a **material runtime fingerprint**.

This fingerprint should include only stable, action-relevant state, not volatile fields like timestamps.

### Minimum fingerprint additions

Add the following to the gate input or to a derived pre-gate digest:

- active watch summary signature
  - counts and ordered status lines are sufficient; do not hash raw timestamps
- queued wake signal signature
  - source + reason of signals still relevant to the next prompt
- any already-available risk/playbook summary that materially changes agent actionability

The first implementation should focus on the surfaces already confirmed in the prompt/runtime path.

### Important sequencing constraint

Some of this state is currently loaded **after** the tick gate decision. The plan is therefore:

1. move the lightweight loading of material gate inputs earlier, or
2. persist/cache a compact digest that can be loaded cheaply before the gate

Do **not** hash the entire rendered prompt. That is too brittle and will reintroduce timestamp/noise churn.

### Interaction with `003`

`003` remains the primary fix for drift/reconnect churn.

This plan assumes:

- non-wakeable events do not emit wake signals
- drift-only and reconnect-only noise does not emit context snapshots that invalidate the hash

This plan should therefore be implemented **after** or **alongside** the non-wakeable-event snapshot discipline from `003`.

### Preserve existing safety valves

Keep:

- wake bypass behavior
- periodic forced full evaluation cadence
- hybrid-mode no-wake guard

Do not remove the periodic sanity evaluation. It is already part of the current behavior and protects against missed events.

### Files likely touched

- `apps/worker/src/tick-gates.ts`
- `apps/worker/src/tick-gate-state.ts`
- `apps/worker/src/agent.ts`
- `apps/worker/src/runtime-composition.ts`
- tests for tick gate state and skip behavior

### Acceptance criteria

- A scheduled tick with unchanged price/PnL/regime/watch summary/wake signature produces no LLM call.
- A watch flip or valid wake still bypasses the gate.
- The forced periodic full evaluation still occurs.
- No broad scheduler rewrite is needed.

## Part B — Harden Invalid Bot Config Handling at Start/Restart Boundaries

### Why

The code already rejects invalid config in the main write paths, so this is no longer a broad validation project.

What remains is a lifecycle hardening task: ensure invalid persisted config cannot keep re-entering the start flow or being presented as runnable.

### Approach

#### B1. Preflight persisted config before marking bot running on start

Before broker/API start paths mark a bot `running` and enqueue startup, validate the persisted/effective config again.

This is specifically for:

- legacy rows
- manually corrupted rows
- rows created before current validation guarantees

If invalid:

- reject start synchronously
- return a field-level validation error
- do not mark the bot running
- do not enqueue startup

#### B2. Treat config-invalid startup failure as terminal until config changes

For any startup failure caused by config invalidity:

- persist a terminal non-running state
- emit a single clear status reason
- ensure reclaim/start loops do not automatically retry it without a config mutation

This can be done either by:

- using an existing non-running status plus a reason code, or
- introducing a dedicated invalid state if the extra DB/status surface is justified

Prefer the smaller change unless product needs demand a distinct status.

#### B3. Clear the terminal invalid marker only on config mutation

When config is successfully adjusted and validated, allow later starts again.

### Files likely touched

- `apps/worker/src/agents/agent-message-broker.ts`
- `apps/api/src/routes/bots.ts`
- `apps/worker/src/index.ts`
- possibly `packages/db/src/repositories.ts` if a status helper/reason helper is needed

### Acceptance criteria

- Invalid persisted bot config is rejected before start enqueue.
- A config-invalid startup failure does not enter reclaim/restart loops.
- A config update can clear the invalid-start condition.
- Healthy bot start behavior remains unchanged.

## Part C — Turn `maxBots` into a Robust Budget Guard

### Why

The existing create-time check is useful, but not sufficient as a cost-control mechanism.

The observed risk is not “no limit exists”; it is that the limit can be bypassed through:

- concurrent create/start requests
- start paths that do not apply the same guard
- runtime states where multiple bots are marked running before a serialized decision is made

### Approach

#### C1. Enforce `maxBots` on `start`, not only `create`

Apply the same agent-level running-bot check on:

- broker `start`
- direct API start path

Reclaim of already-running bots should **not** be blocked by this check, because reclaim is not creating additional runtime budget; it is restoring ownership of a bot already counted as running.

#### C2. Make create/start enforcement atomic per agent

The current pattern is a read (`countRunningBotsByCreator`) followed by write/mark-running, which is race-prone.

Introduce serialized enforcement for agent bot lifecycle actions, using one of:

- advisory lock per `agent.id`, or
- transactional helper in the repository that checks count and marks/creates within one critical section

Preference: use the same class of database-side serialization already used elsewhere for bot creation, rather than adding an in-memory worker-only mutex.

#### C3. Keep semantics budget-oriented, not policy-oriented

This is still a resource/cost guard, not a constraint on agent autonomy.

The limit should only answer:

> can this agent run another bot right now without exceeding its budgeted concurrency?

It should not become a broader behavioral approval layer.

### Files likely touched

- `apps/worker/src/agents/agent-message-broker.ts`
- `apps/api/src/routes/bots.ts`
- `packages/db/src/repositories.ts`
- tests covering concurrent create/start behavior

### Acceptance criteria

- Concurrent create/start requests for the same agent cannot exceed `maxBots`.
- `start` and `create` apply the same effective budget rule.
- Reclaim of already-running bots still works.
- Existing plan-level bot caps continue to work independently.

## Recommended Delivery Order

1. Land `003` session circuit breaker and non-wakeable event work.
2. Extend the existing tick gate fingerprint with watch/wake prompt-driving state.
3. Add start-time preflight validation and terminal invalid-config handling.
4. Add atomic `maxBots` enforcement across create/start.

## Test Plan

### Tick gate

- unchanged scheduled tick skips when watch summary and queued signal digest also match
- wake-triggered tick still runs
- forced periodic evaluation still runs
- drift-only snapshot suppression from `003` no longer causes false gate misses

### Invalid config

- invalid persisted config is rejected before start enqueue
- startup parse failure is terminal/non-retriable until config change
- valid config update clears the blocked state

### `maxBots`

- concurrent create requests cannot both exceed the limit
- concurrent start requests cannot both exceed the limit
- reclaim path can still restart a bot already counted as running

## Rollout Notes

- Reuse existing control points first; prefer tightening over introducing new loops.
- Keep defaults/config in typed config, not hardcoded.
- Preserve the existing wake model and hybrid no-wake behavior.
- Do not bundle prompt caching work into this plan.

## Summary

This plan does **not** propose a fresh cost-control architecture.

It assumes the current direction is correct:

- `003` handles semantic loops and non-wakeable churn
- the existing tick gate remains the main scheduled-tick admission control
- existing config validation and bot error halting remain the foundation

The follow-on work is to make those controls **more complete and harder to bypass**, especially around prompt-driving state, invalid start retries, and concurrent bot-count enforcement.