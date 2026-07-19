# Reconciliation Matrix: 012 Tool Context Wiring vs 005 / 006b

**Status:** Draft
**Purpose:** Reconcile [012-tool-context-wiring.md](./012-tool-context-wiring.md) against the later controlling documents [005-implementation-checklist-per-symbol-on-demand.md](./005-implementation-checklist-per-symbol-on-demand.md) and [006b-followup-plan-2.md](./006b-followup-plan-2.md), and identify what remains as the two deferred items from the implemented 012 slice.

## 1. Precedence Rule

Use the following authority order when interpreting `012`:

1. [005-implementation-checklist-per-symbol-on-demand.md](./005-implementation-checklist-per-symbol-on-demand.md)
2. [006-followup-plan.md](./006-followup-plan.md)
3. [006b-followup-plan-2.md](./006b-followup-plan-2.md)
4. [007-assessment-billing-completion-plan.md](./007-assessment-billing-completion-plan.md)
5. [012-tool-context-wiring.md](./012-tool-context-wiring.md)

Implications:

- `012` is authoritative only where it does not conflict with later locked decisions.
- `012`'s archived draft section is historical only and must not be implemented.
- The feature surface is now the two-tool model from `006b`, not the four-tool model still described in parts of `012`.

## 2. High-Level Outcome

The implemented `012` slice should now be read as:

- **Keep:** authoritative preset binding state, exact-artifact transition handoff, `PresetTransitionService`, `AssessmentIdentityResolver`, typed ports, risk-preserving transition rules, actor-runtime reload/ack requirement.
- **Override:** rollout mode / shadow mode, four-tool surface, any implication that `get_market_preset_assessment`, `recommend_preset_transition`, or `apply_preset_transition` remain active phase-1 tools.
- **Finish:** actor-runtime binding reload and acknowledgement, plus the executable proof required by C6/C7 in [006-followup-plan.md](./006-followup-plan.md).

## 3. Section-by-Section Reconciliation Matrix

