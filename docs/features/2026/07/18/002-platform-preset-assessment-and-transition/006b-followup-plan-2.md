# Follow-up Plan 2: Tool Simplification and Shadow-Mode Removal

**Status:** In Progress (P1, P2, P5, P6, **P3, P4** landed in source — remaining cleanup must still remove stale `recommend_only` references from active docs and any generated outputs or packaging paths that could still surface them; P7-P8 in progress)
**Follows:**
- [005-implementation-checklist-per-symbol-on-demand.md](./005-implementation-checklist-per-symbol-on-demand.md)
- [006-followup-plan.md](./006-followup-plan.md)
- [007-assessment-billing-completion-plan.md](./007-assessment-billing-completion-plan.md)

**Purpose:**
- collapse the preset-assessment flow from three tools to two,
- remove the `recommend_only` / `auto_apply` shadow-mode concept entirely,
- preserve the billable assessment boundary,
- allow one assessment request to cover multiple instruments up to a configurable maximum,
- and retain exact transition auditability.

---

## 0. Decision Summary

This plan assumes the following product direction is accepted:

1. Replace `get_market_preset_assessment` and `recommend_preset_transition` with one billable tool: `assess_strategy_preset`.
2. Rename `apply_preset_transition` to `change_strategy_preset`.
3. Remove shadow mode entirely.
   - Delete `platformAssessment.mode`.
   - Delete `recommend_only` and `auto_apply` as valid configuration values.
   - Delete the apply-time block that rejects transitions in `recommend_only` mode.
4. Keep the feature gate at the agent level via `platformAssessment.enabled` only.
5. Treat `assessmentArtifactId` as an explicit implementation decision gate:
   - keep it as the exact transition reference for this implementation,
   - do not replace it in this slice,
   - any future replacement must first prove equivalent exactness and auditability.
6. Allow `assess_strategy_preset` to accept more than one instrument per request, with a configurable maximum.
   - Default maximum: `3` instruments.
   - If the caller requests more than the configured maximum, process only the first `N` instruments.
   - Return a meaningful truncation message in the response explaining that only the first `N` were assessed.
7. Execute multi-instrument assessments serially in the first implementation.
   - Do not fan out one request into parallel assessment runs in this slice.
8. Billing for multi-instrument requests is per instrument actually assessed, not per instrument requested.
   - Truncated instruments beyond the cap are not billed.
   - Instruments that fail before cache-hit or completed-assessment outcome are not billed unless later billing rules explicitly define otherwise.
9. Multi-instrument responses may be partially successful.
   - The response must contain one result entry per accepted instrument.
   - Whole-request failure is reserved for request-level problems such as invalid input or unavailable dependencies.
10. The config key for the per-request cap is `platformAssessor.maxInstrumentsPerRequest` with default `3`.

This document is the implementation plan for that direction.

---

## 1. Product Intent

The target end state is a simpler agent-facing flow:

1. Agent receives `assessment_review` advice.
2. Agent calls `assess_strategy_preset(symbols, venueFamily, ...)` with one or more instruments.
3. The tool either reuses a fresh artifact or runs a new billed assessment for each accepted instrument.
4. If the request exceeds the configured maximum, the tool assesses only the first `N` instruments and states that clearly in the response.
5. The tool returns the recommendation payload directly, plus the exact transition reference needed for later apply.
6. Agent calls `change_strategy_preset(...)` to switch presets for one assessed instrument.

There is no advisory-only mode where the agent can assess but cannot apply.

---

## 2. Non-Goals

This plan does **not** preserve backward compatibility unless explicitly required later.

The plan does **not** keep old tool names as aliases by default.

The plan does **not** keep a dormant shadow-mode field in config “just in case”. If the concept is removed, it should be removed from schema, runtime logic, tests, and rollout docs.

---

## 3. Critical Constraint: Exact Transition Reference

The current design intentionally requires an exact artifact reference for transition application.

Why this exists today:
- `agent_preset_transitions` persists `assessmentArtifactId` for audit.
- the current feature docs explicitly require an exact artifact handoff from assessment → recommendation → application.
- this prevents “latest artifact” substitution when a fresher artifact appears after the recommendation was generated.

