# Next Implementation Slice: 012 Item 10 And Item 12

**Status:** Draft (revised 2026-07-19 after critique — resolutions H1–H3, M1–M4, L1–L4 folded into the relevant sections and tagged inline)
**Follows:** [012b-reconciliation-matrix.md](./012b-reconciliation-matrix.md)
**Primary closure target:** [006-followup-plan.md](./006-followup-plan.md) C6 and C7
**Purpose:** Convert the two deferred parts of the implemented `012` slice into one concrete, code-checked implementation plan.

This document is grounded in the current source tree as checked on 2026-07-19. It does **not** assume that all of `012` was completed correctly. Instead it records what is already implemented, what is still missing, and applies the now-settled design decision for binding reload:

- reuse the existing actor config-application path;
- do **not** introduce a new binding-specific actor/runtime message in this slice;
- add explicit acknowledgement around the reload call;
- emit the existing runtime config-update event separately for prompt/runtime visibility.

---

## 0. Scope

This slice covers only the two deferred items from the implemented `012` work:

1. **Item 10** — wire actor/runtime consumption of authoritative preset bindings and complete the transition reload/acknowledgement path.
2. **Item 12** — add the missing unit/integration proof required to satisfy `006` C6 and C7.

This slice does **not** re-open:

- request/billing architecture from [007-assessment-billing-completion-plan.md](./007-assessment-billing-completion-plan.md)
- evidence/LLM ranking logic from `008` / `009`
- scanner pre-check design from `010`
- final legacy cleanup from `013`

This slice **does** include small reconciliation fixes when they directly block Item 10 or Item 12. In particular, stale shadow-mode logic from `006b` cannot be allowed to drive new runtime/test behavior.

---

## 1. Code-Checked Baseline

The following statements are verified against the current codebase.

### 1.1 What is implemented already

| Surface | Current state | Evidence |
|---|---|---|
| Transition service exists | `PresetTransitionService` exists and implements `PresetTransitionPort` | `apps/worker/src/market-intelligence/preset-transition-service.ts` |
| Identity resolver exists | `AssessmentIdentityResolverImpl` exists and resolves identity from bindings/config/cache | `apps/worker/src/market-intelligence/assessment-identity-resolver.ts` |
| Assessment port wiring exists | `assess_strategy_preset` delegates through `AssessmentRequestPort` | `apps/worker/src/tools/assess-strategy-preset.ts` |
| Change/apply port wiring exists | `change_strategy_preset` delegates through `PresetTransitionPort` | `apps/worker/src/tools/change-strategy-preset.ts` |
| Review wake plumbing exists | `assessment_review` wake construction and message rendering exist | `apps/worker/src/market-intelligence/review-scheduler.ts`, `apps/worker/src/assessment-review-message.ts`, `apps/worker/src/agent-assessment-review.test.ts` |
| Actor config-update hook exists | Worker can call `actor.applyPendingConfigUpdate(config)` on `agent.config.update` | `apps/worker/src/index.ts`, `apps/worker/src/agent-trading-actor.ts` |

### 1.2 What is still not implemented

| Gap | Current state | Evidence |
|---|---|---|
| Worker runtime does not consume `agent_preset_bindings` for execution | Review scheduler still derives active preset from unified config and strategy config, not authoritative binding state | `apps/worker/src/index.ts` in `resolveActivePreset`, comment: `Until Plan 012 delivers authoritative preset bindings...` |
| Transition service does not notify a live actor | Worker wires `PresetTransitionService({ db, notifyActor: undefined })` | `apps/worker/src/index.ts` |
| Actor ack path is not implemented | `notifyActor` callback is optional; there is no binding-specific ack/reconcile flow | `apps/worker/src/market-intelligence/preset-transition-service.ts` |
| Change tool still enforces stale shadow-mode gate | Tool blocks on `platformAssessment.mode === 'recommend_only'` | `apps/worker/src/tools/change-strategy-preset.ts` |
| Transition service still enforces stale shadow-mode gate | Service blocks on `platformAssessment.mode === 'recommend_only'` | `apps/worker/src/market-intelligence/preset-transition-service.ts` |
| Domain config still contains stale shadow-mode field | `PlatformAssessmentOptInSchema` still includes `mode: recommend_only | apply_capable` | `packages/domain/src/config/schema.ts`, `packages/domain/src/config/assessment-config.ts` |
| No unit tests for binding resolver | No `assessment-identity-resolver.test.ts` exists | `apps/worker/src/market-intelligence/` directory |
| No unit tests for transition service | No `preset-transition-service.test.ts` exists | `apps/worker/src/market-intelligence/` directory |
| No integration proof for actor reload / binding effect | Existing tests cover tool adapters only, not runtime state change | `apps/worker/src/tools/*.test.ts`, `apps/worker/src/runtime-composition.test.ts` |

