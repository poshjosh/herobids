# 002 - Agent Blueprint Marketplace Planning Set

**Status:** Draft  
**Created:** 2026-08-01  
**Scope:** Active planning index for this feature

## Purpose

This feature no longer uses a single monolithic plan document.

The planning set is split into documents with distinct jobs:

1. Target-state brief: the clean end-state and the v1 boundary.
2. ADR list: the architectural decisions that must be locked before implementation spreads.
3. Delivery map: the high-level workstreams and sequence.
4. Historical Phase 1 plan: retained for decision history and superseded for implementation.
5. Field classification: the template-vs-instance manifest that projection must satisfy.
6. Configuration harmonization closure: the prerequisite that removes duplicate agent configuration sources.
7. Phase 1 implementation plan: the sole implementation contract, organized as Milestone A and Milestone B.

This split is intentional because the project does not need backward compatibility for legacy blueprint, database, or Redis state. We can design the clean target first, then sequence delivery from that target.

## Documents

1. [003-target-state-brief.md](./003-target-state-brief.md)
2. [004-adr-list.md](./004-adr-list.md)
3. [005-delivery-map.md](./005-delivery-map.md)
4. [006-phase-1-plan.md](./006-phase-1-plan.md) — superseded implementation history
5. [007-field-classification.md](./007-field-classification.md)
6. [002-agent-bot-config-harmonization-closure.md](../003-agent-bot-config-harmonization/002-agent-bot-config-harmonization-closure.md)
7. [003-agent-blueprint-marketplace-phase-1-implementation.md](../003-agent-bot-config-harmonization/003-agent-blueprint-marketplace-phase-1-implementation.md) — current Phase 1 implementation plan

## Supporting Material

1. [docs/tech/architecture/adrs/2026/08/001-blueprint-is-the-marketplace-asset.md](../../../../../tech/architecture/adrs/2026/08/001-blueprint-is-the-marketplace-asset.md)
2. [docs/tech/architecture/adrs/2026/08/002-template-vs-instance-boundary.md](../../../../../tech/architecture/adrs/2026/08/002-template-vs-instance-boundary.md)
3. [docs/tech/architecture/adrs/2026/08/003-agent-blueprint-contract.md](../../../../../tech/architecture/adrs/2026/08/003-agent-blueprint-contract.md)
4. [docs/tech/architecture/adrs/2026/08/004-blueprint-marketplace-ranking-and-attribution.md](../../../../../tech/architecture/adrs/2026/08/004-blueprint-marketplace-ranking-and-attribution.md)

## Working Rules

1. Lock the target state before adding implementation detail.
2. Treat blueprints as the canonical marketplace asset unless an ADR changes that.
3. Design for clean replacement, not migration compatibility.
4. Treat 009 as superseding 006 for implementation while preserving the accepted ADRs and target state.
5. Use Milestone A and Milestone B inside Phase 1; older Phase 1a/1b/1c labels are historical only.