Therefore, this plan includes an explicit decision gate:

### A1. Reference Model Decision

This decision is now settled for this implementation:

- keep `assessmentArtifactId` as the exact transition reference,
- require `change_strategy_preset` to consume that exact reference,
- persist that exact reference into `agent_preset_transitions` for audit,
- reject any design that resolves “latest artifact for symbol” at apply time.

Alternative reference models may be considered later, but they are out of scope for this slice unless they first satisfy the proof burden below.

Previously-considered options:

| Option | Keep? | Notes |
|---|---|---|
| `assessmentArtifactId` | Preferred default | Smallest current exact reference; already persisted and audited |
| `{canonicalIdentity + assessedAt}` | Allowed only with proof | Must prove uniqueness and no substitution race |
| `requestId` | Allowed only with proof | Must still resolve to one exact persisted artifact |
| “latest fresh artifact for symbol” | Reject | Not exact enough for audited apply |

**Locked plan instruction:** keep `assessmentArtifactId` in this implementation.

---

## 4. Gap Register

| Gap ID | Change | Owner files | Required outcome | Proof |
|---|---|---|---|---|
| P1 | Merge assessment + recommendation into one tool | `apps/worker/src/tools/get-market-preset-assessment.ts`, `apps/worker/src/tools/recommend-preset-transition.ts`, `packages/domain/src/tool-schemas.ts`, `packages/domain/src/tools.ts`, `apps/worker/src/tools/index.ts` | One billable `assess_strategy_preset` tool returns both artifact data and recommendation payload for one or more instruments up to the configured max | Unit/integration tests for fresh-cache path, new-run path, and truncation path |
| P2 | Rename apply tool | `apps/worker/src/tools/apply-preset-transition.ts`, `packages/domain/src/tool-schemas.ts`, `packages/domain/src/tools.ts`, `apps/worker/src/tools/index.ts` | `change_strategy_preset` replaces `apply_preset_transition` everywhere | Tool registry test + apply-tool tests updated |
| P3 | Remove shadow mode from config schema and resolved config | `packages/domain/src/config/schema.ts`, `packages/domain/src/config/assessment-config.ts` | No `platformAssessment.mode`; no `recommend_only`; no `auto_apply` | Schema tests and typecheck |
| P4 | Remove shadow-mode runtime gate | `apps/worker/src/tools/apply-preset-transition.ts` or renamed file | Apply/change path is no longer blocked by advisory-only mode | Updated tool test proving no mode gate remains |
| P5 | Update agent prompt and wake copy | `apps/worker/src/agent.ts`, `apps/worker/src/assessment-review-message.ts`, `apps/worker/src/agent-assessment-review.test.ts` | Prompt mentions only the two new tools | Prompt/message unit tests |
| P6 | Preserve exact transition auditability | `apps/worker/src/tools/recommend-preset-transition.ts`, `apps/worker/src/tools/apply-preset-transition.ts`, `packages/db/src/schema/agent-preset-transitions.ts`, replacement files after merge/rename | `change_strategy_preset` uses one exact audited reference model | Test proving no latest-artifact substitution |
| P7 | Remove old rollout invariant from docs | `docs/features/2026/07/18/002-platform-preset-assessment-and-transition/*.md` | Docs no longer describe `recommend_only` as required rollout behavior | Review pass across 001/005/006/007 docs |
| P8 | Remove old tool names from user-facing and internal surfaces | runtime prompt text, tool catalog, schemas, tests, docs | Only `assess_strategy_preset` and `change_strategy_preset` remain | Grep proof with no old tool names in active source surfaces |
| P11 | Remove stale shadow-mode references from generated outputs and packaging/runtime consumers | checked-in `dist` outputs, package/build scripts, docker/runtime entry surfaces that may consume generated JS directly | No active built artifact or packaging path still exposes `recommend_only`, `auto_apply`, or `platformAssessment.mode` after regeneration | Consumer audit + rebuild + grep proof + targeted validation |
| P9 | Add configurable multi-instrument request cap | `packages/domain/src/config/schema.ts`, `config/default.yaml`, merged assessment tool files, tool schemas, docs | The merged assessment tool accepts multiple instruments, enforces `platformAssessor.maxInstrumentsPerRequest`, defaults to `3`, and returns only the first `N` with a meaningful truncation message | Schema test, config load proof, and tool test for overflow behavior |
| P10 | Lock batch execution and billing semantics | merged assessment tool files, `assessment-request-service.ts`, docs | Multi-instrument requests execute serially, allow partial success, and bill per instrument actually assessed | Integration test for serial processing and mixed outcomes |