### 1.3 What this means

The current codebase has completed the **service/tool scaffolding** part of `012`, but not the **runtime-consumption** part and not the **closure-proof** part.

That is exactly why Item 10 and Item 12 remain open.

---

## 2. Locked Direction For Binding Reload

The codebase did not settle the reload contract by itself, but this slice now has an explicit implementation choice.

### 2.1 Chosen transport contract

Current code supports two adjacent but different update channels:

| Channel | Current payload | Current use |
|---|---|---|
| `agent.config.update` | `{ config }` | Worker → actor config updates via `applyPendingConfigUpdate()` |
| `agent.runtime.config_update` | `{ runtimeDescriptor, reason }` | Agent-runtime prompt/runtime-descriptor refresh, not actor config reload |

This slice chooses the following:

1. **Reuse `agent.config.update { config }` for the actor reload path.**
2. **Materialize the binding-derived effective technical config in the worker before sending it to the actor.**
3. **Do not add a new binding-specific actor/runtime message in this slice.**
4. **Emit the existing runtime config update event separately only for prompt/runtime visibility.**

> **(H3)** "Reuse `agent.config.update`" here means reuse the actor **method** `applyPendingConfigUpdate` — for a local (in-process) actor the worker calls it directly via the actor registry. When the actor is leased to a **different** worker, the direct call cannot reach it and the reload must be delivered over the `agent.config.update` Redis **message** channel instead. Decide and document which path applies (local direct call vs. remote message route) as part of Step 3/Step 5.

Reasoning:

- `AgentTradingActor` already applies config-shaped updates through `applyPendingConfigUpdate()`.
- The actor currently consumes technical config, not binding objects.
- Reusing the existing path minimizes protocol churn and lets Item 10 focus on authoritative binding consumption and acknowledgement semantics.
- Runtime-descriptor visibility is a separate concern from execution config application and should remain separate.

### 2.2 Chosen runtime application model

The actor should not receive binding identity and resolve config for itself in this slice.

Instead:

- the worker resolves the authoritative active binding;
- the worker materializes the effective technical config from that binding plus permitted overrides;
- the worker sends that effective config through the existing config-application path;
- the actor acknowledges success/failure of config application.

The current actor update path only accepts config-shaped updates:

```ts
applyPendingConfigUpdate(newConfig: { technical?: TechnicalConfig | null; execution?: { mode?: string } } | null)
```

This slice makes that implication explicit and turns it into the implementation contract.

> **(H3)** Note the current return type is `void`, which provides no acknowledgement signal. This slice changes the signature to return an applied/rejected `Result` so the service can gate transition success on real acknowledgement (see Step 4).

---

## 3. Item 10: Concrete Implementation Plan

### 3.1 Goal

Make a successful preset transition change the **effective preset used by the running actor**, not just Postgres state.

This is the implementation half of `006` C6.

### 3.2 Required outcome

After a successful `change_strategy_preset` call:

1. the authoritative binding row is updated in `agent_preset_bindings`;
2. the running actor receives a binding/config reload request;
3. the actor applies the new effective technical config;
4. the service records success only after acknowledgement or deterministic reconciliation;
5. transition failure leaves runtime behavior unchanged.

### 3.3 Ordered work

#### Step 1 — remove stale shadow-mode blockers before runtime work

This is a prerequisite reconciliation fix.

Files:

- `packages/domain/src/config/schema.ts`
- `packages/domain/src/config/assessment-config.ts`
- `apps/worker/src/tools/change-strategy-preset.ts`
- `apps/worker/src/market-intelligence/preset-transition-service.ts`
- affected tests

Actions:

- remove `platformAssessment.mode`
- remove `recommend_only` / `apply_capable`
- remove tool/service transition blocks based on `recommend_only`
- update tests to use `platformAssessment.enabled` only

Reason:

Item 10 must target the real two-tool, no-shadow-mode phase-1 model from `005` D8 and `006b` P3/P4.

> **(M1)** `006b`'s status header claims P3/P4 (shadow-mode removal) are complete, but the code still contains `mode: recommend_only | apply_capable` in `packages/domain/src/config/schema.ts` and the `recommend_only` gate in both `apps/worker/src/tools/change-strategy-preset.ts` and `apps/worker/src/market-intelligence/preset-transition-service.ts`. This step **completes** `006b` P3/P4 — it does not duplicate them. Update the `006b` status line to reflect that P3/P4 were not actually finished.

