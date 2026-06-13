---
name: routine-madness
description: 'Implement a saved plan or checklist, then review and iterate until only LOW-severity observations remain. Use when working from docs/features plans, implementation prompts, or any task that requires a review-fix loop with explicit HIGH/MEDIUM/LOW findings.'
argument-hint: 'Plan path or implementation task'
---

# Routine Madness

This skill packages a repeatable implementation loop for repository work: implement from an existing plan, review the result, fix anything above `LOW`, and repeat until the slice is complete.

## When to Use

- The user already has a plan, checklist, or prompt that describes what to implement.
- The task needs both execution and self-review, not just coding to the first green test.
- The workflow should explicitly classify findings as `HIGH`, `MEDIUM`, or `LOW` before deciding whether to continue.
- The request refers to a plan under `docs/features/`, `docs/prompts/`, or a similar saved implementation brief.

## When Not to Use

- The main job is to create the plan rather than execute it.
- The user wants brainstorming, architecture exploration, or code review only.
- The task is a one-off edit with no meaningful review loop.

## Procedure

1. Resolve the source of truth.
   - Prefer the exact plan path or prompt the user named.
   - If the user refers to an existing plan without a path, identify the most relevant saved plan before editing.
   - Treat that document as the implementation contract unless the user overrides it.

2. Load the local constraints before editing.
   - Read the repository instructions that govern architecture, validation, and style.
   - Read only the nearby code needed to identify the controlling code path and one falsifiable local hypothesis.
   - Avoid broad repo exploration once the owning slice is clear.

3. Implement incrementally.
   - Make the smallest grounded change that advances the plan.
   - Prefer fixing root causes over adding compatibility shims or duplicate paths.
   - Preserve existing conventions unless the plan explicitly requires a new pattern.

4. Validate immediately after the first substantive edit.
   - Run the narrowest relevant executable check for the touched slice.
   - If that check fails but still supports the current hypothesis, repair locally and rerun the same check.
   - If it falsifies the hypothesis, step one hop closer to the real control point and continue.

5. Review the implementation.
   - Check for correctness, completeness, regressions, migration safety, contract drift, and missing tests.
   - Record observations with explicit severity: `HIGH`, `MEDIUM`, or `LOW`.
   - If no observations above `LOW` remain, stop.

6. Fix review findings and repeat.
   - Address `HIGH` and `MEDIUM` findings first.
   - Revalidate the touched slice after each fix.
   - Return to the review step until only `LOW` findings remain or there are no findings.

7. Finish with repository validation.
   - Run targeted tests for touched code when available.
   - Run the repo-required validation command before considering the task complete.
   - Summarize what changed, how it was validated, and any remaining low-risk gaps.

## Decision Points

- If the source document conflicts with the codebase's current architecture, prefer the architectural seam that satisfies the plan with the smallest coherent change.
- If multiple fixes are possible, choose the one that removes the root cause and reduces future drift.
- If a finding is only stylistic and has no behavioral or maintainability cost, classify it as `LOW` and do not block completion on it.

## Completion Criteria

- The saved plan or prompt has been implemented.
- Review findings above `LOW` have been addressed.
- Focused validation has passed for the touched slices.
- Repository-level required validation has been run, or any blocker has been stated explicitly.

## Repo Notes

- In this repository, `pnpm lint` is the minimum final validation gate unless the user explicitly narrows scope.
- Keep implementation and review tightly coupled; do not stop at the first apparent completion.