---

## 5. Required Implementation Order

Implement in this order:

1. Remove shadow mode from schema/types/config resolution.
2. Define the multi-instrument request contract and configurable cap.
3. Implement serial batch execution and partial-success response semantics.
4. Merge `get_market_preset_assessment` + `recommend_preset_transition` into `assess_strategy_preset`.
5. Rename `apply_preset_transition` to `change_strategy_preset`.
6. Update prompt text, wake guidance, and tool catalog copy.
7. Update feature docs and rollout documents.
8. Audit checked-in generated outputs and any packaging/runtime consumer that could still surface stale shadow-mode behavior.
9. Rebuild generated outputs from the cleaned source state.
10. Run executable proof for the full two-tool flow.

This order is required because the merged-tool contract depends on exact-reference preservation, serial execution semantics, and the batch response shape.

---

## 6. Tool Contract Target

### 6.1 `assess_strategy_preset`

This tool becomes the single billable assessment entry point.

#### 6.1.1 Locked Request Schema

The first implementation must use one shared venue/instrument context plus a list of symbols.

Use this request shape:

```json
{
   "symbols": ["BTC", "ETH", "SOL"],
   "venueFamily": "hyperliquid",
   "instrumentKind": "perp",
   "idempotencyKey": "optional-client-key"
}
```

Rules:
- `symbols` is required and must contain at least one entry.
- `venueFamily` is shared across the whole request.
- `instrumentKind` is shared across the whole request.
- mixed venue families in one request are not allowed.
- mixed instrument kinds in one request are not allowed.
- the first implementation does not support a heterogeneous `instruments[]` object array.
- if future work needs mixed venue/instrument requests, that must be a separate plan slice.

It must:
- accept one or more instruments in one request,
- enforce a configurable maximum number of instruments per request,
- use config key `platformAssessor.maxInstrumentsPerRequest`,
- default that maximum to `3`,
- if more than the configured maximum are requested, assess only the first `N` instruments,
- return a meaningful truncation message explaining that only the first `N` instruments were assessed,
- execute accepted instruments serially in request order,
- resolve canonical identity,
- route through `AssessmentRequestService`,
- bill or reuse according to the request-service rules on a per-assessed-instrument basis,
- return the assessment artifact payload for each accepted instrument,
- represent recommendation facts only inside the canonical `assessment` object for each accepted instrument,
- return the exact transition reference needed by `change_strategy_preset`.

It must **not** require a second recommendation-only tool call.

It must support partial success:
- each accepted instrument yields one result entry,
- some result entries may succeed while others fail,
- whole-request failure is reserved for request-level errors.

#### 6.1.2 Locked Per-Result Response Schema

Each entry in `data.results` must have an explicit status shape.

Success entry:

```json
{
   "success": true,
   "symbol": "BTC",
   "canonicalIdentity": {
      "instrumentKind": "perp",
      "venueFamily": "hyperliquid",
      "styleTier": "standard",
      "symbol": "BTC"
   },
   "assessment": {
      "artifactId": "a1b2c3",
      "assessedAt": "2026-07-19T10:00:00.000Z",
      "expiresAt": "2026-07-19T16:00:00.000Z",
      "marketSummary": "BTC is trending strongly",
      "regimeSummary": "Bullish regime",
      "scanHealthSummary": "Healthy",
      "rankings": [],
      "recommendedPreset": "momentum_v1",
      "confidence": 0.78,
      "urgency": "medium"
   },
   "transitionReference": {
      "assessmentArtifactId": "a1b2c3"
   },
   "billing": {
      "billed": true,
      "requestId": "req_123",
      "idempotencyKey": "idem_123",
      "source": "new_run"
   }
}
```

