# Per-Trade Level Outage Protection

**Status:** draft  
**Created:** 2026-08-29  
**Parent roadmap:** [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)

## Purpose

Define the bounded outage-protection feature so the system can close the most
important per-trade protection gap without pretending that venue-native,
zero-downtime stop execution already exists.

## Scope

This doc includes:

1. the accepted statement of the current protection gap for stopped agents and
   worker crashes
2. a separate always-on position-level guard loop outside the agent actor
   lifecycle
3. explicit boundaries between the recommended backstop and later venue-native
   protection work

This doc does not include:

1. claiming true crash-proof protection in the first implementation
2. venue-native stop or trigger-order support across all venues
3. unrelated redesign of per-trade level semantics
4. product-code implementation in this documentation step

## Non-Goals

1. Do not keep overstated protection claims once the limitation is known.
2. Do not tie the backstop loop to the lifecycle of a specific agent actor.
3. Do not widen this feature into a cross-venue trigger-order project.
4. Do not treat worker-crash protection as solved if the implementation only
   covers the stopped-agent gap.

## Dependencies

1. [Pending Program Master Roadmap](../000-program/001-master-roadmap.md)
   places this feature after advanced live limit order management.
2. [Pending Feature Inventory](../000-program/005-feature-inventory.md)
   requires this feature to stay as one canonical overview.
3. [001-plan.md](./001-plan.md) remains the legacy source for the protection-gap
   analysis, option set, recommended path, and implementation sketch.
4. [../../2026/07/06/010-per-trade-stoploss-takeprofit/001-plan.md](../../2026/07/06/010-per-trade-stoploss-takeprofit/001-plan.md)
   remains the historical upstream context for the original protection promise
   this feature narrows and repairs.

## Fixed Decisions

1. The current stopped-agent and full-worker-crash gaps must be documented
   explicitly.
2. The recommended implementation path is a separate always-on position-level
   guard service outside the agent actor lifecycle.
3. The actor-local monitor remains the low-latency path for active sessions,
   while the guard service is the backstop for inactive actors.
4. Venue-native trigger protection remains future work and must not be implied
   as delivered by this feature.
5. Duplicate exit attempts must be handled through the existing normal decision
   path and idempotency safeguards.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. exact service name and scheduling interval for the guard loop
2. exact query and mark-source helper boundaries used by the guard service
3. exact observability and warning payloads for missed or duplicate checks

## Acceptance Criteria

1. The feature defines one bounded protection improvement that covers stopped
   agents without overstating crash-proof guarantees.
2. The overview keeps later venue-native stop work clearly out of scope.
3. The fixed decisions make the backstop architecture explicit enough for later
   task-list work to implement without reopening the outage model.
4. The dependency on advanced order-management stabilization remains explicit.

## Validation

1. Compared the scope, fixed decisions, and recommendation against
   [001-plan.md](./001-plan.md).
2. Confirmed the dependency position and canonical shape against
   [../000-program/001-master-roadmap.md](../000-program/001-master-roadmap.md)
   and [../000-program/005-feature-inventory.md](../000-program/005-feature-inventory.md).
3. Verified that the canonical section order matches
   [../000-program/002-feature-doc-template.md](../000-program/002-feature-doc-template.md).
