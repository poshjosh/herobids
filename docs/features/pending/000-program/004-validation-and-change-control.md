# Validation And Change-Control

**Status:** complete  
**Created:** 2026-08-29  
**Depends on:** [000-document-tree.md](./000-document-tree.md), [001-master-roadmap.md](./001-master-roadmap.md), [002-feature-doc-template.md](./002-feature-doc-template.md), [003-spec-agent-playbook.md](./003-spec-agent-playbook.md)

## Purpose

This document defines the canonical status vocabulary for active docs and task
items, the minimum validation evidence required before task lists, features,
or program slices can be marked complete, and the change-control rules to use
when implementation discovers plan drift.

It is grounded in the current mixed pending-doc state, where status words such
as `proposed`, `draft`, `pending`, and `Ready for implementation` already
exist. C05 standardizes interpretation now without renaming files or requiring
an immediate normalization pass.

## Scope

This doc includes:

1. canonical status values for active program docs, feature docs, phase docs,
   task-list docs, and task items
2. compatibility rules for legacy status words already present in pending docs
3. minimum completion evidence at task-list, feature, and program level
4. change-control rules for local discoveries, same-feature plan refinements,
   and escalations that reach program-control scope

This doc does not include:

1. renaming legacy files or folders
2. replacing per-feature or per-task validation sections
3. permitting silent changes to fixed decisions, cross-feature dependencies,
   or roadmap order

## Canonical Status Values For Docs

Use the exact lowercase values below in every active doc `Status` line.

| Status | Meaning | Use when |
| --- | --- | --- |
| `draft` | Active authoring state | The doc exists, but scope, decisions, dependencies, or validation are not yet stable enough for implementation handoff. |
| `ready` | Active and implementation-ready | The doc is authoritative and executable once its named prerequisites are satisfied. |
| `in-progress` | Active and currently being implemented | Code or doc execution against this slice has started, but completion evidence is not yet satisfied. |
| `blocked` | Active but paused | Work cannot continue because of an unresolved dependency, conflict, or decision outside open latitude. |
| `complete` | Finished and validated | The slice governed by the doc is done and the required validation evidence is recorded. |
| `historical` | Reference only | The doc is kept for context and must not control new implementation. |
| `superseded` | Replaced by a newer authority | The doc no longer governs the active path because a later active doc or decision replaced it. |

Apply the doc statuses with these rules:

1. Use the status token alone in `**Status:**`. Put explanations in
   `## Dependencies`, `## Open Questions`, or a separate `**Blocked by:**`
   line when needed.
2. `historical` and `superseded` remove a doc from the active path even if the
   file has not yet moved under `archive/`.
3. Task-list files use the same doc-status vocabulary as feature and
   program-control docs.
4. A high-level or phase doc must not be marked `complete` while an in-scope
   active child doc or active task list remains incomplete, unless the parent
   doc is first updated to narrow or supersede that child scope explicitly.

Expected active-doc transition:

`draft -> ready -> in-progress -> complete`

`blocked` may interrupt any active state. `historical` and `superseded` are
exit states from the active path.

## Canonical Status Values For Task Items

Use the exact lowercase values below for task items inside active task lists.

| Status | Meaning | Use when |
| --- | --- | --- |
| `not-started` | No implementation work has begun | The item is still queued. |
| `in-progress` | Work is actively underway | Code or doc work has started, but validation is not complete. |
| `blocked` | Work cannot continue | The item is waiting on a dependency, conflict resolution, or controlling-doc update. |
| `complete` | Finished and validated | The item's work and validation bullets are satisfied and evidence has been recorded. |

Apply the task-item statuses with these rules:

1. Do not use `pending`, `done`, `ready`, or custom phrases for active task
   items.
2. If one bullet can finish independently of another, split the task item
   instead of marking a partially complete item as `complete`.
3. If a task item's scope moves elsewhere, update the active parent doc and
   task list; do not invent a custom terminal item status to avoid editing the
   plan.

Expected task-item transition:

`not-started -> in-progress -> complete`

`blocked` may interrupt `not-started` or `in-progress`.

## Legacy Compatibility During Normalization

Existing pending docs may keep legacy status words until later normalization,
but they are interpreted through the mapping below.

| Legacy form in repo today | Canonical meaning now | Notes |
| --- | --- | --- |
| `proposed` or `Proposed` | `draft` | Use `draft` for new or edited canonical docs. |
| `draft` or `Draft` | `draft` | Case-normalize when the doc is next edited for substance. |
| `pending` or `Pending` | `draft` by default | If the same line or nearby header makes an unmet dependency explicit, interpret it as `blocked` until normalized. |
| `proposed`, `draft`, or `pending` with trailing prose such as `Proposed — not yet implemented` | canonical meaning of the leading status token | Ignore explanatory prose after the first recognized status token; keep the explanation elsewhere when normalizing. |
| `Ready for implementation` | `ready` | Replace with `ready` when the doc is next substantively edited. |
| `historical` | `historical` | Already canonical; keep lowercase on normalization. |
| `superseded` | `superseded` | Already canonical. |
| task-item `not-started` | `not-started` | Already canonical. |
| author-checklist `[DONE]` | `complete` | Applies to authoring checklists such as the current C01-C14 list. |
| author-checklist `[PENDING]` | `not-started` unless the item is explicitly waiting on an external blocker | If an external blocker is the reason, treat it as `blocked` in normalized task lists. |

