# Review: Skill Tool Validation

## Verdict

Not represented in the current `main...HEAD` diff.

The current tree already contains the shared tool catalog, worker startup assertions, API-side `requiredTools` validation, and the runtime descriptor backstop. But the branch diff for this review only touches [apps/api/src/routes/skills.ts](../../../apps/api/src/routes/skills.ts) as part of the later system-skill startup sync refactor. The core files this plan calls out are otherwise unchanged versus `main`, so marking this plan `DONE` on the current branch is misleading.

## Findings

1. Critical: branch-local implementation evidence is missing.
   The plan calls for changes in the shared tool manifest, worker registry validation, API validation, and runtime descriptor resolution. Against `main`, this branch only changes the skills route to call `syncSystemSkills()`. That means this backlog item is being reviewed as complete without a corresponding branch-local implementation slice.

2. Medium: review provenance is unclear.
   If this backlog is intended to track cumulative repo state instead of branch-local work, that contract is not stated anywhere in the backlog entry. Reviewers will reasonably assume `DONE` means the implementation is present in the branch under review.

## Suggested Change List

1. Critical: modify [docs/features/pending/backlog-next.md](../backlog-next.md) to clarify whether statuses are branch-local or cumulative repo-state markers.
   Change: modify.
   Dependencies: none.
   Risks/Open questions: if backlog status is meant to drive PR review order, leaving this ambiguous will keep producing false-positive `DONE` entries.
   Test expectation: no code test; documentation review only.

2. High: update [docs/features/pending/skill-tool-validation/001-plan.md](001-plan.md) or an adjacent tracking note with provenance for where this work actually landed.
   Change: modify.
   Dependencies: step 1.
   Risks/Open questions: if the implementation predates this branch and already shipped on `main`, the plan should say that explicitly instead of being re-reviewed as new work here.
   Test expectation: no code test; verify links or commit references are accurate.

3. Medium: if this branch is supposed to own the feature after all, add branch-local evidence for the acceptance criteria in the expected files.
   Files/functions: [packages/domain/src/tools.ts](../../../packages/domain/src/tools.ts), [apps/worker/src/tools/index.ts](../../../apps/worker/src/tools/index.ts), [apps/api/src/routes/skills.ts](../../../apps/api/src/routes/skills.ts), [packages/db/src/agent-runtime-descriptor.ts](../../../packages/db/src/agent-runtime-descriptor.ts).
   Change: add or modify.
   Dependencies: step 1, unless the status is intentionally cumulative.
   Risks/Open questions: this may duplicate code already present on `main`; confirm ownership before making any implementation changes.
   Test expectation: unit-test `findUnknownSkillTools`; integration-test `POST /skills`, `PUT /skills/:id`, and fork rejection; no visual verification needed.

## Open Question

Should `backlog-next.md` be reviewed as a branch-local completion checklist or as a whole-repo progress tracker? The answer changes whether this item is a documentation bug or a delivery gap.