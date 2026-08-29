# Spec-Based Implementation Agent Playbook

**Status:** proposed  
**Created:** 2026-08-29  
**Depends on:** [000-document-tree.md](./000-document-tree.md), [001-master-roadmap.md](./001-master-roadmap.md), [002-feature-doc-template.md](./002-feature-doc-template.md)

## Purpose

This playbook tells an implementation agent how to enter the pending feature
doc system, choose the current executable slice, treat active versus
historical material, react when code disagrees with plan, and feed validation
evidence back into the docs.

The active docs define the intended target state. Existing code is evidence of
the current baseline, not authority to widen or reorder the plan.

## Start Point

Use this start rule in order:

1. If `007-implementation-entrypoint.md` exists and is active, start there and
   follow it exactly.
2. If 007 does not exist yet, start from the temporary sequence below.

### Temporary Start Rule Before 007 Exists

Read these docs in order:

1. [000-document-tree.md](./000-document-tree.md)
2. [001-master-roadmap.md](./001-master-roadmap.md)
3. [002-feature-doc-template.md](./002-feature-doc-template.md)
4. the earliest feature in the master roadmap whose dependencies are already
   satisfied and whose active docs expose an implementation-ready task list

For the current staged program, that temporary start path resolves to:

1. [../000-capability-foundations/000-README.md](../000-capability-foundations/000-README.md)
2. [../000-capability-foundations/001-roadmap.md](../000-capability-foundations/001-roadmap.md)
3. [../000-capability-foundations/012-shared-capability-taxonomy-revision.md](../000-capability-foundations/012-shared-capability-taxonomy-revision.md)
4. only the relevant normative inputs from [../000-capability-foundations/008-cross-service-capability-execution-design.md](../000-capability-foundations/008-cross-service-capability-execution-design.md) through [../000-capability-foundations/011-capability-route-and-response-migration-manifest.md](../000-capability-foundations/011-capability-route-and-response-migration-manifest.md), as named by the selected task
5. [../000-capability-foundations/tasks/001-shared-trading-taxonomy-implementation-tasks.md](../000-capability-foundations/tasks/001-shared-trading-taxonomy-implementation-tasks.md)

Do not start from repo code, `author/` notes, or a legacy file name just
because it looks nearby or easier.

## Default Reading Order Inside A Feature

Once the current feature is known, read in this order:

1. `000-README.md` when it exists and the folder has multiple active root docs
   or support directories
2. the canonical high-level doc: `001-overview.md` or `001-roadmap.md`
3. only the active `002+` docs that the parent roadmap marks as part of the
   current slice, plus any explicit normative inputs named by the current task
   list
4. the first active task list in `tasks/` whose parent docs, dependencies, and
   validation are specific enough to execute
5. supporting diagrams only when an active doc explicitly references them

Do not skip directly to a later task list because the code surface looks
smaller. The earliest unblocked executable slice is the default.

## Active Versus Historical Docs

Treat each surface as follows:

| Surface | Role | How to treat it |
| --- | --- | --- |
| `000-README.md` | active folder guide | Read it first inside complex feature folders. It helps you navigate, but it does not override numbered active docs. |
| `001-overview.md` or `001-roadmap.md` | canonical high-level spec | This controls scope, dependencies, fixed decisions, and execution order for the feature. |
| `002+` root docs | active child specs or active normative inputs | Read only the docs the parent roadmap or task list makes relevant to the slice you are executing. |
| `tasks/` | low-level execution surface | Start code work only from a task list whose parent docs are active and whose dependencies are satisfied. |
| `author/` | preparation material | Non-authoritative. Do not implement from it or use it to override active docs. |
| `archive/` | historical or superseded material | Context only. Never use it as authority for new implementation unless an active doc explicitly points to it for migration background. |

Also treat any root doc explicitly marked historical or superseded as
historical even if it has not yet been moved under `archive/`.

## Choosing The Current Executable Slice

Choose the slice with this procedure:

1. use [001-master-roadmap.md](./001-master-roadmap.md) to identify the
   earliest feature whose prerequisite features are already satisfied
2. open that feature's `000-README.md` when present so the active and
   historical paths are explicit
3. read the feature's canonical `001-overview.md` or `001-roadmap.md`
4. if the high-level doc splits the feature, follow its child-doc sequence
   until you reach the first slice that is implementation-ready
5. prefer the earliest task list under `tasks/` that has explicit work and
   validation; if multiple task lists are ready, use the lowest task number
6. if no active task list exists and no active doc explicitly authorizes direct
   implementation, stop and escalate; the docs are not ready for autonomous
   implementation handoff

