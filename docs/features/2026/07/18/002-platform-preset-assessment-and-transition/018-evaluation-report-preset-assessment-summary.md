# Implementation Plan: Evaluation Report Preset-Assessment Summary

**Status:** Done
**Date:** 2026-07-19
**Follows:** [014-corrected-gap-table.md](./014-corrected-gap-table.md), [015-implementation-plan-evidence-catalog-and-assessment-payload.md](./015-implementation-plan-evidence-catalog-and-assessment-payload.md), [017-api-like-e2e-scenario-matrix-for-platform-preset-assessment.md](./017-api-like-e2e-scenario-matrix-for-platform-preset-assessment.md)
**Purpose:** Add a meaningful, non-scored preset-assessment appendix to agent evaluation reports and add companion raw artifacts to the existing evaluation bundle without changing the current evaluation score model.

## Scope

This plan covers only the evaluation/reporting slice for platform preset assessment.

It includes:

1. a non-scored `Preset Assessment Summary` appendix in `REPORT.md`;
2. one or two companion JSON artifacts in the existing evaluation bundle;
3. the collection and reduction logic needed to answer four agent-local questions from persisted records;
4. focused tests for scope filtering, summary derivation, report rendering, and artifact emission.

It does **not** include:

- changing the existing evaluation section score model;
- grading or scoring the shared platform assessor itself;
- new frontend UI beyond the current inline markdown report and existing artifact download list;
- new API routes for evaluation reports;
- rollout observability for the whole platform outside the scope of one evaluated agent.

## Problem Statement

The current evaluation pipeline can already render a deterministic markdown report and ship arbitrary artifacts in the evaluation zip, but it has no first-class way to summarize how one agent interacted with platform preset assessment.

Today:

1. evaluation scoring is limited to fixed sections such as `session_health`, `tool_usage`, and `trading_behavior`;
2. the markdown report renderer projects only those scored sections;
3. the evaluation artifact bundle can already include extra files, but the worker does not currently collect or summarize preset-assessment evidence;
4. the frontend and API already support inline `REPORT.md` viewing and zip download, so the lowest-risk addition is to extend the worker output rather than invent a new surface.

The feature should appear in evaluation reports only when it is meaningful. A disabled agent with no in-scope preset-assessment activity should not receive a noisy empty appendix.

## Goals

1. Answer four agent-local questions in the report appendix:
   - Was the feature enabled for this agent?
   - Did the agent receive review advice?
   - Did it request and reuse assessments successfully?
   - Did it change presets, and was that change clean and auditable?
2. Keep the existing evaluation scorecard unchanged.
3. Preserve the current API and frontend report surfaces by emitting standard evaluation artifacts only.
4. Make the summary auditable by pairing the human-readable appendix with machine-readable JSON artifacts.
5. Ensure the appendix is included only when the agent is opted in or there is preset-assessment activity inside the evaluation scope.

## Current Code-Checked Baseline

The current implementation shape makes this addition straightforward and low risk.

1. The evaluation worker already writes `evaluation.json` and `REPORT.md`, and the bundle route already zips every artifact written for the run.
2. The evidence assembler already collects `agent-metadata.json`, `unified-agent-config.json`, `fills.json`, `journal.json`, `sessions.json`, `positions.json`, and `costs.json`, but no preset-assessment evidence.
3. There are persisted preset-assessment tables that already contain the needed agent-local evidence:
   - `review_advice`
   - `market_assessment_requests`
   - `agent_preset_transitions`
   - `agent_preset_bindings`
4. There are no existing evaluation loaders or reducers for those tables.
5. The current markdown renderer is deterministic and additive, so a non-scored appendix can be appended without changing section scoring.

## Locked Assumptions From Current Feature State

Implementers should treat the following as fixed for this plan unless a later owner plan changes them explicitly.

1. **Active tool surface**
  The active preset-assessment tool surface is:
  - `assess_strategy_preset`
  - `change_strategy_preset`

2. **Shadow mode is not a live source concept**
  `recommend_only` is not part of the live source model for this feature slice. Remaining references are stale docs and at least one stale generated artifact. Cleanup of those remaining references is owned by [006b-followup-plan-2.md](./006b-followup-plan-2.md), including the requirement to cover generated outputs and packaging/runtime consumers.

