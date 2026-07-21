# Bug Report: Staging Agents Never Trade — `AgentTradingActor.start()` Never Called

- **Status:** FIXED — RC1/RC2 fixes and recommended regression tests (items 1–4 below) implemented and verified (`pnpm --filter @herobids/worker exec vitest run`, `pnpm lint`, `pnpm build` all pass). Items 5–6 (CI gating, post-deploy smoke check) are follow-up infra work, not yet implemented.
- **Severity:** CRITICAL — blocks all trading for every agent capability mode (`intelligence`, `mixed`, `scanner_gated`), not just scanner-gated hybrid agents.
- **Date:** 2026-07-21
- **Environment:** Discovered on staging (`128.140.55.192`, `staging.openaidom.com`), worker container `herobids-worker-1`. Root cause is in shared worker composition code and is environment-independent (affects production identically once deployed).
- **Related feature:** [docs/features/2026/07/18/002-platform-preset-assessment-and-transition/](../../18/002-platform-preset-assessment-and-transition/) — specifically item `010` (scanner pre-check / deterministic review advice), companion to `001-plan.md` and `006-followup-plan.md`.

## Summary

Three staging trading agents (`mo-day` / momentum, `swing`, `range`, all `scanner_gated` hybrid mode) ran for 38+ hours with zero trades, zero scan candidates, zero signals, and zero platform preset-assessment activity. Root-caused to two defects introduced while implementing the platform preset-assessment-and-transition feature set:

