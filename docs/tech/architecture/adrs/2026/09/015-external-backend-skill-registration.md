# ADR 015: External Backend Skill Registration

**Date:** 2026-09-23
**Status:** Accepted
**Extends:** [ADR 008](./008-native-capabilities-and-external-backends.md)

## Context

Herobids supports many ordinary external skills through skills.sh. Those skills
are instruction packages and must not gain domain tools, credentials, or
backend access merely by being installed.

Traderton is separately deployable trading infrastructure. The intended product
and technical boundary is that Herobids remains a generic agent platform while
an external backend owns its domain instructions, tools, schemas, policy,
storage, and documentation. The current implementation still contains
Traderton-named client and contract code under `packages/domain/src/traderton/`
and trading-domain modules under `packages/domain/src/trading/`.

## Decision

1. **External Backend** is the product and technical term for a separately
   deployable domain service. It may be operated by the same organization or a
   third party; "external" means outside Herobids core ownership.

2. Herobids uses `ExternalBackendClient` as the generic runtime client and
   `ExternalBackendDefinition` as the operator registration record. Do not use
   `RemoteBoundary`, `TradertonBoundary`, or a backend-specific client name in
   generic platform code.

3. An External Backend Definition contains only generic transport and trust
   metadata: stable backend identity, endpoint/contract version, health policy,
   caller credential reference, trusted descriptor signing keys, and approved
   source skill references. It must not contain domain instructions, tool
   payload semantics, provider policy, pricing, venue rules, or risk policy.

4. A backend publishes a signed, versioned descriptor that binds its approved
   source skill references to backend-owned instructions, tool descriptions,
   schemas, and generic availability metadata. Herobids verifies the descriptor
   against its operator registration, pins or caches it according to the
   registration policy, and rejects expired, untrusted, mismatched, or revoked
   descriptors.

5. A skill receives deep integration only when its installed source reference
   matches both an enabled External Backend Definition and its verified backend
   descriptor. Every other external skill remains an ordinary skills.sh
   instruction package. No `if` branch may recognize a Traderton skill,
   trading tool, or backend identity inside generic registration, dispatch, or
   visibility code.

6. Herobids retains generic dispatch, signed transport, deadline/idempotency
   orchestration, health gating, audit/correlation, and tool-visibility
   composition. The backend retains domain-owned instructions, tool schemas,
   policy, persistence, provider behavior, and documentation.

7. Existing `trading` capability terminology must not be retained as a native
   Herobids product capability solely to make the first backend work. A generic
   descriptor tag may remain only where the generic capability-composition
   model genuinely requires it; the discovery must prove that it does not
   encode trading-specific platform behavior.

8. MCP is deferred. It may later package or expose an External Backend, but it
   does not replace the authenticated private invocation, health, idempotency,
   descriptor trust, and authorization path required for the first backend.

## Initial Module Disposition

| Module | Disposition | Reason |
| --- | --- | --- |
| `packages/domain/src/traderton/` | Generalize or delete after importer audit | Provider-specific consumer transport does not belong in shared domain code. |
| `packages/domain/src/trading/venue-capability.ts` | Move to Traderton, then remove from Herobids | Venue order semantics are wholly trading-domain behavior; the ownership audit records it as dormant in Herobids. |
| `packages/domain/src/trading/trading-protocol.ts` | Split after symbol-level audit | Watch, snapshot, discovery, regime, assessment, and trading-session semantics belong to Traderton; generic agent wake envelope/scheduling concepts may remain in Herobids without importing trading payload types. |

## Consequences

- `system/trading` will not remain a Herobids system skill in the target state.
  There are no active deployments or agent data, so no compatibility/migration
  window is required.
- This ADR does not authorize implementation. The immediate work is staging
   recovery and independent Traderton deployment. The current
   Traderton-specific client/configuration may be used only to prove that
   operational deployment boundary; it is not evidence that the final generic
   External Backend architecture or payment-provider boundary is complete.
- External Backend Genericization Discovery follows the staging operational
   proof and precedes its own implementation plan. It inventories all importers,
   configurations, routes, tool contexts, UI/API contracts, and tests.
- Legal and payment-provider review remains required to decide which product
  references, orchestration paths, billing links, setup flows, and connection
  flows Herobids may retain.

## Discovery Exit Criteria

The implementation plan may be drafted only after discovery provides:

1. a symbol-level disposition for every export in `packages/domain/src/traderton/`
   and `packages/domain/src/trading/`;
2. an importer inventory that identifies genericization, migration to
   Traderton, deletion, or explicitly deferred product work;
3. the concrete External Backend Definition, descriptor trust, key rotation,
   revocation, and failure behavior;
4. an end-to-end trace from external skill installation through descriptor
   resolution, tool visibility, invocation, and result mapping;
5. an MCP comparison showing why it remains deferred or a revised decision
   supported by evidence; and
6. a list of legal/product questions that engineering cannot settle.

## References

- [Staging-First External Backend Roadmap](../../../../../features/2026/09/24/001-staging-first-external-backend-roadmap.md)
- [ADR 008](./008-native-capabilities-and-external-backends.md)
- [Native Capabilities And External Backends](../../../../../features/pending/000-capability-foundations/013-native-capabilities-and-external-backends.md)
- [External Backend Execution Design](../../../../../features/pending/000-capability-foundations/008-cross-service-capability-execution-design.md)
- [Herobids Trading Logic Ownership Audit](../../../../trading/audits/2026/09/001-herobids-trading-logic-ownership-audit.md)