3. **Transition capability must not be collapsed to one scalar field**
  The appendix must use:
  - `allowedTransitionModes`
  - `supportedApplyTransitionModes`

  It must not revive a single scalar `transitionMode` field for capability reporting.

4. **Reuse semantics are version-locked**
  For schema version 1 of the evaluation appendix artifacts, reuse means `cache_hit` only.

5. **Evidence collection is best-effort**
  Preset-assessment evidence collection is best-effort and should degrade via `auditCaveats`, not by failing the whole evaluation run.

6. **Session-scoped config/history mismatch is an accepted caveat**
  For session-scoped evaluations, config-derived fields come from the current unified-config snapshot while activity is filtered historically to the evaluation scope.

7. **Practical caution when touching shadow-mode cleanup**
  If implementation work overlaps remaining `recommend_only` cleanup, first audit whether checked-in `dist` output is consumed operationally before assuming it is safe to ignore. That caution is defined in [006b-followup-plan-2.md](./006b-followup-plan-2.md) and should not be bypassed from this plan.

## Fixed Decisions

The following decisions are locked for this plan.

1. **No new scored section in phase 1.**
   Preset assessment is reported as an appendix and JSON evidence, not as a new evaluation score dimension.

2. **Agent-local summary only.**
   The appendix evaluates how the specific agent used preset assessment. It does not try to evaluate the quality of the shared platform assessor across agents.

3. **Conditional inclusion.**
   The appendix appears only when at least one of the following is true:
   - the agent's current `unifiedConfig.platformAssessment.enabled` is `true`; or
   - there is in-scope preset-assessment activity in `review_advice`, `market_assessment_requests`, or `agent_preset_transitions`.

4. **Current config snapshot, scoped event history.**
   The appendix may use the current `unified-agent-config.json` snapshot to answer enablement and policy questions, but all activity counts must be filtered to the evaluation scope.

5. **No frontend or API expansion required.**
   The existing `REPORT.md` viewer and zip bundle remain the delivery surfaces.

6. **Raw artifact normalization over raw table dumps.**
   The companion JSON files should be normalized evaluation artifacts, not direct DB-row dumps. They must be stable enough for debugging, audit review, and future UI use.

7. **Best-effort collector, explicit caveats.**
  Preset-assessment evidence collection is best-effort. Missing review-advice, request, transition, or binding evidence must not fail the evaluation run; instead the summary adds `auditCaveats` and only renders the appendix when there is still a trustworthy basis to say something useful.

8. **Session-scope config/history limitation is accepted.**
  For session-scoped evaluations, enablement and policy fields come from the current unified-config snapshot, while advice/request/transition activity is filtered historically to the evaluation scope. The appendix must state this limitation explicitly rather than pretending config history is versioned.

## Meaningfulness Rules

The appendix should exist only when it says something useful.

### Include in `REPORT.md` when

At least one of these conditions is true:

1. `platformAssessment.enabled === true` in the current unified config snapshot;
2. at least one in-scope `review_advice` row exists;
3. at least one in-scope `market_assessment_requests` row exists;
4. at least one in-scope `agent_preset_transitions` row exists.

### Emit `preset-assessment-summary.json` when

The appendix is included.

### Emit `preset-assessment-events.json` when

At least one in-scope preset-assessment event exists.

This keeps the bundle informative without filling every evaluation with empty artifacts.

## Question Semantics

The four appendix questions need explicit answer rules so the report is stable and testable.

### Q1. Was the feature enabled for this agent?

Use the current `unified-agent-config.json` snapshot.

- `yes`: `platformAssessment.enabled === true`
- `no`: `platformAssessment.enabled === false`
- `unknown`: unified config missing, malformed, or the field is absent

The appendix must state that this is the current config snapshot at evaluation time, not a time-traveled historical policy view. For session-scoped evaluations this is an accepted limitation and must appear again as an audit caveat when needed.

### Q2. Did the agent receive review advice?

Use in-scope `review_advice` rows.

- `yes`: at least one row has `outcome = advised` and `consumedAt != null`
- `partial`: at least one row has `outcome = advised`, but none were consumed
- `no`: rows exist but none were advised
- `not_applicable`: no in-scope review-advice rows exist

The appendix should also show suppression outcomes such as `blocked_by_cooldown`, `blocked_by_no_credit_indication`, `fresh_artifact_exists`, `not_advised`, and `no_candidate`.

### Q3. Did it request and reuse assessments successfully?

