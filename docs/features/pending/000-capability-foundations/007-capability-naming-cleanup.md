# Native Capability And External Backend Terminology Cleanup

**Status:** draft
**Created:** 2026-07-18  
**Parent roadmap:** [Capability Implementation Roadmap](./001-roadmap.md)  
**Prerequisite:** [Messaging Capability Extraction](./006-messaging-capability-extraction.md)
**Normative inputs:** [Native Capabilities And External Backends](./013-native-capabilities-and-external-backends.md), [Initial Capability Registry And Tool Ownership Manifest](./009-initial-capability-registry-and-tool-ownership-manifest.md), [Capability Activation Model](./010-capability-activation-model.md), [Capability Route And Response Migration Manifest](./011-capability-route-and-response-migration-manifest.md)

## Purpose

Clean up the highest-risk terminology collisions after native-capability and
external-backend boundaries are already real.

## Scope

This phase includes:

1. worker tool-policy terminology cleanup
2. control-plane terminology clarification for native capabilities, external
   backends, registration mechanisms, and runtime families
3. documentation alignment
4. optional additive alias introduction where necessary

This phase does not include:

1. backend extraction
2. large breaking persisted-field renames
3. unrelated product feature work

## Non-Goals

1. Do not perform extraction work in this phase.
2. Do not introduce large breaking persisted-field renames here.
3. Do not reopen unrelated product feature work during cleanup.
4. Do not reopen the native-versus-external taxonomy decisions settled earlier
   in the roadmap.

## Dependencies

1. [Capability Implementation Roadmap](./001-roadmap.md) fixes this cleanup as
   the last executable phase after
   [006-messaging-capability-extraction.md](./006-messaging-capability-extraction.md).
2. [006-messaging-capability-extraction.md](./006-messaging-capability-extraction.md)
   must first make the native and external boundaries real so naming cleanup
   can follow the proven architecture instead of guessing it.
3. [013-native-capabilities-and-external-backends.md](./013-native-capabilities-and-external-backends.md),
   [009-initial-capability-registry-and-tool-ownership-manifest.md](./009-initial-capability-registry-and-tool-ownership-manifest.md),
   [010-capability-activation-model.md](./010-capability-activation-model.md),
   and [011-capability-route-and-response-migration-manifest.md](./011-capability-route-and-response-migration-manifest.md)
   remain binding normative inputs for allowed compatibility terms and route
   semantics.

## Fixed Decisions

1. This cleanup happens after the native and external boundaries are already
   real.
2. Native capability, external backend, registration mechanism, runtime family,
   and tool ownership are separate concepts and must not share ambiguous names.
3. `trading` is the initial external-backend example and `messaging` is the
   current native-capability example.
4. The cleanup must not change runtime behavior by itself.
5. Any remaining legacy terms must be documented explicitly as
   compatibility-only terms.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. exact helper, alias, and comment wording used to reduce terminology
   collisions
2. whether to add additive compatibility aliases that preserve behavior while
   improving clarity
3. test placement for renamed exports or targeted terminology assertions
4. how to format the terminology inventory of allowed and prohibited residuals

## Acceptance Criteria

This phase is complete only when:

1. code comments and type names no longer blur native capability,
   external-backend, and tool-grant terminology in the targeted surfaces
2. stable docs align with the native-capability and external-backend
   architecture
3. no behavior changes are introduced by the cleanup itself
4. any remaining legacy terms are explicitly documented as compatibility-only
5. grep residuals match the approved terminology inventory exactly

## Validation

1. add or update narrow tests only where names or exports changed
2. grep for stale high-risk terminology and confirm intentional residual uses
3. run targeted affected tests
4. run `pnpm lint`

## Deliverables

1. worker tool-policy terminology moved away from product-capability wording
   where that wording is no longer accurate
2. clarified local aliases and comments around `capabilityMode` and runtime
   families
3. updated stable docs for native capability, external backend, registration
   mechanism, runtime family, preset, tool grant, ownership, and route-ID
   terminology
4. conflicting draft plans marked superseded where necessary
5. a before-and-after terminology inventory listing allowed compatibility
   terms, prohibited new usages, and intentional grep residuals

## Terminology Inventory

| Preferred term | Meaning | Avoid or legacy term |
| --- | --- | --- |
| `native capability` | platform-owned domain semantics and activation model | using `capability` when only a runtime family is meant |
| `external backend` | externally bounded domain addressed by `backendId` | calling the first external domain a native capability |
| `registration mechanism` | direct API, skill, or MCP packaging | treating transport or packaging as domain ownership |
| `runtime family` | compatibility or execution grouping such as `trading` or `email` | using family names as the canonical control-plane type |
| `tool owner` | `core`, `general`, native-capability, or external-backend owner | inferring ownership from skill membership alone |
| `legacy compatibility term` | old wording kept only to explain migration or preserve wire compatibility | introducing new product surfaces with the old wording |

## Implementation Notes

This phase is intentionally last. It exists to reduce ambiguity after the
architecture is proven, not before.

If a later wire rename is still desired, that should be planned separately as a
dedicated compatibility migration, not folded into this cleanup.