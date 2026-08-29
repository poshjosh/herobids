# Capability Route And Response Migration Manifest

**Status:** draft
**Created:** 2026-07-18  
**Parent roadmap:** [Capability Implementation Roadmap](./001-roadmap.md)  
**Prerequisite:** [Initial Capability Registry And Tool Ownership Manifest](./009-initial-capability-registry-and-tool-ownership-manifest.md)

## Purpose

Define the canonical public route and response migration policy for shared
capability APIs once the later route-migration phase begins.

## Scope

This doc includes:

1. the canonical route policy for shared capability APIs
2. the complete migration matrix for trading capability routes and callers
3. the compatibility-removal gate and required verification for route
   migration

This doc does not include:

1. implementation of the shared capability resolver itself
2. capability-service extraction mechanics
3. undeclared shared route aliases

## Non-Goals

1. Do not introduce `/capabilities/crypto-trading` as a shared route.
2. Do not maintain a second implementation path behind a compatibility alias.
3. Do not remove compatibility fields or aliases before the explicit removal
   gate is satisfied.

## Dependencies

1. [Capability Implementation Roadmap](./001-roadmap.md) keeps this doc as an
   active supporting reference for the later route-migration phase.
2. [009-initial-capability-registry-and-tool-ownership-manifest.md](./009-initial-capability-registry-and-tool-ownership-manifest.md)
   defines the canonical shared capability IDs this route policy uses.
3. [003-capability-resolution-and-route-migration.md](./003-capability-resolution-and-route-migration.md)
   consumes this migration manifest directly.

## Fixed Decisions

1. Canonical public routes use product capability IDs.
2. Shared control-plane trading routes remain `/capabilities/trading`.
3. Canonical responses use `capabilityId: 'trading'` and separate runtime
   binding detail where needed.
4. Compatibility fields or aliases exist only where explicitly declared.
5. Any declared compatibility handler delegates to the canonical handler.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. exact composition-root wiring for canonical and compatibility handlers
2. deprecation-header shape and telemetry details
3. test placement across API, functional, and web client suites

## Acceptance Criteria

This supporting reference is fit for implementation use only when:

1. the route policy, migration matrix, and compatibility-removal gate are
   explicit and consistent
2. canonical and compatibility response-shape rules are explicit
3. the verification list is specific enough to validate later route migration
   without inventing undeclared aliases

## Validation

1. validate the checks listed under `## Required Verification`
2. confirm [003-capability-resolution-and-route-migration.md](./003-capability-resolution-and-route-migration.md)
   uses this manifest without contradicting canonical route or compatibility
   rules
3. keep `pnpm lint` as the final repo-wide validation gate for any touched code

## Route Policy

1. Canonical public routes use product capability IDs.
2. Shared control-plane trading routes remain `/capabilities/trading`.
3. Canonical responses use `capabilityId: 'trading'` and, where runtime
   binding detail is relevant, `runtimeFamily: 'trading'`.
4. Compatibility responses may retain the existing `family: 'trading'` field
   additively while clients migrate to `capabilityId` and `runtimeFamily`.
5. Temporary aliases or deprecation headers exist only where explicitly
   declared. No shared `/capabilities/crypto-trading` path is introduced.
6. Any declared compatibility handler delegates to the canonical handler; it
   must not maintain a second implementation or response model.

## Complete Migration Matrix

| Method | Canonical route | Legacy alias | Current callers to migrate |
| --- | --- | --- | --- |
| GET | `/capabilities/trading` | none | API capability route tests; functional capability-model tests. |
| GET | `/capabilities/trading/providers` | none | API capability route tests. |
| GET | `/capabilities/trading/connections` | none | `apps/web/src/lib/api-client.ts`; API capability route tests. |
| GET | `/agents/:agentId/capabilities/trading` | none | API capability route tests. |
| GET | `/agents/:agentId/capabilities/trading/state` | none | API capability route tests. |
| GET | `/agents/:agentId/capabilities/trading/readiness` | none | `apps/web/src/lib/api-client.ts`; functional capability-model tests; API route tests. |
| GET | `/agents/:agentId/capabilities/trading/connections` | none | `apps/web/src/lib/api-client.ts`; functional capability-model tests; API route tests. |
| GET | `/agents/:agentId/capabilities/trading/connections/:connectionId` | none | API capability route tests. |
| GET | `/agents/:agentId/capabilities/trading/connections/:connectionId/audit` | none | Functional capability-model tests; API route tests. |
| GET | `/agents/:agentId/capabilities/trading/activity` | none | API capability route tests. |
| GET | `/agents/:agentId/capabilities/trading/outcomes` | none | API capability route tests. |
| GET | `/agents/:agentId/capabilities/trading/positions` | none | `apps/web/src/lib/api-client.ts`; functional trading-positions tests; API route tests. |
| POST | `/agents/:agentId/capabilities/trading/actions/:action` | none | API capability route tests and any action caller found by repository search before implementation. |

The capability list response changes from `families` to a canonical
`capabilities` collection. During migration it returns both fields:

```json
{
   "capabilities": [{ "capabilityId": "trading", "runtimeFamily": "trading" }],
  "families": [{ "family": "trading" }]
}
```

`families` is a deprecated compatibility projection and must be removed only
after callers migrate to `capabilities`, not before.

## Implementation Order

1. Build canonical handlers and canonical response schemas from the shared
   resolver.
2. Add declared compatibility fields or handlers only where needed, and keep
   them delegated to canonical handlers.
3. Move web API client methods and all first-party server callers to canonical
   response shapes.
4. Update route, functional, and UI tests to make canonical trading paths and
   response shapes primary.
5. Retain explicit compatibility tests until removal.

The route registration module remains a composition root. Product metadata and
route identity come from the registry; trading business queries remain behind
the capability boundary as extraction proceeds.

## Compatibility Removal Gate

Any temporary compatibility field or alias may be removed only when all
conditions are true:

1. repository search finds no first-party production caller using deprecated
   paths or fields;
2. web, API, worker, functional, and contract tests use canonical routes and
   response shapes;
3. compatibility usage telemetry has been zero for two complete release cycles;
4. a release note announces the removal after the deprecation period; and
5. the API owner approves the removal in the release checklist.

Until every condition is met, compatibility constructs remain declared in the
registry or docs and covered by parity tests. An undeclared alias is a
startup/CI validation error.

## Required Verification

Tests must prove for every matrix row that:

1. canonical and alias routes return the same business data and status code;
2. canonical responses expose `capabilityId: 'trading'` and preserve
   runtime binding detail separately;
3. compatibility responses retain `family: 'trading'` only where explicitly
   declared and preserve equal business semantics;
4. unauthorized, missing-agent, validation, and readiness failures have equal
   semantics on canonical and alias routes; and
5. no messaging route accidentally adopts the `trading` alias.