Use in-scope `market_assessment_requests` rows.

- `yes`: at least one successful request exists and at least one `cache_hit` success exists
- `partial`: at least one successful request exists, but no reuse was observed, or successes are mixed with blocked or failed outcomes
- `no`: request attempts exist but none succeeded
- `not_applicable`: no in-scope request rows exist

The summary must separate:

- successful fresh runs;
- successful cache hits;
- blocked outcomes such as billing and cooldown;
- provider failures.

For this schema version, **reuse is defined narrowly as `cache_hit` only**. Do not infer broader reuse classes until the request service persists a distinct additional success outcome for them.

### Q4. Did it change presets, and was that change clean and auditable?

Use in-scope `agent_preset_transitions` rows and matching `agent_preset_bindings` rows when needed for current-state context.

- `yes`: at least one applied transition exists and every in-scope applied transition has a persisted `assessmentArtifactId`, old preset, new preset, transition mode, and a durable success state that is not `failed` or `partially_applied`
- `partial`: at least one transition exists, but one or more transitions are deferred, rejected, failed, partially applied, or missing audit fields
- `no`: transition attempts exist but none applied cleanly
- `not_applicable`: no in-scope transition rows exist

This question should stay grounded in persisted evidence only. It should not claim runtime correctness beyond what the persisted transition and binding records can prove.

## Concrete Report Appendix Schema

The appendix is markdown, but its structure must be concrete enough to render deterministically and to map back to machine-readable summary fields.

### Markdown contract

```md
## Preset Assessment Summary

- Inclusion reason: enabled_for_agent | activity_in_scope | enabled_and_activity
- Scope note: current config snapshot + in-scope preset-assessment activity

### 1. Feature Enablement
- Answer: yes | no | unknown
- Current opt-in flag: true | false | unknown
- Style tier: economy | standard | premium | unknown
- Allowed presets: comma-separated preset keys, or "not configured"
- Allowed transition modes: comma-separated modes, or "not configured"
- Supported apply transition modes in this release: comma-separated modes, or "unknown"
- Note: current config snapshot only; historical enablement is not versioned here

### 2. Review Advice
- Answer: yes | partial | no | not_applicable
- Advice rows in scope: <number>
- Advised rows: <number>
- Consumed advice rows: <number>
- Suppression breakdown: not_advised=<n>, blocked_by_cooldown=<n>, blocked_by_no_credit_indication=<n>, fresh_artifact_exists=<n>, no_candidate=<n>
- Top advised identities: comma-separated short identities, or "none"

### 3. Assessment Requests And Reuse
- Answer: yes | partial | no | not_applicable
- Requests in scope: <number>
- Successful fresh runs: <number>
- Successful cache hits: <number>
- Billing blocked: <number>
- Cooldown blocked: <number>
- Provider failed: <number>
- Reuse definition: cache_hit only
- Last successful artifact: <artifact id or none>

### 4. Preset Changes
- Answer: yes | partial | no | not_applicable
- Transition rows in scope: <number>
- Applied: <number>
- Deferred: <number>
- Rejected: <number>
- Failed or partially applied: <number>
- Modes observed: comma-separated modes, or "none"
- Last applied transition: <old preset> -> <new preset> via <mode>, or "none"

### Evidence Notes
- Current active default preset binding: <preset key and behavior version, or unknown>
- Identity-scoped transitions observed in scope: yes | no
- Audit caveats: free-text bullet list, only when needed
```

### Report rendering rules

1. Render this appendix after the normal scored sections.
2. If narrative commentary is enabled, keep the appendix before the optional `## Commentary` section so the deterministic evidence appears before the LLM narrative.
3. Omit empty detail lines when they would read as meaningless noise, but never omit the four answer lines once the appendix is included.
4. Keep identity display compact in markdown, for example `orderbook:hyperliquid:BTC:standard`.

## Companion Artifact Schemas

This phase adds up to two machine-readable artifacts.

## Artifact 1: `preset-assessment-summary.json`

### Purpose

This is the canonical machine-readable version of the markdown appendix.