Failure entry:

```json
{
   "success": false,
   "symbol": "ETH",
   "canonicalIdentity": {
      "instrumentKind": "perp",
      "venueFamily": "hyperliquid",
      "styleTier": "standard",
      "symbol": "ETH"
   },
   "error": "Assessment artifact could not be created.",
   "errorCode": "assessment.provider_failed",
   "billing": {
      "billed": false,
      "requestId": null,
      "idempotencyKey": "idem_123",
      "source": "failed"
   }
}
```

Rules:
- every result entry must include `success: true | false`.
- every result entry must include the original `symbol`.
- `canonicalIdentity` should be included whenever identity resolution succeeded.
- failed entries must include `error` and `errorCode`.
- billing metadata must still be explicit on failed entries.
- top-level `data.results` may contain a mix of success and failure entries.
- top-level `success: true` means the batch request itself executed; it does not imply every result entry succeeded.

The response contract must make truncation explicit. At minimum it must include:
- the configured cap used for the request,
- the number of requested instruments,
- the number actually assessed,
- a human-readable message when truncation occurred.

The response contract must also satisfy a strict anti-redundancy rule:
- each fact must have exactly one canonical location in the response,
- no value may be duplicated across `assessment`, recommendation-related fields, `transitionReference`, or billing metadata unless the duplication is explicitly justified and tested,
- the merged tool must not return a second top-level `recommendation` object that repeats values already present in `assessment`.

Redundant shapes to reject:
- `assessment.recommendedPreset` plus `recommendation.recommendedPreset`
- `assessment.confidence` plus `recommendation.confidence`
- `assessment.urgency` plus `recommendation.urgency`
- `assessment.marketSummary` plus `recommendation.marketSummary`
- `assessment.rankings[0]` plus a repeated top-ranked preset object elsewhere in the payload

Preferred response shape for each assessed instrument:

```json
{
   "success": true,
   "data": {
      "requestedInstrumentCount": 4,
      "assessedInstrumentCount": 3,
      "maxInstrumentsPerRequest": 3,
      "message": "Requested 4 instruments; only the first 3 were assessed because the per-request maximum is 3.",
      "results": [
         {
            "canonicalIdentity": {
               "instrumentKind": "perp",
               "venueFamily": "hyperliquid",
               "styleTier": "standard",
               "symbol": "BTC"
            },
            "assessment": {
               "artifactId": "a1b2c3",
               "assessedAt": "2026-07-19T10:00:00.000Z",
               "expiresAt": "2026-07-19T16:00:00.000Z",
               "marketSummary": "BTC is trending strongly",
               "regimeSummary": "Bullish regime",
               "scanHealthSummary": "Healthy",
               "rankings": [
                  {
                     "presetKey": "momentum_v1",
                     "presetBehaviorVersion": "abc123",
                     "rank": 1,
                     "score": 0.85,
                     "scoreBand": "A",
                     "pros": ["High signal density"],
                     "cons": ["Higher turnover"],
                     "fitNotes": "Best fit in current trend"
                  }
               ],
               "recommendedPreset": "momentum_v1",
               "confidence": 0.78,
               "urgency": "medium"
            },
            "transitionReference": {
               "assessmentArtifactId": "a1b2c3"
            },
            "billing": {
               "billed": true,
               "requestId": "req_123",
               "idempotencyKey": "idem_123",
               "source": "new_run"
            }
         }
      ]
   }
}
```

In this shape, recommendation is represented only by:
- `assessment.recommendedPreset`
- `assessment.confidence`
- `assessment.urgency`
- `assessment.rankings`

There is no separate top-level recommendation object.

This is a hard contract, not an illustrative preference.

### 6.2 `change_strategy_preset`

This tool becomes the single apply tool.

