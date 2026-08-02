# API-Like E2E Scenario Matrix For Platform Preset Assessment

**Status:** Done
**Date:** 2026-07-19
**Follows:** [014-corrected-gap-table.md](./014-corrected-gap-table.md), [015-implementation-plan-evidence-catalog-and-assessment-payload.md](./015-implementation-plan-evidence-catalog-and-assessment-payload.md)
**Precedes:** [016-durable-execution-transition-reconciliation-and-release-evidence.md](./016-durable-execution-transition-reconciliation-and-release-evidence.md)

## Purpose

Define the automated API-like end-to-end scenario matrix for the platform preset-assessment and preset-transition slice.

This document exists to lock the externally visible behavior before broader `016` durability and reconciliation work begins. It is intentionally aligned with the existing shell-wrapper plus TypeScript-driver test style already used elsewhere in the repo.

## Why This Exists

The current gap table identifies a narrow but important remaining implementation slice before `016`:

- assessor config propagation and rollout semantics must honor operator config;
- the request and transition surfaces should then be exercised through realistic end-to-end flows;
- scenario coverage should be explicit before new test harness code is written.

This document itemizes those scenarios and separates:

1. cases that should be automated now as API-like E2E tests;
2. cases that belong in worker-backed functional or integration tests;
3. cases that should be deferred until `016`.

## Test Style

The new tests should follow the existing pattern used by the shell E2E wrappers:

- fully automated;
- load env automatically;
- start the stack if needed;
- stop the stack if started by the test;
- create or clean up required users, agents, connections, and fixtures;
- use API calls as the primary assertion surface;
- use DB checks only where the API cannot expose the required truth safely enough.

## Non-Goals

This document does not define:

- the durable cross-worker lease model;
- restart reconciliation behavior;
- remote actor reload behavior;
- `entries_and_tighten_existing` success behavior;
- the full `006` acceptance scenario.

Those belong to `016`.

## Scenario Matrix

| ID | Scenario | Why it matters | Primary proof surface | When |
|---|---|---|---|---|
| S1 | Operator disables platform assessor globally. Assessment request path is blocked. | Verifies item 4 config propagation actually works. | API-like E2E | Now |
| S2 | Operator enables assessor globally, but agent has `platformAssessment.enabled=false`. Assessment request is blocked for that agent. | Verifies operator config and agent opt-in are both respected. | API-like E2E | Now |
| S3 | Operator enables assessor globally and agent has `platformAssessment.enabled=true`. Assessment request is allowed to proceed. | Baseline positive gate after item 4. | API-like E2E | Now |
| S4 | Review-scheduler behavior respects operator disabled state. No review wake/advice path should activate when operator config disables the feature. | Confirms rollout semantics are not limited to the request tool. | Functional / worker-backed | Now |
| S5 | Review-scheduler behavior respects agent opt-in. Opted-out agent does not participate even when operator config is enabled. | Confirms per-agent gating. | Functional / worker-backed | Now |
| S6 | Assessment request returns the full success payload on a fresh run. | Protects the public tool contract landed in `015`. | API-like E2E | Now |
| S7 | Assessment request returns the full success payload on a cache hit. | Ensures cache-hit and fresh-run shapes stay identical. | API-like E2E | Now |
| S8 | Assessment request preserves `canonicalIdentity` on blocked outcomes where identity resolution succeeded. | Covers the remaining follow-up gap noted after `015`. | API-like E2E or functional | Now |
| S9 | Assessment request rejects unresolved or invalid identity input cleanly. | Basic negative contract coverage. | API-like E2E | Now |
| S10 | Assessment request enforces cooldown. | Public behavior that should stay stable before `016`. | API-like E2E | Now |
| S11 | Assessment request enforces billing block. | Public behavior that should stay stable before `016`. | API-like E2E | Now |
| S12 | Assessment request enforces max instruments per request and returns truncation metadata. | Public contract and operator-config-driven behavior. | API-like E2E | Now |
| S13 | Transition request rejects non-existent artifact. | Baseline negative transition contract. | API-like E2E | Now |
| S14 | Transition request rejects expired artifact. | Protects exact-artifact usage rules. | API-like E2E | Now |
| S15 | Transition request rejects target preset outside allowed set. | Protects policy boundaries. | API-like E2E | Now |
| S16 | Transition request rejects when platform assessment is not enabled for the agent. | Verifies rollout gate is applied consistently across tools. | API-like E2E | Now |
| S17 | `entries_only` transition succeeds with an exact fresh artifact and returns an applied transition result. | Positive transition baseline before `016`. | API-like E2E plus focused DB assertion if needed | Now |
| S18 | `entries_and_tighten_existing` is explicitly rejected in the current slice. | Locks current behavior so later `016` work is an intentional change. | API-like E2E | Now |
| S19 | Operator freshness config changes artifact reuse behavior. | This is the main non-LLM config propagation proof besides enabled/disabled. | API-like E2E | Now |
| S20 | Operator-configured daily request cap is enforced. | Confirms request service uses resolved operator config rather than hardcoded values. | API-like E2E | Now |

## Recommended First Test Set

