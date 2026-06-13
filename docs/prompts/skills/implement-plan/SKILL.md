---
name: implement-plan
description: 'Implement a saved implementation plan or checklist. Use when asked to execute a plan from docs/features, follow docs/prompts/implement-plan.md, make the code changes, review the implementation, and iterate until no findings above LOW remain.'
argument-hint: 'Plan path or implementation task'
---

# Implement Plan

This skill is for repository development work.

## When to Use

- The user asks to implement a plan that already exists.
- The user wants implementation plus self-review, not just planning.

## When Not to Use

- No plan exists yet and the main task is to create one.
- The user wants broad brainstorming instead of execution.
- The task is unrelated to repository development workflow.

## Procedure

1. Resolve the plan input.
   - Prefer an explicit plan path from the user.
   - If the user refers to the latest plan, inspect `docs/features/` and choose the newest dated plan file.
   - Read [the implementation loop](./references/implementation-loop.md) before editing.

2. Load the repo constraints that govern implementation.
   - Follow `AGENTS.md` and the documents in `docs/best-practices/`.
   - Keep changes minimal and architecturally consistent.
   - Use the nearest owning code path instead of exploring broadly.

3. Implement the plan incrementally.
   - Read only the local code needed to form one falsifiable hypothesis.
   - Make the smallest grounded edit that advances the plan.
   - After the first substantive edit, run the narrowest relevant validation immediately.

4. Review what you implemented.
   - Check completeness, correctness, and regressions.
   - Record observations as `HIGH`, `MEDIUM`, or `LOW`.
   - If there are no observations above `LOW`, stop.

5. Address observations and repeat.
   - Fix the current slice in an architecturally sound way.
   - Re-run focused validation after each repair.
   - Repeat the review/fix loop until only `LOW` observations remain or none remain.

6. Finish with repo-level validation.
   - Run targeted tests for touched code when available.
   - Run `pnpm lint` before considering the work complete.
   - Summarize what changed, how it was validated, and any remaining low-risk gaps.

## Repo Notes

- Treat the plan file as the source of truth unless the user overrides it.
- Prefer the existing `.github/agents` flow only as an optional handoff pattern, not as a requirement.
- Do not create extra documentation unless the plan or code change needs it.

## References

- [Implementation loop](./references/implementation-loop.md)