It must:
- accept the exact transition reference chosen in Section 3,
- validate artifact freshness and identity,
- validate that the target preset is allowed,
- persist the immutable transition record,
- return the applied result,
- never branch on shadow/advisory-only mode.

---

## 7. Shadow-Mode Removal Details

The following must be removed fully, not merely ignored:

### 7.1 Schema and Types
- Remove `mode` from `PlatformAssessmentOptInSchema`.
- Remove `mode` from `ResolvedAssessmentConfig`.
- Remove `recommend_only` / `auto_apply` from any public type unions.

### 7.2 Runtime Logic
- Delete the `transition.shadow_mode_blocked` gate and error path.
- Delete config checks that branch on `platformAssessment.mode`.

### 7.3 Tests
- Remove tests that assert `recommend_only` blocks apply.
- Replace them with tests that assert the apply path depends only on:
  - exact reference validity,
  - freshness,
  - allowed preset set,
  - persisted audit snapshot.

### 7.4 Docs
- Remove the D8 rollout premise from the feature docs.
- Replace it with the real rollout gate:
  - feature off → `platformAssessment.enabled = false`
  - feature on → complete two-tool flow is allowed

### 7.5 Generated Outputs And Packaging
- Audit whether any checked-in generated output is used directly by runtime, packaging, deploy, tests, or Docker build paths.
- If generated `dist` artifacts are kept in the repo, regenerate them from the cleaned source state in the same change.
- Do not hand-edit generated outputs unless the build path is broken; the normal path is source fix first, then rebuild.
- If a checked-in generated artifact cannot be regenerated in the current workflow, stop and resolve that build-path issue before claiming shadow-mode removal complete.
- Grep proof must cover both source and any generated outputs that remain tracked.

---

## 8. Assessment Reference Decision Gate

This plan must not hand-wave the `assessmentArtifactId` question.

### Keep it if:
- it remains the clearest exact audited reference,
- `change_strategy_preset` writes it directly into `agent_preset_transitions`,
- it avoids latest-artifact substitution,
- removing it would force weaker “resolve latest by symbol” behavior.

### Replace it only if all are true:
- the replacement maps to one exact persisted artifact,
- the replacement is stable across retries,
- the replacement preserves transition auditability,
- there is an executable test proving that a newly-created later artifact cannot silently replace the one the agent intended to apply.

If that proof is not available, keep `assessmentArtifactId`.

---

## 9. Acceptance Scenario

The work is not complete until this exact scenario passes.

1. Configure one agent with `platformAssessment.enabled = true`.
2. Confirm there is no `platformAssessment.mode` in config schema, runtime config, or persisted config writes.
3. Trigger `assessment_review` advice.
4. Verify the prompt/wake guidance mentions only:
   - `assess_strategy_preset`
   - `change_strategy_preset`
5. Call `assess_strategy_preset(symbols, venueFamily, ...)`.
6. Verify:
   - request service runs,
   - billing/reuse logic runs per assessed instrument,
   - accepted instruments are processed serially in request order,
   - the request uses one shared `venueFamily` and one shared `instrumentKind` across all requested symbols,
   - returned payload includes recommendation data,
   - returned payload includes the exact transition reference,
   - returned payload does not duplicate recommendation facts across multiple sections,
   - each result entry follows the locked success/failure schema,
   - if more than the configured maximum were requested, only the first `N` are assessed and the response contains a meaningful truncation message.
   - mixed success/failure across accepted instruments is represented as partial success, not flattened into one opaque failure.
7. Call `change_strategy_preset(...)` using one exact reference from the assessed set.
8. Verify:
   - no shadow-mode block exists,
   - artifact freshness and allowed-preset checks still run,
   - transition record persists with immutable identity snapshot,
   - the exact reference used for apply is captured for audit.
9. Create a newer artifact for the same canonical identity.
10. Verify the previously returned exact reference still points to the intended artifact and is not silently substituted by “latest”.
11. Verify old tool names are not exposed in the active registry/prompt/docs targeted by this feature slice.
12. Verify no checked-in generated output or packaging/runtime consumer still contains or depends on `recommend_only`, `auto_apply`, or `platformAssessment.mode`.

