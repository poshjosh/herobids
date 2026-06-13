---
name: run-all-tests
description: 'Build, lint, build the agent image, run the full test workflow, and fix failures until all checks pass. Use when asked to run all tests, execute the repo validation sequence, perform browser UATs, and file bug reports for real defects.'
argument-hint: 'Optional scope note or failing area'
---

# Run All Tests

This skill is for repository development work.

## When to Use

- The user asks to run all tests for the repository.
- The task is to validate a change end-to-end before considering it complete.
- The user wants the standard full-suite workflow rather than an ad hoc subset.
- The task includes fixing failures until the suite is green.

## When Not to Use

- The user asked for only a narrow test target.
- The task is pure planning or code review without execution.
- The environment clearly cannot support Docker, browser automation, or the full stack, and the user did not ask for a degraded alternative.

## Procedure

1. Read [the full test workflow](./references/test-workflow.md).

2. Run the required commands in sequence.
   - `pnpm build`
   - `pnpm lint`
   - `docker build -f docker/Dockerfile.agent -t herobids-agent:latest .`
   - `scripts/shell/tests/run-all-tests.sh --e2e`

3. If any command fails, stop at that command and fix the relevant problem.
   - Fix the code, test, script, or environment issue at the root cause when possible.
   - Re-run the failing command until it succeeds.
   - Then continue with the next command in the sequence.

4. After the scripted checks pass, run the browser-controlled UAT flow.
   - Use `docs/tech/user-acceptance-tests.md` as the checklist.
   - Remove any pass mark before re-running a test.
   - Mark a UAT as passed only after it actually passes.
   - If UAT failures reveal product defects, implement fixes and repeat.

5. File bug reports when appropriate.
   - For meaningful defects found during this process, add a report under `docs/bug-reports/yyyy/MM/dd/<serial>-<name>.md`.
   - Keep the report factual: symptom, cause, fix, and validation.

6. Finish with a concise summary.
   - State which commands passed.
   - State whether UATs were run and their outcome.
   - Note any bug reports created.
   - If something could not be run, state the blocker precisely.

## Repo Notes

- Prefer the repository script `scripts/shell/tests/run-all-tests.sh --e2e` over inventing a separate all-tests harness.
- The script is the standard entry point for unit, integration, functional, and optional E2E coverage.
- Keep fixes narrow and validate immediately after each repair.

## References

- [Test workflow](./references/test-workflow.md)