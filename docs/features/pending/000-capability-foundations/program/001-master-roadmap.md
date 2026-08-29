# Capability Foundations Program Master Roadmap

**Status:** complete  
**Created:** 2026-08-29

## Purpose

This roadmap defines how `program/` coordinates the active Capability
Foundations documentation path from inside the feature root.

In this narrowed form, `program/` is not a whole-pending-tree execution plan.
It exists here only to provide the local coordination layer, handoff rules,
and later checkpoints for [Capability Foundations](../001-roadmap.md).

## Scope

This roadmap includes:

1. the authoritative entry path into this Capability Foundations feature root
2. the ordered internal Capability Foundations phase sequence already fixed by
   that feature's roadmap
3. the `program/` handoff surfaces that still matter to this local
   coordination layer

This roadmap does not include:

1. sequencing any sibling top-level pending feature folder
2. reviving the deleted whole-tree execution model
3. treating planned-but-absent program-control docs as current entry gates

## Execution Model

Use this coordination order:

1. read [000-document-tree.md](./000-document-tree.md) for the canonical tree,
   document tiers, and the reserved late-created handoff slots
2. enter the feature through
   [000-README.md](../000-README.md)
3. read the canonical high-level spec at
   [001-roadmap.md](../001-roadmap.md)
4. enter the first executable slice through
   [012-shared-capability-taxonomy-revision.md](../012-shared-capability-taxonomy-revision.md)
   and then
   [tasks/001-shared-trading-taxonomy-implementation-tasks.md](../tasks/001-shared-trading-taxonomy-implementation-tasks.md)
5. use later internal phase docs only when the current slice advances or their
   gates become relevant, in the fixed order defined below
6. treat 008 through 011 as supporting references for later phase detail only;
   they are not entry docs and they do not gate step 4

## Coordinated Capability Foundations Path

### Active Entry Sequence

1. [Capability Foundations Folder Guide](../000-README.md)
2. [Capability Implementation Roadmap](../001-roadmap.md)
3. [Shared Capability Taxonomy Revision](../012-shared-capability-taxonomy-revision.md)
4. [Shared Trading Taxonomy Implementation Tasks](../tasks/001-shared-trading-taxonomy-implementation-tasks.md)

### Later Internal Phase Sequence

1. [002-capability-foundations.md](../002-capability-foundations.md)
2. [003-capability-resolution-and-route-migration.md](../003-capability-resolution-and-route-migration.md)
3. [004-worker-tool-visibility-enforcement.md](../004-worker-tool-visibility-enforcement.md)
4. [005-trading-capability-extraction.md](../005-trading-capability-extraction.md)
5. [006-messaging-capability-extraction.md](../006-messaging-capability-extraction.md)
6. [007-capability-naming-cleanup.md](../007-capability-naming-cleanup.md)

### Supporting References

1. [008-cross-service-capability-execution-design.md](../008-cross-service-capability-execution-design.md)
2. [009-initial-capability-registry-and-tool-ownership-manifest.md](../009-initial-capability-registry-and-tool-ownership-manifest.md)
3. [010-capability-activation-model.md](../010-capability-activation-model.md)
4. [011-capability-route-and-response-migration-manifest.md](../011-capability-route-and-response-migration-manifest.md)

These references support later phase detail, but they are non-entry and
non-gating for the first executable slice.

## Program-Control Handoff Surfaces

1. [007-implementation-entrypoint.md](./007-implementation-entrypoint.md) is
   the current single implementation handoff entrypoint. It resolves the same
   live path used by this roadmap: folder guide, roadmap, 012, then tasks/001.
2. [003-spec-agent-playbook.md](./003-spec-agent-playbook.md) remains the
   implementation behavior guide for code-versus-plan disagreements,
   local-adaptation limits, and stop-and-escalate rules.
3. [004-validation-and-change-control.md](./004-validation-and-change-control.md)
   governs status vocabulary, validation evidence, and stop-versus-update
   decisions for this narrowed coordination path.
4. [005-feature-inventory.md](./005-feature-inventory.md) remains relevant as
   a derivative coordination index that sits beside this roadmap, but it does
   not widen the execution scope of this file beyond Capability Foundations.
5. [006-coherence-review.md](./006-coherence-review.md) records the completed
   coherence pass for the narrowed control-doc set.

## Fixed Now

1. `program/` acts here only as the local coordination layer for Capability
   Foundations.
2. The first executable low-level slice is controlled by
   [001-roadmap.md](../001-roadmap.md),
   [012-shared-capability-taxonomy-revision.md](../012-shared-capability-taxonomy-revision.md),
   and
   [tasks/001-shared-trading-taxonomy-implementation-tasks.md](../tasks/001-shared-trading-taxonomy-implementation-tasks.md).
3. [000-README.md](../000-README.md) is the active
   folder guide entrypoint, while
   [001-roadmap.md](../001-roadmap.md) remains the
   canonical high-level Capability Foundations spec.
4. The default later internal order stays
   002 -> 003 -> 004 -> 005 -> 006 -> 007 exactly as fixed by
   [001-roadmap.md](../001-roadmap.md).
5. 008 through 011 remain active supporting references for later phase detail,
   but they are not part of the readiness gate for entering the first slice.
6. [007-implementation-entrypoint.md](./007-implementation-entrypoint.md) is
   now the live single-file handoff entrypoint for the current scope.
7. This roadmap does not track, sequence, or gate any other top-level pending
   feature folder.

## Invariants

1. [Capability Foundations](../001-roadmap.md) is the only implementation
   feature coordinated by this file.
2. Program-control docs may clarify entry, validation, inventory, or coherence,
   but they may not silently widen this roadmap beyond Capability Foundations.
3. Active implementation entry is now
   [007-implementation-entrypoint.md](./007-implementation-entrypoint.md),
   which resolves to
   [000-README.md](../000-README.md) ->
   [001-roadmap.md](../001-roadmap.md) ->
   [012-shared-capability-taxonomy-revision.md](../012-shared-capability-taxonomy-revision.md) ->
   [tasks/001-shared-trading-taxonomy-implementation-tasks.md](../tasks/001-shared-trading-taxonomy-implementation-tasks.md).
4. [002-capability-foundations.md](../002-capability-foundations.md)
   through [007-capability-naming-cleanup.md](../007-capability-naming-cleanup.md)
   are active later phase docs. [008-cross-service-capability-execution-design.md](../008-cross-service-capability-execution-design.md)
   through [011-capability-route-and-response-migration-manifest.md](../011-capability-route-and-response-migration-manifest.md)
   are active references but not first-slice gates.
5. `author/` and `archive/` remain non-authoritative unless an active doc
   explicitly points to them for background.

## Open Or Deferred

1. If the live Capability Foundations entry sequence changes, update
   [006-coherence-review.md](./006-coherence-review.md),
   [007-implementation-entrypoint.md](./007-implementation-entrypoint.md), and
   [003-spec-agent-playbook.md](./003-spec-agent-playbook.md) together.
2. Any broader pending-tree sequencing, inventory expansion, or sibling-feature
   planning is outside this roadmap.