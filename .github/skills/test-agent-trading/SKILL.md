---
name: test-agent-trading
description: 'Run the agent trade test end-to-end, fix all blocking anomalies, and repeat until the full run is clean. Use when asked to run the agent trade test, validate agent trading behaviour, reproduce trading bugs, or run the agent-trade-test.sh loop.'
argument-hint: 'Optional: starting context such as a known error, a specific phase to focus on, or SKIP_TEARDOWN preference'
---

# Run Agent Trade Test

This skill executes the agent trade test loop: boot the stack, run `agent-trade-test.sh`, review all post-trade assertion phases, fix every blocking error, and repeat until a fully clean run is achieved.

## When to Use

- The user asks to run the agent trade test or validate end-to-end agent trading.
- The task requires reproducing or isolating a trading bug under a live stack.
- The user wants the fix-and-rerun loop rather than a one-shot execution.
- The user needs to confirm agent decision flow, journal events, position visibility, or Redis cleanup after trading.

## When Not to Use

- Only unit or integration tests are needed (use `pnpm test` directly).
- The full test suite is required (`test-and-fix` skill covers that).
- Infrastructure is unavailable and the user only wants static analysis.

## Procedure

### Step 1 — Shutdown the stack

```bash
scripts/shell/run/shutdown.sh
```

Ensure a clean slate before booting. Wait for the command to exit cleanly.

### Step 2 — Start the stack

```bash
scripts/shell/run/build-and-run.sh
```

Wait until all services are healthy before proceeding.

### Step 3 — Determine the test timeout

Read `scripts/shell/tests/agent-trade-test.sh` to understand what the script does and how long each phase is expected to take. Choose a suitable `<timeout>` value in milliseconds. Default: `600000` (10 minutes).

### Step 4 — Run the agent trade test

```bash
TIMEOUT_MS=<timeout> scripts/shell/tests/agent-trade-test.sh
```

Wait for the script to complete. Do **not** interrupt before the timeout unless a fatal stack error makes continuation impossible.

### Step 5 — Review post-trade assertion phases

The script runs automated assertions before teardown. Evaluate each phase result:

| Phase | What is checked |
|-------|----------------|
| **3.5** | Decisions are non-rejected; direct agent journal events exist (`GET /journal?actorId=<agent-id>`); position visibility is consistent (`GET /agents/<id>/capabilities/trading/positions` vs `GET /agents/<id>/capabilities/trading/state`) |
| **3.6** | Agent submits `go_flat`; `openPositionCount` drops to 0 |
| **3.7 (bookkeeping audit)** | `closedAt` is set in DB; `go_flat` execution plan is no longer pending/executing; journal event count post-cycle; worker error logs since test start; Redis agent reminder cleanup |

If **any phase fails**, skip the eval step and go directly to Step 7.

To inspect the agent manually after a failure, rerun Step 4 with `SKIP_TEARDOWN=1`:

```bash
TIMEOUT_MS=<timeout> SKIP_TEARDOWN=1 scripts/shell/tests/agent-trade-test.sh
```

### Step 6 — Evaluate agent trading quality (phases 3.5–3.7 all passed)

Read and execute `.ignore/eval/eval-prompt.md` with meaningful values for:
- `evaluation-period` — the time window of the test run
- `agent-id` — the agent that traded during the test

### Step 7 — Investigate and fix blocking problems

For each error or anomaly that prevents trading or indicates a serious defect:

**a. Investigate**
- Read relevant logs, DB state, and code paths.
- Identify the root cause before touching code.

**b. Implement the fix**
- Prefer the smallest architecturally sound change.
- Follow all conventions in `AGENTS.md` and `docs/best-practices/`.

**c. File a bug report**
```
docs/bug-reports/2026/<MM>/<DD>/<serial>-<bug-title>.md
```

**d. Code review**
- Run the `CodeReviewer` agent per `.github/agents/CodeReviewer.agent.md`.

**e. Address review observations**
- Apply any valid HIGH or MEDIUM findings before continuing.

**f. Verify tests pass**
```bash
pnpm lint
pnpm test
```

**g. Commit**
```bash
git add -A
git commit -m "<scope>: <what and why>"
```

**h. Return to Step 1** and repeat the full loop.

### Step 8 — Stop when clean

When a full run completes with no blocking anomalies in any phase and the eval shows no serious problems, the loop is complete.

## Decision Points

- If a phase 3.5–3.7 failure is infrastructure noise (e.g., flaky Redis timing), attempt one immediate retry before treating it as a code defect.
- If the stack fails to boot in Step 2, fix the infrastructure issue before attempting the test run.
- If the eval in Step 6 surfaces a serious trading quality issue (not just a metric), treat it as a defect and enter Step 7.
- Code review observations rated LOW may be deferred; HIGH and MEDIUM must be resolved before committing.

## Completion Criteria

- A full run of `agent-trade-test.sh` completes with all phases (3.5, 3.6, 3.7) passing.
- The eval in `.ignore/eval/eval-prompt.md` shows no serious trading quality problems.
- All discovered blocking bugs have been fixed, filed, and committed.
- `pnpm lint` and `pnpm test` pass.