### Shape

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-07-19T12:00:00.000Z",
  "scope": {
    "type": "session",
    "sessionId": "session_123"
  },
  "includedInReport": true,
  "inclusionReason": "enabled_and_activity",
  "configSnapshot": {
    "platformAssessmentEnabled": true,
    "styleTier": "standard",
    "allowedPresets": ["momentum_v1", "mean_reversion_v1"],
    "allowedTransitionModes": ["entries_only", "entries_and_tighten_existing"],
    "supportedApplyTransitionModes": ["entries_only"],
    "source": "current_unified_config"
  },
  "answers": {
    "featureEnabled": {
      "status": "yes",
      "detail": "Current unified config has platformAssessment.enabled=true."
    },
    "reviewAdviceReceived": {
      "status": "partial",
      "detail": "Advice was generated in scope, but no advised row was marked consumed."
    },
    "assessmentRequestsAndReuse": {
      "status": "yes",
      "detail": "The agent completed successful requests and hit the request cache at least once."
    },
    "presetChangesCleanAndAuditable": {
      "status": "not_applicable",
      "detail": "No preset transition rows were recorded in this evaluation scope."
    }
  },
  "reviewAdvice": {
    "totalRows": 6,
    "advisedRows": 2,
    "consumedRows": 1,
    "outcomes": {
      "advised": 2,
      "not_advised": 2,
      "blocked_by_cooldown": 1,
      "blocked_by_no_credit_indication": 0,
      "fresh_artifact_exists": 1,
      "no_candidate": 0
    },
    "topAdvisedIdentities": [
      "orderbook:hyperliquid:BTC:standard",
      "orderbook:hyperliquid:ETH:standard"
    ]
  },
  "assessmentRequests": {
    "totalRows": 4,
    "successfulFreshRuns": 1,
    "successfulCacheHits": 2,
    "reuseDefinition": "cache_hit_only",
    "requestInFlight": 0,
    "billingBlocked": 0,
    "cooldownBlocked": 1,
    "identityUnresolved": 0,
    "providerFailed": 0,
    "lastSuccessfulArtifactId": "artifact_123"
  },
  "presetTransitions": {
    "totalRows": 1,
    "applied": 1,
    "deferred": 0,
    "rejected": 0,
    "failed": 0,
    "partiallyApplied": 0,
    "modesObserved": ["entries_only"],
    "lastAppliedTransition": {
      "id": "transition_123",
      "oldPresetKey": "mean_reversion_v1",
      "newPresetKey": "momentum_v1",
      "transitionMode": "entries_only",
      "assessmentArtifactId": "artifact_123",
      "appliedAt": "2026-07-19T12:05:00.000Z"
    }
  },
  "currentDefaultBinding": {
    "activePresetKey": "momentum_v1",
    "behaviorVersion": "hash_abc",
    "styleTier": "standard",
    "sourceArtifactId": "artifact_123",
    "sourceTransitionId": "transition_123"
  },
  "identityScopedTransitionsObserved": true,
  "auditCaveats": [
    "Enablement is derived from the current unified config snapshot, not historical config versioning."
  ]
}
```

### Notes

1. `answers.*.status` uses `yes | partial | no | not_applicable | unknown`.
2. `configSnapshot` is present even when activity exists but config is unavailable; in that case fields become `null` or `unknown` and an audit caveat is added.
3. `allowedTransitionModes` reports current agent policy, while `supportedApplyTransitionModes` reports what this release can actually apply.
4. This artifact is the stable input if the frontend later wants to render a richer dedicated preset-assessment panel.

## Artifact 2: `preset-assessment-events.json`

### Purpose

Provide normalized event-level evidence for debugging and audit review without forcing future readers to infer semantics from raw DB rows.

### Shape

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-07-19T12:00:00.000Z",
  "scope": {
    "type": "session",
    "sessionId": "session_123"
  },
  "events": [
    {
      "eventType": "review_advice",
      "id": "review_123",
      "occurredAt": "2026-07-19T11:50:00.000Z",
      "identity": "orderbook:hyperliquid:BTC:standard",
      "outcome": "advised",
      "activePreset": "mean_reversion_v1",
      "presetBehaviorVersion": "hash_prev",
      "consumedAt": "2026-07-19T11:51:00.000Z",
      "expiresAt": "2026-07-19T12:20:00.000Z",
      "supportingFacts": {
        "candidateRank": 1
      }
    },
    {
      "eventType": "assessment_request",
      "id": "request_123",
      "occurredAt": "2026-07-19T11:52:00.000Z",
      "identity": "orderbook:hyperliquid:BTC:standard",
      "status": "cache_hit",
      "billingOutcome": "captured",
      "assessmentArtifactId": "artifact_123",
      "failureCode": null,
      "requestGroupKey": "group_123"
    },
    {
      "eventType": "preset_transition",
      "id": "transition_123",
      "occurredAt": "2026-07-19T12:05:00.000Z",
      "identity": "orderbook:BTC",
      "state": "applied",
      "outcome": "accepted",
      "oldPresetKey": "mean_reversion_v1",
      "newPresetKey": "momentum_v1",
      "transitionMode": "entries_only",
      "assessmentArtifactId": "artifact_123",
      "openPositionCount": 0,
      "reason": null
    }
  ]
}
```

