# 001 — Agent Evaluation Unified Agent Config Download

**Status:** Done  
**Created:** 2026-07-03  
**Scope:** Include the agent's current persisted unified config as a downloadable evaluation artifact via a dedicated `unified-agent-config.json` file.

## Problem

Agent evaluations currently download operational evidence and a small agent metadata summary, but they do not include the agent's current unified config.

That leaves a gap for operator review:

- The evaluation can show trading outcomes and runtime behavior.
- The bundle can show high-level agent metadata such as execution mode and daily loss limit.
- The bundle cannot show the current technical, intelligence, execution, and risk blocks stored in the agent's unified config.

This makes it harder to answer questions such as:

- What technical scan filters was the agent configured with when the evaluation ran?
- Was hybrid mode enabled because technical and intelligence config were both present?
- What execution and risk settings were currently persisted for the agent?

The current collector already fetches the full agent row, and the agent row already contains `unifiedConfig`. The missing piece is artifact emission, redaction coverage, and test coverage.

## Goal

Add a dedicated evaluation artifact named `unified-agent-config.json` that contains the agent's current persisted unified config at evaluation time.

After this feature:

- Completed evaluations include `unified-agent-config.json` in the artifact manifest.
- The bundle download includes `unified-agent-config.json` automatically.
- Single-artifact download includes `unified-agent-config.json` automatically.
- The artifact is passed through the same JSON redaction path as other user-facing JSON evidence.
- No API route shape or frontend behavior needs to change.

## Non-Goals

- Do not add historical config snapshots tied to agent runtime sessions.
- Do not reconstruct the exact config that was active during an older session if the unified config changed later.
- Do not include bot configs or bot strategy configs in this change.
- Do not change evaluation scoring, analyzers, or report rendering logic.
- Do not add a database migration.
- Do not rename or repurpose `agent-metadata.json`.

## Solution Outline

Add one new best-effort evidence artifact in the evaluation collector:

- `unified-agent-config.json`

The collector will read the already-loaded agent row and write the value of `agent.unifiedConfig` to the artifact store.

The worker's redaction pass will be extended to include `unified-agent-config.json` so the new artifact follows the same handling path as other JSON evidence files.

The existing manifest and bundle behavior will pick up the new artifact automatically because evaluation result assembly already lists artifacts from the store, and the API bundle route already zips whatever the store returns.

## Why This Is The Clean Version

There are two plausible shapes:

1. Expand `agent-metadata.json` to include `unifiedConfig`.
2. Add a separate `unified-agent-config.json` artifact.

This plan chooses the second approach.

Rationale:

- `agent-metadata.json` is currently a compact summary artifact.
- `unifiedConfig` is materially different in size and purpose from metadata.
- A separate artifact avoids widening the meaning of `agent-metadata.json`.
- A dedicated file is easier to discover in downloads and easier to consume programmatically.
- Future config-oriented artifacts can follow the same pattern without bloating the metadata file.

## Design Decisions

### D1: Use a separate artifact named `unified-agent-config.json`

**Decision:** Write `unified-agent-config.json` as a standalone artifact instead of embedding `unifiedConfig` into `agent-metadata.json`.

**Rationale:**

- Keeps metadata and config concerns separate.
- Preserves backward expectations around `agent-metadata.json`.
- Makes the download list clearer for operators.

### D2: Capture current persisted config at evaluation time

**Decision:** The artifact contains the current value of `agents.unifiedConfig` at the moment evidence is collected.

**Rationale:**

- This matches the current request.
- It is cheap to implement because the collector already loads the full agent row.
- It avoids introducing session-snapshot architecture into a small feature.

**Caveat:**

- This is not a historical snapshot.
- If an older session is evaluated after the agent's unified config has changed, the artifact reflects the current DB value, not necessarily the exact config that was active during the evaluated runtime session.

### D3: Keep the collector best-effort

**Decision:** `unified-agent-config.json` follows the same failure model as `agent-metadata.json`.

If the agent row is missing or the collector fails unexpectedly, the evaluation should continue and record the artifact as not collected rather than aborting the full run.

**Rationale:**

- Consistent with adjacent agent metadata collection behavior.
- Avoids turning a small observability enhancement into a new evaluation failure mode.

### D4: Always emit the artifact when the agent row exists

**Decision:** When the agent row exists, always write `unified-agent-config.json` even if `agent.unifiedConfig` is null.

