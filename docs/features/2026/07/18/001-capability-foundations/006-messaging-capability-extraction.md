# Messaging Capability Extraction

**Status:** proposed  
**Created:** 2026-07-18  
**Parent roadmap:** [Capability Implementation Roadmap](./001-roadmap.md)  
**Depends on:** [Crypto-Trading Capability Extraction](./005-crypto-trading-capability-extraction.md)
**Normative inputs:** [Cross-Service Capability Execution Design](./008-cross-service-capability-execution-design.md), [Initial Capability Registry And Tool Ownership Manifest](./009-initial-capability-registry-and-tool-ownership-manifest.md), [Capability Activation Model](./010-capability-activation-model.md)

## Purpose

Extract `messaging` as the second separate deployable capability service after
the `crypto-trading` boundary has already been proven.

## Scope

This phase includes:

1. service boundary for `messaging`
2. capability-tool contract usage for messaging-owned tools
3. explicit provider lifecycle and health surfacing
4. UI alignment for messaging capability and preset terminology

This phase does not include:

1. separate documents capability creation
2. runtime-family renames
3. broad terminology cleanup outside messaging-related surfaces

## Deliverables

1. a deployable `messaging` capability service
2. service-backed execution for:
   - `send_message`
   - `send_email`
   - future artifact or document-delivery hooks only where needed by the slice
3. capability setup and capability detail surfaces that distinguish:
   - provider lifecycle support
   - service health
   - tenant or agent readiness
4. preset or role UI alignment so `personal-assistant` is not treated as a
   capability

## Implementation Notes

### Extraction pattern

Reuse branch-by-abstraction and the complete invocation, durable-intent,
health, and no-fallback requirements in document 008.

### Messaging nuance

1. `send_message` must still work through implicitly active brokered messaging
2. `send_email` must remain provider-linked and readiness-gated
3. documents and attachments remain inside messaging, not as a new top-level
   capability

## Acceptance Criteria

This phase is complete only when:

1. `messaging` runs as a separate deployable service
2. `send_message` and `send_email` execute through the shared invocation
   contract
3. provider lifecycle support is distinguishable from service health and tenant
   readiness in API and UI surfaces
4. preset or role UI no longer mislabels `personal-assistant` as a capability
5. email remains a messaging family or runtime family, not the top-level
   product capability
6. `publish_artifact`, `send_message`, and `send_email` execute in messaging
   according to their ownership in document 009

## Validation And Verification

1. add integration tests for authenticated and idempotent messaging tool calls,
   including `publish_artifact`
2. add UI tests for planned providers being non-actionable
3. add UI and API tests for lifecycle, health, and readiness separation
4. run targeted web, API, worker, and domain tests
5. run `pnpm lint`
6. validate local or staging compose wiring for the new service

## Out Of Scope

1. separate documents capability design
2. broad naming cleanup unrelated to messaging surfaces
3. persisted field renames