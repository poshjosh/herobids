# Messaging Capability Extraction

**Status:** draft
**Created:** 2026-07-18  
**Parent roadmap:** [Capability Implementation Roadmap](./001-roadmap.md)  
**Prerequisite:** [Trading Capability Extraction](./005-trading-capability-extraction.md)
**Normative inputs:** [Cross-Service Capability Execution Design](./008-cross-service-capability-execution-design.md), [Initial Capability Registry And Tool Ownership Manifest](./009-initial-capability-registry-and-tool-ownership-manifest.md), [Capability Activation Model](./010-capability-activation-model.md)

## Purpose

Extract `messaging` as the second separate deployable capability service after
the `trading` boundary has already been proven.

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

## Non-Goals

1. Do not create a separate top-level documents capability in this phase.
2. Do not rename runtime families here.
3. Do not widen cleanup beyond messaging-related surfaces.
4. Do not bypass the shared invocation contract for messaging-owned tools.

## Dependencies

1. [Capability Implementation Roadmap](./001-roadmap.md) fixes this phase after
   [005-trading-capability-extraction.md](./005-trading-capability-extraction.md).
2. [005-trading-capability-extraction.md](./005-trading-capability-extraction.md)
   must first prove the service-boundary pattern for capability extraction.
3. [008-cross-service-capability-execution-design.md](./008-cross-service-capability-execution-design.md),
   [009-initial-capability-registry-and-tool-ownership-manifest.md](./009-initial-capability-registry-and-tool-ownership-manifest.md),
   and [010-capability-activation-model.md](./010-capability-activation-model.md)
   remain binding normative inputs for the invocation boundary, ownership, and
   readiness semantics.

## Fixed Decisions

1. `messaging` is extracted only after `trading` has proven the service
   boundary pattern.
2. `send_message` and `send_email` execute through the shared invocation
   contract once extraction is complete.
3. Documents and attachments remain inside messaging rather than becoming a new
   top-level capability.
4. Provider lifecycle support, service health, and tenant readiness stay
   distinct in API and UI surfaces.
5. Email remains a messaging family or runtime-family detail, not the top-level
   product capability.

## Open Latitude

Implementation may choose the following without escalation, as long as the
fixed decisions, dependencies, acceptance criteria, and validation still hold:

1. service packaging and internal adapter boundaries for messaging transport
2. exact UI/API wiring for lifecycle, health, and readiness surfaces
3. internal naming of provider-specific helpers that does not change shared
   capability ownership or route semantics
4. test placement across web, API, worker, and domain packages

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

## Validation

1. add integration tests for authenticated and idempotent messaging tool calls,
   including `publish_artifact`
2. add UI tests for planned providers being non-actionable
3. add UI and API tests for lifecycle, health, and readiness separation
4. run targeted web, API, worker, and domain tests
5. run `pnpm lint`
6. validate local or staging compose wiring for the new service

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