| 012 section | 012 claim | Status after 005 / 006b | Controlling source | Action |
|---|---|---|---|---|
| `Authoritative Plan` header | Implement only the top section; ignore archived draft | **Still valid** | `012` | Keep this distinction. |
| `Transition Scope Decision` | Transition applies to a **per-identity future-entry preset binding**; default binding remains separate | **Still valid** | `012`, `005` D5 | Keep. This is the core binding model. |
| `Transition Scope Decision` | Add `agent_preset_bindings` as first-class active state | **Still valid** | `012` | Keep. This remains the authoritative persistence model. |
| `Transition Scope Decision` | Effective technical config is derived from binding + permitted overrides | **Still valid** | `012` | Keep. This directly feeds deferred Item 10. |
| `One Transition Service` | Use one worker-owned `PresetTransitionService` | **Still valid** | `012` | Keep. This remains the correct application-service boundary. |
| `One Transition Service` | `apply_preset_transition` is a thin adapter | **Overridden in naming only** | `006b` P2 | Preserve the thin-adapter rule, but the active tool name is `change_strategy_preset`. |
| `One Transition Service` steps 1-4 | Exact artifact load, binding/policy resolution, deterministic compatibility check, pure transition preparation | **Still valid** | `012`, `006b` A1 | Keep. These remain required. |
| `One Transition Service` steps 5-6 | Persist intent, make binding/config durable, notify actor, await acknowledgement/reconciliation | **Still valid and unfinished** | `012`, `006` C6 | This maps directly to **Deferred Item 10**. |
| `One Transition Service` step 7 | Persist exact old/new keys, versions, identity snapshot, artifact ID, scope/mode, action results, outcome/reason | **Still valid** | `012`, `006b` A1 | Keep. This remains the auditability contract. |
| `One Transition Service` state machine | `prepared`, `applying`, `applied`, `deferred`, `rejected`, `failed`, `partially_applied` | **Still valid** | `012` | Keep. Phase 1 may only exercise a subset, but the model is still sound. |
| `Risk And Position Rules` | Creator-locked risk always wins over preset defaults | **Still valid** | `012`, `001`, `000-notes.md` item 4 | Keep. This is a non-negotiable invariant. |
| `Risk And Position Rules` | `entries_only` affects future-entry binding only | **Still valid** | `012`, `002` D12 | Keep. Required for `change_strategy_preset`. |
| `Risk And Position Rules` | `entries_and_tighten_existing` only when policy allows; only permitted protection-tightening actions | **Still valid** | `012`, `002` D12 | Keep. Tests for this map to Deferred Item 12. |
| `Risk And Position Rules` | Must await execution acknowledgement or reconcile actual position state before recording success | **Still valid and unfinished** | `012`, `006` C6 | This maps directly to **Deferred Item 10** and **Deferred Item 12**. |
| `Rollout Mode` | Add `platformAssessment.mode` with `recommend_only` default and apply-capable mode | **Overridden** | `005` D8, `006b` P3/P4 | Remove as a live requirement. Shadow mode is no longer part of phase 1. |
| `Rollout Mode` | Missing/unrecognized mode must not be apply-capable | **Obsolete with shadow-mode removal** | `006b` | Replace with: `platformAssessment.enabled` is the feature gate. |
| `Tool And Identity Wiring` | Do not proliferate `ToolContext` callbacks; use typed worker-owned ports | **Still valid** | `012`, `007` | Keep. This remains the correct transport rule. |
| `Tool And Identity Wiring` | Expose `AssessmentRequestPort` and `PresetTransitionPort` | **Still valid** | `012`, `007` | Keep. These are the right ports. |
| `Tool And Identity Wiring` | `AssessmentIdentityResolver` wraps venue normalization, token resolution, instrument inference, style-tier resolution | **Still valid** | `012` | Keep. This remains authoritative. |
| `Tool Contracts` row: `get_market_preset_assessment` | Dedicated public assessment-read/request tool | **Overridden** | `006b` P1 | Remove from active phase-1 surface. Its responsibility is absorbed into `assess_strategy_preset`. |
| `Tool Contracts` row: `assess_strategy_preset` | Bounded batch adapter over `AssessmentRequestPort` | **Still valid, but strengthened** | `006b` P1, P9, P10 | Keep, but use `006b` as the authoritative contract for request/response shape and batch semantics. |
| `Tool Contracts` row: `recommend_preset_transition` | Separate recommendation tool using exact artifact | **Overridden** | `006b` P1 | Remove from active phase-1 tool surface. Recommendation payload is returned by `assess_strategy_preset`. |
| `Tool Contracts` row: `apply_preset_transition` | Separate apply tool delegates to `PresetTransitionService` | **Overridden in naming only** | `006b` P2 | Keep behavior, but the active tool name is `change_strategy_preset`. |
| `Tool Contracts` prose | Tools must not advertise an action as applied if they only wrote an audit row | **Still valid** | `012` | Keep. This remains critical. |
| `Required Changes And Tests` row: DB schema | Add preset bindings and transition/action state | **Still valid** | `012` | Keep. |
| `Required Changes And Tests` row: Domain/config | Add rollout mode, active-binding types, identity resolver, transition contracts | **Partially overridden** | `005` D8, `006b` P3 | Keep active-binding/identity/transition parts; drop rollout-mode requirement. |
| `Required Changes And Tests` row: Worker/actor runtime | Resolve bindings for candidate execution; reload versioned binding/config and acknowledge application | **Still valid and unfinished** | `012`, `006` C6 | This maps directly to **Deferred Item 10**. |
| `Required Changes And Tests` row: Assessment tools | Delegate through typed ports; remove hardcoded values and direct business logic | **Still valid, but only for the two-tool model** | `012`, `006b` P1/P2/P8 | Keep, but apply only to `assess_strategy_preset` and `change_strategy_preset`. |
| `Required Changes And Tests` row: API/config path | Validate new mode and policy at write time | **Partially overridden** | `005` D8, `006b` P3 | Keep policy validation; drop mode validation. |
| `Required Changes And Tests` tests paragraph | Unit tests: identity, binding precedence, exact artifact, style/allowed-policy, rollout mode, dwell/day limits, risk restrictions | **Partially overridden and unfinished** | `006`, `006b`, `005` D8 | Keep all except rollout-mode assertions. This maps directly to **Deferred Item 12**. |
| `Required Changes And Tests` tests paragraph | Integration tests: `entries_only` updates authoritative binding and actor state; tightening mode reconciles position actions; no mutation occurs in `recommend_only`, stale/mismatched artifacts, actor/action failure | **Partially overridden and unfinished** | `006` C6/C7, `005` D8 | Keep binding/actor-state, exact-artifact, stale/mismatch, and actor/action failure tests. Remove `recommend_only` expectations. This maps directly to **Deferred Item 12**. |
| `Completion Bar` final line | Plan complete only when `006` C6 and C7 have executable proof | **Still valid** | `012`, `006` | Keep. This is the authoritative closure gate for 012. |
| `Archived Draft - Do Not Implement` | ToolContext optional callbacks and old three/four-tool wiring plan | **Superseded** | `012` itself, plus `006b` | Do not use as an implementation source. It is historical context only. |

