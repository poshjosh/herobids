# Spec-Based Implementation Agent Playbook

**Status:** complete  
**Created:** 2026-08-29  
**Depends on:** [000-document-tree.md](./000-document-tree.md), [001-master-roadmap.md](./001-master-roadmap.md)

## Purpose

This playbook tells an implementation agent how to enter the narrowed
program-control docs, follow the active Capability Foundations path,
cross-check the derivative index in
[005-feature-inventory.md](./005-feature-inventory.md) when needed, react
when code disagrees with plan, and feed validation evidence back into the
docs.

In the current narrowed scope,
[001-master-roadmap.md](./001-master-roadmap.md) coordinates only the
Capability Foundations path. It is not a selector across the whole pending
tree.

The active docs define the intended target state. Existing code is evidence of
the current baseline, not authority to widen or reorder the plan.

## Start Point

Use this start rule in order:

1. If `007-implementation-entrypoint.md` exists and is active, start there and
   follow it exactly.
2. If 007 does not exist yet, start from the temporary coordination sequence
   below.

### Temporary Start Rule Before 007 Exists

Read these docs in order:

1. [000-document-tree.md](./000-document-tree.md)
2. [001-master-roadmap.md](./001-master-roadmap.md)
3. [../000-README.md](../000-README.md)
4. [../001-roadmap.md](../001-roadmap.md)
5. [../012-shared-capability-taxonomy-revision.md](../012-shared-capability-taxonomy-revision.md)
6. [../tasks/001-shared-trading-taxonomy-implementation-tasks.md](../tasks/001-shared-trading-taxonomy-implementation-tasks.md)

Steps 3 through 6 are the live Capability Foundations entry sequence until 007
exists.

Consult [005-feature-inventory.md](./005-feature-inventory.md) only as a
derivative coordination index when you need a compact summary of the active
slice classes or historical exclusions.

Do not start from repo code, `author/` notes, or a legacy file name just
because it looks nearby or easier.

## Default Reading Order Inside A Feature

Once inside the coordinated Capability Foundations path, read in this order:

1. [../000-README.md](../000-README.md),
   then
   [../001-roadmap.md](../001-roadmap.md)
2. [../012-shared-capability-taxonomy-revision.md](../012-shared-capability-taxonomy-revision.md),
   then
   [../tasks/001-shared-trading-taxonomy-implementation-tasks.md](../tasks/001-shared-trading-taxonomy-implementation-tasks.md)
3. later active phase docs only when the roadmap or current task list advances
   you to [../002-capability-foundations.md](../002-capability-foundations.md)
   through
   [../007-capability-naming-cleanup.md](../007-capability-naming-cleanup.md)
4. supporting references only when an active doc explicitly points you to
   [../008-cross-service-capability-execution-design.md](../008-cross-service-capability-execution-design.md)
   through
   [../011-capability-route-and-response-migration-manifest.md](../011-capability-route-and-response-migration-manifest.md)
5. [005-feature-inventory.md](./005-feature-inventory.md) only when you need a
   derivative coordination summary of the active slice classes
6. supporting diagrams only when an active doc explicitly references them
7. `author/` and `archive/` only for background, never as implementation
   authority

Do not skip directly to a later phase doc or supporting reference because the
code surface looks smaller. The fixed path controls the current slice.

## Active Versus Historical Docs

Treat each surface as follows:

| Surface | Role | How to treat it |
| --- | --- | --- |
| [../000-README.md](../000-README.md) and [../001-roadmap.md](../001-roadmap.md) | active entry docs | Start the current Capability Foundations path here. These feature-local docs remain the primary authority for entry and sequencing. |
| [../012-shared-capability-taxonomy-revision.md](../012-shared-capability-taxonomy-revision.md) and [../tasks/001-shared-trading-taxonomy-implementation-tasks.md](../tasks/001-shared-trading-taxonomy-implementation-tasks.md) | active ready slice | Enter implementation through these docs after the entry docs. |
| [../002-capability-foundations.md](../002-capability-foundations.md) through [../007-capability-naming-cleanup.md](../007-capability-naming-cleanup.md) | active later phase docs | Use them only when the roadmap or current task list advances the path. |
| [../008-cross-service-capability-execution-design.md](../008-cross-service-capability-execution-design.md) through [../011-capability-route-and-response-migration-manifest.md](../011-capability-route-and-response-migration-manifest.md) | active supporting references | Use them only when an active doc names them; they do not gate entry to the current slice. |
| [005-feature-inventory.md](./005-feature-inventory.md) | derivative coordination index | Use it as a compact summary of slice classes and historical exclusions. It does not override feature-local authority. |
| `author/` | preparation material | Non-authoritative. Do not implement from it or use it to override active docs. |
| `archive/` or any root doc explicitly marked historical or superseded | historical exclusion | Context only. Never use it as authority for new implementation unless an active doc explicitly points to it for background. |

