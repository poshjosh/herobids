# Capability Resolution And Route Migration

**Status:** proposed  
**Created:** 2026-07-18  
**Parent roadmap:** [Capability Implementation Roadmap](./001-roadmap.md)  
**Depends on:** [Capability Foundations](./002-capability-foundations.md)

## Purpose

Add shared capability resolution and canonical product route identities without
changing worker tool-visibility behavior or extracting services yet.

## Scope

This phase includes:

1. shared capability resolution on top of runtime-family resolution
2. canonical public capability route IDs
3. explicit legacy route aliases
4. provider lifecycle enrichment rules

This phase does not include:

1. worker visibility enforcement
2. capability service extraction
3. naming cleanup

## Deliverables

1. shared capability resolver that consumes:
   - resolved skills
   - readiness by runtime family
   - granted connections by runtime family
   - default connections by runtime family
   - capability activation metadata
2. API capability responses sourced from the shared resolver
3. canonical route IDs such as `/capabilities/crypto-trading` and
   `/capabilities/messaging`
4. explicit legacy alias handling for `/capabilities/trading`
5. separate enrichment fields for:
   - static provider lifecycle support
   - capability-service health or reachability
   - tenant or agent readiness

## Implementation Notes

### Activation rules

Initial activation rules must be explicit:

1. `crypto-trading` is explicitly activated
2. `messaging` is implicitly active for the platform inbox or brokered
   user-messaging path
3. `send_email` still requires relevant provider or readiness state

### Route migration strategy

Use a strangler-fig approach at the route boundary:

1. add canonical product routes first
2. keep `/capabilities/trading` only as a declared legacy alias
3. move callers to canonical routes
4. remove the alias only after verification

## Acceptance Criteria

This phase is complete only when:

1. a shared capability resolver exists and is consumed by API surfaces instead
   of ad hoc duplicated logic
2. canonical product routes exist for `crypto-trading` and `messaging`
3. `/capabilities/trading` is either a declared legacy alias or explicitly
   removed; it must not remain ambiguous
4. provider lifecycle support is distinguishable from service health and tenant
   readiness in API responses
5. no worker tool-visibility behavior has changed yet

## Validation And Verification

1. add tests for route IDs and alias behavior
2. add tests proving `crypto-trading` still maps to runtime family `trading`
3. add tests proving messaging capability resolution reflects the brokered
   surface plus email-family detail
4. add tests proving undeclared aliases and missing registry mappings fail
   loudly
5. run targeted API, domain, and db tests
6. run `pnpm lint`

## Extraction Pattern

This phase uses strangler-fig migration at the public API boundary only.

## Out Of Scope

1. worker ownership enforcement
2. cross-service runtime calls
3. separate deployable capability services