### Notes

1. This artifact is optional and should be emitted only when at least one in-scope event exists.
2. The event shape is intentionally normalized across sources rather than mirroring each table verbatim.
3. Identities may be represented as both a canonical string and a structured object if later UI or tooling needs it, but phase 1 can ship with a canonical string plus source-specific fields.

## Implementation Strategy

Implement in this order:

1. collect and normalize in-scope preset-assessment evidence;
2. derive the summary object and raw events artifact;
3. render the markdown appendix from the summary object;
4. add tests for scope filtering, answer derivation, report gating, and artifact emission.

This order keeps the markdown report as a thin projection over a stable machine-readable summary.

## Workstream 1: Collect Preset-Assessment Evaluation Evidence

### Objective

Extend the evaluation evidence assembly path with best-effort collection for the agent-local preset-assessment records needed by the appendix.

### Planned changes

1. Add a new best-effort collector for preset-assessment evidence during evaluation assembly.
2. Query and persist normalized raw snapshots for:
   - in-scope `review_advice` rows;
   - in-scope `market_assessment_requests` rows;
   - in-scope `agent_preset_transitions` rows;
   - current `agent_preset_bindings` default binding for context.
3. Continue using `unified-agent-config.json` as the source of the current opt-in and policy snapshot.
4. Apply explicit scope filters:
   - `review_advice.checkedAt`
   - `market_assessment_requests.requestedAt`
   - `agent_preset_transitions.appliedAt`
5. Persist one or more intermediate evidence artifacts only if they simplify reducer testing; otherwise, reduce directly into the final companion artifacts.
6. If any preset-assessment collector fails, record a summary-level audit caveat rather than failing the evaluation run.

### File surfaces

| Surface | Change |
|---|---|
| `apps/worker/src/agent-evaluation/collectors/evidence-assembler.ts` | Add best-effort preset-assessment evidence collection. |
| optional new helper under `apps/worker/src/agent-evaluation/collectors/` | Encapsulate table queries and scope filtering. |
| optional DB helper under `packages/db/src/` | Add reusable query helpers if direct evaluation queries become noisy. |

### Completion bar

The evaluation worker can retrieve the current config snapshot plus in-scope review-advice, request, transition, and binding evidence without affecting existing evaluation behavior when those tables are empty.

## Workstream 2: Derive Summary And Event Artifacts

### Objective

Build one deterministic reducer that produces the appendix summary and the optional event-level artifact from the collected evidence.

### Planned changes

1. Add a reducer that accepts:
   - current unified config snapshot;
   - filtered review-advice rows;
   - filtered request rows;
   - filtered transition rows;
   - current default binding row.
2. Derive the four question answers using the fixed rules above.
3. Derive stable counts and compact identity lists for report-friendly output.
4. Emit:
   - `preset-assessment-summary.json` when the appendix is included;
   - `preset-assessment-events.json` when there are in-scope events.
5. Keep summary derivation pure and deterministic so it can be tested without running the whole evaluation pipeline.
6. Derive `identityScopedTransitionsObserved` from in-scope transition rows whose scope is not the default binding scope.

### File surfaces

| Surface | Change |
|---|---|
| optional new `apps/worker/src/agent-evaluation/preset-assessment-summary.ts` | Pure reducer and render helpers. |
| optional new `apps/worker/src/agent-evaluation/preset-assessment-summary.test.ts` | Unit tests for answer derivation and inclusion gating. |
| `apps/worker/src/agent-evaluation/run-evaluation.ts` | Write the new artifacts into the evaluation store before final manifest assembly. |

### Completion bar

The worker can deterministically produce the summary object and optional events artifact from persisted evidence without touching the scorecard model.

## Workstream 3: Render The Markdown Appendix

### Objective