The first automated slice should cover the smallest set that proves item 4 and stabilizes the public request/transition contract:

1. S1 operator-disabled global block
2. S2 agent-opt-out block
3. S3 enabled positive path
4. S6 fresh-run success payload
5. S7 cache-hit success payload
6. S10 cooldown block
7. S11 billing block
8. S16 transition gate when assessment not enabled
9. S17 exact-artifact `entries_only` success
10. S18 unsupported mode rejection
11. S19 freshness-config reuse behavior
12. S20 daily-cap enforcement

If these are green, item 4 is much harder to regress accidentally.

## Scenario Details

### S1: Operator-disabled global block

Setup:

- start stack with `platformAssessor.enabled=false`;
- create or load a valid test user;
- create an agent with `platformAssessment.enabled=true`.

Expected:

- assessment request does not proceed to a usable assessment result;
- the response clearly reflects disabled or blocked state;
- no successful assessment artifact is returned.

### S2: Agent-opt-out block

Setup:

- start stack with `platformAssessor.enabled=true`;
- create agent with `platformAssessment.enabled=false`.

Expected:

- assessment request is blocked for that agent;
- transition request is also blocked for that agent.

### S3: Enabled positive path

Setup:

- start stack with `platformAssessor.enabled=true`;
- create agent with `platformAssessment.enabled=true`;
- ensure minimum valid prerequisites exist for a real request path.

Expected:

- request is accepted into either cache-hit or fresh-run path;
- response is not blocked by rollout/config wiring.

### S6 and S7: Full payload on fresh-run and cache-hit

Expected success shape:

- `success=true`;
- `canonicalIdentity` present;
- `assessment.artifactId` present;
- `assessment.assessedAt` present;
- `assessment.expiresAt` present;
- `assessment.marketSummary` present;
- `assessment.regimeSummary` present;
- `assessment.scanHealthSummary` present;
- `assessment.rankings` present;
- `assessment.recommendedPreset` present or null by policy;
- `assessment.confidence` present;
- `assessment.urgency` present;
- `transitionReference.assessmentArtifactId` matches the returned artifact;
- billing metadata present.

### S10: Cooldown enforcement

Setup:

- issue a successful request;
- immediately repeat the same request for the same agent and identity.

Expected:

- second request is blocked by cooldown;
- response contains next-eligible timing or equivalent block detail;
- no new successful run is claimed for the blocked call.

### S11: Billing block

Setup:

- run with billing state that makes the request ineligible.

Expected:

- request is blocked before a successful assessment is claimed;
- response is explicitly billing-related;
- no successful assessment artifact is returned.

### S17: Exact-artifact entries-only transition success

Setup:

- obtain a fresh assessment artifact through the request tool;
- call the preset-change path using that exact artifact ID and an allowed target preset.

Expected:

- transition succeeds in `entries_only` mode;
- returned transition metadata points to the exact artifact used;
- if API alone is insufficient, one focused DB assertion may confirm the active preset binding changed.

### S18: Unsupported mode rejection

Setup:

- obtain a valid fresh artifact;
- request `entries_and_tighten_existing`.

Expected:

- request is rejected explicitly;
- failure is clear and stable;
- no partial state change is reported.

### S19: Freshness config behavior

Setup:

- run one test with a short `cacheFreshnessMs`;
- run another with a longer `cacheFreshnessMs`.

Expected:

- artifact reuse and expiry behavior changes according to operator config;
- the path should not behave as if freshness were hardcoded.

### S20: Daily cap enforcement

Setup:

- configure a small operator `maxReviewRequestsPerDay`;
- make repeated eligible requests until the cap is reached.

Expected:

- requests above the cap are blocked;
- the block is explicit and durable at the public surface.

## Defer To 016

The following should not be forced into the first API-like E2E slice:

- concurrent cache-miss requests from multiple workers;
- stale lease recovery;
- restart reconciliation for in-flight requests;
- restart reconciliation for `applying` transitions;
- cross-worker actor reload;
- successful `entries_and_tighten_existing` application;
- full `006` end-to-end acceptance scenario.

These are real requirements, but they are not the right first target for shell-driven API-like E2E tests before `016`.

## Proposed Test Deliverables

1. One shell wrapper to manage env and stack lifecycle.
2. One TypeScript driver to execute API calls, setup, cleanup, and assertions.
3. Optional helper utilities for:
   - login and user bootstrap;
   - connection bootstrap if required;
   - agent creation with explicit platform-assessment config;
   - artifact lookup or narrow DB assertions where API proof is insufficient.
4. Clear pass/fail console output per scenario.

## Suggested Implementation Order

1. Implement the operator-config propagation fix.
2. Automate S1, S2, S3, and S19 first.
3. Add S6, S7, S10, S11, and S20 next.
4. Add S13 through S18 after the request path is stable.
5. Continue to `016` once the public contract and config wiring are locked down.

## Exit Criteria

This document is satisfied when:

1. the scenario matrix is agreed;
2. the first automated API-like E2E slice exists;
3. item 4 from the corrected gap table has direct end-to-end proof;
4. the remaining durability and reconciliation scenarios are intentionally deferred into `016`.