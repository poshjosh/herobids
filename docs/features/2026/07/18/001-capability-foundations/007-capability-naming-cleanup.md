# Capability Naming Cleanup

**Status:** proposed  
**Created:** 2026-07-18  
**Parent roadmap:** [Capability Implementation Roadmap](./001-roadmap.md)  
**Depends on:** [Messaging Capability Extraction](./006-messaging-capability-extraction.md)
**Normative inputs:** [Initial Capability Registry And Tool Ownership Manifest](./009-initial-capability-registry-and-tool-ownership-manifest.md), [Capability Activation Model](./010-capability-activation-model.md), [Capability Route And Response Migration Manifest](./011-capability-route-and-response-migration-manifest.md)

## Purpose

Clean up the highest-risk terminology collisions after the capability service
boundaries are already real.

## Scope

This phase includes:

1. worker tool-policy terminology cleanup
2. runtime-composition terminology clarification
3. documentation alignment
4. optional additive alias introduction where necessary

This phase does not include:

1. service extraction
2. large breaking persisted-field renames
3. unrelated product feature work

## Deliverables

1. worker tool-policy terminology moved away from product-capability wording
2. clarified local aliases and comments around `capabilityMode`
3. updated stable docs for capability, runtime family, preset, tool grant,
   ownership, and route-ID terminology
4. conflicting draft capability plans marked superseded where necessary
5. a before-and-after terminology inventory listing allowed compatibility terms,
   prohibited new usages, and intentional grep residuals

## Implementation Notes

This phase is intentionally last. It exists to reduce ambiguity after the
architecture is proven, not before.

If a later wire rename is still desired, that should be planned separately as a
dedicated compatibility migration, not folded into this cleanup.

## Acceptance Criteria

This phase is complete only when:

1. code comments and type names no longer blur product capability and tool grant
   terminology in the targeted surfaces
2. stable docs align with the extracted architecture
3. no behavior changes are introduced by the cleanup itself
4. any remaining legacy terms are explicitly documented as compatibility terms
5. grep residuals match the approved terminology inventory exactly

## Validation And Verification

1. add or update narrow tests only where names or exports changed
2. grep for stale high-risk terminology and confirm intentional residual uses
3. run targeted affected tests
4. run `pnpm lint`

## Out Of Scope

1. changing runtime behavior
2. breaking persistence or API compatibility by mass rename
3. reopening capability taxonomy decisions