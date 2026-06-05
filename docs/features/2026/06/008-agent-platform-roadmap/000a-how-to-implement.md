# Implementation Guide

This document explains how to work through the agent platform roadmap without introducing the silent divergence between plans and code that caused the current state of herobids.

**Roadmap:** [000-roadmap.md](./000-roadmap.md)

---

## The Core Problem This Process Solves

Plans were written, implementation started, and the code drifted from the plan without the plan being updated. By the time anyone looked at the plan again, it no longer described reality. This process prevents that by making the plan the living record of what was decided and why, not a snapshot frozen at the start.

---

## Plan File Anatomy

Each plan file has the same structure:

```
# Plan N: Title
**Phase:** N
**Status:** not started | in progress | done
**Depends on:** ...

## Progress
| Step | Description | Status |
|---|---|---|
| N.1 | ... | not started | in progress | done |

## Goal / Context / Deliverables
[the actual plan content]

## Exit Criteria
- [ ] item
- [ ] item

## Decision Log
| Date | Decision | Reason |
|---|---|---|
```

---

## Workflow

### Before starting a phase

1. Read the plan file end-to-end. Note any step that seems wrong given the current state of the code.
2. If you find a contradiction, update the plan **before touching any code**. Log it in the Decision Log with today's date and the reason.
3. Set `**Status:** in progress` in the plan header.

### Working through steps

1. Mark the step `in progress` in the Progress table **before** writing any code.
2. Implement the step. Aim for one commit per step — atomic and focused.
3. Commit message format: `feat(phase-N): <step description>` (e.g. `feat(phase-1): rename trading_instances to bots in domain types`)
4. Mark the step `done` immediately after the commit.
5. Move to the next step.

Do not batch multiple steps into one commit. Do not mark steps done in advance.

### Deviating from the plan

Deviations are expected. The rule is: **write it down before you implement it**.

1. Stop.
2. Open the plan file.
3. Append a row to the Decision Log: `| YYYY-MM-DD | what changed and why |`.
4. Update the affected step description or add a new step if needed.
5. Then implement.

This keeps the plan honest. The Decision Log is append-only — never delete or edit past entries.

### Finishing a phase

1. All steps are `done` in the Progress table.
2. All Exit Criteria checkboxes are ticked.
3. `pnpm lint` passes.
4. All existing tests pass.
5. Set `**Status:** done` in the plan header.
6. Update the Overall Status table in [000-roadmap.md](./000-roadmap.md).

---

## Commit Discipline

| Type | When | Example |
|---|---|---|
| `feat(phase-N)` | A new capability or step | `feat(phase-1): add creatorType/creatorId to bots table` |
| `fix(phase-N)` | Correcting something broken | `fix(phase-1): ensure bots rename propagates to worker` |
| `docs(phase-N)` | Plan or doc update only | `docs(phase-1): log decision to defer blueprint split` |
| `refactor(phase-N)` | Internal restructure, no behavior change | `refactor(phase-1): extract bot domain types to separate file` |

One logical change per commit. If you find yourself writing "and" in the commit message, split it.

---

## Decision Log Rules

- **Append-only.** Past entries are immutable. They are evidence of what was decided and why.
- **Write before you implement.** The log entry precedes the code change, not follows it.
- **Be specific.** "Changed X because Y" not "updated approach."
- **One row per decision.** If a decision has multiple consequences, one row is still fine — describe the decision, not each file touched.

---

## Status Values

| Value | Meaning |
|---|---|
| `not started` | No work has begun |
| `in progress` | Actively being worked on — at most one step per plan at a time |
| `done` | Step is complete, committed, lint passes |
| `blocked` | Cannot proceed; reason should be noted in the Decision Log |

---

## What "Done" Means

A step is `done` when:
- The code change is committed
- `pnpm lint` passes (no new TypeScript errors)
- No existing tests are broken
- The plan file reflects the current state

A phase is `done` when all steps are done and all Exit Criteria are ticked.

---

## Questions

If something is unclear or contradictory, stop and ask before implementing. A five-minute question is cheaper than two hours of rework.
