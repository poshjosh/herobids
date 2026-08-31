# Capability Foundations Folder Guide

**Status:** complete  
**Created:** 2026-08-29

This folder contains the pending design set for capability isolation,
activation, tool ownership, route alignment, and capability-service extraction.

## Reading Order

1. [Capability Implementation Roadmap](./001-roadmap.md)
2. first executable slice for current implementation handoff:
   [013](./013-native-capabilities-and-external-backends.md), then
   [tasks/002](./tasks/002-external-backend-boundary-implementation-tasks.md)
3. broader feature-phase context and later supporting references when needed:
   [002](./002-capability-foundations.md) through
   [011](./011-capability-route-and-response-migration-manifest.md) and
   [014](./014-operational-readiness-for-external-backends.md)
4. automation extraction and MCP registration phases:
   [015](./015-automation-backend-extraction.md) and
   [016](./016-mcp-registration-layer.md)
5. supporting diagrams under [diagrams](./diagrams/current-architecture.md)
6. local coordination, validation, and handoff docs under
   [program/000-document-tree.md](./program/000-document-tree.md) when working
   on the documentation system or implementation entry flow

## Historical Context

The following documents are retained for background only and are not part of
the default implementation path:

1. [archive/000-q-and-a.md](./archive/000-q-and-a.md)
2. [archive/001-tasklist.md](./archive/001-tasklist.md)
3. [archive/002-shared-trading-taxonomy-delta.md](./archive/002-shared-trading-taxonomy-delta.md)
4. [archive/003-taxonomy-impact-map.md](./archive/003-taxonomy-impact-map.md)

## Current Direction

The platform direction now distinguishes:

- native capabilities the platform intentionally owns
- external backends the platform reaches over a boundary contract
- registration mechanisms such as direct API now and skill or MCP packaging
   later

Messaging may remain native. A repo-local service such as `externals/trading/`
is treated as an external backend from day one rather than as native platform
logic. `automation` is the second planned external backend
(`externals/automation/`), with `browser-use` as its first family. MCP is a
registration and transport mechanism, not a capability or backend.

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
- [014](./014-operational-readiness-for-external-backends.md): supporting
   reference for operational readiness requirements that apply to any external
   backend before full cutover; referenced as a normative input by 005
- [015](./015-automation-backend-extraction.md): draft phase doc for the
   second repo-local external backend (`automation`); governs browser-use
   extraction, family-based internal structure, session persistence, and
   automation-specific billing; controlled by [001-roadmap.md](./001-roadmap.md)
   and [ADR 009](../../tech/architecture/adrs/2026/08/009-automation-as-external-backend.md)
- [016](./016-mcp-registration-layer.md): draft phase doc for MCP as the
   third registration and transport mechanism; covers MCP client, tool
   namespacing, operator allowlists, and credential management; controlled by
   [001-roadmap.md](./001-roadmap.md)
- [013](./013-native-capabilities-and-external-backends.md): implementation-
   ready boundary authority for the current executable rewrite slice
- [tasks/002](./tasks/002-external-backend-boundary-implementation-tasks.md):
   concrete code-change tasks for the repo-local external-service boundary,
   transport contract, client adapter, and boundary enforcement; first
   executable low-level slice controlled by [001-roadmap.md](./001-roadmap.md)
   and [013](./013-native-capabilities-and-external-backends.md)
- [diagrams/current-architecture.md](./diagrams/current-architecture.md):
   canonical diagram entrypoint for the active architecture context; other
   diagrams are supporting references when explicitly needed
- [program/](./program/000-document-tree.md): feature-local coordination,
   handoff, validation, and implementation-entry docs kept under the same roof
   as Capability Foundations; supporting authority for navigation and handoff,
   not the primary feature spec path
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
4. [012](./012-shared-capability-taxonomy-revision.md) and
   [tasks/001](./tasks/001-shared-trading-taxonomy-implementation-tasks.md)
   are superseded as the first executable slice by the external-backend rewrite
   direction in [013](./013-native-capabilities-and-external-backends.md).
