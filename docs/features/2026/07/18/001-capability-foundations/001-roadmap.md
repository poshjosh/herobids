# Capability Implementation Roadmap

**Status:** proposed  
**Created:** 2026-07-18

## Summary

This roadmap decomposes capability implementation into bounded, phase-specific
plans so implementation can proceed without mixing foundational metadata,
runtime behavior changes, service extraction, and terminology cleanup in a
single uncontrolled stream.

The roadmap implements the ADR set established in:

- [ADR 002](../../../../tech/adrs/2026/07/002-capability-model-and-registry.md)
- [ADR 003](../../../../tech/adrs/2026/07/003-agent-core-vs-capability-services.md)
- [ADR 004](../../../../tech/adrs/2026/07/004-capability-registry-and-tool-exposure-model.md)

The guiding rule is: do not combine service extraction with naming cleanup.

## Child Plans

1. [Capability Foundations](./002-capability-foundations.md)
2. [Capability Resolution And Route Migration](./003-capability-resolution-and-route-migration.md)
3. [Worker Tool Visibility Enforcement](./004-worker-tool-visibility-enforcement.md)
4. [Crypto-Trading Capability Extraction](./005-crypto-trading-capability-extraction.md)
5. [Messaging Capability Extraction](./006-messaging-capability-extraction.md)
6. [Capability Naming Cleanup](./007-capability-naming-cleanup.md)

## Sequence

The intended order is strict:

1. capability foundations
2. capability resolution and canonical route migration
3. worker visibility enforcement
4. `crypto-trading` service extraction
5. `messaging` service extraction
6. naming and documentation cleanup

Later phases must not start until the acceptance criteria of earlier phases are
met.

## Extraction Strategy

Two extraction patterns are mandatory in this roadmap:

1. **Branch-by-abstraction** for capability service extraction.
   Agent Core must call a stable abstraction first, then switch the backing
   implementation from in-process logic to a separate capability service.
2. **Strangler-fig migration** at public route boundaries.
   Canonical product routes such as `/capabilities/crypto-trading` are added
   first, legacy family-named routes such as `/capabilities/trading` remain as
   declared aliases temporarily, and old paths are removed only after callers
   migrate.

## Roadmap Invariants

These rules apply across all child plans:

1. `crypto-trading` and `messaging` are separate deployable capability services.
2. Runtime binding families such as `trading` and `email` remain compatibility
   layer internals during this rollout.
3. Capability-owned tool calls must converge on one versioned cross-service
   contract.
4. Tool ownership must be exhaustive and machine-readable over
   `AgentToolName`.
5. Capability-owned tool visibility must require both ownership and activation.
6. Provider lifecycle, service health, and tenant readiness are separate
   states.
7. Naming cleanup is not allowed to delay service extraction.

## Phase Gates

### Gate 1: Foundations complete

Required before route migration or worker gating changes:

1. shared registry exists
2. exhaustive ownership manifest exists
3. cross-service capability-tool contract types exist
4. preset or role metadata is separated conceptually from capabilities

### Gate 2: Capability resolution complete

Required before worker gating changes:

1. shared capability resolver exists
2. canonical capability route IDs exist
3. route alias policy is explicit
4. provider lifecycle enrichment model is explicit

### Gate 3: Worker gating complete

Required before service extraction:

1. visibility uses ownership plus activation
2. `send_message` remains available only through explicit messaging rules
3. CI validates ownership exhaustiveness

### Gate 4: Crypto-trading extraction complete

Required before messaging extraction:

1. Agent Core can invoke capability-owned trading tools through the stable
   abstraction
2. service authentication, idempotency, deadlines, and typed failures are real
3. trading-instance authority is preserved

### Gate 5: Messaging extraction complete

Required before naming cleanup:

1. `send_message` and `send_email` run through the messaging capability service
2. provider lifecycle and health appear correctly in capability APIs and UI
3. preset handling is aligned in UI surfaces

## Anti-Scope-Creep Rules

1. Do not promote unrelated skill domains into product capabilities during this
   roadmap.
2. Do not rename persisted fields such as `capabilityFamilies` or
   `capabilityMode` before the service extractions are complete.
3. Do not redesign deep trading semantics while extracting the
   `crypto-trading` service boundary.
4. Do not split attachments or documents into a separate top-level capability
   during this roadmap.

## Completion Condition

The roadmap is complete only when:

1. product capability metadata is sourced from one shared registry
2. every known agent tool has exactly one validated owner
3. capability-owned tool visibility is gated by ownership and activation
4. canonical public capability routes use product capability IDs, with legacy
   aliases only where explicitly declared
5. `crypto-trading` runs through a separate deployable capability service
6. `messaging` runs through a separate deployable capability service
7. runtime families such as `trading` and `email` remain compatibility-layer
   internals rather than durable product identifiers