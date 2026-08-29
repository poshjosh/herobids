# Exit Policy: Scale-Out and Trail Remainder

**Status:** draft  
**Created:** 2026-08-29  
**Parent roadmap:** [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)

## Purpose

Decompose exit-policy work into ordered slices so schema, decision-contract,
actor execution, and durable position-state changes can be planned without
mixing a stateful execution feature into one unbounded implementation pass.

## Scope

This roadmap includes:

1. a configurable exit-policy contract for scale-out and trailing remainder
2. partial-close decision semantics and actor execution behavior
3. durable exit-policy state for open positions across ticks and restarts
4. validation around statefulness, edge cases, and position reduction behavior

This roadmap does not include:

1. unrelated strategy-catalog redesign
2. fully discretionary or LLM-authored exit management
3. venue-specific advanced live-order management beyond this feature's exit
   logic
4. product-code implementation in this documentation step

## Non-Goals

1. Do not keep the exit-policy state only inside a strategy instance.
2. Do not add partial close semantics without also defining durable execution
   and persistence behavior.
3. Do not widen this feature into general order-management recovery beyond the
   exit-policy needs captured here.
4. Do not reopen the current stateless-strategy principle unless a child doc
   explicitly justifies a bounded exception.

## Dependencies

1. [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)
   places this feature after capability foundations and Hyperliquid preset
   tuning, and before advanced live limit order management.
2. [Pending Feature Inventory](../000-program/005-feature-inventory.md)
   requires this feature to use a canonical `001-roadmap.md` with ordered child
   docs.
3. [001-plan.md](./001-plan.md) remains the legacy source for the exit-policy
   schema, partial-close semantics, actor-managed recommendation, and edge-case
   inventory.
4. This feature inherits the master-roadmap requirement that later order
   management and watch-cleanup work layer on top of a stable exit-policy path.

## Fixed Decisions

1. Exit policy adds explicit scale-out and trail-remainder behavior to the
   strategy surface.
2. Partial closes require an explicit decision contract rather than being
   inferred from ordinary `go_flat` behavior.
3. Actor-managed state is the preferred execution model because the position
   tracker is the durable source of truth.
4. Exit-policy state must survive across ticks and restart boundaries where the
   position tracker already owns execution state.
5. Validation must cover fractional closes, stop updates, and trailing-state
   transitions explicitly.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. exact schema field names and helper boundaries for exit-policy metadata
2. whether some edge-case validation lives in engine tests, worker tests, or
   both
3. exact persistence shape for exit-policy state, as long as actor-managed
   durability remains the controlling model

## Child Docs And Sequence

Executable child docs to create in C09:

1. `002-exit-policy-schema.md`
2. `003-partial-close-decision-contract.md`
3. `004-actor-managed-exit-policy-execution.md`
4. `005-position-tracker-state-and-recovery.md`
5. `006-validation-and-edge-cases.md`

Supporting task lists should start only after the decision contract and
actor-managed state model are explicit.

## Acceptance Criteria

1. The roadmap fixes the ordered path from schema through execution and durable
   state.
2. The feature-wide decisions keep exit-policy state tied to execution
   infrastructure rather than hidden inside ephemeral strategy memory.
3. The child-doc sequence matches the source plan's phased path closely enough
   to control later C09 and C10 work.
4. Later dependent features can rely on this roadmap without guessing the
   source of truth for partial-close state.

## Validation

1. Compared the child-doc sequence and fixed decisions against
   [001-plan.md](./001-plan.md).
2. Confirmed the dependency position and canonical shape against
   [../000-program/001-master-roadmap.md](../000-program/001-master-roadmap.md)
   and [../000-program/005-feature-inventory.md](../000-program/005-feature-inventory.md).
3. Verified that the required section order matches
   [../000-program/002-feature-doc-template.md](../000-program/002-feature-doc-template.md).