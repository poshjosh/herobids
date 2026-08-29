# Capability Foundations Folder Guide

**Status:** complete  
**Created:** 2026-08-29

This folder contains the pending design set for capability isolation,
activation, tool ownership, route alignment, and capability-service extraction.

## Reading Order

1. [Capability Implementation Roadmap](./001-roadmap.md)
2. first executable slice for current implementation handoff:
   [012](./012-shared-capability-taxonomy-revision.md), then
   [tasks/001](./tasks/001-shared-trading-taxonomy-implementation-tasks.md)
3. broader feature-phase context and later supporting references when needed:
   [002](./002-capability-foundations.md) through
   [011](./011-capability-route-and-response-migration-manifest.md)
4. supporting diagrams under [diagrams](./diagrams/current-architecture.md)

## Historical Context

The following documents are retained for background only and are not part of
the default implementation path:

1. [archive/000-q-and-a.md](./archive/000-q-and-a.md)
2. [archive/001-tasklist.md](./archive/001-tasklist.md)
3. [archive/002-shared-trading-taxonomy-delta.md](./archive/002-shared-trading-taxonomy-delta.md)
4. [archive/003-taxonomy-impact-map.md](./archive/003-taxonomy-impact-map.md)

## Current Direction

The shared platform vocabulary uses:

- capability
- family
- provider

The first shared product capabilities are `trading` and `messaging`.

Deeper market-specific trading taxonomy such as `crypto`, `forex`, and
`commodities` is trading-owned and should not be promoted into the shared
platform domain language by default.

## Document Roles

- [archive/000-q-and-a.md](./archive/000-q-and-a.md): historical,
  non-authoritative context
- [author/](./author): local preparation material and authoring checklists;
   non-authoritative for implementation
- [001-roadmap.md](./001-roadmap.md): phase ordering and gates
- [002](./002-capability-foundations.md) through [007](./007-capability-naming-cleanup.md):
  broader phase-by-phase rollout context
- [008](./008-cross-service-capability-execution-design.md) through
   [011](./011-capability-route-and-response-migration-manifest.md): supporting
   reference docs for later phase detail; not required to enter the first ready
   slice
- [012](./012-shared-capability-taxonomy-revision.md): implementation-ready
   taxonomy authority for the first executable slice
- [tasks/001](./tasks/001-shared-trading-taxonomy-implementation-tasks.md):
   concrete code-change tasks for routes, activation rows, ownership manifests,
   and contract naming; first executable low-level slice controlled by
   [001-roadmap.md](./001-roadmap.md) and
   [012](./012-shared-capability-taxonomy-revision.md)
- [diagrams/current-architecture.md](./diagrams/current-architecture.md):
   canonical diagram entrypoint for the active architecture context; other
   diagrams are supporting references when explicitly needed
- [archive/002-shared-trading-taxonomy-delta.md](./archive/002-shared-trading-taxonomy-delta.md):
   historical transition rationale retained for history
- [archive/003-taxonomy-impact-map.md](./archive/003-taxonomy-impact-map.md):
   historical implementation impact note retained for history

## Cleanup Notes

1. [archive/000-q-and-a.md](./archive/000-q-and-a.md) is retained only as
   historical context and is intentionally outside the main top-level plan set.
2. [archive/002-shared-trading-taxonomy-delta.md](./archive/002-shared-trading-taxonomy-delta.md) is superseded now that
   the stable ADRs and pending docs carry the adopted direction directly.
3. [archive/003-taxonomy-impact-map.md](./archive/003-taxonomy-impact-map.md) is retained as a historical
   migration note because it documents the route and schema consequences of the
   old shared `crypto-trading` framing versus the adopted shared `trading`
   framing.
