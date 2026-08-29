# Capability Foundations

**Status:** draft
**Created:** 2026-07-18  
**Parent roadmap:** [Capability Implementation Roadmap](./001-roadmap.md)
**Normative inputs:** [Native Capabilities And External Backends](./013-native-capabilities-and-external-backends.md), [Cross-Service Capability Execution Design](./008-cross-service-capability-execution-design.md)

## Purpose

Create the shared platform foundation required to distinguish native
capabilities from external backends, establish generic boundary contracts, and
prevent repo-local external services from leaking into platform-core code.

## Scope

This phase includes:

1. native-versus-external boundary metadata in shared domain code
2. generic external-backend invocation contract types
3. generic registration and ownership metadata for platform tool exposure
4. preset or role metadata separation from domain or backend registration
5. compatibility clarifications around `capabilityFamilies` and related legacy
   terminology

This phase does not include:

1. worker visibility behavior changes beyond generic boundary prerequisites
2. public route migration or domain-specific control-plane routes
3. implementation of one concrete external backend service boundary
4. naming cleanup of legacy persisted fields

## Non-Goals

1. Do not make the platform core own domain-specific policy in this phase.
2. Do not implement a concrete repo-local external service boundary here.
3. Do not move or invent domain-specific public control-plane routes in this
   phase.
4. Do not treat runtime binding families as native domain identifiers.

## Dependencies

1. [Capability Implementation Roadmap](./001-roadmap.md) fixes this phase as a
   later executable phase after the current ready slice.
2. [013-native-capabilities-and-external-backends.md](./013-native-capabilities-and-external-backends.md)
   and [tasks/002-external-backend-boundary-implementation-tasks.md](./tasks/002-external-backend-boundary-implementation-tasks.md)
   define the current controlling slice and boundary rules this phase must
   preserve.
3. [008-cross-service-capability-execution-design.md](./008-cross-service-capability-execution-design.md)
   remains the binding normative input for generic external-boundary contract,
   auth, deadline, and health behavior.

## Fixed Decisions

1. This phase establishes generic shared metadata and contract foundations
   without pulling domain-specific semantics into the platform core.
2. The foundation must distinguish native capabilities from external backends.
3. `capabilityFamilies` remains a legacy runtime-binding concept, not the sole
   source of native-capability or backend-registration truth.
4. Preset or role metadata remains separate from native capability membership
   and external backend registration.
5. Shared modules may carry only transport, auth, health, audit, and generic
   registration semantics across the external boundary.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. helper and module boundaries for generic registration, ownership, and
   contract code
2. exact file placement for shared exports and validation helpers
3. test placement and type-assertion strategy for the generic external-backend
   contract surface
4. local naming of private helpers that does not change the native-versus-
   external model or the shared boundary identifiers

## Acceptance Criteria

This phase is complete only when:

1. shared domain code distinguishes native capabilities from external backends
   explicitly
2. generic registration and ownership metadata is exhaustive over the platform
   tool set it governs
3. unknown tool names or invalid ownership kinds are rejected by validation
   helpers
4. the shared external-boundary contract types compile and are usable by both
   platform-core callers and repo-local or off-repo external services
5. no domain-specific runtime behavior has leaked into the platform core in
   this phase
6. preset and role metadata remains separate from native-capability and
   external-backend registration semantics
7. shared contract typing stops at the generic envelope, discriminants, and
   failure codes; external-domain tool payload schemas remain backend-owned

## Validation

1. add unit tests for native-versus-external registration metadata and generic
   ownership completeness
2. add compile-level tests or type assertions for the generic external-
   backend contract
3. run targeted domain tests for shared registration, ownership, and contract
   modules
4. run grep checks proving shared domain modules do not hardcode external
   service implementation imports
5. run `pnpm lint`

## Deliverables

1. shared domain metadata for native capabilities and external backend
   registration
2. shared ownership metadata for the platform tool set
3. generic external-backend contract types and validation schemas
4. preset or role metadata kept separate from backend registration
5. domain exports for the shared boundary modules above
6. comments or helper names clarifying that `capabilityFamilies` is legacy
   runtime terminology rather than native-capability truth

## Implementation Notes

### Registration metadata

The shared metadata must describe at minimum:

1. whether a domain is native or external
2. how an external backend is registered and addressed
3. which tools are governed by generic platform ownership or external backend
   ownership metadata
4. any generic lifecycle or health metadata the platform needs without
   embedding domain semantics

### Ownership

Ownership must encode every governed `AgentToolName` exhaustively with machine-
readable categories that preserve the boundary between platform-core tools,
native-capability tools, and externally-backed tools.

### Contract types

The shared contract types and validation schemas must implement document 008
only as a generic external-backend boundary, including:

1. versioning
2. request, correlation, and idempotency identifiers
3. tenant, agent, session, and actor identity
4. deadlines and retry semantics
5. typed envelope discriminants and failure codes
6. explicit boundary points where backend-published tool schema descriptors may
   be consumed without moving payload-schema ownership into platform core

## Extraction Pattern

This phase prepares the generic boundary and registration model that later
phases must use. It does not yet create the first concrete repo-local external
service or switch platform callers onto it.