Suggested file content when unset:

```json
null
```

**Rationale:**

- Distinguishes "no unified config is currently set" from "artifact collection failed."
- Produces a deterministic artifact surface.
- Avoids ambiguous absence semantics.

### D5: Include `unified-agent-config.json` in the redaction pass

**Decision:** Extend the hardcoded evidence artifact redaction list to include `unified-agent-config.json`.

**Rationale:**

- Current unified config does not appear to contain secrets, but it can include provider and model selection fields under intelligence.
- Using the standard redaction path keeps the new artifact aligned with existing safety handling and future-proofs the feature if the config schema grows.

### D6: Do not change narrative prompt inputs in this feature

**Decision:** The LLM narrative generator should remain unchanged for now.

**Rationale:**

- The request is specifically about downloads.
- The narrative currently reads a known evidence subset.
- Pulling unified config into the narrative prompt is a separate product decision and can be added later if useful.

### D7: No API or frontend changes are required

**Decision:** Do not change route contracts or UI logic.

**Rationale:**

- The evaluation result manifest is built from store contents.
- The API artifact list and bundle routes already serve dynamic artifact names.
- The frontend already renders download buttons from the returned artifact manifest.

## File Targets

### Worker collector

- `apps/worker/src/agent-evaluation/collectors/evidence-assembler.ts`

### Worker redaction path

- `apps/worker/src/agent-evaluation/run-evaluation.ts`

### Tests to add or update

- `apps/worker/src/agent-evaluation/collectors/evidence-assembler.test.ts`
- `apps/worker/src/agent-evaluation/run-evaluation.test.ts`

If the team wants to avoid adding a full `run-evaluation` test in this small change, a narrower alternative is to factor the evidence-artifact redaction list into a small exported helper and unit-test that helper directly. The preferred version is still a focused `run-evaluation` test because it validates the real integration path.

## Implementation Steps

### Phase 1 — Emit the new artifact

#### Goal

Write `unified-agent-config.json` during evidence collection using the agent row that is already loaded.

#### Tasks

- [ ] In the agent metadata collection block, continue loading the agent row once.
- [ ] After writing `agent-metadata.json`, write `unified-agent-config.json` using `agent.unifiedConfig ?? null`.
- [ ] Add a manifest entry for `unified-agent-config.json` with `collected: true` when the agent row exists.
- [ ] If the agent row is missing, mark `unified-agent-config.json` as `collected: false` with the same not-found semantics as `agent-metadata.json`.
- [ ] If an exception is thrown in the best-effort block, record `unified-agent-config.json` as `collected: false` alongside the existing metadata failure path.

#### Notes

- Do not add a second DB query for unified config.
- Do not introduce a new repository method unless required for testability; `getAgent()` already returns the full row.

### Phase 2 — Redact the new artifact

#### Goal

Ensure `unified-agent-config.json` passes through the same user-facing JSON redaction pass as other evidence artifacts.

#### Tasks

- [ ] Add `unified-agent-config.json` to the `evidenceArtifacts` list in `run-evaluation.ts`.
- [ ] Keep the current best-effort redaction failure behavior unchanged.
- [ ] Do not add special-case redaction logic unless the artifact exposes an actual issue during testing.

#### Notes

- This is primarily consistency and forward-safety work.
- The generic `redactJson` pass should be sufficient.

### Phase 3 — Validate artifact inclusion in downloads

#### Goal

Confirm the new artifact automatically appears in the evaluation result manifest and zip bundle without route or UI changes.

#### Tasks

- [ ] Verify that no changes are needed in `result.artifactManifest` construction.
- [ ] Verify that no changes are needed in the API list-artifacts route.
- [ ] Verify that no changes are needed in the API bundle route.
- [ ] Verify that no changes are needed in the frontend artifact rendering.

#### Notes

This phase is validation-oriented, not code-heavy. The implementation should rely on existing dynamic artifact behavior rather than special-casing the new file anywhere downstream.

## Test Plan

### 1. Collector test

Add a focused evidence-assembler test that verifies:

- [ ] `unified-agent-config.json` is written when the agent exists and has a non-null unified config.
- [ ] The artifact contents equal the persisted unified config JSON.
- [ ] The manifest records `unified-agent-config.json` as collected.
- [ ] `unified-agent-config.json` is still written as JSON `null` when the agent exists but `unifiedConfig` is null.
- [ ] The manifest records `unified-agent-config.json` as not collected when the agent row is unavailable.