Also treat any root doc explicitly marked historical or superseded as
historical even if it has not yet been moved under `archive/`.

## Choosing The Current Executable Slice

Resolve the slice with this procedure:

1. use [001-master-roadmap.md](./001-master-roadmap.md) to confirm that
   `program/` currently coordinates only the Capability Foundations path
2. follow the entry docs in fixed order:
   [../000-README.md](../000-README.md),
   then
   [../001-roadmap.md](../001-roadmap.md)
3. enter the current executable slice through
   [../012-shared-capability-taxonomy-revision.md](../012-shared-capability-taxonomy-revision.md)
   and then
   [../tasks/001-shared-trading-taxonomy-implementation-tasks.md](../tasks/001-shared-trading-taxonomy-implementation-tasks.md)
4. use [005-feature-inventory.md](./005-feature-inventory.md) only when you
   need a derivative summary of slice classes or historical exclusions
5. move to later active phase docs only when the roadmap or task list advances
   the path beyond the current slice
6. if the current coordinated slice has no active task list and no active doc
   explicitly authorizes direct implementation, stop and escalate; the docs are
   not ready for autonomous implementation handoff

## Code-Versus-Plan Disagreement Rules

Code-versus-plan disagreement exists when the current code cannot satisfy the
active docs without changing at least one of the following:

1. `Scope`
2. `Non-Goals`
3. `Dependencies`
4. `Fixed Decisions`
5. `Acceptance Criteria`
6. `Validation`
7. the execution order fixed by the Capability Foundations roadmap or the
   narrowed master-roadmap coordination path

The cases below define what to do.

| Situation | Action |
| --- | --- |
| The code needs only private refactoring, helper extraction, naming cleanup, or test placement choices that stay inside `Open Latitude`. | Adapt locally. No doc update is required unless the active doc's touchpoints or validation instructions become inaccurate. |
| The active task list has stale file paths, stale test names, stale grep targets, or missing current-code notes, but its scope, dependencies, and fixed decisions still hold. | Update the active doc or task list in the same change and continue. |
| Validation shows the intended feature behavior is still correct, but the doc's baseline description or implementation touchpoints are outdated. | Update the active doc so it matches the validated current code truth, then continue. |
| Two active docs conflict about scope, ordering, canonical IDs, route names, ownership, or required validation. | Stop and escalate. Do not choose a side silently. |
| The code can only be made to pass by widening scope, weakening acceptance criteria, changing a fixed identifier, adding a new prerequisite, or reordering the coordinated Capability Foundations path or its child slices. | Stop and escalate. |
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

Use [004-validation-and-change-control.md](./004-validation-and-change-control.md)
for canonical status values, completion evidence rules, and the boundary
between local doc updates and stop-and-escalate changes. When touching legacy
pending docs, normalize status words only as far as the compatibility mapping
in 004 allows without reopening scope.

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
2. no implementation-ready task list exists for the current coordinated slice
3. active docs disagree about sequencing, ownership, canonical naming, or
   validation requirements
4. satisfying the code path would require changing a fixed decision or the
   narrowed master-roadmap coordination order
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
2. treat [001-master-roadmap.md](./001-master-roadmap.md) as the coordination
   layer for Capability Foundations only
3. follow [../000-README.md](../000-README.md),
   then [../001-roadmap.md](../001-roadmap.md),
   then
   [../012-shared-capability-taxonomy-revision.md](../012-shared-capability-taxonomy-revision.md),
   then
   [../tasks/001-shared-trading-taxonomy-implementation-tasks.md](../tasks/001-shared-trading-taxonomy-implementation-tasks.md)
4. use [005-feature-inventory.md](./005-feature-inventory.md) only as a
   derivative coordination summary when you need a compact slice index
5. treat `author/` and `archive/` as non-authoritative
6. adapt locally only inside open latitude
7. update docs when the validated current truth changes locally but the plan
   still holds
8. stop and escalate when implementation would change scope, decisions,
   dependencies, sequencing, or required validation