1. **(RC1 — CRITICAL, regression)** `AgentTradingActor.start()` is never invoked after the actor is constructed in `apps/worker/src/index.ts`. This was accidentally deleted in commit `b85fd19d` ("feat(010): implement scanner pre-check and deterministic review advice") while wiring the new `onPersistScanCandidates` callback into the actor's constructor call.
2. **(RC2 — HIGH, spec gap)** Per-agent `ReviewScheduler` instances (the platform preset-assessment review loop) are only created once, at worker boot, for agents that are already `active` in the DB at that moment (`agentRepo.listActiveAgents()`). Agents started/activated afterward — the normal path in production, since agents are started on demand — never get a scheduler. This directly violates the requirement already documented in [010-scanner-pre-check.md](../../18/002-platform-preset-assessment-and-transition/010-scanner-pre-check.md#L67): *"The scheduler registry must reconcile agents when they start/stop, enable/disable assessment, or update their review interval/config. Worker startup is not the sole lifecycle hook."*

Both defects were introduced/left unresolved during the `002-platform-preset-assessment-and-transition` feature work landed 2026-07-19.

## Impact

| Agent capability mode | Can dispatch LLM turn? | Can submit/execute a decision? | Affected? |
|---|---|---|---|
| `intelligence` | Yes (timer tick, no wake gate) | **No** — `getIntakeDeps()` returns `undefined` because `this.running` and `this.executor` are never set | ✅ Yes |
| `hybrid` / `mixed` | Yes (wake or timer) | **No** — same reason | ✅ Yes |
| `hybrid` / `scanner_gated` | **No** — scanner never starts, so no wake signal ever fires, so the hybrid no-wake guard skips every tick | **No** — same reason, moot since LLM never dispatches | ✅ Yes |

RC1 is a universal blocker: **no agent, in any capability mode, can currently execute a trade**, because the executor (`PaperExecutor`/`ShadowExecutor`/`LiveExecutor`) is constructed inside `AgentTradingActor.start()`, which is never called. `getIntakeDeps()` gates on `this.running`, which is also only set `true` inside `start()`.

RC2 additionally means the adaptive strategy-preset feature (platform preset assessment → wake → `assess_strategy_preset` / `change_strategy_preset`) cannot function for any agent that was started after the worker process booted — which is the normal lifecycle for every agent created through the UI/API.

## Evidence (staging, 2026-07-21)

- Worker logs (`herobids-worker-1`): exactly 3× `"Agent trading actor registered"`, **zero** `"Agent trading actor started"` — the log line emitted at the end of `AgentTradingActor.start()` (`agent-trading-actor.ts` line ~518) never appears.
- Worker logs contain **zero** occurrences of `"Technical scan loop started"`, `candidatesDiscovered`, `candidatesScored`, or `signalsGenerated`.
- Agent container logs repeat every ~30 min tick: `"Hybrid agent: timer tick without wake signal — skipping LLM dispatch"`.
- DB tables all empty for the 38h+ window:
  - `agent_scan_candidates` — 0 rows
  - `market_assessment_requests` — 0 rows
  - `agent_assessment_review_checks` — 0 rows
  - `agent_preset_bindings` — 0 rows
  - `agent_preset_transitions` — 0 rows
- Worker boot log: `"Review schedulers initialised — count: 0"` (all 3 agents were `status: 'stopped'` at worker boot time; they were started afterward via the API/session-manager path, so no scheduler was ever created for them).

## Root Cause 1 — Missing `actor.start()` call (regression)

**Introduced by:** commit `b85fd19d` — `feat(010): implement scanner pre-check and deterministic review advice` (2026-07-19).

**What happened:** The commit added a new `onPersistScanCandidates` callback property to the `AgentTradingActor` constructor call inside the `onSessionActive` handler in `apps/worker/src/index.ts`. In the same diff hunk, the two lines immediately following the constructor call — a blank line and `await actor.start();` — were deleted, apparently by accident while the callback body (many lines) was inserted before the closing `});`.

Diff (`git show b85fd19d -- apps/worker/src/index.ts`):

```diff
+          onPersistScanCandidates: async (candidates) => {
+            ... (new callback body) ...
+          },
         });
-
-        await actor.start();
-
         // Only register if the session is still active (not stopped during start)
         if (agentState.isSessionPending(agentId, sessionId)) {
           agentState.registerActor(agentId, sessionId, actor, mode, venueType);
```

**Why it breaks everything:** `AgentTradingActor.start()` (`apps/worker/src/agent-trading-actor.ts`) is responsible for:
- Setting `this.running = true`
- Resolving the venue adapter and constructing `this.executor`
- Rehydrating positions, risk trackers, reconciler
- Opening the private stream
- **Calling `this.startTechnicalScanLoop()`** — which starts the scanner that discovers candidates and emits wake signals

Since `start()` never runs, `agentState.registerActor(...)` stores an actor that is never `running`, has no `executor`, and never starts its scan loop. `ExecutionActor.getIntakeDeps()` immediately gates on `!this.running || ... || !this.executor` and returns `undefined` — every decision from every agent, regardless of capability mode, is rejected at intake.

## Root Cause 2 — Review schedulers only created at worker boot (spec gap)

**Introduced by:** commit `8a32acd5` — `feat(G5): ReviewScheduler instantiation in worker startup` (2026-07-19), and never closed by a follow-on commit.

**What happened:** The only place a `ReviewScheduler` is created is a one-time loop over `agentRepo.listActiveAgents()` executed once during worker process startup (`apps/worker/src/index.ts`, "Per-Agent Review Schedulers" section). There is no equivalent creation path inside `onSessionActive` / `handleHeartbeat` (`apps/worker/src/agents/agent-session-manager.ts`) for agents that transition to `active` after the worker has already booted — which is the normal case, since agents are started on demand through the API rather than pre-existing at worker boot.

This is a known, already-documented requirement that was not implemented. [010-scanner-pre-check.md](../../18/002-platform-preset-assessment-and-transition/010-scanner-pre-check.md) states explicitly:

> "The scheduler registry must reconcile agents when they start/stop, enable/disable assessment, or update their review interval/config. Worker startup is not the sole lifecycle hook."

**Why it breaks adaptive preset switching:** Without a running `ReviewScheduler` for an agent, `runPreCheck()` never executes for that agent, so no `assessment_review` scanner wake is ever emitted, so the agent never calls `assess_strategy_preset` / `change_strategy_preset`, so the entire platform preset-assessment-and-transition feature (`002-platform-preset-assessment-and-transition`) is inert for any agent started after boot. This is a secondary/independent blocker from RC1 — it would remain broken even after RC1 is fixed.

## Reproduction

1. Deploy the current staging build (or run the worker locally against a seeded agent).
2. Create and start an agent (any capability mode: `intelligence`, `mixed`, or `scanner_gated`).
3. Observe worker logs: `"Agent trading actor registered"` appears; `"Agent trading actor started"` never appears.
4. Wait for a tick (LLM dispatch for `intelligence`/`mixed`, or indefinitely for `scanner_gated` since no wake ever fires).
5. For `intelligence`/`mixed`: observe the agent's `submit_decision` calls are rejected at intake (executor undefined / not running).
6. For all modes: query `agent_scan_candidates`, `market_assessment_requests`, `agent_assessment_review_checks` — all remain empty indefinitely.
7. Confirm via `SELECT count(*) FROM agent_runtime_sessions WHERE status='running'` that sessions are healthy (heartbeats arriving) despite the actor doing nothing — the failure is silent, with no error logged.

## Fix Implemented

1. **RC1:** Restored `await actor.start();` immediately after the `AgentTradingActor` constructor call and before the `agentState.isSessionPending(...)` check in `apps/worker/src/index.ts` (`onSessionActive` handler).
2. **RC2:** Extracted the per-agent scheduler create/stop logic into `startReviewSchedulerForAgent()` / `stopReviewSchedulerForAgent()` functions in `apps/worker/src/index.ts`. These are now called both from the boot-time loop (agents active at boot) and from `onSessionActive`/`onSessionStopped` (agents activated/stopped afterward — the normal case). `startReviewSchedulerForAgent()` is idempotent (guards on `reviewSchedulers.has(agent.id)`), so calling it from both lifecycle hooks never double-registers a scheduler.
3. Added [agent-trading-actor-lifecycle.test.ts](../../../../apps/worker/src/agent-trading-actor-lifecycle.test.ts) — asserts `getIntakeDeps()` is `undefined` before `start()`, defined after `start()`, and `undefined` again after `stop()` (the exact runtime gate RC1 silently broke), plus a mirror of the `onSessionActive` activation sequence (start → check pending → register-or-discard, with start() failures propagating instead of being swallowed).
4. Added [review-scheduler-lifecycle-wiring.test.ts](../../../../apps/worker/src/review-scheduler-lifecycle-wiring.test.ts) — asserts the three gates in `startReviewSchedulerForAgent()` (operator switch, idempotency, agent opt-in), and specifically covers "an agent activated after worker boot still starts a scheduler" (the RC2 regression scenario).

## Files Changed

- `apps/worker/src/index.ts` — restored `actor.start()`; extracted `startReviewSchedulerForAgent()`/`stopReviewSchedulerForAgent()` and wired them into `onSessionActive`/`onSessionStopped`.
- `apps/worker/src/market-intelligence/review-scheduler.test.ts` (new) — `ReviewScheduler` lifecycle unit tests.
- `apps/worker/src/agent-trading-actor-lifecycle.test.ts` (new) — RC1 regression coverage (`getIntakeDeps()` gating, activation-sequence ordering).
- `apps/worker/src/review-scheduler-lifecycle-wiring.test.ts` (new) — RC2 regression coverage (scheduler gating/idempotency).

## Test Coverage Gap Analysis — Why Existing Tests Missed This

Both defects live in `apps/worker/src/index.ts` — the composition root that wires DB/config/class constructors together — which has **zero dedicated test coverage**. Every existing relevant test either mocks the callback or exercises the class in isolation, never the real composition-root wiring:

| Test file | What it covers | What it misses |
|---|---|---|
| [agent-session-manager.test.ts](../../../../apps/worker/src/agents/agent-session-manager.test.ts#L611) | Asserts `AgentSessionManager` *invokes* `onSessionActive` — but the callback under test is a `vi.fn()` mock | The real `onSessionActive` body in `index.ts` (which should call `actor.start()`) is never executed |
| [trading-actor.test.ts](../../../../apps/worker/src/trading-actor.test.ts), [scanner-gated-phase2.test.ts](../../../../apps/worker/src/scanner-gated-phase2.test.ts#L540) | Construct `AgentTradingActor` directly and call `await actor.start()` themselves | Never goes through `index.ts`'s `onSessionActive` — proves the class works, not that the composition root remembers to call it |
| `apps/worker/src/market-intelligence/*.test.ts` (12 files) | Unit-test `PlatformAssessor`, `AssessmentRequestService`, transition tools, wake gate, etc. | No `review-scheduler.test.ts` exists at all — the `ReviewScheduler` class itself is untested, and its boot-only creation loop in `index.ts` has no coverage |
| [scripts/ts/agent-trade-test.ts](../../../../scripts/ts/agent-trade-test.ts) | Creates a real agent, starts it, and explicitly asserts in Phase 3.5 that "decisions are non-rejected" — the one test that would likely have caught RC1 | Its own docstring states it is "NOT part of the routine test suite." No `.github/workflows/` CI exists in this repo to run it automatically before merge or staging deploy |

**Pattern:** unit tests verify units in isolation; the bug is in the glue connecting them (the composition root), which nothing exercises automatically end-to-end.

### Recommended Test Additions

1. **Composition-root wiring test (closes the actual gap):** extract/expose the real `onSessionActive` callback logic from `index.ts` so it's testable, and assert it calls `actor.start()` exactly once before/around `registerActor`, and that a `start()` rejection is not silently swallowed.
2. **`ReviewScheduler` unit tests** (currently none): basic `start()`/`stop()`/`runPreCheck()` lifecycle in isolation.
3. **Session-activation → scheduler-lifecycle test:** assert a scheduler is created when an opted-in agent becomes active *after* worker boot (not just agents active at boot), and stopped on session stop — this directly encodes the already-documented requirement in [010-scanner-pre-check.md](../../18/002-platform-preset-assessment-and-transition/010-scanner-pre-check.md#L67).
4. **Integration invariant check:** after a simulated activation using real class wiring, assert `actor.getIntakeDeps(instrumentId)` returns a defined result — this is the exact runtime gate RC1 silently broke, so testing this observable property catches future regressions regardless of mechanism.
5. **Promote `agent-trade-test.ts` to a gating check:** add CI (`.github/workflows/`) running `pnpm build && pnpm lint && pnpm test` per PR, plus a staging pre/post-deploy job running `scripts/shell/tests/agent-trade-test.sh` in paper mode (no real venue secrets needed).
6. **Post-deploy smoke check** in `infra/hetzner/scripts/`: query worker logs/DB for `"Agent trading actor started"` per active agent shortly after deploy; fail the deploy pipeline if any active agent never reaches that state.

## Verification Plan (post-fix)

1. `pnpm --filter @herobids/worker run test` passes, including new regression tests.
2. `pnpm lint` and `pnpm build` pass.
3. Local/staging smoke: start an agent, confirm `"Agent trading actor started"` appears in worker logs, `agent_scan_candidates` receives rows within one scan interval, and (for opted-in agents) a `ReviewScheduler` log line appears for the agent even though the worker was already running.
4. Re-run the staging investigation queries (`agent_scan_candidates`, `market_assessment_requests`, `agent_assessment_review_checks`) and confirm non-empty activity within one review interval after restart.
