# Capability Resolution And Route Migration

**Status:** draft
**Created:** 2026-07-18  
**Parent roadmap:** [Capability Implementation Roadmap](./001-roadmap.md)  
**Prerequisite:** [Capability Foundations](./002-capability-foundations.md)
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

## Non-Goals

1. Do not change worker visibility rules in this phase.
2. Do not extract capability services here.
3. Do not use this phase for naming cleanup.
4. Do not introduce a shared `/capabilities/crypto-trading` canonical route.

## Dependencies

1. [Capability Implementation Roadmap](./001-roadmap.md) fixes this phase after
   the current ready slice and after
   [002-capability-foundations.md](./002-capability-foundations.md).
2. [002-capability-foundations.md](./002-capability-foundations.md) must first
   establish the shared registry, ownership, and contract foundations this
   phase consumes.
3. [010-capability-activation-model.md](./010-capability-activation-model.md)
   and [011-capability-route-and-response-migration-manifest.md](./011-capability-route-and-response-migration-manifest.md)
   remain binding normative inputs for activation semantics and route coverage.

## Fixed Decisions

1. Shared capability resolution builds on runtime-family resolution rather than
   replacing it with ad hoc logic.
2. Canonical shared capability routes are `/capabilities/trading` and
   `/capabilities/messaging`.
3. Provider lifecycle support, service health, and tenant readiness remain
   distinct response concerns.
4. Activation state must be sourced from the model in document 010, not
   inferred from `capabilityMode`, connections, or skill membership.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. helper boundaries for shared capability resolution and response enrichment
2. exact route-registration wiring and alias enforcement structure
3. test placement across API, domain, and db surfaces
4. private naming of resolver internals that does not change the canonical
   route IDs, activation rules, or compatibility policy

## Acceptance Criteria

This phase is complete only when:

1. a shared capability resolver exists and is consumed by API surfaces instead
   of ad hoc duplicated logic
2. canonical product routes exist for `trading` and `messaging`
3. `/capabilities/trading` is the declared shared canonical route and no
   undeclared crypto-specific shared alias exists
4. provider lifecycle support is distinguishable from service health and tenant
   readiness in API responses
5. no worker tool-visibility behavior has changed yet
6. activation state is sourced only from the model in document 010; it is not
   inferred from `capabilityMode`, connections, or skill membership

## Validation

1. add tests for route IDs and alias behavior
2. add tests proving `trading` maps to runtime family `trading`
3. add tests proving messaging capability resolution reflects the brokered
   surface plus email-family detail
4. add tests proving undeclared aliases and missing registry mappings fail
   loudly
5. run targeted API, domain, and db tests
6. run `pnpm lint`

## Deliverables

1. shared capability resolver that consumes:
   - resolved skills
   - readiness by runtime family
   - granted connections by runtime family
   - default connections by runtime family
   - capability activation metadata
2. API capability responses sourced from the shared resolver
3. canonical route IDs such as `/capabilities/trading` and
   `/capabilities/messaging`
4. explicit route compatibility policy for trading surfaces
5. separate enrichment fields for:
   - static provider lifecycle support
   - capability-service health or reachability
   - tenant or agent readiness

## Implementation Notes

### Activation rules

Initial activation rules must be explicit:

1. `trading` activation follows the durable row and resolver predicate
   defined in document 010
2. `messaging` is implicitly active only for the documented platform-inbox or
   brokered user-messaging path
3. `send_email` requires explicit messaging activation plus relevant provider
   readiness state

### Route migration strategy

Use the complete strangler-fig route matrix and response compatibility policy in
document 011:

1. keep `/capabilities/trading` as the canonical shared control-plane route
2. do not introduce `/capabilities/crypto-trading` as a shared canonical path
3. migrate response shapes and callers only where declared in document 011
4. remove temporary compatibility fields or aliases only after verification

## Extraction Pattern

This phase uses strangler-fig migration at the public API boundary only.