---

## 10. Required Proof

| Area | Minimum proof |
|---|---|
| Tool merge | Tests for `assess_strategy_preset` covering cache hit, fresh artifact reuse, new-run completion, serial multi-instrument execution, partial success, and truncation |
| Request schema | Test proving the first implementation accepts one shared `venueFamily` + `instrumentKind` + `symbols[]` and rejects heterogeneous batch shapes |
| Response shape | Snapshot or structural test proving the merged response has one canonical location per fact and does not duplicate recommendation fields |
| Result entry contract | Test proving `results[]` supports explicit mixed success/failure entries with the locked field set |
| Apply rename | Registry + execution tests for `change_strategy_preset` |
| Shadow removal | No active source references, no active feature-doc references, and no generated outputs or packaging/runtime consumers still exposing `recommend_only`, `auto_apply`, `platformAssessment.mode`, or `transition.shadow_mode_blocked` |
| Generated-output safety | Proof that any tracked `dist` or other built artifacts were regenerated from the cleaned source state, or proof that they are not used by runtime/packaging/deploy paths |
| Exact reference | Test proving apply uses the intended artifact, not a substituted later artifact |
| Multi-instrument cap | Test proving requests above `platformAssessor.maxInstrumentsPerRequest` return only the first `N` instruments with a meaningful truncation message |
| Billing semantics | Test proving truncated instruments are not billed and per-instrument outcomes drive billing |
| Prompt text | Unit test for assessment-review message and any runtime prompt copy changes |
| Docs | Review proof that 005/006/007 no longer describe shadow mode as a rollout invariant |

---

## 11. Completion Rule

This plan is complete only when all of the following are true:

1. The active tool surface is exactly two tools:
   - `assess_strategy_preset`
   - `change_strategy_preset`
2. `recommend_only` and `auto_apply` are removed from source schema, source runtime logic, source tests, active feature docs, and any generated outputs or packaging/runtime consumers that could still surface them.
3. `assessmentArtifactId` remains the exact transition reference and is protected by tests.
4. The merged assessment tool supports multiple instruments up to `platformAssessor.maxInstrumentsPerRequest`, with a default max of `3` and tested overflow behavior.
5. Accepted instruments are executed serially and partial success behavior is tested.
6. Billing semantics are defined per assessed instrument and tested.
7. The merged response shape has one canonical location per fact and no redundant recommendation segments unless explicitly justified and tested.
8. No active source path requires a separate recommendation-only tool call before apply.
9. The full acceptance scenario in Section 9 passes.

If any of those are not true, the feature remains partial.

---

## 11A. Careful Removal Sequence For Remaining `recommend_only` Cleanup

The remaining cleanup must be executed carefully so source cleanup does not leave a stale generated/runtime surface behind.

1. Audit all consumers of checked-in built artifacts before deleting or ignoring stale references.
2. Remove stale shadow-mode references from active docs first so current requirements are unambiguous.
3. Fix source-only references if any are rediscovered.
4. Regenerate tracked build outputs from the cleaned source state.
5. Re-run targeted grep across source plus tracked generated outputs.
6. Re-run targeted tool and transition tests plus the narrow build or package validation that exercises the regenerated output.

This sequence is mandatory because a stale checked-in artifact is more dangerous than a stale doc comment: it can silently reintroduce removed behavior in packaging or deploy flows.

---

## 12. Notes for Implementation Review

The most likely place this effort can regress is the exact-reference question.

The second most likely regression is response-shape drift after the tool merge.

The third most likely regression is silent contract drift in batch semantics — especially parallel fan-out, ambiguous partial-failure handling, or unclear billing of truncated instruments.

If the merged response starts returning both an `assessment` object and a second recommendation object with repeated values, that should be treated as a contract failure, not as harmless duplication.

Merging the first two tools is straightforward.

Removing shadow mode is straightforward.

The risky change is dropping `assessmentArtifactId` without replacing it with an equally exact audited handle. That must be treated as a proof obligation, not as a naming cleanup.
