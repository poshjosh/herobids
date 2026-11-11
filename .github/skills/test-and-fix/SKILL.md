---
name: test-and-fix
description: 'Build, lint, build the agent image, run the full test workflow, and fix failures until all checks pass. Use when asked to run all tests, execute the repo validation sequence, perform browser UATs, and file bug reports for real defects.'
argument-hint: 'Optional scope or failing test context'
---

# Test and Fix

This skill runs the repository validation workflow end to end, fixes failures as they appear, and repeats until the required checks pass.

## When to Use

- The user asks to run tests or validate the repository.
- The task requires the full build, lint, Docker image, and test sequence rather than a narrow targeted check.
- The user wants manual browser UATs after automated validation.
- The user expects real defects to be fixed rather than just reported.

## When Not to Use

- The user wants code review or debugging without running the full validation sequence.
- The required infrastructure is unavailable and the user only wants static analysis.

## Procedure

1. Prepare the environment.
   - Confirm the repository prerequisites required by the test flow are available.
   - Read `AGENTS.md` and any referenced test instructions that constrain validation.
   - If the user already provided failing commands or logs, start from those before re-running broader checks.

2. Run the required validation sequence in order.
   - `pnpm build`
   - `pnpm lint`
   - `docker build -f docker/Dockerfile.agent -t herobids-agent:latest .`
   - `scripts/shell/tests/run-all-tests.sh --e2e`

   **Bound the output of every command** (see the Long-Run Memory Hygiene
   section). These commands emit large logs; capturing them wholesale into
   context is the main cause of runaway memory over long runs. Redirect to a
   log file and read back only a slice — pull the full log into context only
   when a command fails, and even then only the failing tail:

   ```bash
   pnpm build      > /tmp/tf-build.log  2>&1 || tail -n 80  /tmp/tf-build.log
   pnpm lint       > /tmp/tf-lint.log   2>&1 || tail -n 80  /tmp/tf-lint.log
   docker build -f docker/Dockerfile.agent -t herobids-agent:latest . \
                   > /tmp/tf-docker.log 2>&1 || tail -n 120 /tmp/tf-docker.log
   scripts/shell/tests/run-all-tests.sh --e2e \
                   > /tmp/tf-e2e.log    2>&1 || tail -n 200 /tmp/tf-e2e.log
   ```

3. Stop on the first failure and fix it.
   - Treat code, tests, scripts, and configuration as valid fix targets when they are the root cause.
   - Prefer the smallest architecturally sound fix over broad speculative edits.
   - After the fix, rerun the same failed command before proceeding.

4. Continue the sequence only after the current command passes.
   - Once the failed command is green, commit related changes, then resume with the next command in order.
   - Repeat the stop-fix-rerun loop until the entire automated sequence succeeds.

5. Run manual user-acceptance tests.
   - Launch the application in a controllable browser.
   - Follow `docs/tech/user-acceptance-tests.md`.
   - Remove each pass mark before execution, then mark it passed only after the scenario succeeds.
   - If a UAT fails, fix the issue and rerun the affected UATs until they pass.

6. Record real defects when appropriate.
   - For each substantive bug discovered during validation or UAT, add a report under `docs/bug-reports/yyyy/MM/dd/<serial>-<name>.md` when the defect should be preserved for team follow-up.
   - Do not file bug reports for expected local-environment problems unless they reveal a real product or workflow defect.

7. Finish with a validation summary.
   - State which commands ran and which fixes were made.
   - Mention any blockers, skipped steps, or environment prerequisites that prevented full completion.
   - Confirm whether browser UATs and bug reports were completed.

## Decision Points

- If an early command fails, do not continue to later commands until that failure is resolved.
- If a failure is caused by missing local infrastructure rather than a code defect, state the blocker clearly and avoid masking it with unrelated changes.
- If a discovered issue is a genuine product bug, fix it when feasible and decide whether it also needs a durable bug report.

## Completion Criteria

- `pnpm build` passes.
- `pnpm lint` passes.
- The agent Docker image build passes.
- `scripts/shell/tests/run-all-tests.sh --e2e` passes.
- Manual UATs in `docs/tech/user-acceptance-tests.md` are completed, or the blocker is stated explicitly.
- Any appropriate bug reports have been filed.

## Long-Run Memory Hygiene

This skill loops (stop → fix → rerun) and can run for hours. The IDE holds the
agent context in memory, so anything pulled into context accumulates across
iterations and can exhaust machine RAM. Keep the footprint bounded:

- **Bound command output.** Never stream full build/docker/test logs into
  context. Redirect to a file and read back only a tail (see Step 2). On
  success, keep just the pass/fail line; on failure, keep only the failing
  tail (~80–200 lines).
- **Analyse on disk.** When inspecting a large log, use `grep`/`tail`/`rg` to
  extract the relevant lines rather than reading the whole file into context.
- **Do not re-echo.** Once a command passes, don't reprint its captured log.
- **Checkpoint between iterations.** After each fix+commit, treat the commit
  and any bug report as the durable record of progress. Do not carry the full
  transcript of prior iterations forward in your reasoning.
- **Restart on growth.** If the run has gone through many iterations or the
  context feels large, summarise progress (what passed, what was fixed, what
  remains), tell the user, and recommend starting a fresh session (or running
  `/compact` in Kiro) before continuing. Peak memory resets on a fresh session.
