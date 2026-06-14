---
name: evaluate-agent-and-fix
description: 'Evaluate agent trading behaviour, fix quickly-fixable problems, file bug reports, and repeat until stable. Use when asked to evaluate and fix an agent, debug a trading session, run an eval-fix loop, or reach a stable agent state. Superset of evaluate-agent — adds fix loop, bug report filing, and iteration.'
argument-hint: 'agent-id/s (required), evaluation-period, deployment-target, expected-llm-cost (e.g. "agent-id=abc123 period=13:00-now Berlin")'
---

# Evaluate Agent and Fix

Run `evaluate-agent`, identify quickly-fixable problems, fix them, file bug reports, and repeat until the agent reaches a stable state.

## When to Use

- After a trade test run when you want not just analysis but active remediation.
- When debugging agent anomalies and want the loop: observe → fix → re-evaluate.
- When asked to "evaluate and fix", "debug the agent", or "run the eval-fix loop".

## When Not to Use

- When the goal is analysis only (use `evaluate-agent`).
- When infrastructure is unavailable and logs cannot be fetched.

## Inputs

Accepts the same inputs as `evaluate-agent`:

| Parameter | Description | Default |
|-----------|-------------|---------|
| `agent-id` | One or more agent UUIDs | Required |
| `evaluation-period` | Time window, e.g. `13:00 - now (Berlin)` | `Past 1 hour` |
| `deployment-target` | Where the stack is deployed | `local docker compose (development)` |
| `expected-llm-cost` | Expected LLM cost for the period | `unknown` |

## Procedure

### Step 1 — Evaluate

Run the `evaluate-agent` skill with the provided inputs. This produces a `REPORT.md` under `.ignore/eval/<yyyy>/<MM>/<dd>/<agent-id>/<serial>/`.

Read the report carefully before proceeding.

### Step 2 — Triage fixable problems

From the report, identify problems that are:
- **Quickly fixable**: a clear root cause, bounded scope, low risk of regression (e.g. missing guard, wrong config value, off-by-one, missing DB write, broken tool handler).
- **Not quickly fixable**: deep architectural issues, unclear root cause, or requiring extensive investigation — file a bug report for these and move on.

For each fixable problem, note:
- The symptom observed in the report
- The root cause (verified against source code, not assumed)
- The proposed fix

If there are no fixable problems, proceed to Step 5.

### Step 3 — Fix

Implement each fix:
1. Read the relevant source files before editing.
2. Make the minimal change that addresses the root cause.
3. Run `pnpm lint` to confirm no type errors are introduced.
4. Run any relevant unit tests if they exist (`pnpm test`).

Do not fix problems that require re-running the agent — those are validated in Step 4.

### Step 4 — File bug reports

For every problem found (fixed or not), file a bug report at:

```
docs/bug-reports/<yyyy>/<MM>/<dd>/<serial>-<slug>.md
```

Where:
- `<serial>` is a zero-padded sequence per day, starting at `001` (scan the day folder for existing files to determine the next serial).
- `<slug>` is a short kebab-case description, e.g. `agent-missing-position-close`.

Bug report format:

```markdown
# Bug Report: <Title>

- **Status:** OPEN | FIXED
- **Severity:** Critical | High | Medium | Low
- **Date:** <yyyy-MM-dd>
- **Discovered:** evaluate-agent-and-fix — <brief context>
- **Summary:** One sentence describing the bug.

## Symptoms

What was observed. Include log lines or DB evidence from the eval output folder.

## Root Cause

Why it happened.

## Fix

What was changed to resolve it (or "Not fixed — see notes" if deferred).

## Notes

Any follow-up actions or caveats.
```

Set **Status** to `FIXED` if the fix was applied in Step 3, otherwise `OPEN`.

### Step 5 — Re-evaluate

Repeat from Step 1 with the same agent and the same evaluation period.

Continue the loop until one of the following is true:
- No new fixable problems are found in the latest report.
- All remaining open issues are deferred (unfixable quickly) and documented as bug reports.

At that point, the session is considered stable.

### Step 6 — Summarise

Report to the user:
- How many iterations were run.
- What was fixed (with links to changed files).
- What bug reports were filed (with links).
- Any remaining open issues.

## Decision Points

- **Ambiguous root cause**: Do not guess. Re-read source, check DB/logs for evidence. If still unclear after a reasonable search, mark as deferred and file a bug report.
- **Fix introduces risk**: If a fix could affect unrelated behaviour or requires a migration, stop and ask the user before applying.
- **Multiple agents**: Run the loop per agent, then write a combined summary.
- **Re-evaluation period**: Use the same evaluation period as the initial run so the comparison is meaningful, unless the agent was restarted mid-fix (in which case scope the new period from the restart time).

## Constraints

- **Only fix what is clearly understood.** Do not guess at root causes.
- **Run `pnpm lint` after every fix.** Do not leave type errors.
- **Do not modify source files during the evaluate step** (Step 1). Fixes happen only in Step 3.
- **Every problem must be documented** — either fixed and marked `FIXED`, or deferred and marked `OPEN`.
