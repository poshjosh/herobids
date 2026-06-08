# How To Implement

This document explains how to implement work in `agent-evolution` without letting the roadmap, reference docs, task files, and code drift apart.

**Roadmap:** [ROADMAP.md](./ROADMAP.md)

---

## Purpose

The failure mode we are preventing is simple:
- strategy changes, but `ROADMAP.md` is not updated
- design changes, but `references/*.md` are not updated
- implementation moves, but `tasks/*.md` still show the old state
- later agents read stale docs and continue in the wrong direction

This protocol keeps one clear source of truth at each level.

---

## Source Of Truth

Use the files for different purposes. Do not overload them.

| File class | Purpose | What belongs there |
|---|---|---|
| `ROADMAP.md` | Strategic direction | epic ordering, scope constraints, high-level priorities, cross-epic logic |
| `references/*.md` | Design and specification | rationale, architecture, contracts, implementation shape, constraints |
| `tasks/*.md` | Operational tracking | current tasks, dependencies, status, acceptance criteria |
| Code | Actual implementation | the real system state |

If two layers disagree, fix the documentation layer that is supposed to describe that reality before continuing.

---

## Session Start Ritual

Every implementation session for `agent-evolution` starts here:

1. Open [ROADMAP.md](./ROADMAP.md).
2. Identify the epic you are working on.
3. Open the linked task file for that epic.
4. Open the linked reference doc or docs for that epic.
5. Verify the task you are about to work on is still accurate given the current code.
6. Only then start editing code.

This should take about two minutes. Skipping it is how drift begins.

---

## Before Starting A Task

1. Find the task in the relevant `tasks/*.md` file.
2. Confirm its dependencies are complete.
3. Mark the task `in-progress` before changing code.
4. Re-read the acceptance criteria.
5. If the task no longer matches reality, stop and run the catch-up process below.

---

## Catch-Up Process

Use this when code or docs have already drifted.

1. Do not write new code yet.
2. Open the relevant task file.
3. For each affected task, determine whether it is:
   - `done`
   - `partial`
   - `not-started`
   - `blocked`
4. Update the task file to reflect reality.
5. If the implementation changed the intended design, update the relevant file under `references/` before resuming.
6. If the strategic ordering or scope changed, update [ROADMAP.md](./ROADMAP.md) before resuming.

Rule: **reconcile the docs first, then continue implementation.**

---

## When The Plan Changes

Changes are expected. Silent changes are not.

If you discover a better approach while implementing:

1. Stop.
2. Decide which layer changed:
   - strategic change → update `ROADMAP.md`
   - design/spec change → update `references/*.md`
   - execution/status change → update `tasks/*.md`
3. Make the documentation change first.
4. Then implement the code change.

Do not leave a design change living only in code.

---

## Task Status Rules

Use these values consistently:

| Status | Meaning |
|---|---|
| `not-started` | No implementation has begun |
| `in-progress` | Actively being worked on now |
| `done` | Code complete and validation passed |
| `blocked` | Cannot proceed; reason must be written in the task file |
| `partial` | Some implementation exists, but acceptance criteria are not fully met |

`partial` should only appear during catch-up or handoff. Normal forward progress should move from `not-started` → `in-progress` → `done`.

---

## Definition Of Done

A task is `done` only when all of the following are true:

1. The code change is implemented.
2. The focused validation for that task has passed.
3. `pnpm lint` passes for the touched area or repo as appropriate.
4. Existing tests relevant to the change still pass.
5. The task file reflects the current status.
6. Any design or roadmap changes discovered during implementation were written back to docs.

If one of these is false, the task is not done.

---

## Validation Discipline

After the first substantive code edit, run the narrowest meaningful validation immediately:

1. the test for the touched slice, if one exists
2. otherwise a narrow lint/typecheck/build for the touched slice
3. otherwise the best available focused validation command

Do not continue patching unrelated things before that first validation.

---

## Handoff Rules

If you stop mid-task:

1. Leave the task as `in-progress` only if someone is actively continuing immediately.
2. Otherwise set it back to `not-started` or `partial`, whichever is true.
3. Add a short note in the task file describing:
   - what was changed
   - what remains
   - what validation passed or failed

A fresh agent should be able to resume from the task file without reconstructing context from chat history.

---

## Practical Rule

If a future agent can read only these files and still continue correctly:
- [ROADMAP.md](./ROADMAP.md)
- the relevant file in [references](./references)
- the relevant file in [tasks](./tasks)

then the process is working.

If they would need the chat transcript to understand what to do next, the process failed.