## 4. Direct Mapping To The Two Deferred Items

### 4.1 Deferred Item 10: Wire actor runtime for binding reload

This item comes directly from the still-valid parts of `012` and is not optional cleanup.

| Source in 012 | Remaining obligation | Why it is still open |
|---|---|---|
| `Transition Scope Decision` | Resolve the most-specific active binding for a candidate identity, then fall back to default binding | Binding state exists, but runtime consumption must be authoritative. |
| `One Transition Service` step 5 | Notify the running actor with a versioned reload request | The service boundary is correct, but the runtime hook must exist end-to-end. |
| `One Transition Service` step 6 | Await/record actor acknowledgement or reconciliation | A transition is not fully real until runtime state changes or a failure is recorded. |
| `Required Changes And Tests` → `Worker/actor runtime` | Resolve bindings for candidate execution; reload versioned binding/config and acknowledge application | This is the explicit missing implementation slice. |
| `006` C6 | Transition changes the effective active preset **and** the running actor configuration | This is the proof gate that keeps Item 10 open. |

**Interpretation:** Item 10 is the unfinished behavioral half of 012.

### 4.2 Deferred Item 12: Comprehensive unit/integration tests

This item is the executable-proof half of 012 and is required by `006`.

| Source in 012 | Required proof | Updated interpretation after 005 / 006b |
|---|---|---|
| `Required Changes And Tests` → unit tests | Identity resolution, binding precedence, exact-artifact checks, style/allowed-policy checks, dwell/day limits, risk restrictions | Keep all of these. Remove rollout-mode-specific assertions. |
| `Required Changes And Tests` → integration tests | `entries_only` updates authoritative binding and actor state | This is the main C6 proof. |
| `Required Changes And Tests` → integration tests | Tightening mode creates and reconciles position actions | Keep. This proves permitted transition behavior. |
| `Required Changes And Tests` → integration tests | No mutation on stale/mismatched artifact | Keep. This is part of C7. |
| `Required Changes And Tests` → integration tests | No mutation after actor/action failure | Keep. This is part of C6. |
| `Required Changes And Tests` → integration tests | No mutation in `recommend_only` | **Drop**. Shadow mode was removed by `005` D8 and `006b` P3/P4. |
| `Completion Bar` | `006` C6 and C7 executable proof | This is the authoritative test closure requirement. |

**Interpretation:** Item 12 is not generic test debt. It is the missing completion proof for 012.

## 5. What 012 Should Mean Going Forward

After reconciliation, `012` should be interpreted as the plan for:

- authoritative per-identity preset binding state;
- exact-artifact transition auditability;
- one worker-owned `PresetTransitionService`;
- one worker-owned `AssessmentIdentityResolver`;
- two typed ports: `AssessmentRequestPort` and `PresetTransitionPort`;
- the **two-tool** public surface:
  - `assess_strategy_preset`
  - `change_strategy_preset`
- actor-runtime binding resolution and reload acknowledgement;
- executable proof for C6/C7.

It should **not** be interpreted as the live source of truth for:

- shadow mode / `platformAssessment.mode`;
- `get_market_preset_assessment` as an active phase-1 tool;
- `recommend_preset_transition` as an active phase-1 tool;
- `apply_preset_transition` as the canonical apply tool name.

## 6. Recommended Next Slice

If `012` is the last implemented feature/plan, the next implementation slice should be defined as:

1. **Finish Item 10**
   - resolve binding selection inside the actor/runtime execution path;
   - add binding/config reload request + acknowledgement handling;
   - make `PresetTransitionService` final state depend on runtime acknowledgement/reconciliation.

2. **Finish Item 12**
   - add focused unit tests for resolver and transition-policy invariants;
   - add integration tests for C6 and C7;
   - assert two-tool exact-artifact handoff only.

3. **Only then run 013 cleanup**
   - remove stale tool names, shadow-mode text, and legacy compatibility code after proof is green.