Append a deterministic, non-scored `Preset Assessment Summary` section to `REPORT.md` when the summary says it should be included.

### Planned changes

1. Add a dedicated markdown renderer for the appendix rather than embedding ad hoc string assembly inside the main scored-section renderer.
2. Keep the existing `renderReport()` score projection intact.
3. Compose the final report in this order:
   - scored report body;
   - preset-assessment appendix when included;
   - optional narrative commentary last.
4. Ensure the appendix wording stays factual and does not imply stronger guarantees than the persisted evidence supports.

### File surfaces

| Surface | Change |
|---|---|
| `apps/worker/src/agent-evaluation/render-report.ts` | Either accept an optional appendix payload or keep only the scored report and let `run-evaluation.ts` append the appendix separately. |
| `apps/worker/src/agent-evaluation/run-evaluation.ts` | Compose `REPORT.md` with the conditional appendix before optional narrative commentary. |

### Completion bar

`REPORT.md` contains a stable `## Preset Assessment Summary` appendix only when inclusion rules are satisfied, and the appendix answers all four required questions.

## Workstream 4: Preserve Existing Delivery Surfaces

### Objective

Ship the new information through the existing evaluation surfaces with little or no API/UI change.

### Planned changes

1. Rely on the existing artifact manifest and zip-bundle behavior so the new JSON files appear automatically in the download bundle.
2. Rely on the existing inline `REPORT.md` rendering so no frontend rendering change is required for phase 1.
3. Verify the current artifact list UI can display the new files without additional translation or layout work.

### Expected outcome

No new routes, frontend panels, or bundle-specific code are needed for the first slice.

## Tests And Acceptance Proof

### Unit tests

Add focused tests for:

1. appendix inclusion gating:
   - enabled, no activity -> included;
   - disabled, activity present -> included;
   - disabled, no activity -> omitted.
2. answer derivation:
   - review-advice `yes`, `partial`, `no`, `not_applicable`;
   - request/reuse `yes`, `partial`, `no`, `not_applicable`;
   - transition cleanliness `yes`, `partial`, `no`, `not_applicable`.
3. config fallback behavior when unified config is null or malformed.
4. markdown rendering shape and ordering.
5. reuse semantics remain `cache_hit`-only in schema version 1.

### Integration tests

Add focused integration coverage for:

1. evaluation run writes `preset-assessment-summary.json` when inclusion rules match;
2. evaluation run writes `preset-assessment-events.json` when in-scope events exist;
3. `REPORT.md` contains the appendix and places it before `## Commentary` when narrative is enabled;
4. bundle artifact manifest includes the new files when written;
5. scope filtering excludes out-of-range advice, request, and transition rows;
6. collector failures add audit caveats without failing the evaluation run.

### Acceptance bar

This slice is complete when:

1. the evaluation score model is unchanged;
2. the appendix appears only under the defined meaningfulness rules;
3. the appendix answers all four required questions with deterministic status values;
4. the zip bundle includes the new JSON artifacts when appropriate;
5. focused tests prove scope filtering, reducer output, report ordering, and artifact emission.

## Suggested Implementation Order

1. add the evidence collector and scope-filtered queries;
2. add the pure summary/event reducer and unit tests;
3. wire artifact writing in `run-evaluation.ts`;
4. append the markdown summary to `REPORT.md`;
5. add end-to-end evaluation-run integration coverage.

## Risks And Guardrails

1. **Historical enablement ambiguity**
   The current unified config is not a historical config timeline. The appendix must state this explicitly and avoid pretending otherwise.

2. **Overclaiming transition cleanliness**
   The appendix must only claim what persisted transition and binding records prove.

3. **Report noise**
   The inclusion gate must remain strict. A disabled agent with no activity should not get an empty appendix.

4. **Config-history ambiguity**
  Session-scoped reports must repeat that enablement and policy come from the current config snapshot, not historical versioned config.

5. **Future UI coupling**
   The JSON summary should be stable enough that a future dedicated frontend surface can reuse it directly rather than re-deriving logic from raw DB tables.

## Out-Of-Scope Follow-Ups

If this slice lands cleanly, later work may choose to add:

1. a dedicated frontend card backed by `preset-assessment-summary.json`;
2. platform-wide rollout dashboards built from the same normalized summary/event concepts;
3. deeper transition quality analytics such as post-transition realized performance windows;
4. historical config-version correlation if preset-assessment policy versioning becomes first-class.