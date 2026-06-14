---
name: fix-bug
description: 'Analyse a bug from terminal output, logs, or a description — check for a prior fix, identify root cause, implement the minimal fix, and file a dated bug report. Use when asked to fix a bug, debug an error, analyse a crash, investigate a stack trace, or reproduce a failure.'
argument-hint: 'terminal output, log file content, or a description of the error (e.g. paste the stack trace or provide a file path)'
---

# Fix Bug

Analyse a bug, implement the fix, and document it in `docs/bug-reports/`.

## When to Use

- Fixing a bug from a stack trace or terminal error output.
- Investigating a crash, assertion failure, or unexpected behaviour.
- Reproducing a reported bug and applying a targeted fix.

## When Not to Use

- Deep architectural refactors — this skill targets isolated, identifiable bugs.
- When no reproduction evidence is available (no logs, no stack trace, no repro steps).

## Inputs

Provide one or more of:
- Pasted terminal output or stack trace
- A log file path (e.g. `.ignore/eval/…/worker.log`)
- A description of the unexpected behaviour

## Procedure

### Step 1 — Check for a prior fix

Scan `docs/bug-reports/` for an existing report describing the same error. If found with **Status: FIXED**, apply the documented fix directly and skip to Step 4.

### Step 2 — Analyse the root cause

Read all relevant source files before forming a hypothesis. Do not guess — verify the root cause against the code.

Identify:
- The immediate trigger (which line, which condition, which input)
- The underlying cause (wrong assumption, missing guard, schema mismatch, etc.)
- Any related code paths that may share the same defect

### Step 3 — Fix

Build a todo list of changes needed, then implement each one:

1. Make the **minimal change** that addresses the root cause. Do not refactor unrelated code.
2. Run `pnpm lint` after every edit — it must pass before proceeding.
3. Run any existing unit tests that cover the affected code (`pnpm test`).
4. Note any potential side effects or follow-up actions required.

### Step 4 — File a bug report

Save a report at:

```
docs/bug-reports/<yyyy>/<MM>/<dd>/<serial>-<slug>.md
```

Where `<serial>` is zero-padded and increments per day (scan the day folder for existing files). `<slug>` is a short kebab-case description.

If an existing report template is present in `docs/bug-reports/`, follow that format. Otherwise use:

```markdown
# Bug Report: <Title>

- **Status:** FIXED
- **Severity:** Critical | High | Medium | Low
- **Date:** <yyyy-MM-dd>
- **Summary:** One sentence.

## Root Cause

Why it happened.

## Fix

What was changed and why.

## Files Changed

- `path/to/file.ts`

## Verification

How the fix was confirmed (lint pass, test pass, manual check).
```

**Severity rubric:**

| Severity | Criteria |
|----------|----------|
| Critical | System cannot operate safely — crash, data loss, silent incorrect execution, security violation |
| High | Core feature broken or significantly degraded; no workaround |
| Medium | Feature partially broken or degraded; workaround exists |
| Low | Minor annoyance, cosmetic issue, or edge case with negligible impact |

Set **Status** to `FIXED` once the fix is applied.

### Step 5 — Summarise

Report:
- Root cause (one sentence)
- What was changed (files + brief description)
- Link to the bug report
- Any follow-up actions or known risks

## Decision Points

- **Cannot reproduce**: Ask the user for more context before proceeding. Do not guess at a fix.
- **Fix is risky / broad**: Stop and ask the user before applying. Describe the risk.
- **Multiple bugs in one trace**: Handle each independently with its own bug report.
- **Bug previously fixed but still occurring**: Reopen the existing report (set Status back to OPEN), investigate why the fix did not hold, and document the new findings.

## Constraints

- Run `pnpm lint` after every fix. Do not leave type errors.
- Make minimal changes — one bug, one fix.
- Every bug must have a bug report, even if trivial.
- Do not bypass TypeScript strict checks (`any`, `@ts-ignore`, `as unknown as X`).
