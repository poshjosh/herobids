# Capability Route And Response Migration Manifest

**Status:** proposed  
**Created:** 2026-07-18  
**Parent roadmap:** [Capability Implementation Roadmap](./001-roadmap.md)  
**Depends on:** [Initial Capability Registry And Tool Ownership Manifest](./009-initial-capability-registry-and-tool-ownership-manifest.md)

## Route Policy

1. Canonical public routes use product capability IDs.
2. Every current `/capabilities/trading` route remains temporarily as a declared
   alias with identical status code and payload data.
3. Canonical responses use `capabilityId: 'crypto-trading'` and, where runtime
   binding detail is relevant, `runtimeFamily: 'trading'`.
4. Legacy alias responses retain the existing `family: 'trading'` field for
   compatibility and add `capabilityId` and `runtimeFamily` additively.
5. Every legacy response includes `Deprecation: true` and a
   `Link: <canonical-path>; rel="successor-version"` header. Canonical routes
   never emit either header.
6. Alias handlers delegate to the canonical handler; they must not maintain a
   second implementation or response model.

## Complete Migration Matrix

| Method | Canonical route | Legacy alias | Current callers to migrate |
| --- | --- | --- | --- |
| GET | `/capabilities/crypto-trading` | `/capabilities/trading` | API capability route tests; functional capability-model tests. |
| GET | `/capabilities/crypto-trading/providers` | `/capabilities/trading/providers` | API capability route tests. |
| GET | `/capabilities/crypto-trading/connections` | `/capabilities/trading/connections` | `apps/web/src/lib/api-client.ts`; API capability route tests. |
| GET | `/agents/:agentId/capabilities/crypto-trading` | `/agents/:agentId/capabilities/trading` | API capability route tests. |
| GET | `/agents/:agentId/capabilities/crypto-trading/state` | `/agents/:agentId/capabilities/trading/state` | API capability route tests. |
| GET | `/agents/:agentId/capabilities/crypto-trading/readiness` | `/agents/:agentId/capabilities/trading/readiness` | `apps/web/src/lib/api-client.ts`; functional capability-model tests; API route tests. |
| GET | `/agents/:agentId/capabilities/crypto-trading/connections` | `/agents/:agentId/capabilities/trading/connections` | `apps/web/src/lib/api-client.ts`; functional capability-model tests; API route tests. |
| GET | `/agents/:agentId/capabilities/crypto-trading/connections/:connectionId` | `/agents/:agentId/capabilities/trading/connections/:connectionId` | API capability route tests. |
| GET | `/agents/:agentId/capabilities/crypto-trading/connections/:connectionId/audit` | `/agents/:agentId/capabilities/trading/connections/:connectionId/audit` | Functional capability-model tests; API route tests. |
| GET | `/agents/:agentId/capabilities/crypto-trading/activity` | `/agents/:agentId/capabilities/trading/activity` | API capability route tests. |
| GET | `/agents/:agentId/capabilities/crypto-trading/outcomes` | `/agents/:agentId/capabilities/trading/outcomes` | API capability route tests. |
| GET | `/agents/:agentId/capabilities/crypto-trading/positions` | `/agents/:agentId/capabilities/trading/positions` | `apps/web/src/lib/api-client.ts`; functional trading-positions tests; API route tests. |
| POST | `/agents/:agentId/capabilities/crypto-trading/actions/:action` | `/agents/:agentId/capabilities/trading/actions/:action` | API capability route tests and any action caller found by repository search before implementation. |

The capability list response changes from `families` to a canonical
`capabilities` collection. During migration it returns both fields:

```json
{
  "capabilities": [{ "capabilityId": "crypto-trading", "runtimeFamily": "trading" }],
  "families": [{ "family": "trading" }]
}
```

`families` is a deprecated compatibility projection and must be removed with
the aliases, not before.

## Implementation Order

1. Build canonical handlers and canonical response schemas from the shared
   resolver.
2. Add alias handlers that delegate to canonical handlers and append only the
   documented legacy compatibility fields and headers.
3. Move web API client methods and all first-party server callers to canonical
   routes.
4. Update route, functional, and UI tests to make canonical paths primary.
5. Retain explicit alias-parity tests until alias removal.

The route registration module remains a composition root. Product metadata and
route identity come from the registry; trading business queries remain behind
the capability boundary as extraction proceeds.

## Alias Removal Gate

The `/trading` aliases may be removed only when all conditions are true:

1. repository search finds no first-party production caller using the legacy
   paths;
2. web, API, worker, functional, and contract tests use canonical routes;
3. alias usage telemetry has been zero for two complete release cycles;
4. a release note announces the removal after the deprecation period; and
5. the API owner approves the removal in the release checklist.

Until every condition is met, aliases remain declared in the registry and
covered by parity tests. An undeclared alias is a startup/CI validation error.

## Required Verification

Tests must prove for every matrix row that:

1. canonical and alias routes return the same business data and status code;
2. canonical responses expose `capabilityId: 'crypto-trading'` and preserve
   runtime binding detail separately;
3. alias responses retain `family: 'trading'` and carry deprecation headers;
4. unauthorized, missing-agent, validation, and readiness failures have equal
   semantics on canonical and alias routes; and
5. no messaging route accidentally adopts the `trading` alias.