For the current capability-foundations example, the active folder guide,
roadmap, taxonomy revision, the relevant normative inputs from 008 through
011, and
[tasks/001-shared-trading-taxonomy-implementation-tasks.md](../000-capability-foundations/tasks/001-shared-trading-taxonomy-implementation-tasks.md)
together make the shared `trading` taxonomy slice the first executable low-
level task surface.

## Code-Versus-Plan Disagreement Rules

Code-versus-plan disagreement exists when the current code cannot satisfy the
active docs without changing at least one of the following:

1. `Scope`
2. `Non-Goals`
3. `Dependencies`
4. `Fixed Decisions`
5. `Acceptance Criteria`
6. `Validation`
7. the execution order fixed by the parent roadmap or master roadmap

The cases below define what to do.

| Situation | Action |
| --- | --- |
| The code needs only private refactoring, helper extraction, naming cleanup, or test placement choices that stay inside `Open Latitude`. | Adapt locally. No doc update is required unless the active doc's touchpoints or validation instructions become inaccurate. |
| The active task list has stale file paths, stale test names, stale grep targets, or missing current-code notes, but its scope, dependencies, and fixed decisions still hold. | Update the active doc or task list in the same change and continue. |
| Validation shows the intended feature behavior is still correct, but the doc's baseline description or implementation touchpoints are outdated. | Update the active doc so it matches the validated current code truth, then continue. |
| Two active docs conflict about scope, ordering, canonical IDs, route names, ownership, or required validation. | Stop and escalate. Do not choose a side silently. |
| The code can only be made to pass by widening scope, weakening acceptance criteria, changing a fixed identifier, adding a new prerequisite, or reordering features or child slices. | Stop and escalate. |
| An `author/` note or archived file disagrees with an active doc. | Ignore the historical or authoring material. Active docs win. |

## When Local Adaptation Is Allowed

An implementation agent may adapt locally without prior escalation only when
all of the following remain true:

1. the change stays inside the current task list and its active parent docs
2. no new product policy, user-visible contract, or cross-feature dependency is
   introduced
3. no fixed decision is reopened
4. the existing acceptance criteria and validation still prove completion
5. the next task in sequence does not need to change

If any one of these conditions fails, local adaptation is no longer enough.

## When To Update Docs

Update active docs as part of implementation when any of the following occurs:

1. you complete a task and the task list or parent doc must record the new
   current-code truth, finished slice, or concrete validation evidence
2. the active task list's touchpoints, commands, or validation instructions are
   stale but the slice itself is still valid
3. the parent feature doc omitted a local constraint that was already implicit
   in existing fixed decisions and validation, and adding it removes ambiguity
   without changing scope
4. a compatibility note, migration note, or task ordering note is needed so
   the active docs accurately describe what the code now does

Until [004-validation-and-change-control.md](./004-validation-and-change-control.md)
exists, do not invent new status vocabularies. Preserve the status style
already used by the active task list and record only factual, slice-local
updates.

## Validation Feedback Loop

Validation is not separate from the docs. It decides whether the active docs
remain accurate.

Use this loop:

1. run the validation named by the current task list and any controlling parent
   doc before you declare the slice complete
2. if validation fails because of a local implementation defect inside the same
   slice, fix that slice and rerun the same validation before widening scope
3. if validation passes but shows the doc text is now stale, update the active
   doc in the same change set
4. if validation exposes a missing prerequisite, contradictory active docs, or
   a false fixed decision, stop and escalate instead of editing around it
5. do not record validation you did not actually run

Prefer the narrowest evidence that proves the slice: targeted tests, focused
grep checks, schema checks, route checks, and then the required repo-wide
checks such as `pnpm lint` when the active doc names them.

## Stop-And-Escalate Conditions

Stop implementation and escalate when any of the following is true:

1. the active docs do not identify one unambiguous current slice
2. no implementation-ready task list exists for the earliest unblocked feature
3. active docs disagree about sequencing, ownership, canonical naming, or
   validation requirements
4. satisfying the code path would require changing a fixed decision or the
   master-roadmap order
5. a prerequisite feature, migration, contract, or infrastructure boundary is
   missing and the current docs did not authorize creating it here
6. validation evidence shows the plan is unsafe, impossible, or materially
   incomplete
7. proceeding would require treating `author/` or `archive/` material as if it
   were active authority

Escalation should name the exact conflicting docs, the specific code path or
validation result that triggered the stop, and the smallest decision needed to
resume.

## Operating Summary

1. start from the program-control docs, or from 007 once it exists
2. follow the earliest unblocked active feature in master-roadmap order
3. read `000-README.md`, then the canonical `001` doc, then only the relevant
   `002+` docs, then the first executable task list
4. treat `author/` and `archive/` as non-authoritative
5. adapt locally only inside open latitude
6. update docs when the validated current truth changes locally but the plan
   still holds
7. stop and escalate when implementation would change scope, decisions,
   dependencies, sequencing, or required validation