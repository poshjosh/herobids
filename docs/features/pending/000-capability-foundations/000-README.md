# Capability Foundations Folder Guide

This folder contains the pending design set for capability isolation,
activation, tool ownership, route alignment, and capability-service extraction.

## Reading Order

1. [Capability Implementation Roadmap](./001-roadmap.md)
2. phase documents: [002](./002-capability-foundations.md) through
   [007](./007-capability-naming-cleanup.md)
3. normative design inputs: [008](./008-cross-service-capability-execution-design.md)
   through [011](./011-capability-route-and-response-migration-manifest.md)
4. active taxonomy revision draft: [012](./012-shared-capability-taxonomy-revision.md)
5. implementation task list: [tasks/001](./tasks/001-shared-trading-taxonomy-implementation-tasks.md)
6. supporting diagrams under [diagrams](./diagrams/current-architecture.md)

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
- [001-roadmap.md](./001-roadmap.md): phase ordering and gates
- [008](./008-cross-service-capability-execution-design.md) through
  [011](./011-capability-route-and-response-migration-manifest.md): normative
  design inputs for implementation
- [012](./012-shared-capability-taxonomy-revision.md): current taxonomy
   revision draft
- [tasks/001](./tasks/001-shared-trading-taxonomy-implementation-tasks.md):
   concrete code-change tasks for routes, activation rows, ownership manifests,
   and contract naming
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
