# 002 - Agent Blueprint Marketplace ADR List

**Status:** Draft  
**Created:** 2026-08-01

## Purpose

These ADRs lock the architectural decisions that Phase 1 depends on. They are the accepted decision set for this feature unless a later ADR explicitly replaces one of them.

## ADR Set

1. [docs/tech/architecture/adrs/2026/08/001-blueprint-is-the-marketplace-asset.md](../../../../../tech/architecture/adrs/2026/08/001-blueprint-is-the-marketplace-asset.md)
Purpose: decide that blueprints, not live agents, are the canonical marketplace asset.

2. [docs/tech/architecture/adrs/2026/08/002-template-vs-instance-boundary.md](../../../../../tech/architecture/adrs/2026/08/002-template-vs-instance-boundary.md)
Purpose: lock the shareable template surface versus private and runtime-only instance state.

3. [docs/tech/architecture/adrs/2026/08/003-agent-blueprint-contract.md](../../../../../tech/architecture/adrs/2026/08/003-agent-blueprint-contract.md)
Purpose: define the typed blueprint contract, blueprint kinds, and the first-class agent strategy surface.

4. [docs/tech/architecture/adrs/2026/08/004-blueprint-marketplace-ranking-and-attribution.md](../../../../../tech/architecture/adrs/2026/08/004-blueprint-marketplace-ranking-and-attribution.md)
Purpose: decide how blueprint lineage, usage, likes, ranking, and attribution work in v1 and what is deferred.

## Decision Order

1. Blueprint is the marketplace asset.
2. Template versus instance boundary.
3. Blueprint contract.
4. Marketplace ranking and attribution.

The order matters because later ADRs depend on earlier ones.

## Acceptance Bar

The ADR set is ready when:

1. the installable marketplace unit is unambiguous
2. the template surface is explicit enough to drive server-side projection
3. the database and API shape can be derived without legacy compatibility scaffolding
4. Phase 1 can reference these ADRs without re-arguing first principles

## Current State

All four ADRs in this set are accepted and may be treated as binding by the Phase 1 plan.

## Notes

1. These ADRs are intentionally specific to the marketplace asset model.
2. They do not replace the delivery map or the hardened Phase 1 plan.
3. Monetization, public ratings, and evaluation-derived reputation remain downstream concerns unless one of these ADRs explicitly expands scope.
