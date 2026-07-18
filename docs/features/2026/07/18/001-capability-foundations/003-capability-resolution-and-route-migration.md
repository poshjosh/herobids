# Capability Resolution And Route Migration

**Status:** proposed  
**Created:** 2026-07-18  
**Parent roadmap:** [Capability Implementation Roadmap](./001-roadmap.md)  
**Depends on:** [Capability Foundations](./002-capability-foundations.md)
**Normative inputs:** [Capability Activation Model](./010-capability-activation-model.md), [Capability Route And Response Migration Manifest](./011-capability-route-and-response-migration-manifest.md)

## Purpose

Add shared capability resolution and canonical product route identities without
changing worker tool-visibility behavior or extracting services yet.

## Scope

This phase includes:

1. shared capability resolution on top of runtime-family resolution
2. durable product capability activation resolution
3. canonical public capability route IDs
4. explicit legacy route aliases
5. provider lifecycle enrichment rules

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

1. `crypto-trading` activation follows the durable row and resolver predicate
   defined in document 010
2. `messaging` is implicitly active only for the documented platform-inbox or
   brokered user-messaging path
3. `send_email` requires explicit messaging activation plus relevant provider
   readiness state

### Route migration strategy

Use the complete strangler-fig route matrix and response compatibility policy in
document 011:

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
6. activation state is sourced only from the model in document 010; it is not
   inferred from `capabilityMode`, connections, or skill membership

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