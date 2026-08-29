# Native Capability And External Backend Resolution

**Status:** draft
**Created:** 2026-07-18  
**Parent roadmap:** [Capability Implementation Roadmap](./001-roadmap.md)  
**Prerequisite:** [Capability Foundations](./002-capability-foundations.md)
**Normative inputs:** [Native Capabilities And External Backends](./013-native-capabilities-and-external-backends.md), [Capability Activation Model](./010-capability-activation-model.md), [Capability Route And Response Migration Manifest](./011-capability-route-and-response-migration-manifest.md)

## Purpose

Add shared control-plane resolution and canonical route identities for native
capabilities and external backends without changing worker tool visibility yet.

## Scope

This phase includes:

1. shared control-plane resolution across native capabilities, external
   backends, with runtime-family data retained only as compatibility detail
2. durable native capability activation resolution
3. canonical public route IDs for native-capability and external-backend
   control planes
4. explicit compatibility policy for retiring platform-owned routes for the
   first external domain
5. separation of native lifecycle detail from external-backend registration,
   health, and readiness detail

This phase does not include:

1. worker visibility enforcement
2. external-backend runtime extraction beyond the control-plane rewrite
3. platform-owned modeling of external-backend provider taxonomy or persistence
   semantics
4. terminology cleanup

## Non-Goals

1. Do not change worker visibility rules in this phase.
2. Do not model the first external domain as a native capability.
3. Do not keep the old trading capability route family as the canonical
   control-plane identity.
4. Do not move domain-specific provider or persistence rules for an external
   backend into platform-core responses.

## Dependencies

1. [Capability Implementation Roadmap](./001-roadmap.md) fixes this phase after
   the current ready slice and after
   [002-capability-foundations.md](./002-capability-foundations.md).
2. [002-capability-foundations.md](./002-capability-foundations.md) must first
   establish the shared registry, ownership, and contract foundations this
   phase consumes.
3. [013-native-capabilities-and-external-backends.md](./013-native-capabilities-and-external-backends.md)
   establishes the native-versus-external boundary model this phase must
   resolve.
4. [010-capability-activation-model.md](./010-capability-activation-model.md)
   and [011-capability-route-and-response-migration-manifest.md](./011-capability-route-and-response-migration-manifest.md)
   remain binding normative inputs for activation semantics and route coverage.

## Fixed Decisions

1. Shared control-plane resolution may expose runtime-family compatibility
   detail, but native activation and external-backend dispatchability do not
   derive their truth from that compatibility layer.
2. Canonical native-capability routes use `/capabilities/:capabilityId`.
3. Canonical external-backend control-plane routes use
   `/external-backends/:backendId`.
4. Activation state from document 010 applies only to native capabilities.
   External backends resolve dispatchability from registration, entitlement,
   health, and readiness inputs.
5. Direct API registration and invocation are sufficient for external backends.
   Skill or MCP packaging may later wrap the same boundary.
6. Platform responses may surface provider lifecycle only for native
   capabilities the platform owns. External backends surface generic
   registration, health, and readiness detail only.
7. Control-plane state resolution and effective tool-visibility resolution are
   separate concerns. Resolved skills may influence effective visibility, but
   they must not redefine native activation or external-backend dispatchability
   state.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. helper boundaries for shared control-plane resolution and response
   enrichment
2. exact route-registration wiring and compatibility-alias enforcement
   structure
3. test placement across API, domain, and db surfaces
4. private naming of resolver internals that does not change canonical route
   families, activation rules, or compatibility policy

## Acceptance Criteria

This phase is complete only when:

1. a shared control-plane state resolver exists and is consumed by API
   surfaces instead of ad hoc duplicated logic
2. canonical control-plane identity distinguishes `native-capability` from
   `external-backend`
3. canonical native-capability routes exist for native domains and generic
   external-backend routes exist for backend IDs such as `trading`
4. no external backend is represented as a canonical capability route or a
   native activation row
5. native lifecycle support, backend health, entitlement state, and agent
   readiness remain distinguishable in API responses
6. no worker tool-visibility behavior has changed yet

## Validation

1. add tests for canonical route families and declared compatibility aliases
2. add tests proving external backend `trading` resolves through backend
   registration, entitlement or binding state, health, and backend-declared
   readiness, with runtime-family data exposed only as compatibility detail
3. add tests proving native messaging resolution reflects the implicit
   platform-inbox or brokered path plus email-family detail
4. add tests proving undeclared aliases and missing registry mappings fail
   loudly
5. run targeted API, domain, and db tests
6. run `pnpm lint`

## Deliverables

1. a shared control-plane resolver that consumes:
   - the native capability registry
   - the external backend registry
   - enabled native capability activation metadata
   - entitlement and binding summaries
   - health and readiness snapshots
   - runtime-family compatibility detail
2. API control-plane responses sourced from the shared resolver
3. canonical route IDs such as `/capabilities/messaging` and
   `/external-backends/trading`
4. explicit compatibility policy for legacy trading route families
5. separate response fields for:
   - native capability activation
   - external-backend registration
   - health or reachability
   - tenant or agent readiness

## Implementation Notes

### Native capability path

1. Native-capability responses may include platform-owned provider lifecycle
   detail when the platform owns that capability's provider model.
2. `messaging` remains the current native example.

### External backend path

1. External-backend responses identify backend ID, registration mode,
   transport availability, health, entitlement state, and backend-declared
   readiness summary.
2. Backend responses must not force the platform to understand
   trading-specific provider or storage vocabulary.

### State versus visibility

1. Control-plane state answers whether a native capability is active or whether
   an external backend is registered and dispatchable.
2. Effective tool visibility remains a later worker concern that may combine
   control-plane state with resolved skills and runtime policy.
3. API route migration in this phase must not collapse those two views into one
   resolver contract.

### Route migration strategy

1. Use the matrix in document 011 to move platform-owned trading surfaces to
   generic external-backend control-plane routes.
2. Any temporary compatibility alias must delegate to the canonical
   external-backend handler and remain explicitly declared.
3. Remove compatibility fields or aliases only after verification.

## Extraction Pattern

This phase rewrites the control plane first. It does not yet change worker
visibility or widen platform ownership.