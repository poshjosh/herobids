# Advanced Live Limit Order Management

**Status:** draft  
**Created:** 2026-08-29  
**Parent roadmap:** [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)

## Purpose

Decompose advanced live limit-order work into ordered slices so venue
capability modeling, lifecycle management, recovery, and observability can be
implemented on top of the minimal live-order safety path without widening the
critical path prematurely.

## Scope

This roadmap includes:

1. venue capability modeling for managed live limit orders
2. first-class live limit submission and durable lifecycle state
3. timeout, cancel, amend, replace, and restart-recovery behavior
4. execution-quality telemetry and lifecycle alerting

This roadmap does not include:

1. smart routing or price-improvement logic across venues
2. swap-venue order-management work
3. UI order-ticket redesign in this feature
4. product-code implementation in this documentation step

## Non-Goals

1. Do not let this broader feature replace the minimal Phase 3 live-order
   safety path.
2. Do not hide venue differences behind a pretend universal abstraction.
3. Do not treat partial fills or uncertain restart states as edge cases.
4. Do not use blind resubmission as the recovery strategy for ambiguous crash
   windows.

## Dependencies

1. [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)
   places this feature after exit-policy work in the trading runtime
   stabilization phase.
2. [Pending Feature Inventory](../000-program/005-feature-inventory.md)
   requires this feature to use a canonical `001-roadmap.md` with ordered child
   docs.
3. [001-plan.md](./001-plan.md) remains the legacy source for the feature
   boundary, slice order, and safety principles.
4. This feature inherits the source plan's split between the minimal live-order
   safety path and the broader managed-order capabilities captured here.

## Fixed Decisions

1. Venue differences remain explicit and capability-driven.
2. Safety beats convenience; unsupported amend behavior must fail closed or use
   explicit cancel-and-replace.
3. Recovery must prefer durable local state plus venue lookup over blind retry.
4. Partial fills are first-class lifecycle states.
5. The broader feature builds on top of the minimal Phase 3 safety work rather
   than duplicating it.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. exact type and helper boundaries for capability descriptors and lifecycle
   manager modules
2. exact journal and alert payload shapes for lifecycle transitions
3. which capable venues are enabled first, as long as unsupported semantics are
   still rejected explicitly

## Child Docs And Sequence

Executable child docs to create in C09:

1. `002-venue-capability-model.md`
2. `003-live-limit-order-submission.md`
3. `004-order-lifecycle-manager.md`
4. `005-timeout-cancel-and-replace.md`
5. `006-richer-venue-semantics.md`
6. `007-restart-recovery-for-managed-open-orders.md`
7. `008-execution-quality-and-alerting.md`

Supporting task lists should start only after the first child docs fix the
capability model and live-submission contract.

## Acceptance Criteria

1. The roadmap fixes the ordered path from capability modeling through
   submission, lifecycle management, recovery, and observability.
2. The feature-wide decisions keep minimal live-order safety work distinct from
   broader managed-order functionality.
3. The child-doc sequence matches the legacy plan's slice order closely enough
   to control later C09 and C10 work.
4. Later dependent features can rely on this roadmap without guessing how venue
   semantics and restart recovery are supposed to interact.

## Validation

1. Compared the child-doc sequence and fixed decisions against
   [001-plan.md](./001-plan.md).
2. Confirmed the dependency position and canonical shape against
   [../000-program/001-master-roadmap.md](../000-program/001-master-roadmap.md)
   and [../000-program/005-feature-inventory.md](../000-program/005-feature-inventory.md).
3. Verified that the required section order matches
   [../000-program/002-feature-doc-template.md](../000-program/002-feature-doc-template.md).
