---
name: test-agent-trading-and-fix
description: 'Run the agent trade test end-to-end, fix all blocking anomalies, evaluate agent trading quality, fix quickly-fixable behavioural problems, and repeat until the full run is clean and stable. Use when asked to run and fix the agent trade test, validate and fix agent trading behaviour, or run the full trade-test-and-eval loop.'
argument-hint: 'Optional: known error context, phase to focus on, SKIP_TEARDOWN preference'
---

# Run Agent Trade Test and Fix

Full loop: boot stack → trade test → fix blocking errors → evaluate trading quality → fix behavioural problems → repeat until clean and stable.

This skill composes `test-agent-trading` (infrastructure + execution correctness) with `evaluate-agent-and-fix` (trading quality + behavioural correctness).

## When to Use

- You want a single command that runs the trade test, fixes defects, and evaluates trading quality.
- The task requires both execution correctness (phases 3.5–3.7) and behavioural correctness (eval).
- You want the full fix-and-rerun loop rather than separate skills.

## When Not to Use

- You only want to run the test without fixing anything (use `test-agent-trading`).
- You only want to evaluate a past session (use `evaluate-agent` or `evaluate-agent-and-fix`).
- Infrastructure is unavailable.

## Procedure

### Phase A — Trade Test Loop

Follow the full procedure from the `test-agent-trading` skill (Steps 1–8):

1. Shutdown the stack (`scripts/shell/run/shutdown.sh`)
2. Start the stack (`scripts/shell/run/build-and-run.sh`)
3. Determine the test timeout
4. Run `TIMEOUT_MS=<timeout> scripts/shell/tests/agent-trade-test.sh`
5. Review post-trade assertion phases 3.5, 3.6, 3.7
6. If any phase fails → investigate, fix, file bug report, code review, lint/test, commit, return to Step 1
7. Repeat until all phases pass with no blocking anomalies

**Exit Phase A only when**: a full run of `agent-trade-test.sh` completes with phases 3.5, 3.6, and 3.7 all passing.

Note the agent ID and test run time window — they are required for Phase B.

### Phase B — Evaluate and Fix Loop

Follow the full procedure from the `evaluate-agent-and-fix` skill:

1. Run `evaluate-agent` for the agent that traded in Phase A, scoped to the test run time window
2. Triage problems from the report — identify quickly-fixable vs deferred
3. Fix quickly-fixable problems (minimal change, `pnpm lint`, `pnpm test`)
4. File bug reports for all problems (fixed or deferred)
5. Re-evaluate with the same agent and period
6. Repeat until no new fixable problems remain

**Exit Phase B only when**: the latest eval report shows no new fixable problems and all remaining issues are documented as `OPEN` bug reports.

### Phase C — Final verification

```bash
pnpm lint
pnpm test
```

Commit any outstanding changes:

```bash
git add -A
git commit -m "<scope>: fix trading anomalies from trade test run"
```

### Phase D — Summarise

Report to the user:
- Phase A: how many test runs were needed, what was fixed
- Phase B: how many eval iterations were run, what was fixed
- All bug reports filed (with links)
- Any remaining open issues

## Decision Points

- **Phase A blocking failure is infrastructure noise** (flaky Redis timing etc.): retry once before treating as a code defect.
- **Phase B problem requires re-running the agent to validate**: implement the fix, then re-run Phase A from Step 1 before continuing with Phase B.
- **A fix from Phase B breaks Phase A assertions**: treat as a regression — revert, investigate, and file a bug report before retrying.
- **Phase B surfaces a serious trading quality issue that also explains a Phase A failure**: fix it once under Phase B and let Phase A re-run validate it.

## Constraints

- Run `pnpm lint` after every fix. Do not leave type errors.
- Every bug must have a bug report, fixed or deferred.
- Do not skip Phase B if Phase A completes cleanly — the eval is always required.
- Do not commit code that fails `pnpm lint` or `pnpm test`.
