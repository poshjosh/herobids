# Native Capability And External Backend Route And Response Migration Manifest

**Status:** draft
**Created:** 2026-07-18  
**Parent roadmap:** [Capability Implementation Roadmap](./001-roadmap.md)  
**Prerequisite:** [Initial Capability Registry And Tool Ownership Manifest](./009-initial-capability-registry-and-tool-ownership-manifest.md)

## Purpose

Define the canonical public route and response migration policy for native
capability APIs and external-backend control-plane APIs once the later
route-migration phase begins.

## Scope

This doc includes:

1. the canonical route policy for native capabilities and external backends
2. the migration matrix for replacing legacy platform-owned external-domain
   routes with generic external-backend control-plane routes
3. the compatibility-removal gate and required verification for route
   migration

This doc does not include:

1. implementation of the shared control-plane resolver itself
2. external-backend invocation transport mechanics
3. undeclared route aliases
4. platform-owned domain-specific routes for external backends

## Non-Goals

1. Do not introduce canonical external-domain routes under
   `/capabilities/:backendId`.
2. Do not maintain a second platform-owned implementation path behind a
   compatibility alias.
3. Do not remove compatibility fields or aliases before the explicit removal
   gate is satisfied.
4. Do not let platform core claim ownership of external-domain response
   semantics.

## Dependencies

1. [Capability Implementation Roadmap](./001-roadmap.md) keeps this doc as an
   active supporting reference for the later route-migration phase.
2. [009-initial-capability-registry-and-tool-ownership-manifest.md](./009-initial-capability-registry-and-tool-ownership-manifest.md)
   defines the canonical native capability IDs and backend IDs this route
   policy uses.
3. [003-capability-resolution-and-route-migration.md](./003-capability-resolution-and-route-migration.md)
   consumes this migration manifest directly.

## Fixed Decisions

1. Canonical native-capability routes use capability IDs.
2. Canonical external-backend control-plane routes use backend IDs under
   `/external-backends`.
3. Canonical responses distinguish native-capability entries from
   external-backend entries.
4. Platform-core external-backend routes may expose only generic metadata,
   entitlement, health, readiness, connection summary, and audit summary.
5. Any declared compatibility handler delegates to the canonical handler or a
   transparent backend-owned pass-through.

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
4. no external backend is left modeled as a canonical native-capability route

## Validation

1. validate the checks listed under `## Required Verification`
2. confirm [003-capability-resolution-and-route-migration.md](./003-capability-resolution-and-route-migration.md)
   uses this manifest without contradicting canonical route or compatibility
   rules
3. keep `pnpm lint` as the final repo-wide validation gate for any touched code

## Route Policy

1. Native-capability routes use `/capabilities` and
   `/agents/:agentId/capabilities/...`.
2. External-backend control-plane routes use `/external-backends` and
   `/agents/:agentId/external-backends/:backendId/...`.
3. Canonical native responses use `capabilityId`. Canonical external responses
   use `backendId`.
4. Combined control-plane responses use separate `capabilities` and
   `externalBackends` collections rather than flattening both concepts into one
   type.
5. Temporary aliases or deprecation headers exist only where explicitly
   declared. No canonical external-domain route is introduced under
   `/capabilities`.
6. If a legacy external-domain route is temporarily kept, it delegates to the
   canonical external-backend handler or acts as a transparent backend-owned
   pass-through without platform-owned semantic reshaping.

## Complete Migration Matrix

### Generic control-plane routes

| Method | Canonical route | Legacy platform-owned route | Current callers to migrate | Policy |
| --- | --- | --- | --- | --- |
| GET | `/capabilities` | legacy `families` list projection | API capability route tests; functional capability-model tests. | Native capabilities only. |
| GET | `/capabilities/:capabilityId` | none | API capability route tests. | Native capability detail only. |
| GET | `/agents/:agentId/capabilities` | legacy capability-state list projections | API capability route tests; web control-plane callers. | Native capability state only. |
| PUT | `/agents/:agentId/capabilities/:capabilityId/activation` | none | API activation tests and any agent-settings caller. | Native activation only. |
| GET | `/external-backends` | legacy trading capability catalog routes | API route tests; web control-plane callers. | Generic external-backend catalog only. |
| GET | `/external-backends/:backendId` | legacy top-level trading capability detail route | API route tests; web control-plane callers. | Generic backend metadata only. |
| GET | `/agents/:agentId/external-backends` | legacy agent trading capability summary routes | API route tests; web control-plane callers. | Agent-scoped external-backend state only. |
| GET | `/agents/:agentId/external-backends/:backendId` | legacy agent trading state route | API route tests. | Generic backend state only. |
| GET | `/agents/:agentId/external-backends/:backendId/readiness` | legacy agent trading readiness route | `apps/web/src/lib/api-client.ts`; functional capability-model tests; API route tests. | Generic readiness and health summary only. |
| GET | `/agents/:agentId/external-backends/:backendId/connections` | legacy agent trading connections route | `apps/web/src/lib/api-client.ts`; API route tests. | Generic connection summary only. |
| GET | `/agents/:agentId/external-backends/:backendId/connections/:connectionId` | legacy agent trading connection detail route | API route tests. | Generic connection detail only. |
| GET | `/agents/:agentId/external-backends/:backendId/connections/:connectionId/audit` | legacy agent trading connection audit route | functional capability-model tests; API route tests. | Generic audit summary only. |

### Legacy domain-specific external-domain surfaces

| Legacy platform-owned route group | Canonical replacement | Policy |
| --- | --- | --- |
| trading activity route group | backend-owned activity route if still required | Not a canonical platform-core control-plane route. |
| trading outcomes route group | backend-owned outcomes route if still required | Not a canonical platform-core control-plane route. |
| trading positions route group | backend-owned positions route if still required | Not a canonical platform-core control-plane route. |
| trading action route group | backend-owned direct API or explicit transparent proxy if still required | Platform core must not assign domain meaning to the action payload. |

The top-level control-plane list response changes from a single `families`
projection to separate canonical collections. During migration it may return
both shapes:

```json
{
  "capabilities": [{ "kind": "native-capability", "capabilityId": "messaging" }],
  "externalBackends": [{ "kind": "external-backend", "backendId": "trading" }],
  "families": [{ "family": "trading" }]
}
```

`families` is a deprecated compatibility projection and must be removed only
after callers migrate to `capabilities` and `externalBackends`, not before.

## Implementation Order

1. Build canonical handlers and canonical response schemas from the shared
   resolver.
2. Add declared compatibility fields or handlers only where needed, and keep
   them delegated to canonical handlers or transparent backend pass-throughs.
3. Move web API client methods and all first-party server callers to canonical
   native-capability and external-backend response shapes.
4. Update route, functional, and UI tests to make native-capability routes and
   external-backend routes primary.
5. Retain explicit compatibility tests until removal.

The route registration module remains a composition root. Native-capability
metadata and external-backend identity come from the registry; external-domain
business queries remain behind the backend boundary as extraction proceeds.

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
startup or CI validation error.

## Required Verification

Tests must prove for every matrix row that:

1. canonical and compatibility routes return the same control-plane data and
   status code when a compatibility route is still declared;
2. canonical responses expose `capabilityId` only for native capabilities and
   `backendId` only for external backends;
3. compatibility responses retain deprecated `family` projections only where
   explicitly declared and preserve equal control-plane semantics;
4. unauthorized, missing-agent, validation, and readiness failures have equal
   semantics on canonical and compatibility routes; and
5. no native messaging route accidentally adopts external-backend semantics and
   no external backend is surfaced as a canonical capability route.