#### Step 2 — introduce authoritative binding lookup for runtime use

Files:

- `apps/worker/src/index.ts`
- `apps/worker/src/market-intelligence/review-scheduler.ts`
- any new binding-resolution helper module

Actions:

- introduce authoritative binding lookup from `agent_preset_bindings` for runtime use
- support most-specific binding lookup first, then `scope = 'default'`
- **(H1)** when no binding row exists, fall back to unified-config derivation — do **not** hard-replace `resolveActivePreset()`. Bindings are only created on transition, so a fresh agent that has never transitioned has no binding row (the common case). The lookup contract is: authoritative binding if present, else derive from unified config (today's behaviour) as the default seed.
- **(H1)** the `agent_preset_bindings` row only carries `activePresetKey`, `styleTier`, `behaviorVersion`, `appliedPresetVersion`. It does **not** carry `signalBias`, `enabledIndicators`, `compatibilityThresholds`, or `scanInterval` that the review-scheduler pre-check consumes. When resolving from a binding, project the preset key into those derived fields via the preset catalog (`applyPresetToAgent`), not from the binding row alone.
- centralize this lookup in one helper/service rather than duplicating it in scheduler and transition code

Reason:

Current worker code still derives active preset from unified config. That directly contradicts `012`'s binding-state model — but the derivation path must be preserved as the no-binding fallback (see H1 above), not deleted.

#### Step 3 — define the actor reload contract using the existing config path

Files likely touched:

- `apps/worker/src/index.ts`
- `apps/worker/src/agent-trading-actor.ts`
- possibly `apps/worker/src/agent.ts`

Optional prompt/runtime visibility surface:

- `apps/worker/src/runtime-composition.ts`
- `apps/worker/src/runtime-composition.test.ts`

Actions:

- reuse the actor config-application **method** (`applyPendingConfigUpdate`) for actor reload — see H3 below
- **(H2)** materialize the binding-derived effective technical config using the existing `applyPresetToAgent` and `computePresetBehaviorVersion` primitives in `packages/domain/src/config/presets.ts`. This is the load-bearing piece of Item 10 and must be a first-class, named step — not an incidental "helper". Without real materialization the actor is handed a placeholder/identical config and the C6 proof ("actor technical config changes after reload") cannot pass.
- **(H2)** replace the hardcoded `behaviorVersion: 'v1'` / `newBehaviorVersion: 'v1'` stubs in `preset-transition-service.ts` (transition record **and** binding upsert) with `computePresetBehaviorVersion` output as part of this step.
- **(H3)** the actor config-application path must report success/failure. `applyPendingConfigUpdate` currently returns `void`; change it to return a `Result` (or throw meaningfully) so acknowledgement is a real signal, not an assumption.
- **(H3)** address actor locality: the transition service and actor registry are in-process, but `006` scenario 6 / C4 cover cross-worker actor leases. If the target actor is leased to another worker, an in-process `actorRegistry.get` call cannot reach it — the reload must route via the `agent.config.update` Redis message. Decide and document the locality behaviour (in-process direct call when local; message route when remote or absent).
- **(M4)** decide ownership of materialization explicitly: the worker `notifyActor` callback materializes the effective config from the resolved binding, then applies it via the config path. Keep the plan's two descriptions consistent — either the callback re-loads + materializes, or the service passes an already-materialized config. Do not describe both.
- emit the existing runtime config update event separately when runtime/prompt visibility of the new preset is needed

Minimum acknowledgement contract:

- accepted reload request
- applied reload successfully
- rejected/failed reload with reason

**(H3)** This acknowledgement does **not** require a new protocol message in this slice, but it **does** require `applyPendingConfigUpdate` to return an applied/rejected result. It may be implemented as the success/failure contract of the worker callback that invokes the running actor's config application path, provided that callback can observe the actor's applied/rejected outcome.

#### Step 4 — teach the actor to apply binding-derived config through `applyPendingConfigUpdate()`

Files:

- `apps/worker/src/agent-trading-actor.ts`
- possibly `apps/worker/src/technical-phase.ts`
- any config-materialization helper

Actions:

- **(H3)** extend `applyPendingConfigUpdate()` to return an applied/rejected `Result` (not `void`) so the reload can be acknowledged. This is required, not conditional — the current signature `applyPendingConfigUpdate(newConfig): void` provides no acknowledgement channel.
- ensure the actor applies the binding-derived effective technical config (materialized per H2 in Step 3)
- ensure technical scan loop restarts when binding-derived technical config changes
- ensure no restart is required for the basic `entries_only` transition path unless execution invariants require one

Preferred direction:

- keep `applyPendingConfigUpdate()` as the actor entry point;
- do not add a new binding-specific actor method unless the existing config path proves insufficient during implementation.

#### Step 5 — wire `PresetTransitionService.notifyActor`

Files:

- `apps/worker/src/index.ts`
- `apps/worker/src/market-intelligence/preset-transition-service.ts`

Actions:

- replace `notifyActor: undefined` with a real callback
- callback must materialize binding-derived effective config (per H2) and apply it to the running actor via the existing config path, observing the actor's applied/rejected result (per H3)
- service must not mark transition `applied` until reload success is observed
- **(L1)** fix the latent argument mismatch: `applyTransition` currently calls `this.deps.notifyActor(agentId, transitionId)` while the deps parameter is named `bindingId`. Since this step rewrites the callsite, correct the name/semantics so the callback receives the identifier it actually needs (agent + resolved binding).
- **(H3)** the callback must handle the actor-absent / cross-worker case rather than assuming success — see Step 6.

Optional visibility step:

- **(L3)** after successful actor config application, optionally emit the existing runtime config update event with reason `binding_changed` so the agent runtime summary can reflect the new active preset/binding state. Note: the existence of this `agent.runtime.config_update` event is **unverified in this plan's baseline** — confirm it before relying on it. It is visibility-only and not required for Item 10 completion.

#### Step 6 — add reconciliation path for missing ack / worker restart

Files:

- `apps/worker/src/market-intelligence/preset-transition-service.ts`
- possibly worker startup/recovery code

Actions:

- define what happens if actor is absent, dead, or restart interrupts the transition
- convert current optimistic assumption into a deterministic outcome
- ensure failed reload leaves transition in `failed` and does not silently claim success
- **(M3)** commit to a concrete startup reconciliation rule: on worker startup, any transition left in `applying` (interrupted mid-flight) must resolve deterministically — either re-drive the reload or mark `failed`. `006` scenario 11 requires in-flight transition state to be recoverable from Postgres after restart.
- **(M3)** if full restart-recovery proof is deferred out of this slice, say so explicitly here and in the completion bar (§3.4) so the gap is intentional rather than silent.

### 3.4 Item 10 completion bar

Item 10 is complete only when:

- worker resolves active preset from the authoritative binding when one exists, and falls back to unified-config derivation when none exists **(H1)**;
- binding-derived effective technical config is materialized via `applyPresetToAgent` / `computePresetBehaviorVersion`, with the `'v1'` stubs removed **(H2)**;
- `PresetTransitionService` uses a real `notifyActor` implementation;
- actor runtime actually reloads binding-derived config via the existing config-application path, and `applyPendingConfigUpdate` returns an applied/rejected result **(H3)**;
- transition success depends on actor acknowledgement/reconciliation, including the actor-absent / cross-worker case **(H3)**;
- restart reconciliation of in-flight (`applying`) transitions is either proven or explicitly deferred **(M3)**;
- there is no stale `recommend_only` gate anywhere in the change/apply path.

---

## 4. Item 12: Concrete Test Plan

### 4.1 Goal

Produce the missing executable proof for `006` C6 and C7.

### 4.2 What tests already exist

| Test area | Current coverage | Evidence |
|---|---|---|
| Tool adapter validation | Good coverage for `change_strategy_preset` guard paths and adapter behavior | `apps/worker/src/tools/change-strategy-preset.test.ts` |
| Tool adapter validation | Basic/fallback coverage for `assess_strategy_preset` | `apps/worker/src/tools/assess-strategy-preset.test.ts` |
| Review wake message | Good UI/message coverage for `assessment_review` prompt text | `apps/worker/src/agent-assessment-review.test.ts` |
| Request service | Broad unit coverage exists | `apps/worker/src/market-intelligence/assessment-request-service.test.ts` |

### 4.3 What tests are missing

> **(M2)** This slice implements `entries_only` runtime consumption only. `entries_and_tighten_existing` (position actions) is **out of scope** here. Tightening-mode tests below are therefore **rejection-only**: they assert the tightening path is refused with no position action and no binding change. Full tightening reconciliation proof is deferred to the slice that implements position actions.

| Missing test | Why it matters |
|---|---|
| `AssessmentIdentityResolverImpl` unit tests | `012` requires identity resolution, binding precedence, venue readiness, token-resolution failure paths |
| `PresetTransitionService` unit tests | `012` requires exact artifact checks, allowed-policy checks, stale/mismatched artifact failure, runtime-failure handling |
| Runtime/actor reload integration test | `006` C6 explicitly requires actor state change, not just DB writes |
| Exact-artifact handoff integration test | `006` C7 requires that a billed artifact ID is used exactly, never substituted |
| Tightening-mode **rejection** test (M2) | Proves `entries_and_tighten_existing` is refused in this slice with no position action and no binding mutation — locks the safety invariant that tightening cannot silently no-op into an `entries_only` apply |

### 4.4 Required new tests

#### A. New unit test file: `assessment-identity-resolver.test.ts`

Target file:

- `apps/worker/src/market-intelligence/assessment-identity-resolver.test.ts`

Cases:

- resolves venue/instrument from bot binding
- falls back to unified config when no bot binding exists
- returns `no_binding` when neither exists
- resolves style tier from `agent_preset_bindings`
- returns `no_style_tier` when no active default binding exists
- fails closed when venue instrument cache is not ready
- fails when token resolver is not configured
- resolves swap/dex symbol via token resolver
- rejects empty/whitespace symbol

#### B. New unit test file: `preset-transition-service.test.ts`

Target file:

- `apps/worker/src/market-intelligence/preset-transition-service.test.ts`

Cases:

- recommend path: artifact missing / expired
- recommend path: already on recommended preset
- recommend path: top-ranked preset blocked by allowed-presets policy
- apply path: exact artifact required
- apply path: stale artifact rejected
- apply path: preset not allowed by agent policy
- apply path: preset not in artifact allowed set
- apply path: transition persists `prepared -> applying -> applied`
- apply path: actor notification failure leaves state `failed`
- apply path: binding upsert happens only after successful actor notification

#### C. Runtime integration test: binding reload applies to actor

Suggested target:

- extend `apps/worker/src/runtime-composition.test.ts` or add a new focused runtime integration test file

Cases:

- simulate successful transition application
- assert actor receives reload/config update
- assert actor technical config / active preset changes after reload
- assert technical scan loop or relevant runtime surface reflects new binding-derived config

#### D. Exact-artifact handoff test for C7

Suggested target:

- service-level or tool-to-service integration test

Cases:

- **(L2)** `change_strategy_preset` uses the exact `assessmentArtifactId` it is given (the agent performs the handoff — no code auto-passes it between tools)
- a newer artifact for the same identity does not get substituted
- stale/mismatched artifact is rejected without implicit reassessment

### 4.5 Item 12 completion bar

Item 12 is complete only when:

- new unit tests exist for `AssessmentIdentityResolverImpl` and `PresetTransitionService`;
- one integration test proves `entries_only` changes authoritative binding **and** running actor state;
- one integration test proves exact artifact handoff with no substitution;
- one failure-path integration test proves no success is recorded after actor/action failure;
- a rejection-only test proves `entries_and_tighten_existing` is refused in this slice **(M2)**;
- stale shadow-mode assertions are removed from the test surface.

---

## 5. Files Expected To Change In This Slice

### Runtime / binding consumption

- `packages/domain/src/config/schema.ts`
- `packages/domain/src/config/assessment-config.ts`
- `packages/domain/src/config/presets.ts` — reuse `applyPresetToAgent` / `computePresetBehaviorVersion` for materialization **(H2)**
- `apps/worker/src/index.ts`
- `apps/worker/src/agent-trading-actor.ts` — `applyPendingConfigUpdate` returns applied/rejected `Result` **(H3)**
- `apps/worker/src/market-intelligence/preset-transition-service.ts` — remove `'v1'` stubs in transition record and binding upsert; fix `notifyActor` arg **(H2, L1, L4)**
- `apps/worker/src/market-intelligence/review-scheduler.ts`
- `apps/worker/src/tools/change-strategy-preset.ts`
- optionally `apps/worker/src/runtime-composition.ts` for prompt/runtime visibility only (event existence unverified — **L3**)

### Tests

- `apps/worker/src/market-intelligence/assessment-identity-resolver.test.ts` (new)
- `apps/worker/src/market-intelligence/preset-transition-service.test.ts` (new)
- `apps/worker/src/tools/change-strategy-preset.test.ts`
- `apps/worker/src/runtime-composition.test.ts` or new focused runtime reload test file

---

## 6. Proposed Execution Order

1. Remove stale shadow-mode field/gates/tests.
2. Add authoritative binding lookup helper and wire worker/review scheduler to it.
3. Materialize binding-derived effective technical config in the worker.
4. Implement actor reload through the existing `agent.config.update { config }` application path.
5. Add explicit acknowledgement around the reload call and wire a real `notifyActor` callback.
6. Emit the existing runtime config update event separately for visibility if needed.
7. Add resolver and transition-service unit tests.
8. Add runtime/exact-artifact integration tests.
9. Run focused proof for `006` C6/C7.

---