### 2. Run-evaluation redaction test

Add a focused `run-evaluation` test that verifies:

- [ ] `unified-agent-config.json` is included in the redaction pass.
- [ ] The final artifact manifest contains `unified-agent-config.json`.
- [ ] No regression occurs in the existing `evaluation.json` and `REPORT.md` writes.

If a full `runEvaluation` test feels too heavy, the fallback is:

- [ ] Extract the evidence artifact name list into a helper or constant.
- [ ] Unit-test that `unified-agent-config.json` is included in that list.

That fallback is acceptable but weaker than a real run path test.

### 3. No API or web regression test required for this feature

Because artifact discovery is already dynamic, no dedicated API or frontend test should be required unless existing tests prove otherwise.

Optional lightweight regression checks:

- [ ] Verify the bundle route still returns all store-listed artifacts.
- [ ] Verify the frontend continues to render manifest-driven download buttons.

## Validation

Run the smallest useful checks after implementation:

- [ ] Targeted tests for the new collector and redaction coverage.
- [ ] `pnpm lint`

If the test footprint ends up touching evaluation artifact behavior broadly, also run:

- [ ] The relevant worker evaluation test subset.

## Acceptance Criteria

- [ ] Completed evaluations include `unified-agent-config.json` in `artifactManifest`.
- [ ] Bundle downloads include `unified-agent-config.json`.
- [ ] Single-artifact download works for `unified-agent-config.json`.
- [ ] `unified-agent-config.json` contains the current persisted `agents.unifiedConfig` value at evaluation time.
- [ ] When `unifiedConfig` is unset, `unified-agent-config.json` is present with JSON `null` content.
- [ ] The artifact is passed through the evaluation redaction path.
- [ ] No API schema changes are required.
- [ ] No frontend code changes are required.
- [ ] `pnpm lint` passes.

## Caveats

### Current versus historical truth

This feature captures the current persisted unified config at evaluation time. It does not guarantee the exact config that was active during the historical session being evaluated.

If the product later needs historical accuracy, that requires a separate design for session-bound config snapshots.

### Terminology: "strategy" is ambiguous for agents

For bots, "strategy" usually means `bots.config.strategy`.

For agents, the closest equivalent is not a single strategy object. It is typically some combination of:

- `unifiedConfig.technical`
- `unifiedConfig.intelligence`
- `unifiedConfig.execution`
- `unifiedConfig.risk`

This feature should be framed as "download current unified agent config," not "download agent strategy," to avoid confusion with bot strategy config.

### Artifact shape should stay stable once shipped

If consumers begin relying on `unified-agent-config.json`, later changing it from raw unifiedConfig JSON to a wrapped metadata object would be a breaking change in practice.

For that reason, this plan recommends writing the raw unifiedConfig value directly.

## Alternatives

### Alternative A — Extend `agent-metadata.json` instead of adding a new file

Not recommended.

Pros:

- One fewer artifact.
- Slightly less code.

Cons:

- Overloads a compact summary file.
- Muddies the purpose of `agent-metadata.json`.
- Makes future consumers parse a mixed summary-plus-config payload.

### Alternative B — Add `technical-config.json` only

Reasonable only if the product requirement is explicitly limited to technical scan settings.

Pros:

- Even smaller surface.
- Avoids exposing intelligence model-selection fields.

Cons:

- Narrower than the stated goal.
- Likely leads to follow-up requests for intelligence, execution, and risk anyway.

### Alternative C — Add `bot-configs.json` in the same change

Not recommended for this feature.

Pros:

- Fuller operational picture.

Cons:

- Materially broader scope.
- Introduces additional query, shape, and semantics decisions.
- Mixes "agent current config" with "bot fleet config" in one change.

### Alternative D — Make unified config part of `evaluation.json` only

Possible, but not preferred.

Pros:

- No extra standalone artifact in the list.
- One fewer file download.

Cons:

- `evaluation.json` is report-oriented structured output, not a direct evidence artifact.
- Separate artifact is easier to inspect and reason about.
- A dedicated evidence file aligns better with the current bundle model.

## Follow-Up Options

Out of scope for this plan, but natural follow-ups:

- Historical session-bound agent config snapshots.
- `bot-configs.json` download artifact.
- Feeding `unified-agent-config.json` into the optional narrative prompt.
- Showing unified config inline in the evaluation UI instead of only as a download.