Compatibility rules:

1. Interpret legacy words case-insensitively until they are normalized.
2. Apply the same mapping whether the legacy status appears in an inline
   `**Status:**` line or in a small dedicated `## Status` section.
3. Do not introduce new mixed-case or prose-heavy status variants in active
   docs after this file exists.
4. When a doc is next edited for substance, normalize its status token if the
   controlling doc path is already clear.

## Validation Evidence

Completion requires actual evidence, not intent.

Use these evidence rules everywhere:

1. Record only checks that were actually run or directly inspected.
2. Prefer the narrowest executable proof that can falsify the slice: targeted
   tests, focused commands, migrations, route checks, schema checks, or grep
   assertions.
3. Use manual or UAT evidence only when no practical automated proof exists,
   and name the exact steps performed.
4. When a parent doc and child task both define validation, `complete`
   requires satisfying both.
5. A completion claim is incomplete if it says only "verified" or "looks
   good" without naming the check.

### Task-List Evidence

A task item may move to `complete` only when:

1. the item's `Work` is implemented
2. every validation bullet under that item has passed
3. the task list records the actual evidence in the same change, using exact
   command names, test names, grep targets, or manual steps

A task-list doc may move to `complete` only when:

1. every active task item is `complete` or has been removed by an updated
   controlling doc
2. the task list's own completion or end-state check has passed
3. the repo-required final gate has passed for the touched slice; in this repo,
   `pnpm lint` is the minimum final gate unless a controlling doc adds more
   checks

### Feature And Phase Evidence

A feature `001-overview.md`, `001-roadmap.md`, or active `002+` phase doc may
move to `complete` only when:

1. every in-scope active child doc and active task list is complete, or the
   parent doc has been updated to supersede or narrow that scope explicitly
2. every acceptance criterion in the feature or phase doc is satisfied
3. every validation item in the feature or phase doc has passed
4. compatibility, migration, or user-visible checks named by the doc have been
   recorded when they are part of the acceptance criteria
5. the final repo-required gate for the touched code has passed

### Program Evidence

A program-control doc or a program slice in the master roadmap may move to
`complete` only when:

1. every earlier dependency it claims satisfied is actually complete
2. active roadmap links, parent-child links, and the implementation entrypoint
   reflect the new current truth
3. no conflicting active docs remain for the completed slice
4. lower-level feature and task-list evidence already exists; program docs may
   summarize that evidence, but they do not replace it

## Change-Control Rules

Use the smallest controlling-doc update that resolves the discovery.

### Local Discovery: Update And Continue

You may update docs and continue implementation in the same change when the
discovery is local and all of the following remain true:

1. scope, non-goals, dependencies, fixed decisions, and roadmap order stay the
   same
2. no new cross-feature dependency, product policy, or user-visible contract
   is introduced
3. the existing acceptance criteria and validation still prove completion
4. the change is limited to stale paths, stale test names, current-code notes,
   local touchpoints, or equivalent slice-local instructions

In that case, update the current task list or nearest active parent doc first,
then continue implementation.

### Same-Feature Plan Refinement: Update The Nearest Parent Doc First

If implementation discovers that the plan inside one feature needs a real but
still local refinement, update the nearest controlling feature or phase doc
before continuing. This includes cases where you must:

1. split one task into smaller tasks
2. clarify child-doc order inside the same feature
3. tighten acceptance criteria or validation without weakening them
4. add a same-feature dependency that does not change master-roadmap order or
   reopen a fixed decision

After the parent doc is updated, update the child task list to match it, then
resume implementation.

### Cross-Feature Or Fixed-Decision Change: Stop And Escalate

Stop implementation and escalate before making more code changes when the
discovery would do any of the following:

1. add, remove, or reorder a feature dependency in the master roadmap
2. reopen a fixed decision in a feature, phase, or program-control doc
3. change a canonical ID, shared route, shared schema, ownership boundary, or
   other cross-feature contract
4. weaken acceptance criteria or validation so the old evidence no longer
   proves completion
5. require treating `author/` or `archive/` material as authority because the
   active docs are insufficient or conflicting

Escalation action:

1. stop widening code work
2. mark the affected active doc or task item `blocked` when helpful
3. name the exact conflicting docs, discovery, and smallest required decision
4. update the controlling program doc only after the decision is made

## Practical Rules

1. New or substantively edited active docs should use the canonical status
   values from this file.
2. Keep blockers and dependency prose outside the status token.
3. Do not mark a feature `complete` because code landed if the feature doc's
   own validation is still unrun or unrecorded.
4. Do not resolve cross-feature drift by silently editing only the lowest task
   list. Update the smallest controlling higher-level doc, or stop and
   escalate.