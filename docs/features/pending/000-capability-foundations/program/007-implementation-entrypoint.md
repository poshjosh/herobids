# Capability Foundations Implementation Entrypoint

**Status:** complete  
**Created:** 2026-08-29  
**Depends on:** [001-master-roadmap.md](./001-master-roadmap.md), [003-spec-agent-playbook.md](./003-spec-agent-playbook.md), [004-validation-and-change-control.md](./004-validation-and-change-control.md), [../000-README.md](../000-README.md), [../001-roadmap.md](../001-roadmap.md), [../012-shared-capability-taxonomy-revision.md](../012-shared-capability-taxonomy-revision.md), [../tasks/001-shared-trading-taxonomy-implementation-tasks.md](../tasks/001-shared-trading-taxonomy-implementation-tasks.md)

## Purpose

Provide one unambiguous starting point for spec-based implementation of the
current Capability Foundations slice.

## Current Scope

1. This entrypoint applies only to the narrowed Capability Foundations path under `docs/features/pending/000-capability-foundations/`.
2. Do not start from sibling top-level pending folders.
3. Do not treat `author/`, `archive/`, or the derivative [005-feature-inventory.md](./005-feature-inventory.md) as controlling implementation authority.

## Start Here

Read and follow these docs in order:

1. [../000-README.md](../000-README.md)
2. [../001-roadmap.md](../001-roadmap.md)
3. [../012-shared-capability-taxonomy-revision.md](../012-shared-capability-taxonomy-revision.md)
4. [../tasks/001-shared-trading-taxonomy-implementation-tasks.md](../tasks/001-shared-trading-taxonomy-implementation-tasks.md)

## First Executable Slice

1. Feature: Capability Foundations
2. Current slice: Shared Capability Taxonomy Revision
3. First task list: Shared Trading Taxonomy Implementation Tasks
4. Immediate objective: implement the shared `trading` and `messaging`
	capability taxonomy through shared domain metadata, ownership, and
	foundational contract touchpoints named by `tasks/001`.

## Authority Order

Use these docs in descending authority for the current slice:

1. [../tasks/001-shared-trading-taxonomy-implementation-tasks.md](../tasks/001-shared-trading-taxonomy-implementation-tasks.md) for concrete work items and validation commands;
2. [../012-shared-capability-taxonomy-revision.md](../012-shared-capability-taxonomy-revision.md) for slice scope, fixed decisions, and acceptance criteria;
3. [../001-roadmap.md](../001-roadmap.md) for phase order, gates, and the later execution path;
4. [../000-README.md](../000-README.md) for navigation and historical classification;
5. [004-validation-and-change-control.md](./004-validation-and-change-control.md) for status normalization, completion evidence, and stop-versus-update rules;
6. [003-spec-agent-playbook.md](./003-spec-agent-playbook.md) for implementation behavior when the code surface disagrees with the docs.

## Do Not Skip Ahead

1. Do not jump directly to 002 through 007 because those later phase docs exist.
2. Do not pull activation persistence, public route migration, worker gating,
   or service-backed invocation naming into this slice; those belong to later
   phase docs.
3. Do not use 008 through 011 unless an active controlling doc for the current slice explicitly points to them.
4. Do not widen scope beyond the shared taxonomy slice without an active doc update.

## After This Slice

After `tasks/001` is complete and validated, resume from the later executable
phases in [../001-roadmap.md](../001-roadmap.md) in the documented order.

## Stop And Escalate

Stop and escalate instead of improvising when:

1. active docs disagree about scope, sequencing, ownership, or validation;
2. the code can satisfy the slice only by changing a fixed decision or reordering the roadmap;
3. no active task list or active doc authorizes the next move;
4. a required dependency is missing and the current docs did not authorize creating it here.

## Validation

1. derived this entrypoint from the final coherence pass recorded in [006-coherence-review.md](./006-coherence-review.md);
2. matched the start sequence against [001-master-roadmap.md](./001-master-roadmap.md), [003-spec-agent-playbook.md](./003-spec-agent-playbook.md), and [../001-roadmap.md](../001-roadmap.md);
3. confirmed that the first executable slice remains `012 -> tasks/001` across the active narrowed control-doc set.
