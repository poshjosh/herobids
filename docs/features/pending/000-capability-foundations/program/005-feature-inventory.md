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
3. the later draft phase docs that remain on the governed path in dependency
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
| [013-native-capabilities-and-external-backends.md](../013-native-capabilities-and-external-backends.md) | ready child slice | Current implementation-ready authority for the external-backend boundary rewrite slice. |
| [tasks/002-external-backend-boundary-implementation-tasks.md](../tasks/002-external-backend-boundary-implementation-tasks.md) | low-level task list | Concrete code-change task surface for the current rewrite slice, subordinate to `013` and the roadmap. |

### Later Draft Phase Docs

These remain draft Capability Foundations phase docs after the current ready
slice and stay ordered by the roadmap's dependency sequence.

| Order | Surface | Role | Inventory meaning |
| --- | --- | --- | --- |
| 1 | [002-capability-foundations.md](../002-capability-foundations.md) | later draft phase doc | Governs the shared native-versus-external foundations that consolidate the generic boundary and registration model after the current ready slice. |
| 2 | [003-capability-resolution-and-route-migration.md](../003-capability-resolution-and-route-migration.md) | later draft phase doc | Governs native-capability and external-backend control-plane resolution plus route migration after the foundations phase. |
| 3 | [004-worker-tool-visibility-enforcement.md](../004-worker-tool-visibility-enforcement.md) | later draft phase doc | Governs generic worker visibility from native activation and external-backend dispatchability once control-plane resolution is stable. |
| 4 | [005-trading-capability-extraction.md](../005-trading-capability-extraction.md) | later draft phase doc | Governs consolidation and completion of the first repo-local external trading backend boundary after generic visibility prerequisites are satisfied. |
| 5 | [006-messaging-capability-extraction.md](../006-messaging-capability-extraction.md) | later draft phase doc | Governs native messaging hardening and extraction that coexists with external backends. |
| 6 | [007-capability-naming-cleanup.md](../007-capability-naming-cleanup.md) | later draft phase doc | Governs terminology cleanup separating native capabilities, external backends, registration mechanisms, runtime families, and legacy terms. |

### Supporting References

These docs remain in-scope, but they are supporting references rather than the
readiness gate for entering the first executable slice.

| Surface | Role | Inventory meaning |
| --- | --- | --- |
| [008-cross-service-capability-execution-design.md](../008-cross-service-capability-execution-design.md) | supporting reference | Reference design for the generic external-backend execution boundary, shared envelope, auth, and readiness rules. |
| [009-initial-capability-registry-and-tool-ownership-manifest.md](../009-initial-capability-registry-and-tool-ownership-manifest.md) | supporting reference | Reference manifest for native capability rows, external backend rows, and exhaustive tool ownership. |
| [010-capability-activation-model.md](../010-capability-activation-model.md) | supporting reference | Reference model for native capability activation and external-backend dispatchability state. |
| [011-capability-route-and-response-migration-manifest.md](../011-capability-route-and-response-migration-manifest.md) | supporting reference | Reference manifest for native capability and external-backend route and response migration. |
| [014-operational-readiness-for-external-backends.md](../014-operational-readiness-for-external-backends.md) | supporting reference | Reference requirements for latency budgets, shadow-mode validation, restart resilience, load testing, and cutover criteria for any external backend. Referenced as a normative input by 005. |

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
| [012-shared-capability-taxonomy-revision.md](../012-shared-capability-taxonomy-revision.md) | superseded slice | Excluded from the active inventory as the old platform-owned first-slice model. |
| [tasks/001-shared-trading-taxonomy-implementation-tasks.md](../tasks/001-shared-trading-taxonomy-implementation-tasks.md) | superseded task list | Excluded from the active inventory as the old first-slice implementation path. |

## Validation

1. Matched the entry helper, high-level roadmap, current executable rewrite slice,
   later active phase docs, and supporting references against
   [000-README.md](../000-README.md).
2. Matched the same inventory classes and the 002 through 007 dependency order
   against [001-roadmap.md](../001-roadmap.md).
3. Confirmed that referenced diagrams remain in-scope support surfaces under
   the tree and README rules even though this file does not list them as
   numbered inventory items.
4. Removed the prior whole-tree pending-feature catalog so this file no longer
   references sibling pending features outside `000-capability-foundations/`.