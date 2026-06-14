---
name: review-code
description: 'Review code and provide prioritised, actionable feedback. Use when asked to review code, audit a PR, check an implementation against a plan, inspect unstaged changes, or assess code quality, readability, naming, and maintainability.'
argument-hint: 'file path, diff, PR branch, or description of what to review (defaults to unstaged changes)'
---

# Review Code

Review code and produce a prioritised, actionable task list of findings. Optionally hand off to a VisualTester or Implementer.

## When to Use

- Reviewing unstaged changes, a branch diff, or specific files.
- Checking that an implementation satisfies the acceptance criteria of a feature plan.
- Auditing code quality, naming, structure, or adherence to project conventions.
- Any request mentioning "review", "audit", "check the code", or "inspect changes".

## When Not to Use

- Bug diagnosis with a stack trace — use the `fix-bug` skill instead.
- Implementing changes — use the `implement-plan` skill instead.

## Inputs

Provide one or more of:
- A file path or directory to review
- A branch name or PR description
- A feature plan or spec the implementation should satisfy
- Nothing — defaults to unstaged changes, then branch diff

## Procedure

### Step 1 — Determine scope

1. If a specific file, directory, or branch was provided, scope the review to that.
2. Otherwise, run `git diff` (unstaged). If empty, run `git diff HEAD~1` (last commit vs default branch).
3. If still no diff, ask the user what to review.

### Step 2 — Gather context

Before reviewing, read:
- The relevant source files in full (not just the diff).
- Any linked feature plan or spec in `docs/features/`.
- `AGENTS.md` and files in `docs/best-practices/` for project conventions.

### Step 3 — Review

Evaluate the code across these dimensions:

| Dimension | What to check |
|-----------|---------------|
| **Correctness** | Does it do what it claims? Edge cases handled? |
| **Plan alignment** | Does it satisfy acceptance criteria? Any spec gaps? |
| **Type safety** | No `any`, `@ts-ignore`, or `as unknown as X`. Branded types used correctly. |
| **Error handling** | Public APIs return `Result<T,E>`. No swallowed errors. Every async loop reschedules on failure. |
| **Security** | No secrets in code. Inputs validated at boundaries (Zod). No OWASP Top 10 issues. |
| **Architecture** | Domain ports respected. No circular deps. Constructor injection used. |
| **Naming** | Meaningful, descriptive names. Tool names use `verb_noun` pattern. No misleading names. |
| **Simplicity** | No over-engineering, premature abstraction, or unnecessary dependencies. |
| **Tests** | Coverage appropriate for the risk level of the change. |

### Step 4 — Output findings

Produce a numbered task list ordered by priority. Each item must include:

- **Priority**: `critical` | `high` | `medium` | `low`
- **Location**: file path and function/component name
- **Change type**: add | modify | delete | rename | move
- **Description**: what to change and why (actionable, not vague)
- **Dependencies**: which other items this depends on (if any)
- **Risks / open questions**: anything that needs a decision before acting

At the end, note which changes should be:
- **Unit tested** — pure logic, isolated functions
- **Integration tested** — cross-package interactions, DB, venues
- **Visually verified** — any UI-facing change

### Step 5 — Handoffs (optional)

After delivering feedback, offer:
- **Rework** → hand off to the `Implementer` agent to address valid findings.
- **Visual Test** → hand off to the `VisualTester` agent if the change affects a frontend.

## Quality Bar

The review is complete when:
- [ ] All five review dimensions are addressed (or explicitly marked N/A).
- [ ] Every finding has a priority, location, and actionable description.
- [ ] Plan alignment is confirmed or deviations are listed as `critical` or `high` items.
- [ ] Testing notes are present.
