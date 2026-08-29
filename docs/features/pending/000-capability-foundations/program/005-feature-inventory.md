# Capability Foundations Slice Coordination Index

**Status:** complete  
**Created:** 2026-08-29  
**Depends on:** [000-document-tree.md](./000-document-tree.md), [001-master-roadmap.md](./001-master-roadmap.md), [004-validation-and-change-control.md](./004-validation-and-change-control.md), [../000-README.md](../000-README.md), [../001-roadmap.md](../001-roadmap.md)

## Purpose

This document defines a derivative coordination index for the Capability
Foundations surfaces coordinated by `program/`.

In this narrowed form, `program/` does not inventory the top-level pending
feature tree. It inventories the internal document surfaces inside
`000-capability-foundations/` that control entry, execution order, supporting
reference use, and historical exclusions for this program slice.

It therefore replaces this file's earlier whole-program feature-inventory role
with a narrowed coordination index for the current scope.

This file is a derivative coordination index. The primary authority for slice
order, readiness, and role boundaries remains
[000-README.md](../000-README.md) and
[001-roadmap.md](../001-roadmap.md).

## Scope

This document includes:

1. the entry and high-level Capability Foundations docs;
2. the first ready executable slice now used for implementation handoff;
3. the later active phase docs that remain on the governed path in dependency
   order;
4. the supporting references that stay in-scope for later phase detail;
5. the archive material that is explicitly excluded from the active inventory.

This document does not include:

1. sibling pending features outside `000-capability-foundations/`;
2. a whole-tree catalog of top-level pending features;
3. authoring prep material or archive notes as active implementation
   authority;
4. a numbered inventory of supporting diagrams, even when an active doc
   references them.

## Active Inventory

The role labels below summarize the active Capability Foundations docs for
coordination purposes. They do not override the feature-local authority in
[000-README.md](../000-README.md) or
[001-roadmap.md](../001-roadmap.md).

### Entry And High-Level Docs

| Surface | Role | Inventory meaning |
| --- | --- | --- |
| [000-README.md](../000-README.md) | entry helper | Folder guide for the narrowed program path. It routes readers to the canonical roadmap first and then to the first ready slice. |
| [001-roadmap.md](../001-roadmap.md) | canonical high-level spec | Governs phase order, readiness gates, cross-phase invariants, and the distinction between active docs, supporting references, and history. |

### First Executable Slice

| Surface | Role | Inventory meaning |
| --- | --- | --- |
| [012-shared-capability-taxonomy-revision.md](../012-shared-capability-taxonomy-revision.md) | ready child slice | Current implementation-ready authority for the first executable Capability Foundations slice. |
| [tasks/001-shared-trading-taxonomy-implementation-tasks.md](../tasks/001-shared-trading-taxonomy-implementation-tasks.md) | low-level task list | Concrete code-change task surface for the first slice, subordinate to `012` and the roadmap. |

### Later Active Phase Docs

These remain active Capability Foundations phase docs after the current ready
slice and stay ordered by the roadmap's dependency sequence.

| Order | Surface | Role | Inventory meaning |
| --- | --- | --- | --- |
| 1 | [002-capability-foundations.md](../002-capability-foundations.md) | active later phase doc | Governs the broader foundations phase that remains on the active path after the current ready slice. |
| 2 | [003-capability-resolution-and-route-migration.md](../003-capability-resolution-and-route-migration.md) | active later phase doc | Governs capability resolution and canonical route migration after foundations work is in place. |
| 3 | [004-worker-tool-visibility-enforcement.md](../004-worker-tool-visibility-enforcement.md) | active later phase doc | Governs worker-side ownership and activation enforcement once route resolution is stable. |
| 4 | [005-trading-capability-extraction.md](../005-trading-capability-extraction.md) | active later phase doc | Governs the deployable trading capability extraction phase after worker gating is complete. |
| 5 | [006-messaging-capability-extraction.md](../006-messaging-capability-extraction.md) | active later phase doc | Governs the deployable messaging capability extraction phase after trading extraction. |
| 6 | [007-capability-naming-cleanup.md](../007-capability-naming-cleanup.md) | active later phase doc | Governs naming cleanup only after the extraction phases are complete. |

### Supporting References

These docs remain in-scope, but they are supporting references rather than the
readiness gate for entering the first executable slice.

| Surface | Role | Inventory meaning |
| --- | --- | --- |
| [008-cross-service-capability-execution-design.md](../008-cross-service-capability-execution-design.md) | supporting reference | Later-phase design reference for cross-service execution behavior. |
| [009-initial-capability-registry-and-tool-ownership-manifest.md](../009-initial-capability-registry-and-tool-ownership-manifest.md) | supporting reference | Reference manifest for registry shape and exhaustive tool ownership. |
| [010-capability-activation-model.md](../010-capability-activation-model.md) | supporting reference | Reference model for activation state and readiness semantics. |
| [011-capability-route-and-response-migration-manifest.md](../011-capability-route-and-response-migration-manifest.md) | supporting reference | Reference manifest for canonical route IDs and migration coverage. |

## Excluded From The Active Inventory

Referenced diagrams remain allowed active support surfaces under the document
tree and README rules, but this inventory tracks only the numbered textual
authorities and the archive exclusions around them.

Archive material is historical context only. It may inform background reading,
but it does not control the active implementation path coordinated by
`program/`.

| Surface | Role | Inventory meaning |
| --- | --- | --- |
| [archive/000-q-and-a.md](../archive/000-q-and-a.md) | historical context | Excluded from the active inventory and retained only for background context. |
| [archive/001-tasklist.md](../archive/001-tasklist.md) | historical context | Excluded from the active inventory and not a current execution task list. |
| [archive/002-shared-trading-taxonomy-delta.md](../archive/002-shared-trading-taxonomy-delta.md) | historical context | Excluded from the active inventory and retained as transition rationale only. |
| [archive/003-taxonomy-impact-map.md](../archive/003-taxonomy-impact-map.md) | historical context | Excluded from the active inventory and retained as a historical impact note only. |

## Validation

1. Matched the entry helper, high-level roadmap, first executable slice,
   later active phase docs, and supporting references against
   [000-README.md](../000-README.md).
2. Matched the same inventory classes and the 002 through 007 dependency order
   against [001-roadmap.md](../001-roadmap.md).
3. Confirmed that referenced diagrams remain in-scope support surfaces under
   the tree and README rules even though this file does not list them as
   numbered inventory items.
4. Removed the prior whole-tree pending-feature catalog so this file no longer
   references sibling pending features outside `000-capability-foundations/`.